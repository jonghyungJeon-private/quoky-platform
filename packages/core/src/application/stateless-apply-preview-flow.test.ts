import { describe, expect, it } from 'vitest';
import { Capability, CodeGenerationStatus, IntentType, RiskLevel, SessionStatus, TaskStatus } from '../domain';
import type { ConversationContext, Session, Task } from '../domain';
import { StatelessApplyPreviewFlow } from './stateless-apply-preview-flow';
import type { ApplyPreviewAnchor, PendingScopeClarification } from './conversation-runtime';

const TS = '2026-07-02T00:00:00.000Z';
const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };

const sessionOf = (o: Partial<Session> = {}): Session => ({
  id: 'sess-1',
  actorId: 'actor-1',
  context: CTX,
  status: SessionStatus.ACTIVE,
  activeProjectId: 'proj-1',
  createdAt: TS,
  lastActivityAt: TS,
  ...o,
});

const anchorOf = (o: Partial<ApplyPreviewAnchor> = {}): ApplyPreviewAnchor => ({
  kind: 'code-preview-apply',
  status: 'ELIGIBLE',
  executionPlanRef: { id: 'plan-1', goal: 'g' },
  workspaceRef: { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' },
  targetFiles: ['packages/core/src/application/foo.ts'],
  codeGenerationRef: { id: 'gen-1', status: CodeGenerationStatus.SUCCEEDED },
  codeProposalRef: { id: 'prop-1' },
  instruction: '이 버그 고쳐줘',
  projectId: 'proj-1',
  createdAt: TS,
  ...o,
});

/** An unrelated Task that already carries a planId — the shape an approval anchor always has. */
const approvalAnchorTaskOf = (o: Partial<Task> = {}): Task => ({
  id: 'task-approval',
  title: 't',
  description: 'd',
  status: TaskStatus.WAITING_APPROVAL,
  intent: {
    type: IntentType.IMPLEMENT_CODE,
    capability: Capability.CODE_IMPLEMENTATION,
    confidence: 1,
    requiresWork: true,
    summary: 's',
  },
  riskLevel: RiskLevel.HIGH,
  context: CTX,
  planId: 'plan-1',
  createdAt: TS,
  updatedAt: TS,
  ...o,
});

/** A genuine scope-clarification anchor Task — different discriminator, same plan-less shape. */
const scopeClarificationTaskOf = (): Task => ({
  id: 'task-scope',
  title: 't',
  description: 'd',
  status: TaskStatus.PENDING,
  intent: {
    type: IntentType.IMPLEMENT_CODE,
    capability: Capability.CODE_IMPLEMENTATION,
    confidence: 1,
    requiresWork: true,
    summary: 's',
  },
  riskLevel: RiskLevel.HIGH,
  context: CTX,
  createdAt: TS,
  updatedAt: TS,
  metadata: {
    conversationScopeClarificationAnchor: {
      kind: 'code-scope-clarification',
      summary: 's',
      createdAt: TS,
    } satisfies PendingScopeClarification,
  },
});

/** In-memory fake store — a stand-in for `StorageProvider.sessions`/`tasks`. */
function makeStore() {
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const store = {
    sessions: {
      async save(s: Session) {
        sessions.set(s.id, s);
        return s;
      },
    },
    tasks: {
      async get(id: string) {
        return tasks.get(id) ?? null;
      },
      async save(t: Task) {
        tasks.set(t.id, t);
        return t;
      },
    },
  };
  return { store, sessions, tasks };
}

describe('StatelessApplyPreviewFlow (Sprint 2s, ADR-0040)', () => {
  it('anchor creates a Task with no planId', async () => {
    const { store, tasks } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const [task] = [...tasks.values()];
    expect(task!.planId).toBeUndefined();
  });

  it('anchor uses TaskStatus.PENDING for ELIGIBLE and WAITING_APPROVAL for AWAITING_APPROVAL', async () => {
    const { store, tasks } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf({ status: 'ELIGIBLE' }));
    expect([...tasks.values()][0]!.status).toBe(TaskStatus.PENDING);

    const { store: store2, tasks: tasks2 } = makeStore();
    const flow2 = new StatelessApplyPreviewFlow(store2);
    await flow2.anchor(sessionOf(), anchorOf({ status: 'AWAITING_APPROVAL', approvalId: 'appr-1' }));
    expect([...tasks2.values()][0]!.status).toBe(TaskStatus.WAITING_APPROVAL);
  });

  it('anchor stores the discriminator kind = code-preview-apply', async () => {
    const { store, tasks } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const [task] = [...tasks.values()];
    const stored = task!.metadata!.conversationApplyPreviewAnchor as ApplyPreviewAnchor;
    expect(stored.kind).toBe('code-preview-apply');
  });

  it('anchor sets session.activeTaskId to the anchor Task', async () => {
    const { store, sessions, tasks } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const [task] = [...tasks.values()];
    expect(sessions.get('sess-1')?.activeTaskId).toBe(task!.id);
  });

  it('findAnchor then anchor round-trips the full fact set', async () => {
    const { store, sessions } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const anchored = sessions.get('sess-1')!;
    expect(await flow.findAnchor(anchored)).toEqual(anchorOf());
  });

  it('re-anchoring (ELIGIBLE -> AWAITING_APPROVAL -> APPROVED) preserves every ref', async () => {
    const { store, sessions } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    let session = sessions.get('sess-1')!;
    await flow.anchor(session, { ...anchorOf(), status: 'AWAITING_APPROVAL', approvalId: 'appr-1' });
    session = sessions.get('sess-1')!;
    await flow.anchor(session, { ...anchorOf(), status: 'APPROVED', approvalId: 'appr-1', approvedAt: TS });
    session = sessions.get('sess-1')!;
    const found = await flow.findAnchor(session);
    expect(found?.status).toBe('APPROVED');
    expect(found?.approvalId).toBe('appr-1');
    expect(found?.approvedAt).toBe(TS);
    expect(found?.workspaceRef).toEqual(anchorOf().workspaceRef);
    expect(found?.targetFiles).toEqual(anchorOf().targetFiles);
    expect(found?.codeGenerationRef).toEqual(anchorOf().codeGenerationRef);
    expect(found?.codeProposalRef).toEqual(anchorOf().codeProposalRef);
  });

  it('findAnchor returns null when activeTaskId is absent', async () => {
    const { store } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    expect(await flow.findAnchor(sessionOf({ activeTaskId: undefined }))).toBeNull();
  });

  it('findAnchor returns null when the pointed-at Task has a planId (approval anchor, not ours)', async () => {
    const { store, tasks } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    tasks.set('task-approval', approvalAnchorTaskOf());
    const found = await flow.findAnchor(sessionOf({ activeTaskId: 'task-approval' }));
    expect(found).toBeNull();
  });

  it('findAnchor returns null for a scope-clarification anchor (wrong discriminator)', async () => {
    const { store, tasks } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    tasks.set('task-scope', scopeClarificationTaskOf());
    const found = await flow.findAnchor(sessionOf({ activeTaskId: 'task-scope' }));
    expect(found).toBeNull();
  });

  it('a projectId mismatch clears the anchor (since it is genuinely ours) and returns null', async () => {
    const { store, sessions } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf({ projectId: 'proj-1' }));
    const anchored = sessions.get('sess-1')!;
    const found = await flow.findAnchor({ ...anchored, activeProjectId: 'proj-2' });
    expect(found).toBeNull();
    expect(sessions.get('sess-1')?.activeTaskId).toBeUndefined(); // safely cleared
  });

  it('clear does not clear an approval anchor (Task with planId at the pointer)', async () => {
    const { store, tasks, sessions } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    tasks.set('task-approval', approvalAnchorTaskOf());
    const session = sessionOf({ activeTaskId: 'task-approval' });
    sessions.set('sess-1', session);
    await flow.clear(session);
    expect(sessions.get('sess-1')?.activeTaskId).toBe('task-approval'); // untouched
  });

  it('clear resets activeTaskId for a genuine apply-preview anchor', async () => {
    const { store, sessions } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const anchored = sessions.get('sess-1')!;
    await flow.clear(anchored);
    expect(sessions.get('sess-1')?.activeTaskId).toBeUndefined();
  });
});

describe('StatelessApplyPreviewFlow.clearIfCurrent (QA-V2-CL-03, Codex P2 #4)', () => {
  function liveStore() {
    const { store, sessions, tasks } = makeStore();
    return { store: { ...store, sessions: { ...store.sessions, async get(id: string) { return sessions.get(id) ?? null; } } }, sessions, tasks };
  }

  it('clears only while the LIVE anchor is the same generation in the same status', async () => {
    const { store, sessions } = liveStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const stale = sessions.get('sess-1')!;
    expect(await flow.clearIfCurrent(stale, { status: 'ELIGIBLE', codeGenerationId: 'gen-other' })).toBe(false);
    expect(await flow.clearIfCurrent(stale, { status: 'APPROVED', codeGenerationId: 'gen-1' })).toBe(false);
    expect(sessions.get('sess-1')!.activeTaskId).toBe(stale.activeTaskId);
    expect(await flow.clearIfCurrent(stale, { status: 'ELIGIBLE', codeGenerationId: 'gen-1' })).toBe(true);
    expect(sessions.get('sess-1')!.activeTaskId).toBeUndefined();
  });

  it('a stale ELIGIBLE copy never clears an anchor advanced to APPROVED meanwhile', async () => {
    const { store, sessions } = liveStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    const stale = sessions.get('sess-1')!;
    await flow.anchor(sessions.get('sess-1')!, anchorOf({ status: 'AWAITING_APPROVAL', approvalId: 'a-1' }));
    await flow.anchor(sessions.get('sess-1')!, anchorOf({ status: 'APPROVED', approvalId: 'a-1', approvedAt: TS }));
    const approvedTask = sessions.get('sess-1')!.activeTaskId;
    expect(await flow.clearIfCurrent(stale, { status: 'ELIGIBLE', codeGenerationId: 'gen-1' })).toBe(false);
    expect(sessions.get('sess-1')!.activeTaskId).toBe(approvedTask);
    expect((await flow.findAnchor(sessions.get('sess-1')!))?.status).toBe('APPROVED');
  });

  it('fails closed (clears nothing) when the store cannot re-read the session', async () => {
    const { store, sessions } = makeStore();
    const flow = new StatelessApplyPreviewFlow(store);
    await flow.anchor(sessionOf(), anchorOf());
    expect(await flow.clearIfCurrent(sessions.get('sess-1')!, { status: 'ELIGIBLE', codeGenerationId: 'gen-1' })).toBe(false);
    expect(sessions.get('sess-1')!.activeTaskId).toBeDefined();
  });
});
