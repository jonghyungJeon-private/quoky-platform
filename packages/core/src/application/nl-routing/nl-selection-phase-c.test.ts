import { describe, expect, it } from 'vitest';
import { Capability, type Actor, type Session } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest, LogFields, Logger } from '../../ports';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry, type NlClassBProbe } from './catalog';
import { NlSelectionService, type NlIntentMode, type NlPhase, type NlSelectionDecision, type NlSelectionRoute } from './nl-selection-service';
import { NL_WAVE1_ENTRIES } from './wave1-entries';

// ADR-0120 D6 Phase C / ADR-0121 S1 at the service level, with a scripted stub selector (no model): the phase switch,
// the S1 locality hardening (equal family AND equal execution locality), and the content-free D10/D11 agreement log.

const T0 = '2026-10-13T03:00:00.000Z';
const ALL: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const out = (entryId: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [], ...extra });

function harness(options: { mode?: NlIntentMode; phase?: NlPhase; script?: string[]; locality?: AiExecutionLocality; family?: string; fail?: boolean } = {}) {
  const calls: AiRequest[] = [];
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const script = [...(options.script ?? [])];
  let session: Session = {
    id: 'sess-c',
    actorId: 'owner',
    context: { platform: 'test', channelId: 'dm-1', userId: 'u', direct: true },
    status: 'ACTIVE' as Session['status'],
    createdAt: T0,
    lastActivityAt: T0,
  };
  const actor: Actor = { id: 'owner', displayName: 'Owner', identities: [], createdAt: T0 };
  const provider: AiProvider = {
    id: 'scripted-selector',
    ...(options.family !== undefined ? { family: options.family } : {}),
    ...(options.locality !== undefined ? { executionLocality: options.locality } : {}),
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    async isAvailable() {
      return true;
    },
    async execute(request) {
      calls.push(request);
      if (options.fail === true) throw new Error('selector down');
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
  const service = new NlSelectionService({
    mode: options.mode ?? 'active',
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
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
    actors: { get: async () => actor, save: async (next) => next },
    timeZone: 'Asia/Seoul',
    logger,
  });
  const decide = (
    text: string,
    opts: { grammar?: NlClassBProbe; route?: NlSelectionRoute; chatProviderId?: string; chatProviderLocality?: AiExecutionLocality } = {},
  ): Promise<NlSelectionDecision> =>
    service.decide({
      text,
      attachmentCount: 0,
      session,
      actor,
      now: T0,
      entries: ALL,
      route: opts.route ?? (opts.grammar !== undefined ? 'class-b' : 'chat'),
      chatProviderId: opts.chatProviderId ?? options.family ?? 'scripted-selector',
      ...(opts.chatProviderLocality !== undefined ? { chatProviderLocality: opts.chatProviderLocality } : {}),
      ...(opts.grammar !== undefined ? { grammar: opts.grammar } : {}),
    });
  return { service, calls, logs, decide };
}

const agreementLines = (logs: Array<{ event: string; fields?: LogFields }>) => logs.filter((log) => log.event === 'nl_selection.agreement').map((log) => log.fields ?? {});

describe('NlSelectionService — Phase C switch (ADR-0120 D6, ADR-0121 S1)', () => {
  it('phaseCEnabled only with QUOKY_NL_PHASE=c in active or shadow; Phase A is the default', () => {
    const cases: Array<[NlIntentMode, NlPhase | undefined, boolean]> = [
      ['off', 'c', false],
      ['shadow', 'c', true],
      ['active', 'c', true],
      ['active', 'a', false],
      ['active', undefined, false],
      ['shadow', undefined, false],
    ];
    for (const [mode, phase, expected] of cases) {
      expect(harness({ mode, ...(phase !== undefined ? { phase } : {}) }).service.phaseCEnabled(), `${mode}/${phase ?? 'default'}`).toBe(expected);
    }
  });
});

describe('NlSelectionService — S1 locality hardening (NL-1 residual)', () => {
  it('an equal family with a different execution locality is refused before any call', async () => {
    const local = harness({ family: 'claude-cli', locality: 'LOCAL', script: [out('jira.issues')] });
    expect(await local.decide('내 지라 이슈', { chatProviderId: 'claude-cli', chatProviderLocality: 'REMOTE' })).toEqual({ kind: 'skip', reason: 'chat-locality-differs' });
    expect(local.calls).toHaveLength(0);
    expect(await local.decide('내 지라 이슈', { chatProviderId: 'claude-cli', chatProviderLocality: 'LOCAL' })).toMatchObject({ kind: 'execute' });
    expect(local.calls).toHaveLength(1);

    const remote = harness({ family: 'claude-cli', script: [out('jira.issues')] });
    expect(await remote.decide('내 지라 이슈', { chatProviderId: 'claude-cli', chatProviderLocality: 'LOCAL' })).toEqual({ kind: 'skip', reason: 'chat-locality-differs' });
    // An absent locality on either side is `REMOTE` (the executionLocalityOf default).
    expect(await remote.decide('내 지라 이슈', { chatProviderId: 'claude-cli' })).toMatchObject({ kind: 'execute' });
    expect(remote.calls).toHaveLength(1);
  });

  it('the warm-up and the A2 yield check apply the same rule', async () => {
    const h = harness({ family: 'claude-cli', locality: 'LOCAL' });
    expect(await h.service.warmUp({ chatProviderId: 'claude-cli', chatProviderLocality: 'REMOTE' })).toBe('skipped');
    expect(h.calls).toHaveLength(0);
    const yieldService = new NlSelectionService({
      mode: 'active',
      grammarYield: true,
      router: { select: async () => ({ id: 'x', family: 'claude-cli', executionLocality: 'LOCAL', capabilities: [], isAvailable: async () => true, execute: async () => ({ text: '', artifacts: [] }) }) },
      sessions: { updateMetadataEntry: async () => null },
      actors: { get: async () => null, save: async (actor) => actor },
      timeZone: 'Asia/Seoul',
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    expect(await yieldService.yieldsToSelection('claude-cli', 'REMOTE')).toBe(false);
    expect(await yieldService.yieldsToSelection('claude-cli', 'LOCAL')).toBe(true);
  });
});

describe('NlSelectionService — D10/D11 agreement log (content-free)', () => {
  const grammar: NlClassBProbe = { grammarId: 'work-lookup.my-items', selection: { entryId: 'jira.issues', args: { keyword: '위클리카' } } };

  it('active: logs grammar id, entry ids, the outcome and the agree flags — never the text or an argument value', async () => {
    const h = harness({
      phase: 'c',
      script: [
        out('jira.issues', { keyword: '위클리카' }),
        out('jira.issues', { keyword: '위클리카', status: 'in-progress' }),
        out('github.items', { keyword: '위클리카' }),
        out('none'),
        out('jira.issues', { keyword: '위클리카' }, { ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: { keyword: '위클리카' } }] }),
      ],
    });
    const texts = ['위클리카 관련 지라 이슈 보여줘', '위클리카 진행중인 지라 이슈', '위클리카 깃허브 지라 이슈 보여줘', '위클리카 관련 지라 이슈 보여줘요', '위클리카 지라랑 깃허브 이슈 보여줘'];
    for (const text of texts) await h.decide(text, { grammar });
    expect(agreementLines(h.logs)).toEqual([
      expect.objectContaining({ grammarId: 'work-lookup.my-items', grammarEntryId: 'jira.issues', entryId: 'jira.issues', outcome: 'execute', mode: 'active', agree: true, agreeEntry: true }),
      expect.objectContaining({ entryId: 'jira.issues', outcome: 'execute', agree: false, agreeEntry: true }),
      expect.objectContaining({ entryId: 'github.items', outcome: 'execute', agree: false, agreeEntry: false }),
      expect.objectContaining({ entryId: 'none', outcome: 'none', agree: false, agreeEntry: false }),
      expect.objectContaining({ entryId: 'none', outcome: 'ask', agree: false, agreeEntry: false }),
    ]);
    assertContentFree(agreementLines(h.logs), [...texts, '위클리카', 'in-progress']);
  });

  it('fallback causes are logged without an agree flag (they are not agreement data); no line without a grammar probe', async () => {
    const down = harness({ phase: 'c', fail: true });
    expect(await down.decide('위클리카 관련 지라 이슈 보여줘', { grammar })).toEqual({ kind: 'unavailable' });
    const tooLong = harness({ phase: 'c' });
    expect(await tooLong.decide(`지라 이슈 ${'가'.repeat(700)}`, { grammar })).toEqual({ kind: 'skip', reason: 'too-long' });
    const credential = harness({ phase: 'c' });
    expect(await credential.decide('지라 이슈 ghp_' + 'a'.repeat(36), { grammar })).toEqual({ kind: 'skip', reason: 'credential' });
    const family = harness({ phase: 'c' });
    expect(await family.decide('지라 이슈 보여줘', { grammar, chatProviderId: 'other-family' })).toEqual({ kind: 'skip', reason: 'chat-provider-differs' });
    for (const [h, reason] of [[down, 'failed'], [tooLong, 'too-long'], [credential, 'credential'], [family, 'chat-provider-differs']] as const) {
      const lines = agreementLines(h.logs);
      expect(lines, reason).toHaveLength(1);
      expect(lines[0], reason).toMatchObject({ grammarId: 'work-lookup.my-items', outcome: 'fallback', reason });
      expect(lines[0], reason).not.toHaveProperty('agree');
    }
    expect(credential.calls).toHaveLength(0);
    const plain = harness({ phase: 'c', script: [out('jira.issues')] });
    await plain.decide('지라 쪽 내 건들 훑어볼래');
    expect(agreementLines(plain.logs)).toEqual([]);
  });

  it('shadow (grammar-hit shadowing): the decision is skip, the selection runs in the background and logs only the agreement', async () => {
    const h = harness({ mode: 'shadow', phase: 'c', script: [out('jira.issues', { keyword: '위클리카' })] });
    expect(await h.decide('위클리카 관련 지라 이슈 보여줘', { grammar })).toEqual({ kind: 'skip', reason: 'shadow' });
    await h.service.lastShadowRun;
    expect(h.calls).toHaveLength(1);
    expect(agreementLines(h.logs)).toEqual([expect.objectContaining({ outcome: 'execute', mode: 'shadow', agree: true, agreeEntry: true })]);
    assertContentFree(agreementLines(h.logs), ['위클리카 관련 지라 이슈 보여줘', '위클리카']);
  });
});

/** Every field is a closed id, a flag or a number; no owner text or argument value appears in any field. */
function assertContentFree(lines: readonly LogFields[], forbidden: readonly string[]): void {
  const allowed = new Set(['grammarId', 'grammarEntryId', 'entryId', 'outcome', 'mode', 'agree', 'agreeEntry', 'reason', 'latencyMs', 'cached']);
  for (const line of lines) {
    for (const [key, value] of Object.entries(line)) {
      expect(allowed.has(key), key).toBe(true);
      expect(['string', 'boolean', 'number'].includes(typeof value), key).toBe(true);
      if (typeof value === 'string') {
        expect(value, key).toMatch(/^[a-z0-9.-]+$/);
        for (const text of forbidden) expect(value.includes(text), `${key} carries content`).toBe(false);
      }
    }
  }
}

describe('selection prompt — S1 narrowing follow-up rule', () => {
  it('tells the selector that a narrowing follow-up with no previous selection is a clarification, never CLEAR or none', async () => {
    const { buildSelectionPrompt, NL_SELECTION_PROMPT_VERSION } = await import('./selection-prompt');
    const prompt = buildSelectionPrompt({ entries: ALL, text: '그 중에 스크럼만' });
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v17');
    expect(prompt).toContain('A narrowing follow-up');
    expect(prompt).toContain('never CLEAR, never none');
    expect(prompt.split('\n').filter((line) => line.startsWith('Previous selection:')).at(-1)).toBe('Previous selection: none');
  });
});
