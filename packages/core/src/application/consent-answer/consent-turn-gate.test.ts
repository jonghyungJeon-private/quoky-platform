import { describe, expect, it } from 'vitest';
import type { Actor } from '../../domain';
import { ConsentPendingStore, summaryConsentPending, type BoundConsent } from './consent-pending';
import { ConsentTurnGate, type ConsentContinuation, type ConsentGateTurn } from './consent-turn-gate';
import type { ConsentClassifierSwitch } from './consent-answer';

// CS-2: the runtime gate over a REAL store and the REAL answer pipeline; only the continuation and the classifier are stubs.

const OWNER: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: '2026-11-25T00:00:00.000Z' };
const KEY = 'discord||dm-1|';
const SCOPE = { actorId: OWNER.id, conversationKey: KEY };
const T0 = 1_000_000;

interface Rig {
  readonly store: ConsentPendingStore;
  readonly gate: ConsentTurnGate;
  readonly clock: { now: number };
  readonly continued: BoundConsent[];
  readonly voided: number[];
  readonly logs: Array<{ message: string; fields?: unknown }>;
  open(language?: 'ko' | 'en', scope?: { actorId: string; conversationKey: string }): void;
  turn(text: string, extra?: Partial<ConsentGateTurn>): ConsentGateTurn;
}

function rig(options: { classifier?: ConsentClassifierSwitch; continuation?: ConsentContinuation | (() => never) } = {}): Rig {
  const store = new ConsentPendingStore();
  const clock = { now: T0 };
  const continued: BoundConsent[] = [];
  const voided: number[] = [];
  const logs: Array<{ message: string; fields?: unknown }> = [];
  const gate = new ConsentTurnGate({
    store,
    classifier: options.classifier ?? { mode: 'off' },
    continueSummary: async (bound) => {
      continued.push(bound);
      if (typeof options.continuation === 'function') return options.continuation();
      return options.continuation ?? { kind: 'reply', reply: { text: 'SUMMARY-BODY-TEXT' } };
    },
    voidContinuations: () => voided.push(1),
    now: () => clock.now,
    logger: { info: (message, fields) => logs.push({ message, fields }), warn: () => undefined, error: () => undefined },
  });
  return {
    store,
    gate,
    clock,
    continued,
    voided,
    logs,
    open: (language = 'ko', scope = SCOPE) =>
      store.open(summaryConsentPending({ scope, language, createdAtMs: T0, recipient: 'Claude', sources: [{ source: 'mail', itemIds: ['m1', 'm2'] }], runRef: 'run-1' })),
    turn: (text, extra = {}) => ({ actor: OWNER, conversationKey: KEY, direct: true, text, attachmentCount: 0, ownerStepPending: false, control: false, ...extra }),
  };
}

describe('ConsentTurnGate (CS-2)', () => {
  it('a closed yes binds and runs the continuation once; the history keeps the fixed note, never the summary', async () => {
    const r = rig();
    r.open();
    const out = await r.gate.handle(r.turn('응'));
    expect(out).toMatchObject({ kind: 'reply', text: 'SUMMARY-BODY-TEXT' });
    expect(out.kind === 'reply' && out.historyNote).toBe('(확인한 항목의 요약을 전달했어요.)');
    expect(out.kind === 'reply' && out.historyNote).not.toContain('SUMMARY-BODY');
    expect(r.continued).toHaveLength(1);
    expect(r.continued[0]?.pending.kind).toBe('summary-consent');
    // Single use: a second yes finds a used step, which is the expired line, never a second run.
    const again = await r.gate.handle(r.turn('응'));
    expect(again).toMatchObject({ kind: 'reply', text: '요약 확인 시간이 지났어요. 다시 요청해 주세요.' });
    expect(r.continued).toHaveLength(1);
  });

  it('a closed no is consumed with the fixed cancel line and routes nothing (English follows the step language)', async () => {
    const ko = rig();
    ko.open('ko');
    expect(await ko.gate.handle(ko.turn('아니'))).toMatchObject({ kind: 'reply', text: '요약을 취소했어요. 원문은 보내지 않았어요.' });
    const en = rig();
    en.open('en');
    expect(await en.gate.handle(en.turn('no'))).toMatchObject({ kind: 'reply', text: 'I cancelled the summary. Nothing was sent.' });
    expect(ko.continued).toHaveLength(0);
  });

  it.each(['ㅇㅇ', 'ok', '보내줘'])('%s with the classifier off cancels silently and the turn routes normally', async (text) => {
    const r = rig();
    r.open();
    expect(await r.gate.handle(r.turn(text))).toEqual({ kind: 'route' });
    expect(r.store.stateOf(SCOPE)).toBe('cancelled');
    expect(r.continued).toHaveLength(0);
  });

  it('a multi-line reply within the caps is consumed and not re-planned (462 floor)', async () => {
    const r = rig();
    r.open();
    expect(await r.gate.handle(r.turn('응\n드라이브도 같이'))).toMatchObject({ kind: 'reply', text: '요약을 취소했어요. 원문은 보내지 않았어요.' });
    expect(r.continued).toHaveLength(0);
  });

  it('a reply over the caps routes as a new request', async () => {
    const r = rig();
    r.open();
    expect(await r.gate.handle(r.turn('가'.repeat(61)))).toEqual({ kind: 'route' });
    expect(r.store.stateOf(SCOPE)).toBe('cancelled');
  });

  it('a late closed token after the window gets the fixed expired line and is consumed', async () => {
    const r = rig();
    r.open();
    r.clock.now = T0 + 600_000;
    expect(await r.gate.handle(r.turn('응'))).toMatchObject({ kind: 'reply', text: '요약 확인 시간이 지났어요. 다시 요청해 주세요.' });
    expect(r.continued).toHaveLength(0);
    // Not a closed token: a late ordinary message is just routed.
    const r2 = rig();
    r2.open();
    r2.clock.now = T0 + 600_000;
    expect(await r2.gate.handle(r2.turn('내일 일정 알려줘'))).toEqual({ kind: 'route' });
  });

  it('a channel turn leaves the step open; another conversation does not claim it', async () => {
    const r = rig();
    r.open();
    expect(await r.gate.handle(r.turn('응', { direct: false }))).toEqual({ kind: 'route' });
    expect(r.store.stateOf(SCOPE)).toBe('open');
    expect(await r.gate.handle(r.turn('응', { conversationKey: 'discord||dm-2|' }))).toEqual({ kind: 'route' });
    expect(r.store.stateOf(SCOPE)).toBe('open');
    expect(r.continued).toHaveLength(0);
  });

  it('another owner step open, or a control phrase, forfeits the step without a claim and routes', async () => {
    const owner = rig();
    owner.open();
    expect(await owner.gate.handle(owner.turn('응', { ownerStepPending: true }))).toEqual({ kind: 'route' });
    expect(owner.store.stateOf(SCOPE)).toBeUndefined();
    expect(owner.continued).toHaveLength(0);
    const control = rig();
    control.open();
    expect(await control.gate.handle(control.turn('도움말', { control: true }))).toEqual({ kind: 'route' });
    expect(control.store.stateOf(SCOPE)).toBeUndefined();
    // After the forfeit nothing is held: a later yes is an ordinary message, never a run.
    expect(await control.gate.handle(control.turn('응'))).toEqual({ kind: 'route' });
  });

  it('the kill switch voids the store and the continuation records; a later yes runs nothing', async () => {
    const r = rig();
    r.open();
    r.gate.voidAll();
    expect(r.store.stateOf(SCOPE)).toBe('voided');
    expect(r.voided).toEqual([1]);
    expect(await r.gate.handle(r.turn('응'))).toMatchObject({ kind: 'reply', text: '요약 확인 시간이 지났어요. 다시 요청해 주세요.' });
    expect(r.continued).toHaveLength(0);
  });

  it('a declined continuation shows its fixed line and spends the yes (no re-open); a throwing one is the unavailable line', async () => {
    const declined = rig({ continuation: { kind: 'declined', reason: 'hourly-cap', text: 'FIXED-DECLINE' } });
    declined.open();
    expect(await declined.gate.handle(declined.turn('응'))).toMatchObject({ kind: 'reply', text: 'FIXED-DECLINE', historyNote: 'FIXED-DECLINE' });
    expect(declined.store.stateOf(SCOPE)).toBe('used');
    const thrown = rig({ continuation: () => { throw new Error('boom'); } });
    thrown.open();
    expect(await thrown.gate.handle(thrown.turn('응'))).toMatchObject({ kind: 'reply', text: '지금은 요약을 보낼 수 없어서 아무것도 보내지 않았어요. 다시 요청해 주세요.' });
  });

  it('a non-finite clock fails closed: the step is late, the closed token is consumed with the expired line, nothing runs', async () => {
    const r = rig();
    r.open();
    r.clock.now = Number.NaN;
    expect(await r.gate.handle(r.turn('응'))).toMatchObject({ kind: 'reply', text: '요약 확인 시간이 지났어요. 다시 요청해 주세요.' });
    expect(r.continued).toHaveLength(0);
  });

  describe('classifier stub on (unit only; the production switch stays off)', () => {
    const on = (label: string): ConsentClassifierSwitch => ({ mode: 'on', classify: async () => label });

    it('yes-and-more binds, continues, and carries the rerun text (r-01 whole message; r-02 the lines after a closed yes)', async () => {
      const whole = rig({ classifier: on('yes-and-more') });
      whole.open();
      const a = await whole.gate.handle(whole.turn('좋아 그리고 드라이브도'));
      expect(a).toMatchObject({ kind: 'reply', text: 'SUMMARY-BODY-TEXT', rerunText: '좋아 그리고 드라이브도' });
      const cut = rig({ classifier: on('yes-and-more') });
      cut.open();
      const b = await cut.gate.handle(cut.turn('응\n드라이브도 같이'));
      // A two-line reply that is not a closed token reaches the classifier; r-02 cuts the first closed-yes line.
      expect(b).toMatchObject({ kind: 'reply', rerunText: '드라이브도 같이' });
      expect(cut.continued).toHaveLength(1);
      // The rerun finds no pending step: the step is used.
      expect(cut.store.stateOf(SCOPE)).toBe('used');
    });

    it('unclear re-asks the fixed question once; a second unclear cancels', async () => {
      const r = rig({ classifier: on('unclear') });
      r.open('en');
      expect(await r.gate.handle(r.turn('hmm maybe'))).toMatchObject({ kind: 'reply', text: 'Shall I send it? (yes/no)' });
      expect(r.store.stateOf(SCOPE)).toBe('open');
      expect(await r.gate.handle(r.turn('hmm maybe'))).toMatchObject({ kind: 'reply', text: 'I cancelled the summary. Nothing was sent.' });
      expect(r.continued).toHaveLength(0);
    });
  });

  it('logs closed codes only, never the reply text, an id or the summary', async () => {
    const r = rig();
    r.open();
    await r.gate.handle(r.turn('응'));
    await r.gate.handle(r.turn('아니'));
    const dump = JSON.stringify(r.logs);
    for (const secret of ['SUMMARY-BODY', 'm1', 'm2', 'run-1', '아니', '응']) expect(dump, secret).not.toContain(secret);
  });

  it('conversationKeyOf is platform|space|channel|thread', () => {
    expect(ConsentTurnGate.conversationKeyOf({ platform: 'discord', channelId: 'c' })).toBe('discord||c|');
    expect(ConsentTurnGate.conversationKeyOf({ platform: 'discord', spaceId: 's', channelId: 'c', threadId: 't' })).toBe('discord|s|c|t');
  });
});
