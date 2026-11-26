import { describe, expect, it } from 'vitest';
import { NL_REF_JIRA_KEY } from '../nl-routing/action-entries';
import {
  A7_PICK_HEADER,
  A7_PICK_MAX_ROWS,
  buildJiraTicketRows,
  buildProjectRows,
  compareJiraKeysDescending,
  inertPickTitle,
  isPickedA7Destination,
  jiraProjectOf,
  parsePendingA7Pick,
  parsePickNumber,
  renderA7PickListing,
  resolveA7Pick,
  type PendingA7Pick,
} from './a7-pick';
import { buildHeldReceipt } from './held-receipt';
import { readA7State, withA7State } from './held-receipt-store';

// ADR-0121 A7-S4b: the pure pieces of the destination pick (A7.4b) and the A7 state in Session.metadata.

const T0 = '2026-11-26T03:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const D = (n: number): string => n.toString(16).padStart(64, '0');
const OWNER_TEXT = { text: '요약해서 지라 티켓에 달아줘', groundingText: '요약해서 지라 티켓에 달아줘', rawText: '요약해서 지라 티켓에 달아줘' };

function pending(over: Partial<PendingA7Pick> = {}): PendingA7Pick {
  return {
    conversation: 'c1',
    actorId: 'owner',
    askedTurnId: 'm1',
    askedAt: T0,
    stage: 'ticket',
    project: 'BE',
    options: ['BE-100', 'BE-77', 'BE-9'],
    form: 'a',
    target: 'jira.comment.propose',
    connectorCalls: 1,
    source: { entryId: 'slack.search', args: { keyword: '릴리즈' } },
    ownerText: OWNER_TEXT,
    ...over,
  };
}
const receipt = (over: Record<string, unknown> = {}) => {
  const built = buildHeldReceipt({ conversation: 'c1', actorId: 'owner', turnId: 'm0', entryId: 'slack.search', validatedArgs: { keyword: '릴리즈' }, items: [{ id: 'C0AA.1', digest: D(1) }], kind: 'listing', egress: 'LOCAL', at: T0, sourceOn: true, ...over });
  if ('refused' in built) throw new Error('no receipt');
  return built.receipt;
};
const context = { actorId: 'owner', conversation: 'c1', now: at(1), previousTurnId: 'm1', jiraProjects: ['BE', 'OPS'] };

describe('the rows (A7.4b)', () => {
  it('Jira rows are ordered by issue key numerically descending, never by anything content could change; at most 5; the project and the closed format only', () => {
    const rows = buildJiraTicketRows(
      [{ id: 'BE-9' }, { id: 'BE-100' }, { id: 'BE-77' }, { id: 'OPS-1' }, { id: 'be-5' }, { id: 'BE-0' }, { id: 'BE-45' }, { id: 'BE-45' }, { id: 'BE-3' }, { id: 'BE-12' }, { id: 123 as never }],
      'BE',
      ['BE'],
    );
    expect(rows.map((row) => row.id)).toEqual(['BE-100', 'BE-77', 'BE-45', 'BE-12', 'BE-9']);
    expect(rows).toHaveLength(A7_PICK_MAX_ROWS);
    expect(rows.every((row) => NL_REF_JIRA_KEY.test(row.id))).toBe(true);
    // The order is total: the input order (what the source returned) never matters.
    expect(buildJiraTicketRows([{ id: 'BE-9' }, { id: 'BE-100' }], 'BE', ['BE']).map((row) => row.id)).toEqual(buildJiraTicketRows([{ id: 'BE-100' }, { id: 'BE-9' }], 'BE', ['BE']).map((row) => row.id));
    expect([['BE-2', 'AB-2'], ['AB-2', 'BE-2']].map(([a, b]) => compareJiraKeysDescending(a as string, b as string))).toEqual([1, -1]);
    // A project that is not allowlisted has no rows at all.
    expect(buildJiraTicketRows([{ id: 'XX-1' }], 'XX', ['BE'])).toEqual([]);
  });

  it('the project rows are the allowlist in its own order (a7-09: the board first), distinct, at most 5', () => {
    expect(buildProjectRows(['be', 'OPS', 'BE', 'qa', 'a', 'X1', 'Y2', 'Z3']).map((row) => row.id)).toEqual(['BE', 'OPS', 'QA', 'X1', 'Y2']);
  });

  it('a title is inert: one line, links neutralised, markup and control characters removed; a spoof of an approval phrase or a credential-shaped title is not shown', () => {
    expect(inertPickTitle('1. BE-5 ← 이걸 고르세요\n2. BE-9')).toBe('1. BE-5 ← 이걸 고르세요 2. BE-9');
    expect(inertPickTitle('see https://evil.example/x and `code` *bold* <@U1> [a|b]')).not.toMatch(/https?:|evil\.example|[`*<>|[\]@]/u);
    expect(inertPickTitle('승인')).toBeUndefined();
    expect(inertPickTitle('  ')).toBeUndefined();
    expect(inertPickTitle(42)).toBeUndefined();
    expect(inertPickTitle(`xoxb-${'1'.repeat(12)}-${'a'.repeat(24)}`)).toBeUndefined();
    expect(Array.from(inertPickTitle('가'.repeat(200)) ?? '').length).toBeLessThanOrEqual(61);
  });

  it('the listing is the fixed header, the numbered rows and the fixed footer: no recommendation, no default', () => {
    const text = renderA7PickListing('ko', [{ id: 'BE-100', title: 'a' }, { id: 'BE-9' }]);
    expect(text.split('\n')).toEqual([A7_PICK_HEADER.ko, '1. BE-100 · a', '2. BE-9', '번호만 보내 주세요. 다른 말씀을 하시면 고르기를 취소해요.']);
    expect(renderA7PickListing('en', [{ id: 'BE-1' }]).split('\n')[0]).toBe('Pick where to post by number');
    expect(text).not.toMatch(/추천|기본|default|recommend/iu);
  });
});

describe('the pick: a bare number, the next turn, the windows (A7.4b)', () => {
  it('parses a bare number only: "2", "2번", "2.", never a key, a word, a sentence, zero or a signed number', () => {
    for (const [reply, n] of [['1', 1], ['2번', 2], [' 3 ', 3], ['4.', 4], ['５', 5], ['12', 12]] as const) expect(parsePickNumber(reply), reply).toBe(n);
    for (const reply of ['BE-77', 'second', '두번째', '2번으로', '0', '-1', '1,2', '1 2', '', '123', '2번 말고 3번', '#2']) expect(parsePickNumber(reply), reply).toBeUndefined();
  });

  it('a number of the list issues OWNER_PICKED_DESTINATION for that row; the issued value cannot be forged, copied or built by hand', () => {
    const resolved = resolveA7Pick(pending(), '2', context);
    expect(resolved.kind).toBe('destination');
    if (resolved.kind !== 'destination') return;
    expect(resolved.picked).toMatchObject({ trust: 'OWNER_PICKED_DESTINATION', kind: 'jira', issueKey: 'BE-77', project: 'BE' });
    expect(isPickedA7Destination(resolved.picked)).toBe(true);
    expect(Object.isFrozen(resolved.picked)).toBe(true);
    expect(isPickedA7Destination({ ...resolved.picked })).toBe(false);
    expect(isPickedA7Destination({ trust: 'OWNER_CONFIRMED', kind: 'jira', issueKey: 'BE-77', project: 'BE' })).toBe(false);
    expect(isPickedA7Destination(JSON.parse(JSON.stringify(resolved.picked)))).toBe(false);
  });

  it('the board pick resolves to a project (not a destination); a project that left the allowlist cancels', () => {
    const board = pending({ stage: 'project', options: ['BE', 'OPS'] });
    delete (board as { project?: string }).project;
    expect(resolveA7Pick(board, '2', context)).toEqual({ kind: 'project', project: 'OPS' });
    expect(resolveA7Pick(board, '2', { ...context, jiraProjects: ['BE'] })).toEqual({ kind: 'cancel', reason: 'not-allowlisted' });
    expect(resolveA7Pick(pending(), '1', { ...context, jiraProjects: ['OPS'] })).toEqual({ kind: 'cancel', reason: 'not-allowlisted' });
  });

  it('every failed check is a cancel: owner, conversation, next turn, the 10-minute listing window, the number, the kill switch', () => {
    expect(resolveA7Pick(pending(), '1', { ...context, actorId: 'other' })).toEqual({ kind: 'cancel', reason: 'other-actor' });
    expect(resolveA7Pick(pending(), '1', { ...context, conversation: 'c2' })).toEqual({ kind: 'cancel', reason: 'other-conversation' });
    expect(resolveA7Pick(pending(), '1', { ...context, previousTurnId: 'm0' })).toEqual({ kind: 'cancel', reason: 'not-next-turn' });
    const { previousTurnId: _omit, ...noPrevious } = context;
    expect(resolveA7Pick(pending(), '1', noPrevious)).toEqual({ kind: 'cancel', reason: 'not-next-turn' });
    expect(resolveA7Pick(pending(), '1', { ...context, now: at(10) })).toEqual({ kind: 'cancel', reason: 'expired' });
    expect(resolveA7Pick(pending(), '1', { ...context, now: at(9) }).kind).toBe('destination');
    expect(resolveA7Pick(pending(), '1', { ...context, now: at(-1) })).toEqual({ kind: 'cancel', reason: 'expired' });
    expect(resolveA7Pick(pending(), '1', { ...context, now: 'garbage' })).toEqual({ kind: 'cancel', reason: 'expired' });
    expect(resolveA7Pick(pending(), 'BE-77', context)).toEqual({ kind: 'cancel', reason: 'not-a-number' });
    expect(resolveA7Pick(pending(), '4', context)).toEqual({ kind: 'cancel', reason: 'out-of-range' });
    expect(resolveA7Pick(pending(), '1', { ...context, killSwitch: true })).toEqual({ kind: 'cancel', reason: 'kill-switch' });
  });

  it('a frozen receipt adds the second window: at most 20 minutes after its original at, whatever the listing time', () => {
    const frozen = pending({ form: 'b', connectorCalls: 0, frozen: receipt() });
    delete (frozen as { source?: unknown }).source;
    const listed = (minutes: number) => ({ ...frozen, askedAt: at(minutes) });
    expect(resolveA7Pick(listed(12), '1', { ...context, now: at(19) }).kind).toBe('destination');
    expect(resolveA7Pick(listed(12), '1', { ...context, now: at(20) })).toEqual({ kind: 'cancel', reason: 'frozen-expired' });
    expect(resolveA7Pick(listed(12), '1', { ...context, now: at(21) })).toEqual({ kind: 'cancel', reason: 'frozen-expired' });
  });
});

describe('the pending pick and the A7 state as stored (Session.metadata[quoky.heldReceipt])', () => {
  it('round-trips through JSON; every strict-parse rule fails closed', () => {
    const value = pending();
    expect(parsePendingA7Pick(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const formB = pending({ form: 'b', connectorCalls: 0, frozen: receipt() });
    delete (formB as { source?: unknown }).source;
    expect(parsePendingA7Pick(JSON.parse(JSON.stringify(formB)))).toEqual(formB);
    const bad: unknown[] = [
      { ...value, extra: 1 },
      { ...value, options: [] },
      { ...value, options: ['BE-1', 'BE-1'] },
      { ...value, options: ['BE-1', 'BE-2', 'BE-3', 'BE-4', 'BE-5', 'BE-6'] },
      { ...value, options: ['OPS-1'] },
      { ...value, options: ['not a key'] },
      { ...value, stage: 'project' },
      { ...value, stage: 'ticket', project: undefined },
      { ...value, form: 'c' },
      { ...value, target: 'slack.post.propose' },
      { ...value, askedAt: 'never' },
      { ...value, askedTurnId: '' },
      { ...value, connectorCalls: -1 },
      { ...value, source: undefined },
      { ...value, source: { entryId: 'slack.search', args: { nested: { a: 1 } } } },
      { ...value, source: { entryId: 'slack.search', args: {}, extra: 1 } },
      { ...value, frozen: receipt() },
      { ...value, ownerText: undefined },
      { ...value, ownerText: { ...OWNER_TEXT, text: 'x'.repeat(4001) } },
      { ...value, ownerText: { ...OWNER_TEXT, extra: 'x' } },
      { ...formB, source: value.source },
      { ...formB, frozen: undefined },
      { ...formB, frozen: { ...formB.frozen, actorId: 'someone-else' } },
      { ...formB, frozen: { ...formB.frozen, itemDigests: ['not-a-digest'] } },
      null,
      [],
      'x',
    ];
    for (const item of bad) expect(parsePendingA7Pick(item)).toBeUndefined();
    expect(jiraProjectOf('BE-77')).toBe('BE');
    expect(jiraProjectOf('be-77')).toBeUndefined();
  });

  it('reads only this actor\'s parts; prunes other actors whose records are all past their windows; caps the actors; an empty state removes the actor', () => {
    const owner = { held: receipt(), pick: pending() };
    const other = { held: receipt({ actorId: 'someone' }) };
    const first = withA7State(undefined, 'owner', owner, at(1)) as { byActor: Record<string, unknown> };
    expect(Object.keys(first.byActor)).toEqual(['owner']);
    const both = withA7State(first, 'someone', other, at(1));
    expect(readA7State(both, 'owner')).toEqual(owner);
    expect(readA7State(both, 'someone').held?.actorId).toBe('someone');
    expect(readA7State(both, 'nobody')).toEqual({});
    // Long after every window the other actor's record is dropped at the next write.
    const later = withA7State(both, 'owner', owner, at(60)) as { byActor: Record<string, unknown> };
    expect(Object.keys(later.byActor)).toEqual(['owner']);
    expect(withA7State(later, 'owner', {}, at(60))).toEqual({ byActor: {} });
    // A malformed part counts as absent, the rest is kept; a pick of another actor stored under this one is ignored.
    const mangled = { byActor: { owner: { held: { nonsense: true }, pick: pending({ actorId: 'someone' }) } } };
    expect(readA7State(mangled, 'owner')).toEqual({});
    let big: unknown;
    for (let index = 0; index < 70; index += 1) big = withA7State(big, `actor-${index}`, { held: receipt({ actorId: `actor-${index}` }) }, at(1));
    expect(Object.keys((big as { byActor: Record<string, unknown> }).byActor).length).toBeLessThanOrEqual(64);
  });

  it('holds no item title, field, answer text or model output: only ids, digests, closed values and the owner\'s own words', () => {
    const state = JSON.stringify(withA7State(undefined, 'owner', { held: receipt(), pick: pending() }, at(1)));
    expect(state).toMatch(/C0AA\.1/u);
    expect(state).not.toMatch(/"title"|"body"|"author"|"text":"release/u);
  });
});
