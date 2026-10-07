import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovalStatus,
  CodeGenerationStatus,
  RiskLevel,
  SessionStatus,
  WorkspaceChangeStatus,
} from '../domain';
import type { Actor, ApprovalRequest, ConversationContext, Id, InboundMessage, Session, Task } from '../domain';
import type { Logger } from '../ports';
import { ApprovalManager } from './approval-manager';
import type { ApprovalPolicy } from './approval-policy';
import {
  APPROVAL_REFERENCE_MAX_ATTEMPTS,
  ApprovalDecisionService,
  OPS_UI_DECISION_SURFACE,
  approvalBindingDigest,
  approvalConfirmationReference,
  approvalReferenceWindow,
  normalizeApprovalReference,
} from './approval-decision-service';
import type { ApprovalSurfaceDecision } from './approval-decision-service';
import { ConversationRuntime } from './conversation-runtime';
import type { ApplyPreviewAnchor, ConversationRuntimeDeps } from './conversation-runtime';
import { APPROVAL_REFERENCE_LINE_PREFIX, ResponseComposer } from './response-composer';
import { StatelessApplyPreviewFlow } from './stateless-apply-preview-flow';
import { StatelessApprovalFlow } from './stateless-approval-flow';
import { StatelessScopeClarificationFlow } from './stateless-scope-clarification-flow';

/**
 * ADR-0113 D7 / OPS-2b acceptance, offline: the operations UI and chat share ONE decision path. One fixture is driven
 * from both surfaces and the effects compared (decision record, conversation state, recorded history, reply); an
 * approval cannot be granted without a valid confirmation reference, for another actor, past expiry or twice; a chat
 * and a UI decision racing on one approval produce exactly one decision; the reference line appears in chat only
 * while the UI is on.
 */

const TS = '2026-10-07T00:00:00.000Z';
const OWNER_ID = 'actor-owner';
const OWNER: Actor = { id: OWNER_ID } as Actor;
const STRANGER: Actor = { id: 'actor-stranger' } as Actor;
const CTX: ConversationContext = { platform: 'discord', spaceId: 'guild-1', channelId: 'chan-1', userId: 'owner-user' };
const SESSION_ID = 'sess-1';
const PROJECT_ID = 'proj-1';
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TS));
});
afterEach(() => {
  vi.useRealTimers();
});

/** In-memory storage seam (sessions, tasks, approvals) shared by the real stateless flows and ApprovalManager. */
function memoryStore() {
  const sessions = new Map<Id, Session>();
  const tasks = new Map<Id, Task>();
  const approvals = new Map<Id, ApprovalRequest>();
  return {
    sessions: {
      async get(id: Id) { return sessions.get(id) ?? null; },
      async save(session: Session) { sessions.set(session.id, session); return session; },
      async list() { return [...sessions.values()]; },
    },
    tasks: {
      async get(id: Id) { return tasks.get(id) ?? null; },
      async save(task: Task) { tasks.set(task.id, task); return task; },
    },
    approvals: {
      async get(id: Id) { return approvals.get(id) ?? null; },
      async save(request: ApprovalRequest) { approvals.set(request.id, request); return request; },
      async delete(id: Id) { approvals.delete(id); },
      async list() { return [...approvals.values()]; },
      async findByExecutionPlan(planId: Id) { return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId); },
    },
    raw: { sessions, tasks, approvals },
  };
}
type Store = ReturnType<typeof memoryStore>;

const commitPendingOf = (approvalId: Id, o: Partial<ApplyPreviewAnchor> = {}): ApplyPreviewAnchor => ({
  kind: 'code-preview-apply',
  status: 'COMMIT_APPROVAL_PENDING',
  executionPlanRef: { id: 'plan-1', goal: 'g' },
  workspaceRef: { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' },
  targetFiles: ['src/a.ts'],
  codeGenerationRef: { id: 'gen-1', status: CodeGenerationStatus.SUCCEEDED },
  codeProposalRef: { id: 'prop-1' },
  instruction: 'fix it',
  projectId: PROJECT_ID,
  createdAt: TS,
  workspaceChangeRef: { id: 'chg-1', status: WorkspaceChangeStatus.APPLIED },
  commitApprovalId: approvalId,
  proposedCommitMessage: 'fix: a',
  commitCandidateFiles: ['src/a.ts'],
  ...o,
});

interface Fixture {
  store: Store;
  manager: ApprovalManager;
  runtime: ConversationRuntime;
  service: ApprovalDecisionService;
  history: string[];
  decides: number;
  approvalId: Id;
}

/** A runtime wired with the real stateless flows over one in-memory store; only the decision-turn collaborators exist. */
async function fixture(options: { sessionActor?: Id; kind?: 'commit' | 'plan' | 'eligible' } = {}): Promise<Fixture> {
  const store = memoryStore();
  const manager = new ApprovalManager(store as never, {} as ApprovalPolicy);
  const history: string[] = [];
  const f = { store, manager, history, decides: 0 } as Fixture;
  const realDecide = manager.decide.bind(manager);
  manager.decide = async (id, decision) => {
    const result = await realDecide(id, decision);
    f.decides++;
    return result;
  };
  const session: Session = {
    id: SESSION_ID,
    actorId: options.sessionActor ?? OWNER_ID,
    context: CTX,
    status: SessionStatus.ACTIVE,
    activeProjectId: PROJECT_ID,
    createdAt: TS,
    lastActivityAt: TS,
  };
  await store.sessions.save(session);
  const applyPreviewFlow = new StatelessApplyPreviewFlow(store);
  if (options.kind === 'eligible') {
    const { commitApprovalId: _c, proposedCommitMessage: _m, commitCandidateFiles: _f, workspaceChangeRef: _w, ...rest } = commitPendingOf('none');
    await applyPreviewFlow.anchor(session, { ...rest, status: 'ELIGIBLE' });
    f.approvalId = '';
  } else if (options.kind === 'plan') {
    const approval = await manager.requestForRisk({
      executionPlanRef: { id: 'plan-9', goal: 'g' },
      riskLevel: RiskLevel.HIGH,
      reason: 'code change',
      requestedBy: OWNER_ID,
    });
    await store.tasks.save({ id: 'task-plan', planId: 'plan-9', status: 'WAITING_APPROVAL' } as unknown as Task);
    await store.sessions.save({ ...session, activeTaskId: 'task-plan' });
    f.approvalId = approval.id;
  } else {
    const approval = await manager.requestForRisk({
      executionPlanRef: { id: 'plan-1', goal: 'g' },
      riskLevel: RiskLevel.HIGH,
      reason: 'commit src/a.ts',
      requestedBy: OWNER_ID,
    });
    await applyPreviewFlow.anchor(session, commitPendingOf(approval.id));
    f.approvalId = approval.id;
  }
  const deps = {
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: {
      async openForContext() { return (await store.sessions.get(SESSION_ID))!; },
      async touch(s: Session) { return s; },
      async close(s: Session) { return s; },
    },
    memory: {
      async recordShortTerm() { return { id: 'mem-1' }; },
      async recordAssistant(text: string) { history.push(text); },
      async recordToolMemory() { return undefined; },
    },
    approvals: manager,
    approvalFlow: new StatelessApprovalFlow(store),
    scopeClarificationFlow: new StatelessScopeClarificationFlow(store),
    applyPreviewFlow,
    composer: new ResponseComposer(),
    orchestrator: {
      async resume() { throw new Error('resume must not run in these tests'); },
      async run() { throw new Error('run not expected'); },
    },
    logger: silent,
  } as unknown as ConversationRuntimeDeps;
  f.runtime = new ConversationRuntime(deps);
  f.service = f.runtime.approvalDecisions;
  return f;
}

const message = (text: string): InboundMessage => ({ id: 'm1', context: CTX, text, receivedAt: TS });

async function liveAnchor(f: Fixture): Promise<ApplyPreviewAnchor | null> {
  const session = (await f.store.sessions.get(SESSION_ID))!;
  return new StatelessApplyPreviewFlow(f.store).findAnchor(session);
}

/** The reference chat shows: turn the line on and read it from the pending reminder (an ordinary message). */
async function chatReference(f: Fixture): Promise<string> {
  f.service.setConfirmationReferenceEnabled(true);
  const reply = await f.runtime.handle(message('이게 뭐였지?'));
  const line = reply.reply.text.split('\n').find((l) => l.startsWith(APPROVAL_REFERENCE_LINE_PREFIX));
  if (line === undefined) throw new Error('no reference line');
  return line.slice(APPROVAL_REFERENCE_LINE_PREFIX.length, APPROVAL_REFERENCE_LINE_PREFIX.length + 6);
}

const sessionsOf = (f: Fixture) => async () => f.store.sessions.list();

function decideUi(f: Fixture, decision: 'approve' | 'reject', reference?: string, actor: Actor = OWNER): Promise<ApprovalSurfaceDecision> {
  return f.service.decideFromOpsUi({
    approvalId: f.approvalId,
    decision,
    actor,
    ...(reference === undefined ? {} : { reference }),
    sessions: sessionsOf(f),
  });
}

describe('ApprovalDecisionService — chat and the operations UI share one decision (ADR-0113 D7)', () => {
  it('UI approve == chat approve on one fixture (decision record, conversation state, history, reply)', async () => {
    const chat = await fixture();
    const ui = await fixture();
    await chatReference(chat); // the same reminder turn on both fixtures, so the histories are comparable
    const reference = await chatReference(ui);

    const chatTurn = await chat.runtime.handle(message('승인'));
    const uiDecision = await decideUi(ui, 'approve', reference);

    expect(uiDecision.status).toBe('DECIDED');
    if (uiDecision.status !== 'DECIDED') return;
    expect(uiDecision.outcome).toBe('APPROVED');
    expect(uiDecision.kind).toBe('COMMIT');
    expect(uiDecision.reply.text).toBe(chatTurn.reply.text);
    expect(uiDecision.chat).toEqual(CTX);

    const chatRecord = (await chat.manager.get(chat.approvalId))!;
    const uiRecord = (await ui.manager.get(ui.approvalId))!;
    expect(uiRecord.status).toBe(ApprovalStatus.APPROVED);
    const strip = (r: ApprovalRequest) => ({ status: r.status, decision: r.decision, decidedBy: r.decidedBy, decidedAt: r.decidedAt });
    expect(strip(uiRecord)).toEqual(strip(chatRecord));
    expect(chatRecord.comment).toBeUndefined(); // chat records stay as before
    expect(uiRecord.comment).toBe(OPS_UI_DECISION_SURFACE); // the audit marker (no new table)

    const chatAnchor = await liveAnchor(chat);
    const uiAnchor = await liveAnchor(ui);
    expect(uiAnchor?.status).toBe('COMMIT_APPROVED');
    expect({ ...uiAnchor, commitApprovalId: 'x' }).toEqual({ ...chatAnchor, commitApprovalId: 'x' });
    expect(ui.history).toEqual(chat.history);
    expect(ui.decides).toBe(1);
  });

  it('approving in the UI only records: the next chat "승인" gets the existing already-decided routing, nothing executes', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    await decideUi(f, 'approve', reference);
    const again = await f.runtime.handle(message('승인'));
    expect(again.reply.text).toBe(new ResponseComposer().composeNoPendingDecision(CTX).text);
    expect(f.decides).toBe(1);
  });

  it('UI reject == chat reject on one fixture', async () => {
    const chat = await fixture();
    const ui = await fixture();
    const chatTurn = await chat.runtime.handle(message('거절'));
    const uiDecision = await decideUi(ui, 'reject');
    expect(uiDecision).toMatchObject({ status: 'DECIDED', outcome: 'REJECTED', kind: 'COMMIT' });
    if (uiDecision.status !== 'DECIDED') return;
    expect(uiDecision.reply.text).toBe(chatTurn.reply.text);
    expect((await ui.manager.get(ui.approvalId))?.status).toBe(ApprovalStatus.REJECTED);
    expect((await liveAnchor(ui))?.status).toBe('WORKSPACE_APPLIED');
    expect((await liveAnchor(chat))?.status).toBe('WORKSPACE_APPLIED');
    expect(ui.history).toEqual(chat.history);
  });

  it('cannot approve without a valid reference; five wrong references disable UI approve for that approval (chat unaffected)', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    expect(await decideUi(f, 'approve')).toEqual({ status: 'REFUSED', refusal: 'REFERENCE_REQUIRED' });
    const wrong = reference === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let i = 1; i < APPROVAL_REFERENCE_MAX_ATTEMPTS; i++) {
      expect(await decideUi(f, 'approve', wrong)).toEqual({ status: 'REFUSED', refusal: 'REFERENCE_MISMATCH' });
    }
    expect(await decideUi(f, 'approve', wrong)).toEqual({ status: 'REFUSED', refusal: 'REFERENCE_LOCKED' });
    // Locked for the window even with the right reference; nothing was decided.
    expect(await decideUi(f, 'approve', reference)).toEqual({ status: 'REFUSED', refusal: 'REFERENCE_LOCKED' });
    expect(f.decides).toBe(0);
    expect((await f.manager.get(f.approvalId))?.status).toBe(ApprovalStatus.PENDING);
    // Chat still decides.
    await f.runtime.handle(message('승인'));
    expect((await f.manager.get(f.approvalId))?.status).toBe(ApprovalStatus.APPROVED);
  });

  it('accepts the reference case-insensitively with Crockford look-alikes, in the current or the previous window', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    vi.setSystemTime(new Date(Date.parse(TS) + 29 * 60_000)); // next window (TS is a window boundary), still unexpired
    const typed = reference.toLowerCase().replace(/1/g, 'l').replace(/0/g, 'o');
    expect(normalizeApprovalReference(typed)).toBe(reference);
    expect(await decideUi(f, 'approve', typed)).toMatchObject({ status: 'DECIDED', outcome: 'APPROVED' });
  });

  it('refuses a reference for a changed binding digest or from another actor', async () => {
    const f = await fixture();
    const approval = (await f.manager.get(f.approvalId))!;
    const anchor = (await liveAnchor(f))!;
    const window = approvalReferenceWindow(Date.parse(TS));
    const changed = ApprovalDecisionService.anchoredBinding({ ...anchor, proposedCommitMessage: 'fix: other' })!;
    const forChanged = approvalConfirmationReference(f.approvalId, approvalBindingDigest(approval, changed), OWNER_ID, window);
    const forStranger = approvalConfirmationReference(
      f.approvalId,
      approvalBindingDigest(approval, ApprovalDecisionService.anchoredBinding(anchor)!),
      STRANGER.id,
      window,
    );
    const valid = approvalConfirmationReference(
      f.approvalId,
      approvalBindingDigest(approval, ApprovalDecisionService.anchoredBinding(anchor)!),
      OWNER_ID,
      window,
    );
    expect(forChanged).not.toBe(valid);
    expect(forStranger).not.toBe(valid);
    expect(await decideUi(f, 'approve', forChanged)).toEqual({ status: 'REFUSED', refusal: 'REFERENCE_MISMATCH' });
    expect(await decideUi(f, 'approve', forStranger)).toEqual({ status: 'REFUSED', refusal: 'REFERENCE_MISMATCH' });
    expect(f.decides).toBe(0);
  });

  it('refuses an approval held by another actor (foreign), deciding nothing', async () => {
    const f = await fixture({ sessionActor: STRANGER.id });
    expect(await decideUi(f, 'reject')).toEqual({ status: 'REFUSED', refusal: 'FOREIGN' });
    expect(await f.service.locateForOpsUi(f.approvalId, OWNER, sessionsOf(f))).toEqual({ status: 'REFUSED', refusal: 'FOREIGN' });
    expect(f.decides).toBe(0);
  });

  it('records an expired approval as expired (never approved), exactly as the next chat turn would', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    vi.setSystemTime(new Date(Date.parse(TS) + 31 * 60_000));
    const decided = await decideUi(f, 'approve', reference);
    expect(decided).toMatchObject({ status: 'DECIDED', outcome: 'EXPIRED' });
    const record = (await f.manager.get(f.approvalId))!;
    expect(record).toMatchObject({ status: ApprovalStatus.REJECTED, decidedBy: 'system', comment: 'expired' });
    expect((await liveAnchor(f))?.status).toBe('WORKSPACE_APPLIED');
  });

  it('a decided (consumed) approval cannot be decided again from either surface; a double submit decides once', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    const [first, second] = await Promise.all([decideUi(f, 'approve', reference), decideUi(f, 'approve', reference)]);
    expect(first).toMatchObject({ status: 'DECIDED', outcome: 'APPROVED' });
    expect(second).toEqual({ status: 'REFUSED', refusal: 'ALREADY_DECIDED' });
    expect(await decideUi(f, 'reject')).toEqual({ status: 'REFUSED', refusal: 'ALREADY_DECIDED' });
    expect(f.decides).toBe(1);
  });

  it('a chat decision and a UI decision racing on one approval produce exactly one decision', async () => {
    const noPending = new ResponseComposer().composeNoPendingDecision(CTX).text;
    for (const order of ['ui-started-first', 'chat-started-first'] as const) {
      const f = await fixture();
      const ui = () => decideUi(f, 'reject');
      const chat = () => f.runtime.handle(message('승인'));
      const [uiResult, chatResult] =
        order === 'ui-started-first'
          ? await Promise.all([ui(), chat()])
          : await Promise.all([chat(), ui()]).then(([c, u]) => [u, c] as const);
      expect(f.decides, order).toBe(1);
      const record = (await f.manager.get(f.approvalId))!;
      if (record.status === ApprovalStatus.REJECTED) {
        // The UI reached the per-approval lock first: chat gets the existing "nothing to decide" reply.
        expect(uiResult).toMatchObject({ status: 'DECIDED', outcome: 'REJECTED' });
        expect(chatResult.reply.text).toBe(noPending);
        expect((await liveAnchor(f))?.status).toBe('WORKSPACE_APPLIED');
      } else {
        expect(record.status).toBe(ApprovalStatus.APPROVED);
        expect(uiResult).toEqual({ status: 'REFUSED', refusal: 'ALREADY_DECIDED' });
        expect((await liveAnchor(f))?.status).toBe('COMMIT_APPROVED');
      }
    }
    // Chat decided first (sequentially): the UI gets ALREADY_DECIDED.
    const f = await fixture();
    await f.runtime.handle(message('승인'));
    expect(await decideUi(f, 'reject')).toEqual({ status: 'REFUSED', refusal: 'ALREADY_DECIDED' });
    expect(f.decides).toBe(1);
  });

  it('a plan-scoped approval (its chat approve resumes work) can be rejected from the UI but must be approved in chat', async () => {
    const f = await fixture({ kind: 'plan' });
    const located = await f.service.locateForOpsUi(f.approvalId, OWNER, sessionsOf(f));
    expect(located).toMatchObject({ status: 'FOUND', view: { kind: 'PLAN', approvable: false } });
    expect(await decideUi(f, 'approve', 'ABCDEF')).toEqual({ status: 'REFUSED', refusal: 'APPROVE_IN_CHAT' });
    expect(f.decides).toBe(0);
    const chatTwin = await fixture({ kind: 'plan' });
    const chatTurn = await chatTwin.runtime.handle(message('거절'));
    const rejected = await decideUi(f, 'reject');
    expect(rejected).toMatchObject({ status: 'DECIDED', outcome: 'REJECTED', kind: 'PLAN' });
    if (rejected.status === 'DECIDED') expect(rejected.reply.text).toBe(chatTurn.reply.text);
    expect((await f.manager.get(f.approvalId))?.status).toBe(ApprovalStatus.REJECTED);
  });

  it('locate shows metadata only and refuses an unknown id', async () => {
    const f = await fixture();
    const located = await f.service.locateForOpsUi(f.approvalId, OWNER, sessionsOf(f));
    expect(located).toMatchObject({
      status: 'FOUND',
      view: { approvalId: f.approvalId, kind: 'COMMIT', riskLevel: RiskLevel.HIGH, approvable: true, chat: CTX },
    });
    expect(JSON.stringify(located)).not.toContain('commit src/a.ts'); // no reason / payload
    expect(await f.service.locateForOpsUi('nope', OWNER, sessionsOf(f))).toEqual({ status: 'REFUSED', refusal: 'NOT_FOUND' });
    expect(await f.service.decideFromOpsUi({ approvalId: 'nope', decision: 'reject', actor: OWNER, sessions: sessionsOf(f) })).toEqual({
      status: 'REFUSED',
      refusal: 'NOT_FOUND',
    });
  });
});

describe('the chat confirmation reference line (ADR-0113 D7)', () => {
  it('is absent while the UI is off: the reminder is byte-identical to the composer output', async () => {
    const f = await fixture();
    const turn = await f.runtime.handle(message('이게 뭐였지?'));
    const approval = (await f.manager.get(f.approvalId))!;
    expect(turn.reply.text).toBe(new ResponseComposer().composePendingApprovalReminder(CTX, approval, 30 * 60_000).text);
    expect(turn.reply.text).not.toContain(APPROVAL_REFERENCE_LINE_PREFIX);
  });

  it('rides the approval preview itself (here the apply approval), and that reference approves from the UI', async () => {
    const f = await fixture({ kind: 'eligible' });
    f.service.setConfirmationReferenceEnabled(true);
    const preview = await f.runtime.handle(message('적용해줘'));
    expect(preview.status).toBe('AWAITING_APPROVAL');
    const base = new ResponseComposer().composeApplyApprovalRequested(CTX, ['src/a.ts']).text;
    expect(preview.reply.text.startsWith(`${base}\n${APPROVAL_REFERENCE_LINE_PREFIX}`)).toBe(true);
    expect(f.history.at(-1)).toBe(base);
    const reference = preview.reply.text.slice(base.length + 1 + APPROVAL_REFERENCE_LINE_PREFIX.length).slice(0, 6);
    f.approvalId = (await f.store.approvals.list())[0]!.id;
    expect(await decideUi(f, 'approve', reference)).toMatchObject({ status: 'DECIDED', outcome: 'APPROVED', kind: 'APPLY' });
    expect((await liveAnchor(f))?.status).toBe('APPROVED');
  });

  it('is appended only while the UI is on, and the history keeps the reply without it', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    expect(reference).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(f.history.at(-1)).not.toContain(APPROVAL_REFERENCE_LINE_PREFIX);
    f.service.setConfirmationReferenceEnabled(false);
    const off = await f.runtime.handle(message('이게 뭐였지?'));
    expect(off.reply.text).not.toContain(APPROVAL_REFERENCE_LINE_PREFIX);
  });
});
