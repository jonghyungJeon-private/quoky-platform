import { describe, expect, it } from 'vitest';
import { ApprovalStatus, SessionStatus } from '../../domain';
import type { Actor, ApprovalRequest, Session, Task } from '../../domain';
import { connectorWriteSent, type ConnectorWriteOutcome, type IssueCommentWriter } from '../../ports/connector-write.port';
import type { ConnectorWriteMatch, ConnectorWritePrepareResult, ConnectorWriteReceipt, ConnectorWriteReceiptRepository } from '../../ports/connector-write-receipt.port';
import {
  AGENT_WRITE_PROPOSAL_KEY_BODY,
  agentProposalProvenanceLine,
  destinationShapedKeys,
  type AgentWriteProposalBanner,
  type AgentWriteProposalRequest,
} from '../../ports/agent-write-proposal.port';
import { NL_REF_JIRA_KEY } from '../nl-routing/action-entries';
import { plainTextOf } from '../message-rendering';
import { AgentWriteProposalService } from './agent-write-proposal';
import { AGENT_PROPOSAL_MARKER, AGENT_PROPOSAL_CARD_MAX_CHARS, renderAgentProposalCard } from './connector-write-copy';
import { StatelessConnectorWriteFlow, isActionSwitchGoverned } from './connector-write-flow';
import { connectorWritePayloadSha256 } from './connector-write-payload';

// ADR-0121 A7-S4a: the proposal port's implementation over the REAL ADR-0112 flow. Storage, approvals, receipts and the comment writer
// are in-memory fakes.

const T0 = '2026-11-25T01:00:00.000Z';
const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
const KEY = 'BE-123';
const BANNER: AgentWriteProposalBanner = {
  source: { entryId: 'slack.search', query: '릴리즈' },
  items: [{ id: 'C0AA.111', date: '2026-11-20' }, { id: 'C0AA.222' }],
  dropped: 1,
  omitted: 0,
  drafter: { locality: 'LOCAL' },
};

class MemoryReceipts implements ConnectorWriteReceiptRepository {
  readonly rows = new Map<string, ConnectorWriteReceipt>();
  async prepare(receipt: ConnectorWriteReceipt): Promise<ConnectorWritePrepareResult> {
    const existing = [...this.rows.values()].find((row) => row.idempotencyKey === receipt.idempotencyKey);
    if (existing) return { created: false, receipt: existing };
    this.rows.set(receipt.id, { ...receipt });
    return { created: true, receipt };
  }
  async complete(id: string, outcome: ConnectorWriteOutcome, now: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'PREPARED') return null;
    const next = { ...row, status: outcome.status, updatedAt: now, data: outcome.status === 'SENT' ? { externalRef: outcome.externalRef } : { reason: outcome.reason } } as ConnectorWriteReceipt;
    this.rows.set(id, next);
    return next;
  }
  async findByIdempotencyKey(key: string): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].find((row) => row.idempotencyKey === key) ?? null;
  }
  async findById(id: string, actorId: string): Promise<ConnectorWriteReceipt | null> {
    const row = this.rows.get(id);
    return row !== undefined && row.actorId === actorId ? row : null;
  }
  async findLatestSent(match: ConnectorWriteMatch): Promise<ConnectorWriteReceipt | null> {
    return [...this.rows.values()].filter((row) => row.status === 'SENT' && row.actorId === match.actorId && row.operation === match.operation && row.target === match.target && row.payloadSha256 === match.payloadSha256).pop() ?? null;
  }
  async findSentUndoOf(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async findLatestUnresolved(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async findLatestForOperation(): Promise<ConnectorWriteReceipt | null> {
    return null;
  }
  async markInterruptedPreparedUncertain(): Promise<number> {
    return 0;
  }
}

function harness(options: { readonly noWriter?: boolean } = {}) {
  const sessions = new Map<string, Session>();
  const tasks = new Map<string, Task>();
  const approvals = new Map<string, ApprovalRequest>();
  const receipts = new MemoryReceipts();
  const context = { platform: 'test', channelId: 'chan-1', userId: 'owner-user' };
  for (const id of ['sess-1', 'sess-2']) sessions.set(id, { id, actorId: OWNER.id, context, status: SessionStatus.ACTIVE, createdAt: T0, lastActivityAt: T0 });
  const sent: Array<{ issueKey: string; text: string }> = [];
  const comments: IssueCommentWriter = {
    source: 'jira',
    allowsIssue: (key) => /^BE-\d+$/.test(key),
    async addComment(request) {
      sent.push({ issueKey: request.issueKey, text: request.text });
      return connectorWriteSent('c-1');
    },
  };
  const store = {
    sessions: {
      get: async (id: string) => sessions.get(id) ?? null,
      save: async (session: Session) => {
        sessions.set(session.id, { ...session });
        return session;
      },
      list: async () => [...sessions.values()],
    },
    tasks: {
      get: async (id: string) => tasks.get(id) ?? null,
      save: async (task: Task) => {
        tasks.set(task.id, structuredClone(task));
        return task;
      },
      listByContext: async () => [...tasks.values()],
    },
  };
  let seq = 0;
  const flow = new StatelessConnectorWriteFlow({
    writers: options.noWriter === true ? {} : { issueComments: comments },
    receipts,
    approvals: {
      async requestForRisk(input) {
        const approval: ApprovalRequest = { id: `appr-${++seq}`, executionPlanRef: input.executionPlanRef, status: ApprovalStatus.PENDING, riskLevel: input.riskLevel, reason: input.reason, requestedBy: input.requestedBy, createdAt: T0 };
        approvals.set(approval.id, approval);
        return approval;
      },
      get: async (id) => approvals.get(id) ?? null,
      async decide(id, decision) {
        const approval = { ...(approvals.get(id) as ApprovalRequest), status: decision.approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED };
        approvals.set(id, approval);
        return approval;
      },
    },
    store,
    timeZone: 'Asia/Seoul',
    newId: () => `id-${++seq}`,
  });
  const service = new AgentWriteProposalService({ flow, sessions: store.sessions, actors: { get: async (id) => (id === OWNER.id ? OWNER : null) } });
  const request = (over: Partial<AgentWriteProposalRequest> = {}): AgentWriteProposalRequest => {
    const payloadText = over.payloadText ?? [agentProposalProvenanceLine('slack.search', 2), '릴리즈 일정이 하루 밀렸어요.', '담당은 홍길동이에요.'].join('\n');
    return {
      operation: 'jira-comment',
      target: { issueKey: KEY },
      payloadText,
      actorId: OWNER.id,
      sessionId: 'sess-1',
      grounding: 'owner-text',
      banner: BANNER,
      named: 1,
      nonTargets: destinationShapedKeys(payloadText, KEY),
      now: T0,
      ...over,
    };
  };
  const session = (id = 'sess-1'): Session => sessions.get(id) as Session;
  return { flow, service, request, sent, session, approvals, receipts };
}

const textOf = (card: Parameters<typeof plainTextOf>[0]): string => plainTextOf(card);

describe('the A7 card (A7.5 step 7), over the real ADR-0112 flow', () => {
  it('cards a Jira comment: a normal CRITICAL anchor bound to actor, session, target, operation and the payload hash; nothing is sent', async () => {
    const h = harness();
    const request = h.request();
    const result = await h.service.propose(request);
    expect(result.kind).toBe('carded');
    if (result.kind !== 'carded') return;
    const view = await h.flow.find(h.session());
    expect(view?.anchor).toMatchObject({ status: 'APPROVAL_PENDING', actorId: OWNER.id, sessionId: 'sess-1', operation: 'ISSUE_COMMENT', target: KEY, agentProposal: true, payload: { operation: 'ISSUE_COMMENT', issueKey: KEY, text: request.payloadText } });
    expect(view?.anchor.approvalId).toBe(result.cardId);
    expect(h.approvals.get(result.cardId)?.riskLevel).toBe('CRITICAL');
    expect(result.payloadSha256).toBe(view?.anchor.payloadSha256);
    expect(result.payloadSha256).toBe(connectorWritePayloadSha256('ISSUE_COMMENT', KEY, { issueKey: KEY, text: request.payloadText }));
    expect(h.sent).toHaveLength(0);
    // The kill switch governs the card (A7.10).
    expect(isActionSwitchGoverned(view?.anchor as NonNullable<typeof view>['anchor'])).toBe(true);
  });

  it('shows the operation, the destination source, the marker, the FULL payload in a quoted block, the banner, the named line and the unchanged execution phrase', async () => {
    const h = harness();
    const request = h.request();
    const result = await h.service.propose(request);
    if (result.kind !== 'carded') throw new Error('no card');
    const card = textOf(result.card);
    expect(card).toContain('Jira 댓글 제안 카드예요');
    expect(card).toContain(`대상: Jira ${KEY} (대상은 보내신 문장에서 가져왔어요)`);
    expect(card).toContain(AGENT_PROPOSAL_MARKER);
    expect(AGENT_PROPOSAL_MARKER).toBe('모델 작성 초안 — 아래 글자 그대로 올라갑니다');
    // The payload, byte for byte, between the marker and the banner, in one fenced block.
    const fence = card.indexOf('```');
    expect(fence).toBeGreaterThan(card.indexOf(AGENT_PROPOSAL_MARKER));
    expect(card.slice(fence)).toContain(`\`\`\`\n${request.payloadText}\n\`\`\``);
    expect(card).toContain('출처: Slack 메시지 검색');
    expect(card).toContain('검색어 ');
    expect(card).toContain('릴리즈');
    expect(card).toContain('1) 2026-11-20 C0AA.111');
    expect(card).toContain('2) C0AA.222');
    expect(card).not.toContain('날짜 없음');
    expect(card).not.toContain('초안에 넣지 않았어요');
    expect(card).toContain('1건은 그 사이 바뀌어 뺐어요');
    expect(card).toContain('초안 작성: 이 컴퓨터의 모델');
    expect(card).toContain('초안에 실제 이름 1명이 들어 있어요');
    expect(card).toContain('"승인"이라고 답한 뒤 "댓글 실행"이라고 보내야 실제로 실행돼요');
    expect(card).not.toContain('초안 안의');
  });

  it('names the remote operator, and a draft without names says so', async () => {
    const h = harness();
    const result = await h.service.propose(h.request({ banner: { ...BANNER, dropped: 0, drafter: { locality: 'REMOTE', operator: 'Acme AI' } }, named: 0 }));
    if (result.kind !== 'carded') throw new Error('no card');
    const card = textOf(result.card);
    expect(card).toContain('초안 작성: Acme AI');
    expect(card).toContain('초안에 사람 이름은 들어 있지 않아요');
    expect(card).not.toContain('그 사이 바뀌어');
  });

  it('says for every destination-shaped token in the draft that is not the destination: it is not a target and nothing goes there', async () => {
    const h = harness();
    const payloadText = ['[Quoky 요약] 출처: Slack 메시지 2건', 'be-999 와 BE-123, 그리고 PROJ-7 도 언급됐어요.'].join('\n');
    const result = await h.service.propose(h.request({ payloadText }));
    if (result.kind !== 'carded') throw new Error('no card');
    const card = textOf(result.card);
    expect(card).toContain('초안 안의 BE-999 표기는 대상이 아니에요. BE-999에는 아무것도 보내지 않아요');
    expect(card).toContain('초안 안의 PROJ-7 표기는 대상이 아니에요. PROJ-7에는 아무것도 보내지 않아요');
    expect(card).not.toContain('초안 안의 BE-123');
    // The destination is the owner's literal; the token in the text changed nothing.
    expect((await h.flow.find(h.session()))?.anchor.target).toBe(KEY);
  });

  it('approves in two steps and sends exactly the bytes the card showed, once', async () => {
    const h = harness();
    const request = h.request();
    const carded = await h.service.propose(request);
    if (carded.kind !== 'carded') throw new Error('no card');
    const pending = await h.flow.find(h.session());
    if (!pending?.approval) throw new Error('no pending approval');
    h.approvals.set(pending.approval.id, { ...pending.approval, status: ApprovalStatus.APPROVED });
    await h.flow.recordApproval({ session: h.session(), actor: OWNER, now: T0, view: pending });
    const view = await h.flow.find(h.session());
    const done = await h.flow.execute({ session: h.session(), actor: OWNER, now: T0, view: view as NonNullable<typeof view> });
    expect(done).toMatchObject({ kind: 'outcome', outcome: { status: 'SENT' } });
    expect(h.sent).toEqual([{ issueKey: KEY, text: request.payloadText }]);
    const again = await h.flow.find(h.session());
    expect(await h.flow.execute({ session: h.session(), actor: OWNER, now: T0, view: again as NonNullable<typeof again> })).toMatchObject({ kind: 'repeat', status: 'SENT' });
    expect(h.sent).toHaveLength(1);
  });

  it('one open A7 card per owner: a second proposal (another destination, or the same) waits, and nothing is prepared', async () => {
    const h = harness();
    const first = await h.service.propose(h.request());
    expect(first).toMatchObject({ kind: 'carded' });
    expect(await h.service.openCardOf(OWNER.id, T0)).toMatchObject({ target: KEY });
    expect(await h.service.propose(h.request({ target: { issueKey: 'BE-124' } }))).toEqual({ kind: 'wait-open-card', openTarget: KEY });
    expect(await h.service.propose(h.request())).toEqual({ kind: 'wait-open-card', openTarget: KEY });
    expect(await h.service.propose(h.request({ sessionId: 'sess-2', target: { issueKey: 'BE-124' } }))).toEqual({ kind: 'wait-open-card', openTarget: KEY });
    // A decline closes it; the next proposal cards.
    const view = await h.flow.find(h.session());
    await h.flow.close(h.session(), view as NonNullable<typeof view>, 'denied', T0);
    expect(await h.service.openCardOf(OWNER.id, T0)).toBeUndefined();
    expect((await h.service.propose(h.request({ target: { issueKey: 'BE-124' } }))).kind).toBe('carded');
  });

  it('refuses a payload that cannot be shown whole, with no card and no approval left behind', async () => {
    const h = harness();
    const long = Array.from({ length: 9 }, (_, index) => `${index}${'가'.repeat(190)}`).join('\n');
    const tooLong = await h.service.propose(h.request({ payloadText: long }));
    expect(tooLong).toEqual({ kind: 'refused', reason: 'payload-too-large' });
    expect(h.approvals.size).toBe(0);
    expect(await h.flow.find(h.session())).toBeNull();
    // A card whose banner pushes it past the card bound is refused too (never cut).
    const wide: AgentWriteProposalBanner = { ...BANNER, items: Array.from({ length: 10 }, (_, index) => ({ id: `C0AA.${String(index).padStart(200, '9')}` })) };
    expect(await h.service.propose(h.request({ banner: wide, payloadText: `${'가'.repeat(1390)}` }))).toEqual({ kind: 'refused', reason: 'payload-too-large' });
    expect(h.approvals.size).toBe(0);
  });

  it('more lines than the provenance line and the 8 draft lines is refused', async () => {
    const h = harness();
    expect(await h.service.propose(h.request({ payloadText: Array.from({ length: 10 }, (_, index) => `줄 ${index}`).join('\n') }))).toEqual({ kind: 'refused', reason: 'too-many-lines' });
    expect(h.approvals.size).toBe(0);
  });

  it('refuses closed: a target off the allowlist, a bad key, an empty or credential payload, writes off, an ordinary open approval', async () => {
    const h = harness();
    expect(await h.service.propose(h.request({ target: { issueKey: 'ZZ-1' } }))).toEqual({ kind: 'refused', reason: 'target-not-allowed' });
    expect(await h.service.propose(h.request({ target: { issueKey: 'nope' } }))).toEqual({ kind: 'refused', reason: 'invalid-target' });
    expect(await h.service.propose(h.request({ payloadText: '   ' }))).toEqual({ kind: 'refused', reason: 'payload-invalid' });
    expect(await h.service.propose(h.request({ payloadText: `토큰 ${'sk-' + 'a'.repeat(30)}` }))).toEqual({ kind: 'refused', reason: 'credential' });
    expect(await harness({ noWriter: true }).service.propose(h.request())).toEqual({ kind: 'refused', reason: 'writes-off' });
    expect(await h.service.propose(h.request({ sessionId: 'nope' }))).toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(h.approvals.size).toBe(0);
    // An ordinary connector-write approval of the owner is open (W2): no A7 card beside it.
    expect((await h.flow.prepare({ session: h.session(), actor: OWNER, now: T0, draft: { kind: 'issue-comment', issueKey: KEY, text: '직접 쓴 댓글' } })).kind).toBe('preview');
    expect(await h.service.propose(h.request({ sessionId: 'sess-2' }))).toEqual({ kind: 'refused', reason: 'owner-step-open' });
  });

  it('a card is not the owner\'s own comment request: only the proposal marks the anchor', async () => {
    const h = harness();
    await h.flow.prepare({ session: h.session(), actor: OWNER, now: T0, draft: { kind: 'issue-comment', issueKey: KEY, text: '직접 쓴 댓글' } });
    const view = await h.flow.find(h.session());
    expect(view?.anchor.agentProposal).toBeUndefined();
    expect(isActionSwitchGoverned(view?.anchor as NonNullable<typeof view>['anchor'])).toBe(false);
  });
});

describe('review round 1: expiry, stop race, shown length, re-shown card', () => {
  const LATER = '2026-11-25T02:00:00.000Z'; // 60 minutes after T0, past the 30-minute lifetime

  it('an expired card of another session does not block the next proposal (the lapsed card is not open)', async () => {
    const h = harness();
    expect((await h.service.propose(h.request())).kind).toBe('carded');
    // Still inside the lifetime: it blocks.
    expect(await h.service.openCardOf(OWNER.id, T0)).toMatchObject({ target: KEY });
    // Past the lifetime: no open card, and a proposal for another destination in another session is carded.
    expect(await h.service.openCardOf(OWNER.id, LATER)).toBeUndefined();
    const next = await h.service.propose(h.request({ sessionId: 'sess-2', target: { issueKey: 'BE-124' }, now: LATER }));
    expect(next.kind).toBe('carded');
  });

  it('an expired ordinary approval does not count as an open owner step either', async () => {
    const h = harness();
    await h.flow.prepare({ session: h.session(), actor: OWNER, now: T0, draft: { kind: 'issue-comment', issueKey: KEY, text: '직접 쓴 댓글' } });
    expect(await h.service.propose(h.request({ sessionId: 'sess-2' }))).toEqual({ kind: 'refused', reason: 'owner-step-open' });
    expect((await h.service.propose(h.request({ sessionId: 'sess-2', now: LATER }))).kind).toBe('carded');
  });

  it('a stop that lands after the card is prepared closes the card (stopped) and returns a closed result', async () => {
    const h = harness();
    const result = await h.service.propose(h.request({ stillRunning: async () => false }));
    expect(result).toEqual({ kind: 'refused', reason: 'stopped' });
    const view = await h.flow.find(h.session());
    expect(view === null || view.anchor.status === 'CLOSED' || view.anchor.closedReason === 'stopped').toBe(true);
    expect(await h.service.openCardOf(OWNER.id, T0)).toBeUndefined();
    expect(h.sent).toHaveLength(0);
  });

  it('the bound applies to the card as shown: an over-long banner is refused and no approval is left open', async () => {
    const h = harness();
    const wide: AgentWriteProposalBanner = { ...BANNER, items: Array.from({ length: 10 }, (_, index) => ({ id: `C0AA.${String(index).padStart(120, '9')}` })) };
    const result = await h.service.propose(h.request({ banner: wide, payloadText: '가'.repeat(500) }));
    expect(result).toEqual({ kind: 'refused', reason: 'payload-too-large' });
    expect(await h.service.openCardOf(OWNER.id, T0)).toBeUndefined();
  });

  it('keeps the content-free card fields on the anchor, and a card shown within the bound stays within it', async () => {
    const h = harness();
    const request = h.request();
    const result = await h.service.propose(request);
    if (result.kind !== 'carded') throw new Error('no card');
    const anchor = (await h.flow.find(h.session()))?.anchor;
    expect(anchor?.agentCard).toEqual({ banner: request.banner, named: request.named, nonTargets: request.nonTargets });
    expect(textOf(result.card).length).toBeLessThanOrEqual(1700);
  });

  it('shows other cuts neutrally, separate from the drift line', async () => {
    const h = harness();
    const result = await h.service.propose(h.request({ banner: { ...BANNER, dropped: 0, omitted: 3 } }));
    if (result.kind !== 'carded') throw new Error('no card');
    const card = textOf(result.card);
    expect(card).toContain('3건은 초안에 넣지 않았어요');
    expect(card).not.toContain('그 사이 바뀌어');
  });
});

describe('review round 2: UTF-16 length units, shown-card re-check, UNC-1', () => {
  it('measures the card in UTF-16 units (the chunker\'s unit): an emoji draft under the bound in code points but over it in units is refused, nothing left open', async () => {
    const h = harness();
    const base = h.request();
    const card = (lines: string) => textOf(renderAgentProposalCard({ issueKey: KEY, text: lines, banner: base.banner, named: base.named, nonTargets: [], remainingMs: 1_800_000, executionPhrase: '댓글 실행' }));
    const lines = (n: number) => Array.from({ length: 5 }, () => '😀'.repeat(n)).join('\n');
    let n = 1;
    while (card(lines(n + 1)).length <= AGENT_PROPOSAL_CARD_MAX_CHARS) n += 1;
    const over = lines(n + 1);
    expect(Array.from(card(over)).length).toBeLessThanOrEqual(AGENT_PROPOSAL_CARD_MAX_CHARS); // the old code-point count would have passed it
    expect(card(over).length).toBeGreaterThan(AGENT_PROPOSAL_CARD_MAX_CHARS);
    expect(over.length).toBeLessThanOrEqual(1400); // not the ADR-0112 payload bound: only the card bound refuses it
    expect(await h.service.propose(h.request({ payloadText: over, nonTargets: [] }))).toEqual({ kind: 'refused', reason: 'payload-too-large' });
    expect(h.approvals.size).toBe(0);
    expect((await h.service.propose(h.request({ payloadText: lines(n), nonTargets: [] }))).kind).toBe('carded');
  });

  it('re-checks the card as SHOWN after prepare (its own execution phrase and remaining time): over the bound it is closed as cancelled and refused', async () => {
    const h = harness();
    const deps = (h.service as unknown as { deps: ConstructorParameters<typeof AgentWriteProposalService>[0] }).deps;
    const flow = new Proxy(h.flow, {
      get(target, key) {
        if (key === 'prepare') {
          return async (input: Parameters<typeof target.prepare>[0]) => {
            const step = await target.prepare(input);
            return step.kind === 'preview' ? { ...step, executionPhrase: '길게'.repeat(900) } : step;
          };
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const service = new AgentWriteProposalService({ ...deps, flow });
    const result = await service.propose(h.request());
    expect(result).toEqual({ kind: 'refused', reason: 'payload-too-large' });
    const view = await h.flow.find(h.session());
    expect(view === null || view.anchor.status === 'CLOSED').toBe(true);
    if (view !== null) expect(view.anchor.closedReason).toBe('cancelled');
    expect(await service.openCardOf(OWNER.id, T0)).toBeUndefined();
    expect(h.sent).toHaveLength(0);
  });

  it('UNC-1: an unresolved earlier send of the same payload leads the first card and the re-shown card with the existing warning', async () => {
    const h = harness();
    h.receipts.findLatestUnresolved = async () => ({ status: 'UNCERTAIN', updatedAt: T0 }) as never;
    const request = h.request();
    const result = await h.service.propose(request);
    if (result.kind !== 'carded') throw new Error('no card');
    expect(textOf(result.card).startsWith('주의: 같은 내용의 이전 요청은 결과를 확인하지 못했어요')).toBe(true);
    const fields = (await h.flow.find(h.session()))?.anchor.agentCard;
    expect(fields?.unconfirmedEarlier).toMatchObject({ status: 'UNCERTAIN', at: T0 });
    const reshown = renderAgentProposalCard({ issueKey: KEY, text: request.payloadText, ...(fields as NonNullable<typeof fields>), remainingMs: 1_000_000, executionPhrase: '댓글 실행' });
    expect(textOf(reshown)).toContain('주의: 같은 내용의 이전 요청은 결과를 확인하지 못했어요');
    // No unresolved earlier send: no warning, and nothing extra on the anchor (the control).
    const clean = harness();
    const plain = await clean.service.propose(clean.request());
    if (plain.kind !== 'carded') throw new Error('no card');
    expect(textOf(plain.card)).not.toContain('주의:');
    expect((await clean.flow.find(clean.session()))?.anchor.agentCard).not.toHaveProperty('unconfirmedEarlier');
  });
});

describe('the key grammar helper', () => {
  it('is the A1-D4 grammar of the catalog and finds whole-word keys only, upper-cased, distinct, without the destination', () => {
    expect(NL_REF_JIRA_KEY.source).toBe(`^${AGENT_WRITE_PROPOSAL_KEY_BODY}$`);
    expect(destinationShapedKeys('BE-123 be-999 BE-999 xBE-5 PROJ-7x AB_C-12 BE-0', 'be-123')).toEqual(['BE-999', 'XBE-5', 'AB_C-12']);
    expect(destinationShapedKeys('아무 키도 없어요', KEY)).toEqual([]);
  });
});

// ADR-0121 A7-S4b: a picked destination says so on the card, and the closure of a card is read from its persisted anchor.
describe('A7-S4b: the picked destination and the closure check (A7.4b, A7.4c item 4)', () => {
  it('an owner-picked destination says "직접 고르신 대상" on the card, on the anchor and on the re-shown card; an owner-text one keeps its line', async () => {
    const h = harness();
    const picked = await h.service.propose(h.request({ grounding: 'owner-picked' }));
    if (picked.kind !== 'carded') throw new Error('no card');
    const text = textOf(picked.card);
    expect(text).toContain(`직접 고르신 대상: Jira ${KEY}`);
    expect(text).not.toContain('대상은 보내신 문장에서');
    const view = await h.flow.find(h.session());
    expect(view?.anchor.agentCard?.grounding).toBe('owner-picked');
    const request = h.request({ grounding: 'owner-picked' });
    const reshown = textOf(renderAgentProposalCard({ issueKey: KEY, text: request.payloadText, banner: BANNER, named: 1, nonTargets: [], remainingMs: 60_000, executionPhrase: '댓글 실행', grounding: view?.anchor.agentCard?.grounding }));
    expect(reshown).toContain(`직접 고르신 대상: Jira ${KEY}`);
    const named = harness();
    const result = await named.service.propose(named.request());
    if (result.kind !== 'carded') throw new Error('no card');
    expect(textOf(result.card)).toContain(`대상: Jira ${KEY} (대상은 보내신 문장에서 가져왔어요)`);
    expect((await named.flow.find(named.session()))?.anchor.agentCard?.grounding).toBeUndefined();
  });

  it('any other grounding is refused (closed values only)', async () => {
    const h = harness();
    expect(await h.service.propose(h.request({ grounding: 'owner-confirmed' as never }))).toEqual({ kind: 'refused', reason: 'unavailable' });
  });

  it('closureOf reads the persisted anchor by its task: open, then each closure as a closed value; anything unreadable is unknown (hands nothing on)', async () => {
    const reasons = [
      ['denied', 'declined'],
      ['cancelled', 'owner-void'],
      // A system displacement and a flow step that never reached a preview are not the owner's void: they hand nothing on.
      ['abandoned', 'unknown'],
      ['superseded', 'unknown'],
      ['expired', 'expired'],
      ['stopped', 'kill-switch'],
      ['inconsistent', 'unknown'],
    ] as const;
    for (const [reason, expected] of reasons) {
      const h = harness();
      const result = await h.service.propose(h.request());
      if (result.kind !== 'carded' || result.taskId === undefined) throw new Error('no card');
      const ask = { sessionId: 'sess-1', taskId: result.taskId, actorId: OWNER.id, now: T0 };
      expect(await h.service.closureOf(ask)).toBe('open');
      const view = await h.flow.find(h.session());
      await h.flow.close(h.session(), view as NonNullable<typeof view>, reason, T0);
      expect(await h.service.closureOf(ask), reason).toBe(expected);
    }
    const h = harness();
    const result = await h.service.propose(h.request());
    if (result.kind !== 'carded' || result.taskId === undefined) throw new Error('no card');
    // A card whose approval lapsed is expired (its lifetime), another session, a missing task and a thrown read are unknown.
    expect(await h.service.closureOf({ sessionId: 'sess-1', taskId: result.taskId, actorId: OWNER.id, now: '2026-11-25T02:00:00.000Z' })).toBe('expired');
    expect(await h.service.closureOf({ sessionId: 'sess-9', taskId: result.taskId, actorId: OWNER.id, now: T0 })).toBe('unknown');
    // Another actor asking about this owner's card: unknown (the anchor, the session and the asker must be one actor).
    expect(await h.service.closureOf({ sessionId: 'sess-1', taskId: result.taskId, actorId: 'someone-else' as never, now: T0 })).toBe('unknown');
    expect(await h.service.closureOf({ sessionId: 'sess-1', taskId: 'no-such-task', actorId: OWNER.id, now: T0 })).toBe('unknown');
  });

  it('a send is closed as sent (the flow marks the anchor SENT)', async () => {
    const h = harness();
    const result = await h.service.propose(h.request());
    if (result.kind !== 'carded' || result.taskId === undefined) throw new Error('no card');
    // The service reads the anchor only: a SENT anchor (as the flow's execute leaves it) maps to `sent`.
    const view = await h.flow.find(h.session());
    const anchored = { ...(view as NonNullable<typeof view>).anchor, status: 'SENT' as const };
    const reader = new AgentWriteProposalService({
      flow: { ...h.flow, supports: h.flow.supports.bind(h.flow), anchorOfTask: async () => ({ ...(view as NonNullable<typeof view>), anchor: anchored }) } as never,
      sessions: { get: async () => h.session() },
      actors: { get: async () => OWNER },
    });
    expect(await reader.closureOf({ sessionId: 'sess-1', taskId: result.taskId, actorId: OWNER.id, now: T0 })).toBe('sent');
    const unresolved = new AgentWriteProposalService({
      flow: { supports: () => true, anchorOfTask: async () => ({ ...(view as NonNullable<typeof view>), anchor: { ...anchored, status: 'UNCERTAIN' } }) } as never,
      sessions: { get: async () => h.session() },
      actors: { get: async () => OWNER },
    });
    expect(await unresolved.closureOf({ sessionId: 'sess-1', taskId: result.taskId, actorId: OWNER.id, now: T0 })).toBe('unknown');
  });
});
