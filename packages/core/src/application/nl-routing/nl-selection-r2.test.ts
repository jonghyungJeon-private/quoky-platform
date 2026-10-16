import { describe, expect, it } from 'vitest';
import { Capability, type Actor, type IsoTimestamp, type Session } from '../../domain';
import type { AiProvider, AiRequest, LogFields, Logger } from '../../ports';
import { LAST_LISTING_METADATA_KEY, withLabelledListing } from '../last-listing';
import { NL_ACTION_ENTRIES, nlItemSummarizeEntry } from './action-entries';
import { NlActionSwitch } from './action-switch';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { LAST_READ_METADATA_KEY } from './last-read';
import { NL_ACTION_CAPS, NL_ACTION_LOG_EVENT, NlActionCaps, type NlActionLevel } from './nl-action-policy';
import { NlActionsConfigError, NlSelectionService, itemR2Acts, type NlItemR2Level, type NlSelectionDecision } from './nl-selection-service';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// A6 R2 at the selection service: the QUOKY_NL_ITEM_R2 sub-flag (proposal §7), the daily ITEM_READ cap (§4) and the
// lastRead / fetch audit fields. A scripted selector; no network, no model.

const T0 = '2026-10-16T03:00:00.000Z';
const at = (minutes: number): IsoTimestamp => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const R2_ENTRY = nlItemSummarizeEntry(['jira', 'slack']);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES)
  .filter((entry): entry is NlCatalogEntry => entry !== undefined)
  .map((entry) => (entry.id === 'item.summarize' ? R2_ENTRY : entry));
const ALL = [...READS, ...ACTIONS];
const out = (entryId: string, args: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });

const JIRA = [
  { label: 1, id: 'PROJ-12:10012' },
  { label: 2, id: 'PROJ-14:10014' },
];
const SLACK = [
  { label: 1, id: 'C1:1700000000.000100' },
  { label: 2, id: 'C1:1700000001.000200' },
];

function world(options: { level: NlActionLevel; itemR2?: NlItemR2Level; script: string[]; caps?: NlActionCaps }) {
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const script = [...options.script];
  let session: Session = {
    id: 'sess-1',
    actorId: 'owner',
    context: { platform: 'test', channelId: 'dm', userId: 'u', direct: true },
    status: 'ACTIVE' as Session['status'],
    createdAt: T0,
    lastActivityAt: T0,
  };
  const actor: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
  const provider: AiProvider = {
    id: 'scripted',
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    async isAvailable() {
      return true;
    },
    async execute(_request: AiRequest) {
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return { text: next, artifacts: [] };
    },
  };
  const logger: Logger = {
    info: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    warn: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
    error: (event, fields) => void logs.push({ event, ...(fields ? { fields } : {}) }),
  };
  const actors = { get: async () => actor, save: async (next: Actor) => next };
  const service = new NlSelectionService({
    mode: 'active',
    router: { select: async () => provider },
    sessions: {
      async updateMetadataEntry(_ref, key, update) {
        const metadata: Record<string, unknown> = { ...(session.metadata ?? {}) };
        const next = update(metadata[key]);
        if (next === undefined) delete metadata[key];
        else metadata[key] = next;
        session = { ...session, metadata };
        return session;
      },
    },
    actors,
    timeZone: 'Asia/Seoul',
    logger,
    actions: {
      level: options.level,
      ...(options.itemR2 !== undefined ? { itemR2: options.itemR2 } : {}),
      killSwitch: new NlActionSwitch({ actors, logger }),
      ...(options.caps !== undefined ? { caps: options.caps } : {}),
    },
  });
  return {
    service,
    logs,
    session: () => session,
    actor,
    setListing(source: 'jira' | 'slack', items: readonly { label: number; id: string }[], minute = 0) {
      const current = session.metadata?.[LAST_LISTING_METADATA_KEY];
      session = { ...session, metadata: { ...(session.metadata ?? {}), [LAST_LISTING_METADATA_KEY]: withLabelledListing(current, 'owner', source, items, at(minute), 'listing') } };
    },
    decide(text: string, now: IsoTimestamp = at(1)): Promise<NlSelectionDecision> {
      return service.decide({
        direct: true,
        text,
        attachmentCount: 0,
        session,
        actor,
        now,
        entries: ALL,
        route: 'chat',
        chatProviderId: 'scripted',
        turnId: 'turn-1',
      });
    },
  };
}

const actionLogs = (w: ReturnType<typeof world>) => w.logs.filter((log) => log.event === NL_ACTION_LOG_EVENT);

describe('QUOKY_NL_ITEM_R2 startup and the §7 table', () => {
  it('refuses a sub-flag without an action level', () => {
    const actors = { get: async () => null, save: async (a: Actor) => a };
    const logger = { info() {}, warn() {}, error() {} };
    const build = (itemR2: NlItemR2Level) =>
      new NlSelectionService({ mode: 'active', router: { select: async () => ({}) as AiProvider }, sessions: { updateMetadataEntry: async () => null }, actors, timeZone: 'Asia/Seoul', logger, actions: { level: 'off', itemR2 } });
    for (const level of ['shadow', 'jira', 'all'] as const) {
      expect(() => build(level)).toThrow(NlActionsConfigError);
      expect(() => build(level)).toThrow(/NL_ITEM_R2_REQUIRES_ACTIONS/);
    }
    expect(() => build('off')).not.toThrow();
  });

  it('itemR2Acts follows the proposal table', () => {
    expect(itemR2Acts('local', 'jira', 'jira')).toBe(true);
    expect(itemR2Acts('local', 'jira', 'slack')).toBe(false);
    expect(itemR2Acts('local', 'all', 'jira')).toBe(true);
    expect(itemR2Acts('local', 'all', 'slack')).toBe(true);
    expect(itemR2Acts('local', 'shadow', 'jira')).toBe(false);
    expect(itemR2Acts('local', 'shadow', 'slack')).toBe(false);
    expect(itemR2Acts('local', 'off', 'jira')).toBe(false);
    for (const itemR2 of ['off', 'shadow', 'jira', 'all'] as const) {
      expect(itemR2Acts('shadow', itemR2, 'jira')).toBe(false);
      expect(itemR2Acts('shadow', itemR2, 'slack')).toBe(false);
      expect(itemR2Acts('off', itemR2, 'jira')).toBe(false);
    }
  });

  it('reports the configured sub-flag', () => {
    expect(world({ level: 'local', itemR2: 'jira', script: [] }).service.itemR2Level()).toBe('jira');
    expect(world({ level: 'local', script: [] }).service.itemR2Level()).toBe('off');
  });
});

describe('item.summarize over jira and slack by sub-flag', () => {
  const jiraSelection = () => out('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' });
  const slackSelection = () => out('item.summarize', { source: 'slack', ref: '#1', mode: 'summary' });

  it('local + itemR2 shadow resolves and logs shadow, never executes', async () => {
    const w = world({ level: 'local', itemR2: 'shadow', script: [jiraSelection()] });
    w.setListing('jira', JIRA);
    const decision = await w.decide('2번 이슈 요약해줘');
    expect(decision).toEqual({ kind: 'none' });
    const logs = actionLogs(w);
    expect(logs.at(-1)?.fields).toMatchObject({ entryId: 'item.summarize', result: 'shadow' });
    expect(logs.some((log) => log.fields?.result === 'executed')).toBe(false);
  });

  it('itemR2 jira executes a jira selection with the resolved target', async () => {
    const w = world({ level: 'local', itemR2: 'jira', script: [jiraSelection()] });
    w.setListing('jira', JIRA);
    const decision = await w.decide('2번 이슈 요약해줘');
    expect(decision).toMatchObject({
      kind: 'execute',
      command: { entryId: 'item.summarize', args: { source: 'jira', mode: 'summary' }, target: { source: 'jira', id: 'PROJ-14:10014', label: 2 } },
    });
  });

  it('itemR2 jira treats a slack selection as shadow', async () => {
    const w = world({ level: 'local', itemR2: 'jira', script: [slackSelection()] });
    w.setListing('slack', SLACK);
    expect(await w.decide('1번 슬랙 메시지 요약해줘')).toEqual({ kind: 'none' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ entryId: 'item.summarize', result: 'shadow' });
  });

  it('itemR2 all executes slack', async () => {
    const w = world({ level: 'local', itemR2: 'all', script: [slackSelection()] });
    w.setListing('slack', SLACK);
    expect(await w.decide('1번 슬랙 메시지 요약해줘')).toMatchObject({ kind: 'execute', command: { target: { source: 'slack', id: 'C1:1700000000.000100' } } });
  });

  it('the shadow action level never executes jira even with itemR2 all', async () => {
    const w = world({ level: 'shadow', itemR2: 'all', script: [jiraSelection()] });
    w.setListing('jira', JIRA);
    expect(await w.decide('2번 이슈 요약해줘')).toEqual({ kind: 'none' });
    expect(actionLogs(w).at(-1)?.fields).toMatchObject({ result: 'shadow' });
  });
});

describe('ITEM_READ caps', () => {
  it('30 per hour and at most 100 per day by default', () => {
    expect(NL_ACTION_CAPS.itemReadPerHour).toBe(30);
    expect(NL_ACTION_CAPS.itemReadPerDay).toBe(100);
    const caps = new NlActionCaps();
    const hour = 60 * 60_000;
    // 3 per hour-slot spread over a day never hits the hourly cap; the daily cap stops the 101st.
    let now = 0;
    for (let i = 0; i < 100; i += 1) {
      expect(caps.allows('a', 'ITEM_READ', now)).toBe(true);
      caps.note('a', 'ITEM_READ', now);
      now += 14 * 60_000;
    }
    expect(now).toBeLessThan(24 * hour);
    expect(caps.allows('a', 'ITEM_READ', now)).toBe(false);
    expect(caps.allows('b', 'ITEM_READ', now)).toBe(true);
    // The first read has left the 24 h window.
    expect(caps.allows('a', 'ITEM_READ', 24 * hour + 1)).toBe(true);
  });

  it('30 within one hour is refused', () => {
    const caps = new NlActionCaps();
    for (let i = 0; i < 30; i += 1) caps.note('a', 'ITEM_READ', i);
    expect(caps.allows('a', 'ITEM_READ', 31)).toBe(false);
  });

  it('custom caps without itemReadPerDay still default the day to 100', () => {
    const caps = new NlActionCaps({ localWritePerHour: 1000, localWritePerDay: 1000, itemReadPerHour: 1000, externalPerHour: 1, externalPerDay: 1 });
    for (let i = 0; i < 99; i += 1) caps.note('a', 'ITEM_READ', i * 1000);
    expect(caps.allows('a', 'ITEM_READ', 100_000)).toBe(true);
    caps.note('a', 'ITEM_READ', 100_000);
    expect(caps.allows('a', 'ITEM_READ', 101_000)).toBe(false);
  });

  it('an explicit itemReadPerDay is honoured', () => {
    const caps = new NlActionCaps({ ...NL_ACTION_CAPS, itemReadPerDay: 2 });
    caps.note('a', 'ITEM_READ', 0);
    caps.note('a', 'ITEM_READ', 1);
    expect(caps.allows('a', 'ITEM_READ', 2)).toBe(false);
  });
});

describe('recordActionReceipt for item.summarize over jira', () => {
  const message = { id: 'in-1', context: { platform: 'test', channelId: 'dm' } as never };
  const executed = (extra: Record<string, unknown> = {}) => ({ entryId: 'item.summarize' as const, result: 'executed' as const, source: 'jira' as const, itemId: 'PROJ-14:10014', label: 2, ...extra });
  const decided = {
    entryId: 'item.summarize' as const,
    risk: 'ITEM_READ' as const,
    refKind: 'index' as const,
    resolution: 'resolved' as const,
    result: 'executed' as const,
    target: { source: 'jira' as const, id: 'PROJ-14:10014', label: 2, listingAt: at(0) },
  };

  it('writes quoky.lastRead when itemR2 is not off', async () => {
    const w = world({ level: 'local', itemR2: 'jira', script: [] });
    await w.service.recordActionReceipt({ session: w.session(), actor: w.actor, message, now: at(1), action: executed(), decided });
    expect(w.session().metadata?.[LAST_READ_METADATA_KEY]).toEqual({
      byActor: { owner: { source: 'jira', id: 'PROJ-14:10014', label: 2, listingAt: at(0), at: at(1) } },
    });
  });

  it('writes nothing while itemR2 is off', async () => {
    const w = world({ level: 'local', script: [] });
    await w.service.recordActionReceipt({ session: w.session(), actor: w.actor, message, now: at(1), action: executed(), decided });
    expect(w.session().metadata?.[LAST_READ_METADATA_KEY]).toBeUndefined();
  });

  it('writes nothing for a refused read or for a mail item', async () => {
    const w = world({ level: 'local', itemR2: 'all', script: [] });
    await w.service.recordActionReceipt({ session: w.session(), actor: w.actor, message, now: at(1), action: executed({ result: 'refused', reason: 'not-found' }), decided });
    await w.service.recordActionReceipt({ session: w.session(), actor: w.actor, message, now: at(1), action: executed({ source: 'mail', itemId: 'm1' }) });
    expect(w.session().metadata?.[LAST_READ_METADATA_KEY]).toBeUndefined();
  });

  it('the decided line carries fetchOutcome, fetchCount and fetchBytes when the receipt has a fetch', async () => {
    const w = world({ level: 'local', itemR2: 'jira', script: [] });
    await w.service.recordActionReceipt({ session: w.session(), actor: w.actor, message, now: at(1), action: executed({ fetch: { outcome: 'ok', count: 2, bytes: '<4k' } }), decided });
    const line = actionLogs(w).at(-1)?.fields;
    expect(line).toMatchObject({ entryId: 'item.summarize', result: 'executed', fetchOutcome: 'ok', fetchCount: 2, fetchBytes: '<4k' });
    expect(JSON.stringify(line)).not.toContain('PROJ');
    const bare = world({ level: 'local', itemR2: 'jira', script: [] });
    await bare.service.recordActionReceipt({ session: bare.session(), actor: bare.actor, message, now: at(1), action: executed(), decided });
    expect(actionLogs(bare).at(-1)?.fields).not.toHaveProperty('fetchOutcome');
  });
});
