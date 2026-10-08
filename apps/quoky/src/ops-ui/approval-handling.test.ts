import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_REFERENCE_LINE_PREFIX,
  ApprovalManager,
  ApprovalStatus,
  CodeGenerationStatus,
  ConversationRuntime,
  ResponseComposer,
  RiskLevel,
  SessionStatus,
  StatelessApplyPreviewFlow,
  StatelessApprovalFlow,
  StatelessScopeClarificationFlow,
  WorkspaceChangeStatus,
} from '@quoky/core';
import type {
  Actor,
  ApplyPreviewAnchor,
  ApprovalPolicy,
  ApprovalRequest,
  ConversationContext,
  ConversationRuntimeDeps,
  Id,
  InboundMessage,
  Logger,
  NotificationSinkOutcome,
  OwnerNotification,
  Session,
  Task,
} from '@quoky/core';

import { renderDiscordContent, renderNotificationForDiscord } from '@quoky/adapter-discord';
import { cookieFrom, send } from './test-support/http-client';
import type { TestResponse } from './test-support/http-client';
import { OpsUiActions, opsDecisionResultText } from './actions/ops-actions';
import { OpsUiServer } from './http/server';
import type { OpsViewModel } from './http/view-model';

/**
 * OPS-2b (ADR-0113 D7) end to end, offline: the real `ConversationRuntime` and its shared `ApprovalDecisionService`, the
 * OPS actions and the loopback listener. Approve/reject are CSRF-protected same-origin POSTs inside a session, a double
 * submit decides once and sends exactly one `OPS_DECISION_RESULT` to the owner DM, the page never shows the reply text,
 * the payload or the reference, and approving records only (no execution).
 */

const TS = '2026-10-07T00:00:00.000Z';
const OWNER_ID = 'actor-owner';
const OWNER: Actor = { id: OWNER_ID } as Actor;
const CTX: ConversationContext = { platform: 'discord', spaceId: '123456789012345678', channelId: '223456789012345678', userId: '323456789012345678' };
const SESSION_ID = 'sess-1';
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const VIEW: OpsViewModel = { generatedAt: TS, panels: [] };
// Built by concatenation so no token-shaped literal sits in the source.
const SECRET_LIKE = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

interface Fixture {
  runtime: ConversationRuntime;
  manager: ApprovalManager;
  approvalId: Id;
  sessions: Map<Id, Session>;
  tasks: Map<Id, Task>;
  history: string[];
  notices: OwnerNotification[];
  actions: OpsUiActions;
  /** Every git call the runtime attempted (none may happen on a decision). */
  executions: string[];
}

async function fixture(options: { sessionActor?: Id; notice?: NotificationSinkOutcome } = {}): Promise<Fixture> {
  const sessions = new Map<Id, Session>();
  const tasks = new Map<Id, Task>();
  const approvals = new Map<Id, ApprovalRequest>();
  const store = {
    sessions: {
      async get(id: Id) { return sessions.get(id) ?? null; },
      async save(session: Session) { sessions.set(session.id, session); return session; },
    },
    tasks: {
      async get(id: Id) { return tasks.get(id) ?? null; },
      async save(task: Task) { tasks.set(task.id, task); return task; },
    },
    approvals: {
      async get(id: Id) { return approvals.get(id) ?? null; },
      async save(request: ApprovalRequest) { approvals.set(request.id, request); return request; },
      async findByExecutionPlan(planId: Id) { return [...approvals.values()].filter((a) => a.executionPlanRef.id === planId); },
    },
  };
  const manager = new ApprovalManager(store as never, {} as ApprovalPolicy);
  const applyPreviewFlow = new StatelessApplyPreviewFlow(store);
  const session: Session = {
    id: SESSION_ID,
    actorId: options.sessionActor ?? OWNER_ID,
    context: CTX,
    status: SessionStatus.ACTIVE,
    activeProjectId: 'proj-1',
    createdAt: TS,
    lastActivityAt: TS,
  };
  await store.sessions.save(session);
  const approval = await manager.requestForRisk({
    executionPlanRef: { id: 'plan-1', goal: 'g' },
    riskLevel: RiskLevel.CRITICAL,
    reason: `push abc to origin/feature ${SECRET_LIKE}`,
    requestedBy: OWNER_ID,
  });
  const anchor: ApplyPreviewAnchor = {
    kind: 'code-preview-apply',
    status: 'PUSH_APPROVAL_PENDING',
    executionPlanRef: { id: 'plan-1', goal: 'g' },
    workspaceRef: { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' },
    targetFiles: ['src/a.ts'],
    codeGenerationRef: { id: 'gen-1', status: CodeGenerationStatus.SUCCEEDED },
    codeProposalRef: { id: 'prop-1' },
    instruction: 'BODY_MARKER fix it',
    projectId: 'proj-1',
    createdAt: TS,
    workspaceChangeRef: { id: 'chg-1', status: WorkspaceChangeStatus.APPLIED },
    commitHash: 'a'.repeat(40),
    pushApprovalId: approval.id,
    pushCommitHash: 'a'.repeat(40),
    pushRemote: 'origin',
    pushBranch: 'feature',
    pushUpstreamRef: 'origin/feature',
  };
  await applyPreviewFlow.anchor(session, anchor);
  const history: string[] = [];
  const executions: string[] = [];
  const deps = {
    actors: { async resolveFromContext() { return OWNER; } },
    sessions: {
      async openForContext() { return sessions.get(SESSION_ID)!; },
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
    git: new Proxy({}, { get: (_t, name) => () => { executions.push(String(name)); throw new Error('no git in this test'); } }),
    logger: silent,
  } as unknown as ConversationRuntimeDeps;
  const runtime = new ConversationRuntime(deps);
  const notices: OwnerNotification[] = [];
  const actions = new OpsUiActions({
    owner: async () => ({ status: 'RESOLVED', actorId: OWNER_ID }),
    clock: () => new Date().toISOString(),
    timeZone: 'Asia/Seoul',
    approvals: {
      decisions: runtime.approvalDecisions,
      actor: async (id) => (id === OWNER_ID ? OWNER : null),
      sessions: async () => [...sessions.values()],
      notify: async (notification) => {
        notices.push(notification);
        return options.notice ?? { status: 'SENT', via: 'dm' };
      },
    },
    logger: silent,
  });
  return { runtime, manager, approvalId: approval.id, sessions, tasks, history, notices, actions, executions };
}

let dir: string;
const servers: OpsUiServer[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TS));
  dir = mkdtempSync(path.join(tmpdir(), 'ops-ui-approvals-'));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

interface Harness {
  readonly port: number;
  readonly token: string;
  readonly events: string[];
}

async function serve(f: Fixture): Promise<Harness> {
  const tokenFile = path.join(dir, `ops-ui-${servers.length}.token`);
  const events: string[] = [];
  const server = new OpsUiServer({
    host: '127.0.0.1',
    port: 0,
    tokenFilePath: tokenFile,
    view: async () => VIEW,
    log: {
      info: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
      warn: (event, fields) => events.push(`${event} ${JSON.stringify(fields ?? {})}`),
    },
    actions: f.actions,
  });
  const started = await server.start();
  if (started.status !== 'LISTENING') throw new Error('not listening');
  servers.push(server);
  return { port: started.port, token: readFileSync(tokenFile, 'utf8').trim(), events };
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

async function signIn(h: Harness): Promise<string> {
  const res = await send({ port: h.port, method: 'POST', path: '/session', origin: origin(h.port), form: { token: h.token } });
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('no cookie');
  return cookie;
}

function formField(page: string, action: string, name: string): string {
  const form = page.split('<form').find((chunk) => chunk.includes(`action="${action}"`));
  const match = form ? new RegExp(`name="${name}" value="([^"]+)"`).exec(form) : null;
  if (!match?.[1]) throw new Error(`no ${name} in ${action}`);
  return match[1];
}

function post(h: Harness, p: string, form: Record<string, string>, cookie?: string, from = origin(h.port)): Promise<TestResponse> {
  return send({ port: h.port, method: 'POST', path: p, origin: from, form, ...(cookie ? { cookie } : {}) });
}

const message = (text: string): InboundMessage => ({ id: 'm1', context: CTX, text, receivedAt: TS });

/** The reference the chat preview line shows while the UI is on (read from the pending reminder). */
async function chatReference(f: Fixture): Promise<string> {
  f.runtime.approvalDecisions.setConfirmationReferenceEnabled(true);
  const turn = await f.runtime.handle(message('이게 뭐였지?'));
  const line = turn.reply.text.split('\n').find((l) => l.startsWith(APPROVAL_REFERENCE_LINE_PREFIX));
  if (!line) throw new Error('no reference line');
  return line.slice(APPROVAL_REFERENCE_LINE_PREFIX.length, APPROVAL_REFERENCE_LINE_PREFIX.length + 6);
}

async function confirmPage(h: Harness, f: Fixture, cookie: string): Promise<TestResponse> {
  return send({ port: h.port, path: `/approvals/decide?id=${f.approvalId}`, cookie });
}

describe('OPS-2b approve/reject over the listener (ADR-0113 D7)', () => {
  it('shows metadata only (no payload, reason, reply or reference) and links back to the chat conversation', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    const h = await serve(f);
    const cookie = await signIn(h);
    const page = await confirmPage(h, f, cookie);
    expect(page.status).toBe(200);
    expect(page.body).toContain('푸시');
    expect(page.body).toContain('CRITICAL');
    expect(page.body).toContain(`href="https://discord.com/channels/${CTX.spaceId}/${CTX.channelId}"`);
    expect(page.body).toContain('rel="noopener noreferrer"');
    expect(page.body).toContain('action="/actions/approvals/approve"');
    expect(page.body).toContain('action="/actions/approvals/reject"');
    for (const hidden of [reference, SECRET_LIKE, 'BODY_MARKER', 'origin/feature', 'push abc']) expect(page.body).not.toContain(hidden);
  });

  it('approve needs the session, the listener Origin and the CSRF token; then it decides once and notifies once', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    const h = await serve(f);
    const cookie = await signIn(h);
    const page = (await confirmPage(h, f, cookie)).body;
    const csrf = formField(page, '/actions/approvals/approve', 'csrf');
    const nonce = formField(page, '/actions/approvals/approve', 'nonce');

    expect((await post(h, '/actions/approvals/approve', { csrf, nonce, reference })).status).toBe(403); // no session
    expect((await post(h, '/actions/approvals/approve', { nonce, reference }, cookie)).status).toBe(403); // no CSRF
    expect((await post(h, '/actions/approvals/approve', { csrf: 'x'.repeat(43), nonce, reference }, cookie)).status).toBe(403);
    expect((await post(h, '/actions/approvals/approve', { csrf, nonce, reference }, cookie, 'http://evil.example')).status).toBe(403);
    expect((await f.manager.get(f.approvalId))?.status).toBe(ApprovalStatus.PENDING);
    expect(f.notices).toHaveLength(0);

    // Double submit (concurrent and repeated): one decision, one notice.
    const [first, second] = await Promise.all([
      post(h, '/actions/approvals/approve', { csrf, nonce, reference }, cookie),
      post(h, '/actions/approvals/approve', { csrf, nonce, reference }, cookie),
    ]);
    const third = await post(h, '/actions/approvals/approve', { csrf, nonce, reference }, cookie);
    for (const res of [first, second, third]) {
      expect(res.status).toBe(200);
      expect(res.body).toContain('APPROVED');
    }
    expect([first, second, third].filter((res) => res.body.includes('다시 실행하지 않았어요'))).toHaveLength(2);
    expect((await f.manager.get(f.approvalId))?.status).toBe(ApprovalStatus.APPROVED);
    expect(f.notices).toHaveLength(1);
    const notice = f.notices[0]!;
    expect(notice.kind).toBe('OPS_DECISION_RESULT');
    expect(notice.target).toEqual({ platform: 'discord', channelId: '', userId: CTX.userId }); // owner DM only
    expect(notice.text.startsWith('[Quoky 운영 화면] 푸시 승인 요청을 운영 화면에서 승인했어요.')).toBe(true);
    expect([...notice.text].length).toBeLessThanOrEqual(1800);
    // The page shows the category only, never the reply text.
    const replyText = new ResponseComposer().composePushApprovalRecorded(CTX).text;
    expect(notice.text).toContain(replyText);
    expect(first.body).not.toContain(replyText);
    // Approving recorded only: the chain is PUSH_APPROVED and no git call ran; a later chat "승인" decides nothing.
    const anchor = await new StatelessApplyPreviewFlow({
      sessions: { async save(s: Session) { return s; } },
      tasks: { get: async (id: Id) => f.tasks.get(id) ?? null, save: async (t: Task) => t },
    }).findAnchor(f.sessions.get(SESSION_ID)!);
    expect(anchor?.status).toBe('PUSH_APPROVED');
    expect(f.executions).toEqual([]);
    const audit = h.events.filter((e) => e.startsWith('ops-ui.action '));
    expect(audit.join('\n')).not.toMatch(new RegExp(`${reference}|BODY_MARKER`));
  });

  it('a wrong reference decides nothing and sends nothing; the retry link goes back to the confirmation page', async () => {
    const f = await fixture();
    const reference = await chatReference(f);
    const h = await serve(f);
    const cookie = await signIn(h);
    const page = (await confirmPage(h, f, cookie)).body;
    const wrong = reference === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    const res = await post(
      h,
      '/actions/approvals/approve',
      { csrf: formField(page, '/actions/approvals/approve', 'csrf'), nonce: formField(page, '/actions/approvals/approve', 'nonce'), reference: wrong },
      cookie,
    );
    expect(res.body).toContain('REFERENCE_MISMATCH');
    expect(res.body).toContain(`href="/approvals/decide?id=${f.approvalId}"`);
    expect((await f.manager.get(f.approvalId))?.status).toBe(ApprovalStatus.PENDING);
    expect(f.notices).toHaveLength(0);
  });

  it('reject is a single explicit confirm and matches the chat reject; one notice', async () => {
    const f = await fixture();
    const chatTwin = await fixture();
    const chatTurn = await chatTwin.runtime.handle(message('거절'));
    const h = await serve(f);
    const cookie = await signIn(h);
    const page = (await confirmPage(h, f, cookie)).body;
    const res = await post(
      h,
      '/actions/approvals/reject',
      { csrf: formField(page, '/actions/approvals/reject', 'csrf'), nonce: formField(page, '/actions/approvals/reject', 'nonce') },
      cookie,
    );
    expect(res.body).toContain('REJECTED');
    expect((await f.manager.get(f.approvalId))).toMatchObject({ status: ApprovalStatus.REJECTED, comment: 'ops-ui' });
    expect(f.history).toEqual(chatTwin.history);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]!.text).toContain(chatTurn.reply.text);
  });

  it('refuses a foreign approval without deciding or notifying', async () => {
    const f = await fixture({ sessionActor: 'actor-stranger' });
    const h = await serve(f);
    const cookie = await signIn(h);
    const page = await confirmPage(h, f, cookie);
    expect(page.body).toContain('FOREIGN');
    expect(page.body).not.toContain('name="nonce"');
    expect(await f.actions.decideApproval(f.approvalId, 'reject', '')).toMatchObject({ code: 'FOREIGN', ok: false });
    expect(f.notices).toHaveLength(0);
  });

  it('reports an uncertain DM delivery without resending', async () => {
    const f = await fixture({ notice: { status: 'UNCERTAIN', reason: 'TIMEOUT' } });
    const outcome = await f.actions.decideApproval(f.approvalId, 'reject', '');
    expect(outcome).toMatchObject({ code: 'REJECTED', ok: true });
    expect(outcome.message).toContain('다시 보내지 않아요');
    expect(f.notices).toHaveLength(1);
    expect(await f.actions.decideApproval(f.approvalId, 'reject', '')).toMatchObject({ code: 'ALREADY_DECIDED' });
    expect(f.notices).toHaveLength(1);
  });

  it('refuses an approval id of the wrong shape before any lookup', async () => {
    const f = await fixture();
    const h = await serve(f);
    const cookie = await signIn(h);
    expect((await send({ port: h.port, path: '/approvals/decide?id=../../x', cookie })).status).toBe(400);
    expect((await send({ port: h.port, path: `/approvals/decide?id=${f.approvalId}` })).status).toBe(303); // no session
  });
});

describe('OPS_DECISION_RESULT text (ADR-0113 D7)', () => {
  it('is bounded by the delivered-text limit and drops a credential-shaped reply', () => {
    expect([...opsDecisionResultText('COMMIT', 'APPROVED', 'x'.repeat(5000))].length).toBe(1800);
    const guarded = opsDecisionResultText('COMMIT', 'REJECTED', `reply ${SECRET_LIKE}`);
    expect(guarded).not.toContain(SECRET_LIKE);
    expect(guarded.startsWith('[Quoky 운영 화면] 커밋 승인 요청을 운영 화면에서 거절했어요.')).toBe(true);
  });

  // Live QA 2026-10-07: execution is bound to the approving conversation, so the DM says what, where and how long.
  const APPROVED_REPLY = [
    'Slack 게시 승인을 기록했어요. 아직 실행하지 않았어요.',
    '실제로 실행하려면 "Slack 게시 실행"이라고 보내 주세요. 승인 후 30분이 지나면 다시 요청해야 해요.',
  ].join('\n');
  const POST = {
    operation: 'CHANNEL_POST',
    target: { kind: 'channel', channelLabel: 'quoky-test', channelId: 'C0TEST' },
    executionPhrase: 'Slack 게시 실행',
    remainingMs: 30 * 60_000,
  } as const;

  it('an approved connector write names the target, the guild channel, the exact phrase and the lifetime', () => {
    // PLT-0: the notice is neutral content; this is its exact Discord text (the conversation as `<#id>`).
    expect(renderDiscordContent(opsDecisionResultText('CONNECTOR_WRITE', 'APPROVED', APPROVED_REPLY, { ...POST, chat: CTX }))).toBe(
      [
        '[Quoky 운영 화면] 운영 화면에서 승인했어요: Slack 게시 → #quoky-test.',
        `실제 게시는 <#${CTX.channelId}>에서 "Slack 게시 실행"이라고 보내면 돼요 (승인은 약 30분 유효). 이 DM에서는 실행되지 않아요.`,
      ].join('\n'),
    );
  });

  it('an approved connector write asked in the owner DM says "이 DM"; a thread is named by the thread', () => {
    const dm: ConversationContext = { platform: 'discord', channelId: '423456789012345678', userId: CTX.userId };
    expect(renderDiscordContent(opsDecisionResultText('CONNECTOR_WRITE', 'APPROVED', APPROVED_REPLY, { ...POST, chat: dm }))).toBe(
      [
        '[Quoky 운영 화면] 운영 화면에서 승인했어요: Slack 게시 → #quoky-test.',
        '실제 게시는 이 DM에서 "Slack 게시 실행"이라고 보내면 돼요 (승인은 약 30분 유효).',
      ].join('\n'),
    );
    const thread: ConversationContext = { ...CTX, threadId: '523456789012345678' };
    const comment = { operation: 'ISSUE_COMMENT', target: { kind: 'issue', issueKey: 'PROJ-12' }, executionPhrase: '댓글 실행', remainingMs: 30 * 60_000 } as const;
    expect(renderDiscordContent(opsDecisionResultText('CONNECTOR_WRITE', 'APPROVED', 'x', { ...comment, chat: thread }))).toContain(
      '운영 화면에서 승인했어요: Jira 댓글 → PROJ-12.\n실제 댓글은 <#523456789012345678>에서 "댓글 실행"이라고 보내면 돼요',
    );
  });

  it('the decision DM of an approved connector write is the notice built from the shared decision', async () => {
    const notices: OwnerNotification[] = [];
    const actions = new OpsUiActions({
      owner: async () => ({ status: 'RESOLVED', actorId: OWNER_ID }),
      clock: () => TS,
      timeZone: 'Asia/Seoul',
      approvals: {
        decisions: {
          locateForOpsUi: async () => ({ status: 'REFUSED', refusal: 'NOT_FOUND' }),
          decideFromOpsUi: async () => ({
            status: 'DECIDED',
            outcome: 'APPROVED',
            kind: 'CONNECTOR_WRITE',
            reply: { context: CTX, text: APPROVED_REPLY },
            chat: CTX,
            connectorWrite: POST,
          }),
        },
        actor: async () => OWNER,
        sessions: async () => [],
        notify: async (notification) => {
          notices.push(notification);
          return { status: 'SENT' };
        },
      },
      logger: silent,
    });
    const outcome = await actions.decideApproval('a'.repeat(32), 'approve', 'ABC123');
    expect(outcome.code).toBe('APPROVED');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('OPS_DECISION_RESULT');
    expect(notices[0]?.text).toContain(`실제 게시는 #${CTX.channelId}에서 "Slack 게시 실행"이라고 보내면 돼요`);
    expect(renderNotificationForDiscord(notices[0] as OwnerNotification)).toContain(`실제 게시는 <#${CTX.channelId}>에서 "Slack 게시 실행"이라고 보내면 돼요`);
  });

  it('a rejection, an expiry or another gate kind keeps the header and the chat reply (no notice)', () => {
    const next = { ...POST, chat: CTX };
    expect(opsDecisionResultText('CONNECTOR_WRITE', 'REJECTED', '요청을 거절했어요.', next)).toBe(
      '[Quoky 운영 화면] 커넥터 쓰기 승인 요청을 운영 화면에서 거절했어요. 이어지는 단계는 채팅에서 해요.\n요청을 거절했어요.',
    );
    expect(opsDecisionResultText('CONNECTOR_WRITE', 'EXPIRED', '만료됐어요.', next)).not.toContain('실제 게시는');
    expect(opsDecisionResultText('PUSH', 'APPROVED', 'x')).not.toContain('실제');
  });
});
