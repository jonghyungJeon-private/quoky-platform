import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeGmailTokenFile } from '@quoky/connector-gmail';
import { writeGDriveTokenFile } from '@quoky/connector-gdrive';
import type {
  Actor,
  AiProvider,
  AiRequest,
  CalendarEventQuery,
  ConnectorProvider,
  ConnectorQuery,
  ConversationContext,
  ConversationTurnHandler,
  InboundMessage,
  Intent,
  NlArgs,
  NlSelectedCommand,
  StorageProvider,
  TurnResult,
} from '@quoky/core';

/**
 * ADR-0120 NL-1 end to end, offline: the REAL `AppModule` (every production feature composition, the real turn-handler
 * registry, the real `IntentClassifier`, the real `NlSelectionService` in `active` mode and the real handlers'
 * `handleSelected`) over a real SQLite file. Only the edges are stubbed: the AI providers (the `INTENT_SELECTION` call
 * returns a scripted answer — the golden answer of the case — and every other call a fixed chat reply), the four work
 * connectors, and the calendar, mail and Drive readers. Nothing leaves the process.
 *
 * - Every case of `golden/nl-intent.v1.json` is sent through `ConversationRuntime.handle()`. A positive must end in its
 *   entry: through selection (`handleSelected` with exactly the golden args) or, when a frozen Class B grammar answers
 *   first (Phase A), through that grammar — and then the selector is never called. A negative never reaches a
 *   `handleSelected`. Whenever the selector runs, `IntentClassifier.classify` already ran in that turn (D6).
 * - Scenario tests: the owner's two phrases and the follow-ups end to end (ask once, basis line, refinement, override),
 *   Class A precedence, the provider-down fallback, the pre-egress credential guard, pasted-content injection, DM-only
 *   entries in a channel, and `off` / `shadow`.
 */

const OWNER = '111111111111111111';
const ENV_PREFIXES = /^(?:QUOKY_|CHUNSIK_|DISCORD_)/;
const SELECTION = 'INTENT_SELECTION';
const CHAT_REPLY = 'NL-1 stub chat reply';

interface GoldenCase {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: { readonly entryId: string; readonly args: NlArgs };
  readonly channel?: boolean;
  /** S1: the frozen Class B grammar that answers this case in Phase A with QUOKY_NL_GRAMMAR_YIELD=on (production). */
  readonly grammar?: string;
  /** S1: that grammar's own catalog equivalent (null: none), the eval's grammar-side scoring input. */
  readonly grammarAnswer?: { readonly entryId: string; readonly args: NlArgs } | null;
  /**
   * The Class B grammar that answers this case with QUOKY_NL_GRAMMAR_YIELD=off when it differs from `grammar` (an earlier
   * grammar that the A2 yield makes decline; ADR-0120 A2 implementation note 2). Absent: `grammar`.
   */
  readonly grammarYieldOff?: string;
}

const CORPUS = JSON.parse(
  readFileSync(join(__dirname, '../../../../packages/core/src/application/golden/nl-intent.v1.json'), 'utf8'),
) as { cases: GoldenCase[] };

/**
 * Phase A (ADR-0120 D6): an earlier route answers these before selection may run — a frozen Class B grammar, the
 * classifier's personal-work surface or a Class A command — with a neighbouring capability. They become Phase C corpus
 * evidence (NL-2); pinned here so any change in the earlier routes is visible.
 */
const EARLIER_ROUTE: Readonly<Record<string, string>> = {
  'brief-017': 'todo.list',
  'help-014': 'calendar.events',
  'help-025': 'class-a:PROJECT_ANALYSIS',
  // S1 corpus: the to-do list grammar answers this how-to question with the list (Phase C selects help.topic).
  'help-038': 'todo.list',
};

const none = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
const answer = (entryId: string, args: NlArgs = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });

describe('ADR-0120 NL-1 — natural-language selection through the production AppModule (offline)', () => {
  let tempDir = '';
  let savedEnv: NodeJS.ProcessEnv = {};
  let closeApp: (() => Promise<void>) | undefined;
  let core: typeof import('@quoky/core');
  let runtime: { handle(message: InboundMessage): Promise<TurnResult> };
  let storage: StorageProvider;
  let sessions: import('@quoky/core').SessionManager;
  let ownerActor: Actor;
  let selectorAnswer: string | (() => never) = none;
  let failSelected = false;
  const requests: AiRequest[] = [];
  const order: string[] = [];
  const selected: Array<{ handlerId: string; command: NlSelectedCommand }> = [];
  const selectedOutcomes: string[] = [];
  const claims: Array<{ handlerId: string; kind: string }> = [];
  const deskCommands: Array<{ kind: string; source?: string }> = [];
  const intents: Intent[] = [];
  const connectorQueries: Array<{ source: string; query: ConnectorQuery }> = [];
  const readerCalls: string[] = [];
  /** Phase C: every `classBProbe` call (handler id and whether it was a hit). */
  const probes: Array<{ handlerId: string; grammarId?: string; entryId?: string; selection?: { entryId: string; args: NlArgs } }> = [];
  let seq = 0;

  beforeAll(async () => {
    for (const method of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
    savedEnv = { ...process.env };
    for (const key of Object.keys(process.env)) if (ENV_PREFIXES.test(key)) delete process.env[key];
    tempDir = mkdtempSync(join(tmpdir(), 'quoky-nl1-'));
    const gmailToken = join(tempDir, 'gmail.json');
    const driveToken = join(tempDir, 'drive.json');
    writeGmailTokenFile(gmailToken, 'nl1-gmail-refresh-placeholder');
    writeGDriveTokenFile(driveToken, 'nl1-drive-refresh-placeholder');
    Object.assign(process.env, {
      QUOKY_DISCORD_OWNER_IDS: OWNER,
      QUOKY_DB_PATH: join(tempDir, 'quoky.db'),
      QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
      QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
      QUOKY_OLLAMA_ENABLED: 'false',
      CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
      QUOKY_REMINDERS_ENABLED: 'true',
      QUOKY_TIMEZONE: 'Asia/Seoul',
      QUOKY_CALENDAR_GOOGLE_CLIENT_ID: 'nl1-calendar-client',
      QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET: 'nl1-calendar-client-placeholder',
      QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN: 'nl1-calendar-refresh-placeholder',
      QUOKY_GMAIL_TOKEN_FILE: gmailToken,
      QUOKY_DRIVE_TOKEN_FILE: driveToken,
      QUOKY_NL_INTENT_MODE: 'active',
    });
    vi.resetModules();
    core = await import('@quoky/core');
    const { AppModule } = await import('../app.module');
    const { stubProviderSelection } = await import('../provider-selection/test-support');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    storage = app.get<StorageProvider>(core.STORAGE_PROVIDER);
    await storage.init();
    await app.get<{ init(): Promise<void> }>(core.VECTOR_PROVIDER).init();
    closeApp = async () => {
      await storage.close().catch(() => undefined);
      await app.close();
    };

    const stub = (provider: AiProvider): void => {
      Object.assign(provider, {
        async isAvailable() {
          return true;
        },
        async execute(request: AiRequest) {
          requests.push(request);
          if (request.capability === SELECTION) {
            order.push('select');
            const scripted = selectorAnswer;
            return { text: typeof scripted === 'function' ? scripted() : scripted, artifacts: [] };
          }
          order.push(`provider:${request.capability}`);
          return { text: CHAT_REPLY, artifacts: [] };
        },
      });
    };
    for (const provider of app.get<AiProvider[]>(core.AI_PROVIDERS)) stub(provider);
    stubProviderSelection(app, stub);

    // The four work connectors, read-only fakes (the production array is shared by the work desk).
    const connectors = app.get<ConnectorProvider[]>(core.CONNECTOR_PROVIDERS);
    for (const source of ['jira', 'github', 'slack', 'confluence']) {
      connectors.push({
        source,
        readOnly: true,
        async isAvailable() {
          return true;
        },
        async query(query: ConnectorQuery) {
          connectorQueries.push({ source, query });
          return {
            source,
            items: [
              { id: `${source.toUpperCase()}-1`, title: `${source} 위클리카 정산 화면`, url: `https://${source}.example.invalid/1`, status: 'Open' },
              { id: `${source.toUpperCase()}-2`, title: `${source} 로그인 오류`, url: `https://${source}.example.invalid/2`, status: 'Open' },
            ],
          };
        },
      });
    }
    Object.assign(app.get(core.CALENDAR_READER) as object, {
      async listEvents(query: CalendarEventQuery) {
        readerCalls.push(`calendar:${query.from}..${query.to}`);
        return [];
      },
    });
    Object.assign(app.get(core.MAIL_READER) as object, {
      async search() {
        readerCalls.push('mail:search');
        return { messages: [], matched: 0, matchedIsLowerBound: false };
      },
      async getMessage() {
        throw new Error('offline');
      },
    });
    Object.assign(app.get(core.DRIVE_READER) as object, {
      async searchByName() {
        readerCalls.push('drive:search');
        return { files: [], matched: 0, matchedIsLowerBound: false };
      },
      async recentFiles() {
        readerCalls.push('drive:recent');
        return { files: [], matched: 0, matchedIsLowerBound: false };
      },
      async exportText() {
        throw new Error('offline');
      },
    });

    for (const handler of app.get<readonly ConversationTurnHandler[]>(core.CONVERSATION_TURN_HANDLERS)) {
      const handle = handler.handle.bind(handler);
      vi.spyOn(handler, 'handle').mockImplementation(async (ctx) => {
        const outcome = await handle(ctx);
        if (outcome !== null) claims.push({ handlerId: handler.id, kind: (outcome as { kind?: string }).kind ?? 'reply' });
        return outcome;
      });
      const probe = handler.classBProbe?.bind(handler);
      if (probe !== undefined) {
        (handler as { classBProbe?: ConversationTurnHandler['classBProbe'] }).classBProbe = (ctx) => {
          const hit = probe(ctx);
          probes.push({ handlerId: handler.id, ...(hit !== null ? { grammarId: hit.grammarId, ...(hit.selection !== undefined ? { entryId: hit.selection.entryId, selection: { entryId: hit.selection.entryId, args: { ...hit.selection.args } } } : {}) } : {}) });
          return hit;
        };
      }
      const serve = handler.handleSelected?.bind(handler);
      if (serve !== undefined) {
        (handler as { handleSelected?: ConversationTurnHandler['handleSelected'] }).handleSelected = async (command, ctx) => {
          selected.push({ handlerId: handler.id, command });
          const outcome = await serve(command, ctx);
          selectedOutcomes.push(outcome === null ? 'null' : (outcome as { kind?: string }).kind ?? 'reply');
          return failSelected && outcome !== null ? ({ ...outcome, status: 'FAILED' } as typeof outcome) : outcome;
        };
      }
    }
    const desk = app.get(core.WorkChatService);
    const deskHandle = desk.handle.bind(desk);
    vi.spyOn(desk, 'handle').mockImplementation(async (command, actor) => {
      deskCommands.push(command as { kind: string; source?: string });
      return deskHandle(command, actor);
    });
    const classifier = app.get(core.IntentClassifier);
    const classify = classifier.classify.bind(classifier);
    vi.spyOn(classifier, 'classify').mockImplementation(async (message, ctx) => {
      order.push('classify');
      const intent = await classify(message, ctx);
      intents.push(intent);
      return intent;
    });
    runtime = app.get(core.ConversationRuntime);
    sessions = app.get(core.SessionManager);

    // The owner Actor (created on first contact) gets its Jira/GitHub identities and the D7 preference for the corpus run.
    await send('안녕');
    const actor = await storage.actors.findByExternalIdentity('discord', OWNER);
    if (actor === null) throw new Error('owner actor missing');
    ownerActor = await storage.actors.save({
      ...actor,
      identities: [...actor.identities, { platform: 'jira', externalId: 'jira-owner-account' }, { platform: 'github', externalId: 'octo-owner' }],
      metadata: { [core.INTERPRETATION_PREFERENCES_METADATA_KEY]: { 'jira.created-scope': { value: 'either', at: new Date().toISOString() } } },
    });
  }, 120_000);

  afterAll(async () => {
    await closeApp?.();
    process.env = savedEnv;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function context(direct = true): ConversationContext {
    seq += 1;
    const n = String(seq).padStart(6, '0');
    return direct
      ? { platform: 'discord', channelId: `880000000000${n}`, userId: OWNER, direct: true }
      : { platform: 'discord', spaceId: '999999999999999901', channelId: `770000000000${n}`, userId: OWNER, direct: false };
  }

  async function send(text: string, ctx: ConversationContext = context()): Promise<TurnResult> {
    seq += 1;
    return runtime.handle({ id: `nl1-${seq}`, context: ctx, text, receivedAt: new Date().toISOString() });
  }

  /** Amendment A2: flip the grammar-yield flag (and optionally the mode) on the live service for one scenario. */
  async function withGrammarYield<T>(yieldOn: boolean, mode: 'off' | 'shadow' | 'active', run: () => Promise<T>): Promise<T> {
    const service = (runtime as unknown as { deps: { nlSelection: { mode: string; deps: { grammarYield?: boolean } } } }).deps.nlSelection;
    const saved = { mode: service.mode, flag: service.deps.grammarYield };
    service.mode = mode;
    service.deps.grammarYield = yieldOn;
    try {
      return await run();
    } finally {
      service.mode = saved.mode;
      service.deps.grammarYield = saved.flag;
    }
  }

  /** S1: switch the live service to Phase C (and a mode) for one scenario; the selection cache is cleared on entry. */
  async function withPhase<T>(phase: 'a' | 'c' | 'c-shadow', mode: 'off' | 'shadow' | 'active', run: () => Promise<T>): Promise<T> {
    const service = (runtime as unknown as { deps: { nlSelection: { mode: string; cache: Map<string, unknown>; deps: { phase?: string } } } }).deps.nlSelection;
    const saved = { mode: service.mode, phase: service.deps.phase };
    service.mode = mode;
    service.deps.phase = phase;
    service.cache.clear();
    try {
      return await run();
    } finally {
      service.mode = saved.mode;
      service.deps.phase = saved.phase;
      service.cache.clear();
    }
  }

  function marks() {
    return {
      probes: probes.length,
      requests: requests.length,
      order: order.length,
      selected: selected.length,
      claims: claims.length,
      desk: deskCommands.length,
      intents: intents.length,
      connectors: connectorQueries.length,
      readers: readerCalls.length,
    };
  }

  async function setPrior(ctx: ConversationContext, prior: { entryId: string; args: NlArgs }): Promise<void> {
    const session = await sessions.openForContext(ctx, ownerActor.id);
    await sessions.updateMetadataEntry(session, core.LAST_SELECTION_METADATA_KEY, () => ({
      actorId: ownerActor.id,
      entryId: prior.entryId,
      args: { ...prior.args },
      at: new Date().toISOString(),
    }));
  }

  /** The entry a Class B grammar (or the classifier's personal-work surface, or the help control) answered with. */
  function grammarEntry(start: ReturnType<typeof marks>, text: string): string | undefined {
    const claim = claims.slice(start.claims)[0];
    if (claim !== undefined) {
      switch (claim.handlerId) {
        case 'calendar':
          return claim.kind === 'write-draft' ? 'calendar.write' : 'calendar.events';
        case 'mail':
          return 'mail.list';
        case 'drive':
          return 'drive.files';
        case 'reminders':
          return 'reminder.list';
        case 'help-intent':
          return 'help.topic';
        case 'work-chat.todo':
        case 'work-chat.lookup': {
          const desk = deskCommands.slice(start.desk).at(-1);
          if (desk?.kind === 'lookup') return { jira: 'jira.issues', github: 'github.items', slack: 'slack.search', confluence: 'confluence.search' }[desk.source ?? ''];
          if (desk?.kind.startsWith('todo')) return 'todo.list';
          return `work-chat:${desk?.kind ?? '?'}`;
        }
        default:
          return `handler:${claim.handlerId}`;
      }
    }
    const intent = intents.slice(start.intents).at(-1);
    if (intent?.raw?.kind === 'personal-work-surface') return 'todo.list';
    if (/^(?:도움말|help|\/help|명령어)$/i.test(text.trim())) return 'help.topic';
    if (intent !== undefined && intent.type !== 'CHAT') return `class-a:${intent.type}`;
    return undefined;
  }

  it.each([false, true])('dispatches every golden case with QUOKY_NL_GRAMMAR_YIELD=%s: positives end in their entry (selection or Class B), negatives never in a handleSelected', async (yieldOn) => {
    const before = probes.length;
    await withGrammarYield(yieldOn, 'active', () => dispatchCorpus());
    // Phase A (the default, QUOKY_NL_PHASE unset): no Class B probe is ever asked, so dispatch is exactly pre-S1.
    expect(probes.length).toBe(before);
  }, 600_000);

  it.each([false, true])('S1 Phase C, QUOKY_NL_GRAMMAR_YIELD=%s: every golden positive ends in its entry through selection — grammar hits included — with one selector call at most', async (yieldOn) => {
    const report = await withGrammarYield(yieldOn, 'active', () => withPhase('c', 'active', () => dispatchCorpusPhaseC(yieldOn)));
    // ADR-0121 S1 corpus rule: each entry with a frozen Class B grammar has at least 25 phrasings that grammar answers
    // today (production: yield on), so the Phase C evaluation measures the selector on exactly those messages.
    for (const entryId of CLASS_B_ENTRIES) expect(report.grammarHits[entryId] ?? 0, entryId).toBeGreaterThanOrEqual(25);
  }, 600_000);

  async function dispatchCorpus(): Promise<void> {
    const failures: string[] = [];
    const routes = { selection: 0, grammar: 0, negatives: 0 };
    for (const golden of CORPUS.cases) {
      const ctx = context(golden.channel !== true);
      if (golden.prior !== undefined) await setPrior(ctx, golden.prior);
      // A correction ("아니 담당만") overwrites the stored preference (D7); every case starts from the seeded one.
      await seedPreference('either');
      selectorAnswer = golden.expect === 'none' ? none : answer(golden.expect.entryId, golden.expect.args);
      const start = marks();
      let result: TurnResult;
      try {
        result = await send(golden.text, ctx);
      } catch (error) {
        failures.push(`${golden.id}: threw ${String(error).slice(0, 80)}`);
        continue;
      }
      const turnOrder = order.slice(start.order);
      const selectIndex = turnOrder.indexOf('select');
      if (selectIndex >= 0 && !turnOrder.slice(0, selectIndex).includes('classify')) failures.push(`${golden.id}: selection before classify`);
      if (turnOrder.filter((step) => step === 'select').length > 1) failures.push(`${golden.id}: more than one selection call`);
      const served = selected.slice(start.selected);
      if (golden.expect === 'none') {
        routes.negatives += 1;
        if (served.length > 0) failures.push(`${golden.id}: negative reached handleSelected(${served[0]!.command.entryId})`);
        continue;
      }
      const expected = golden.expect;
      if (served.length > 0) {
        routes.selection += 1;
        const command = served[0]!.command;
        const wantArgs: Record<string, unknown> = { ...expected.args };
        // The seeded D7 preference fills the open created-scope.
        if (expected.entryId === 'jira.issues' && expected.args.window === 'created' && expected.args.role === undefined) wantArgs.role = 'either';
        if (command.entryId !== expected.entryId) failures.push(`${golden.id}: selected ${command.entryId}, want ${expected.entryId}`);
        else if (JSON.stringify(sortKeys(command.args)) !== JSON.stringify(sortKeys(wantArgs))) {
          failures.push(`${golden.id}: args ${JSON.stringify(command.args)}, want ${JSON.stringify(wantArgs)}`);
        }
        if (result.status !== 'RESPONDED') failures.push(`${golden.id}: status ${result.status}`);
        if (golden.channel === true && ['mail.list', 'drive.files', 'brief.today'].includes(expected.entryId)) {
          if (!/DM/.test(result.reply.text)) failures.push(`${golden.id}: DM-only entry answered in a channel`);
          if (readerCalls.length !== start.readers) failures.push(`${golden.id}: a reader ran in a channel`);
        }
        continue;
      }
      const grammar = grammarEntry(start, golden.text);
      if (grammar === expected.entryId || (grammar !== undefined && EARLIER_ROUTE[golden.id] === grammar)) {
        routes.grammar += 1;
        if (selectIndex >= 0) failures.push(`${golden.id}: Class B answered but the selector was called`);
        continue;
      }
      failures.push(`${golden.id}: no dispatch (grammar=${grammar ?? '-'}, reply=${result.reply.text.replace(/\s+/g, ' ').slice(0, 60)})`);
    }
    expect(failures).toEqual([]);
    expect(routes.selection + routes.grammar + routes.negatives).toBe(CORPUS.cases.length);
    expect(routes.selection).toBeGreaterThan(100);
    // Every wave-1 entry was served through its handler's handleSelected at least once.
    expect(new Set(selected.map((served) => served.command.entryId))).toEqual(new Set(core.NL_CATALOG_ENTRY_IDS));
  }

  /** The entries a frozen Class B grammar answers in Phase A (the S1 corpus needs >= 25 such phrasings each). */
  const CLASS_B_ENTRIES = ['jira.issues', 'github.items', 'slack.search', 'confluence.search', 'calendar.events', 'mail.list', 'drive.files', 'todo.list', 'help.topic'] as const;

  async function dispatchCorpusPhaseC(yieldOn: boolean): Promise<{ grammarHits: Record<string, number> }> {
    const failures: string[] = [];
    const grammarHits: Record<string, number> = {};
    for (const golden of CORPUS.cases) {
      const ctx = context(golden.channel !== true);
      if (golden.prior !== undefined) await setPrior(ctx, golden.prior);
      await seedPreference('either');
      selectorAnswer = golden.expect === 'none' ? none : answer(golden.expect.entryId, golden.expect.args);
      const start = marks();
      let result: TurnResult;
      try {
        result = await send(golden.text, ctx);
      } catch (error) {
        failures.push(`${golden.id}: threw ${String(error).slice(0, 80)}`);
        continue;
      }
      const turnOrder = order.slice(start.order);
      const selects = turnOrder.filter((step) => step === 'select').length;
      if (selects > 1) failures.push(`${golden.id}: more than one selection call`);
      const hit = probes.slice(start.probes).find((probe) => probe.grammarId !== undefined);
      const workSurface = intents.slice(start.intents).at(-1)?.raw?.kind === 'personal-work-surface';
      // The corpus `grammar` tag is exact for production (yield on); with yield off a grammar also takes qualifier cases.
      // A case that a different, earlier grammar takes with yield off names it explicitly (`grammarYieldOff`).
      const probed = hit?.grammarId ?? (workSurface ? 'work-surface' : undefined);
      const yieldOffTag = golden.grammarYieldOff ?? golden.grammar;
      if (yieldOn ? golden.grammar !== probed : yieldOffTag !== undefined && yieldOffTag !== probed) {
        failures.push(`${golden.id}: corpus grammar tag ${golden.grammar ?? '-'} but the probe says ${probed ?? '-'}`);
      }
      // The recorded grammar answer (the eval's grammar-side scoring) is what the probe says, by meaning (dates resolved).
      if (yieldOn && hit !== undefined) {
        const recorded = golden.grammarAnswer ?? null;
        const live = hit.selection ?? null;
        const entry = core.NL_WAVE1_ENTRIES[(live ?? recorded)?.entryId as keyof typeof core.NL_WAVE1_ENTRIES];
        const now = new Date().toISOString();
        const same =
          recorded === null || live === null
            ? recorded === live
            : core.nlSelectionMeaning(recorded as never, entry, now, 'Asia/Seoul') === core.nlSelectionMeaning(live as never, entry, now, 'Asia/Seoul') ||
              (recorded.entryId === live.entryId && typeof recorded.args.range === 'string' && /^(?:next-)?[a-z]{3}$|^\d{2}-\d{2}$/.test(recorded.args.range));
        if (!same) failures.push(`${golden.id}: recorded grammarAnswer ${JSON.stringify(recorded)} but the probe says ${JSON.stringify(live)}`);
      }
      if (hit !== undefined) {
        // Phase C: at a Class B position the selector runs first — before the grammar's own handle and before classify.
        if (selects !== 1) failures.push(`${golden.id}: Class B hit (${hit.grammarId}) without exactly one selection call`);
        if (turnOrder.indexOf('classify') >= 0 && turnOrder.indexOf('classify') < turnOrder.indexOf('select')) failures.push(`${golden.id}: classify before a Class B selection`);
        if (claims.slice(start.claims).some((claim) => claim.handlerId === hit.handlerId)) failures.push(`${golden.id}: the grammar answered although the selector was up`);
        if (golden.expect !== 'none') grammarHits[golden.expect.entryId] = (grammarHits[golden.expect.entryId] ?? 0) + 1;
      } else if (workSurface && golden.expect !== 'none') {
        grammarHits[golden.expect.entryId] = (grammarHits[golden.expect.entryId] ?? 0) + 1;
      }
      const served = selected.slice(start.selected);
      if (golden.expect === 'none') {
        if (served.length > 0) failures.push(`${golden.id}: negative reached handleSelected(${served[0]!.command.entryId})`);
        continue;
      }
      const expected = golden.expect;
      if (served.length === 0) {
        const grammar = grammarEntry(start, golden.text);
        // Only a Class A route (or the help control phrase) may still answer a positive before selection.
        if (grammar !== undefined && (grammar.startsWith('class-a:') || grammar === 'help.topic' || grammar === 'reminder.list') && claims.slice(start.claims).every((claim) => claim.handlerId !== 'calendar' && claim.handlerId !== 'mail' && claim.handlerId !== 'drive' && claim.handlerId !== 'work-chat.lookup')) continue;
        failures.push(`${golden.id}: not selected (grammar=${grammar ?? '-'}, reply=${result.reply.text.replace(/\s+/g, ' ').slice(0, 60)})`);
        continue;
      }
      const command = served[0]!.command;
      const wantArgs: Record<string, unknown> = { ...expected.args };
      if (expected.entryId === 'jira.issues' && expected.args.window === 'created' && expected.args.role === undefined) wantArgs.role = 'either';
      if (command.entryId !== expected.entryId) failures.push(`${golden.id}: selected ${command.entryId}, want ${expected.entryId}`);
      else if (JSON.stringify(sortKeys(command.args)) !== JSON.stringify(sortKeys(wantArgs))) failures.push(`${golden.id}: args ${JSON.stringify(command.args)}, want ${JSON.stringify(wantArgs)}`);
    }
    expect(failures).toEqual([]);
    return { grammarHits };
  }

  async function seedPreference(value: string): Promise<void> {
    const actor = (await storage.actors.get(ownerActor.id)) as Actor;
    const stored = actor.metadata?.[core.INTERPRETATION_PREFERENCES_METADATA_KEY] as Record<string, { value?: string }> | undefined;
    if (stored?.['jira.created-scope']?.value === value) return;
    await storage.actors.save({
      ...actor,
      metadata: { ...(actor.metadata ?? {}), [core.INTERPRETATION_PREFERENCES_METADATA_KEY]: { 'jira.created-scope': { value, at: new Date().toISOString() } } },
    });
  }

  it.each(['a', 'c'] as const)('adversarial sweep (Phase %s): on every pasted or injection negative a hostile selector cannot write, ground a pasted word or change the preference', async (phase) => {
    await withPhase(phase, 'active', () => adversarialSweep(phase));
  }, 600_000);

  async function adversarialSweep(phase: 'a' | 'c'): Promise<void> {
    const hostile = CORPUS.cases.filter(
      (golden) =>
        golden.expect === 'none' &&
        (/[>`]/.test(golden.text) || /무시|ignore|instruction|지시|system|프롬프트|reveal|삭제|delete|보내|send|실행/i.test(golden.text)),
    );
    expect(hostile.length).toBeGreaterThanOrEqual(15);
    // The first word inside the pasted/quoted part, as a keyword the owner did not write.
    const pastedWord = (text: string) =>
      /```\n?([^\s`"(]+)/u.exec(text)?.[1] ?? /^>\s*(\S+)/mu.exec(text)?.[1] ?? 'zzqx-unseen';
    const failures: string[] = [];
    for (const golden of hostile) {
      const variants: Array<[string, string]> = [
        ['write id', answer('jira.create', { summary: 'x' })],
        ['write id', answer('mail.send', { to: 'Kim' })],
        ['pasted keyword', answer('slack.search', { keyword: pastedWord(golden.text) })],
        ['ungrounded keyword', answer('jira.issues', { keyword: 'zzqx-unseen' })],
        ['unrequested role', answer('jira.issues', { window: 'created', range: 'today', role: 'reporter' })],
        ['plausible wrong read', answer('calendar.events', { range: 'today' })],
      ];
      for (const [label, scripted] of variants) {
        await seedPreference('either');
        selectorAnswer = scripted;
        // Every variant reaches the stub selector (the same text would otherwise be answered from the selection cache).
        (runtime as unknown as { deps: { nlSelection: { cache: Map<string, unknown> } } }).deps.nlSelection.cache.clear();
        const start = marks();
        const outcomes = selectedOutcomes.length;
        let result: TurnResult;
        try {
          result = await send(golden.text);
        } catch (error) {
          failures.push(`${golden.id}/${label}: threw ${String(error).slice(0, 60)}`);
          continue;
        }
        const served = selected.slice(start.selected);
        if (selectedOutcomes.slice(outcomes).some((kind) => kind === 'write-draft')) failures.push(`${golden.id}/${label}: a write draft from selection`);
        for (const { command } of served) {
          if (!core.NL_CATALOG_ENTRY_IDS.includes(command.entryId)) failures.push(`${golden.id}/${label}: served ${command.entryId}`);
          const prepared = core.prepareSelectionInput(golden.text);
          const grounding = 'skip' in prepared ? '' : prepared.groundingText;
          for (const name of ['keyword', 'from', 'name']) {
            const value = command.args[name];
            if (typeof value === 'string' && !core.isGroundedIn(value, grounding)) failures.push(`${golden.id}/${label}: ungrounded ${name}`);
          }
          if (command.args.window === 'created' && command.args.role !== 'either') failures.push(`${golden.id}/${label}: role ${String(command.args.role)}`);
        }
        const stored = ((await storage.actors.get(ownerActor.id))?.metadata?.[core.INTERPRETATION_PREFERENCES_METADATA_KEY] ?? {}) as Record<string, { value?: string }>;
        if (stored['jira.created-scope']?.value !== 'either') failures.push(`${golden.id}/${label}: preference changed`);
        if (typeof result.reply.text !== 'string' || result.reply.text.length === 0) failures.push(`${golden.id}/${label}: empty reply`);
        if ((label === 'write id' || label === 'pasted keyword' || label === 'ungrounded keyword') && served.length > 0) {
          failures.push(`${golden.id}/${label}: executed ${served[0]!.command.entryId}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // Phase C reaches the grammar-hit negatives too (pasted quotes a grammar used to answer): the same rules hold there.
    if (phase === 'c') expect(hostile.some((golden) => golden.grammar !== undefined || /^>/m.test(golden.text))).toBe(true);
  }

  async function withoutPreference(): Promise<void> {
    const actor = (await storage.actors.get(ownerActor.id)) as Actor;
    const { [core.INTERPRETATION_PREFERENCES_METADATA_KEY]: _dropped, ...rest } = actor.metadata ?? {};
    await storage.actors.save({ ...actor, metadata: rest });
  }

  it("owner phrase 1: asks once, answers with the basis line, refines \"그 중에 위클리카만\", and \"아니 담당만\" overrides", async () => {
    await withoutPreference();
    const ctx = context();
    selectorAnswer = answer('jira.issues', { window: 'created', range: 'today' });
    let start = marks();
    const asked = await send('오늘 jira 이슈 등록된거 브리핑해줘', ctx);
    expect(asked.reply.text).toContain('"등록된 이슈"를 어떤 기준으로 볼까요?');
    expect(asked.reply.text).toContain('3. 둘 다 (담당 또는 보고)');
    expect(connectorQueries.length).toBe(start.connectors);

    start = marks();
    const answered = await send('3', ctx);
    expect(requests.slice(start.requests).some((request) => request.capability === SELECTION)).toBe(false);
    expect(answered.reply.text.split('\n')[0]).toBe('기준: 내가 담당·보고자 / 오늘 생성 (30일 동안 이 기준을 써요. 바꾸려면 "아니 담당만"처럼 말해 주세요)');
    const query = connectorQueries.slice(start.connectors)[0]!;
    expect(query.source).toBe('jira');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    expect(query.query.params).toMatchObject({ actorExternalId: 'jira-owner-account', role: 'either', window: { field: 'created', from: today } });
    expect(query.query.params).not.toHaveProperty('status');

    selectorAnswer = answer('jira.issues', { window: 'created', range: 'today', role: 'either', keyword: '위클리카' });
    start = marks();
    const refined = await send('그 중에 위클리카만', ctx);
    expect(refined.reply.text.split('\n')[0]).toBe('기준: 내가 담당·보고자 / 오늘 생성 / "위클리카" 포함');
    expect(requests.slice(start.requests).find((request) => request.capability === SELECTION)?.prompt).toContain(
      'Previous selection: {"entryId":"jira.issues","args":{"role":"either","window":"created","range":"today"}}',
    );
    expect(refined.reply.text).not.toContain('로그인 오류');

    selectorAnswer = answer('jira.issues', { window: 'created', range: 'today', role: 'assignee' });
    start = marks();
    const overridden = await send('아니 담당만', ctx);
    expect(overridden.reply.text.split('\n')[0]).toBe('기준: 내가 담당 / 오늘 생성 (기준을 바꿨어요)');
    expect(connectorQueries.slice(start.connectors)[0]!.query.params).not.toHaveProperty('role');
    const stored = (await storage.actors.get(ownerActor.id))?.metadata?.[core.INTERPRETATION_PREFERENCES_METADATA_KEY];
    expect(stored).toMatchObject({ 'jira.created-scope': { value: 'assignee' } });

    // The preference is per actor: a new conversation (or the other platform) reuses it without asking.
    selectorAnswer = answer('jira.issues', { window: 'created', range: 'today' });
    const reused = await send('오늘 jira 이슈 등록된거 브리핑해줘', context());
    expect(reused.reply.text.split('\n')[0]).toBe('기준: 내가 담당 / 오늘 생성');
  });

  it('owner phrase 2: "오늘 나한테 할당된 jira 이슈가 있을텐데 ?" lists my open assigned issues (the ADR-0100 query) with the basis line', async () => {
    selectorAnswer = answer('jira.issues', { role: 'assignee', range: 'today' });
    const start = marks();
    const result = await send('오늘 나한테 할당된 jira 이슈가 있을텐데 ?');
    expect(result.reply.text.split('\n')[0]).toBe('기준: 내가 담당 / 미해결');
    expect(connectorQueries.slice(start.connectors)[0]!.query.params).toEqual({ actorExternalId: 'jira-owner-account', filter: 'all', limit: 20 });
  });

  it('count questions answer with a count line and the deterministic list (never a summary)', async () => {
    selectorAnswer = answer('jira.issues', { count: true });
    const start = marks();
    const result = await send('지라 티켓 개수가 궁금해');
    expect(selected.length).toBe(start.selected + 1);
    expect(result.reply.text).toContain('Jira 이슈 2개예요.');
    expect(requests.slice(start.requests).filter((request) => request.capability !== SELECTION)).toHaveLength(0);
  });

  it('ADR-0120 A8: an owner release sentence reaches jira.release with the basis line, reads through named queries only and is never summarised; a link off the configured site is never fetched', async () => {
    selectorAnswer = answer('jira.release', { release: '20261015', project: '차란차 운영' });
    const start = marks();
    const result = await send('jira에서 20261015 배포건 뭐 있는지 확인해줘 차란차 운영');
    expect(selected.slice(start.selected).map((entry) => entry.command.entryId)).toEqual(['jira.release']);
    expect(result.reply.text.split('\n')[0]).toBe('기준: 릴리스 "20261015" / 프로젝트 "차란차 운영" / 전체 담당');
    // The fake Jira has no such project: one `containers` read, then the honest not-found answer.
    expect(connectorQueries.slice(start.connectors).map((entry) => entry.query.query)).toEqual(['containers']);
    expect(result.reply.text).toContain('Jira 프로젝트를 찾지 못했어요');
    expect(requests.slice(start.requests).filter((request) => request.capability !== SELECTION)).toHaveLength(0);
    expect(requests.slice(start.requests).find((request) => request.capability === SELECTION)?.prompt).toContain('- jira.release: ');

    // This app configures no Jira site host, so even the owner's real-looking release link is not on it: ignored, nothing read.
    selectorAnswer = answer('jira.release', {});
    const linkStart = marks();
    const linked = await send('https://charancha.atlassian.net/projects/OP26/versions/16555/tab/release-report-all-issues');
    expect(selected.slice(linkStart.selected).map((entry) => entry.command.entryId)).toEqual(['jira.release']);
    expect(connectorQueries.slice(linkStart.connectors)).toHaveLength(0);
    expect(linked.reply.text).toContain('그 링크는 열지 않았어요');
  });

  /** The `Previous selection:` line of the last selector call since `from` (the prompt's own examples carry others). */
  const lastPrevious = (from: number): string | undefined =>
    requests
      .slice(from)
      .filter((request) => request.capability === SELECTION)
      .at(-1)
      ?.prompt.split('\n')
      .filter((line) => line.startsWith('Previous selection:'))
      .at(-1);

  it('follow-up 2, defect 1: a Class B listing becomes the lastSelection, so "그 중에 스크럼만" after the calendar grammar refines the calendar (live sequence)', async () => {
    const ctx = context();
    // 1. The Jira grammar answers (no selector).
    let start = marks();
    await send('내 지라 이슈 보여줘', ctx);
    expect(order.slice(start.order)).not.toContain('select');
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toMatchObject({ entryId: 'jira.issues', args: {} });
    // 2. "그 중에 진행중인거만" runs through NL: the previous selection is the grammar's Jira listing.
    selectorAnswer = answer('jira.issues', { status: 'in-progress' });
    start = marks();
    const second = await send('그 중에 진행중인 것만 보여줘', ctx);
    expect(order.slice(start.order), second.reply.text).toContain('select');
    expect(lastPrevious(start.requests)).toBe('Previous selection: {"entryId":"jira.issues","args":{}}');
    // 3. The calendar grammar answers this week: lastSelection is now the calendar, no longer Jira.
    start = marks();
    await send('이번 주 일정 알려줘', ctx);
    expect(order.slice(start.order)).not.toContain('select');
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toMatchObject({ entryId: 'calendar.events', args: { range: 'this-week' } });
    // 4. "그 중에 스크럼만" refines this week's calendar, not the stale Jira selection.
    selectorAnswer = answer('calendar.events', { range: 'this-week', keyword: '스크럼' });
    start = marks();
    const refined = await send('그 중에 스크럼 일정만', ctx);
    expect(lastPrevious(start.requests)).toBe('Previous selection: {"entryId":"calendar.events","args":{"range":"this-week"}}');
    expect(selected.slice(start.selected).map((served) => served.command.entryId)).toEqual(['calendar.events']);
    expect(refined.reply.text).toContain('스크럼');
    expect(refined.reply.text).not.toContain('Jira');
  });

  it('live UAT R4/R5: a weekday follow-up is a period, never a title keyword; a time-word keyword never sticks to the next period; "회의만" keeps the period', async () => {
    const ctx = context();
    await send('이번 주 일정 알려줘', ctx);
    // The selector wrongly returns the weekday as a keyword: validation refuses it, nothing is served, no keyword is stored.
    selectorAnswer = answer('calendar.events', { range: 'this-week', keyword: '목요일' });
    let start = marks();
    const refused = await send('목요일 거는?', ctx);
    expect(selected.slice(start.selected)).toEqual([]);
    expect(refused.reply.text).not.toContain('"목요일"');
    // The right answer is a period. The question cleared the previous selection, so the owner's "목요일" has no week
    // word: this-thu is the same Thursday as thu on this clock and is stored in its canonical form (calendar-accuracy note).
    selectorAnswer = answer('calendar.events', { range: 'this-thu' });
    start = marks();
    await send('목요일 거는?', ctx);
    expect(lastPrevious(start.requests)).toBe('Previous selection: none');
    expect(selected.slice(start.selected).map((served) => served.command.args)).toEqual([{ range: 'thu' }]);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toMatchObject({ args: { range: 'thu' } });
    // Next period: no keyword to carry.
    selectorAnswer = answer('calendar.events', { range: 'week-after-next' });
    start = marks();
    await send('아니 다다음 주', ctx);
    expect(selected.slice(start.selected).map((served) => served.command.args)).toEqual([{ range: 'week-after-next' }]);
    // "회의만": the flag is grounded in the owner's word and drops all-day entries.
    await send('이번 주 일정 알려줘', ctx);
    selectorAnswer = answer('calendar.events', { range: 'this-week', timedOnly: true });
    start = marks();
    await send('그 중에 회의만', ctx);
    expect(selected.slice(start.selected).map((served) => served.command.args)).toEqual([{ range: 'this-week', timedOnly: true }]);
  });

  it('review P2: a mail item pick is transient — it is not stored, so "안 읽은 것만" refines the listing, not the pick', async () => {
    const ctx = context();
    selectorAnswer = answer('mail.list', {});
    await send('메일함 좀', ctx);
    selectorAnswer = answer('mail.list', { item: 2 });
    await send('2번은 누가 보냈어?', ctx);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toMatchObject({ entryId: 'mail.list', args: {} });
    selectorAnswer = answer('mail.list', { unread: true });
    const start = marks();
    await send('안 읽은 것만', ctx);
    expect(lastPrevious(start.requests)).toBe('Previous selection: {"entryId":"mail.list","args":{}}');
    expect(selected.slice(start.selected).map((served) => served.command.args)).toEqual([{ unread: true }]);
  });

  it('follow-up 2, defect 1: a chat turn clears lastSelection, so "그 중에 스크럼만" then gets the clarification question', async () => {
    const ctx = context();
    await send('이번 주 일정 알려줘', ctx);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeDefined();
    selectorAnswer = none;
    expect((await send('요즘 날씨가 너무 덥다', ctx)).reply.text).toBe(CHAT_REPLY);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeUndefined();
    selectorAnswer = JSON.stringify({ entryId: 'calendar.events', args: { keyword: '스크럼' }, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'jira.issues', args: { keyword: '스크럼' } }] });
    const start = marks();
    const asked = await send('그 중에 스크럼만', ctx);
    expect(lastPrevious(start.requests)).toBe('Previous selection: none');
    expect(asked.reply.text).toContain('어떤 걸 찾으세요?');
  });

  it('follow-up 2, defect 1: help clears lastSelection and a different grammar listing replaces it', async () => {
    const ctx = context();
    for (const text of ['도움말', '이번 주 일정 알려줘']) {
      await send('내 지라 이슈 보여줘', ctx);
      expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeDefined();
      await send(text, ctx);
      const kept = (await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY];
      if (text === '도움말') expect(kept).toBeUndefined();
      else expect(kept).toMatchObject({ entryId: 'calendar.events' });
    }
  });

  it('follow-up 2, defect 1: a grammar-handled Jira listing followed by "그 중에 위클리카만" refines Jira', async () => {
    const ctx = context();
    await send('내 지라 이슈 보여줘', ctx);
    selectorAnswer = answer('jira.issues', { keyword: '위클리카' });
    const start = marks();
    const refined = await send('그 중에 위클리카만', ctx);
    expect(lastPrevious(start.requests)).toBe('Previous selection: {"entryId":"jira.issues","args":{}}');
    expect(refined.reply.text).toContain('위클리카');
    expect(refined.reply.text).not.toContain('로그인 오류');
  });

  it('amendment A2, flag off (default): the grammars answer exactly as before — the qualifier is still swallowed, no selector call', async () => {
    await withGrammarYield(false, 'active', async () => {
      for (const text of ['이번 주 정기회의 일정 있어?', '내 지라 이슈 어제 업데이트된 거 보여줘']) {
        const start = marks();
        await send(text);
        expect(order.slice(start.order), text).not.toContain('select');
        expect(claims.slice(start.claims).length, text).toBeGreaterThan(0);
      }
    });
  });

  it('amendment A2, flag on and mode active: "이번 주 정기회의 일정 있어?" is declined by the calendar grammar and selection binds the keyword', async () => {
    await withGrammarYield(true, 'active', async () => {
      selectorAnswer = answer('calendar.events', { range: 'this-week', keyword: '정기회의' });
      const start = marks();
      // Not a corpus phrasing, so the selection cache (shared by the corpus sweep) cannot answer it.
      const result = await send('이번 주 정기회의 일정이 있나요?');
      expect(claims.slice(start.claims).filter((claim) => claim.handlerId === 'calendar')).toEqual([]);
      expect(order.slice(start.order)).toContain('select');
      expect(selected.slice(start.selected).map((served) => served.command.args)).toEqual([{ range: 'this-week', keyword: '정기회의' }]);
      expect(result.reply.text).toContain('정기회의');
    });
  });

  it('amendment A2, flag on but mode off or shadow: no decline, the grammar answers as before', async () => {
    for (const mode of ['off', 'shadow'] as const) {
      await withGrammarYield(true, mode, async () => {
        const start = marks();
        await send('이번 주 정기회의 일정이 있나요?');
        expect(claims.slice(start.claims).filter((claim) => claim.handlerId === 'calendar').length, mode).toBe(1);
      });
    }
  });

  it('amendment A2: with the flag on, polite forms are still answered by the grammar, even with the selector down', async () => {
    await withGrammarYield(true, 'active', async () => {
      selectorAnswer = () => {
        throw new Error('selector down');
      };
      for (const text of ['내일 일정 알려주실래요?', '이번 주 일정 보여주시겠어요']) {
        const start = marks();
        await send(text);
        expect(order.slice(start.order), text).not.toContain('select');
        expect(claims.slice(start.claims).filter((claim) => claim.handlerId === 'calendar').length, text).toBe(1);
      }
      selectorAnswer = none;
    });
  });

  it('amendment A2: with the selector down, a declined qualifier message gets honest chat, not a wrong-span answer', async () => {
    await withGrammarYield(true, 'active', async () => {
      selectorAnswer = () => {
        throw new Error('selector down');
      };
      const start = marks();
      const result = await send('이번 주 정기회의 일정이 있나요? 알려주세요');
      expect(claims.slice(start.claims).filter((claim) => claim.handlerId === 'calendar')).toEqual([]);
      expect(result.reply.text).toBe(CHAT_REPLY);
      selectorAnswer = none;
    });
  });

  it('follow-up 2: a selected read that FAILS does not keep lastSelection', async () => {
    const ctx = context();
    await send('내 지라 이슈 보여줘', ctx);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeDefined();
    selectorAnswer = answer('jira.issues', { keyword: '실패확인용' });
    failSelected = true;
    try {
      const failed = await send('그 중에 실패확인용만 보여줘', ctx);
      expect(failed.status).toBe('FAILED');
    } finally {
      failSelected = false;
    }
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeUndefined();
  });

  it('follow-up 2: a turn that throws ends the follow-up window', async () => {
    const ctx = context();
    await send('내 지라 이슈 보여줘', ctx);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeDefined();
    const memory = (runtime as unknown as { deps: { memory: { recordShortTerm: () => Promise<never> } } }).deps.memory;
    const spy = vi.spyOn(memory, 'recordShortTerm').mockRejectedValueOnce(new Error('boom'));
    try {
      const result = await send('요즘 날씨가 너무 덥네 정말', ctx);
      expect(result.status).toBe('FAILED');
    } finally {
      spy.mockRestore();
    }
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeUndefined();
  });

  it('D6/D8 no new egress: selection runs only when the chat turn resolves to the selector\'s own provider', async () => {
    const deps = (runtime as unknown as { deps: { router: Record<string, unknown> } }).deps;
    const original = deps.router;
    const chatTurn = async (chatProviderId: string | null, text: string) => {
      const otherChat = {
        id: chatProviderId ?? 'none',
        capabilities: [{ capability: 'GENERAL_CHAT', priority: 1 }],
        isAvailable: async () => true,
        execute: async (request: AiRequest) => {
          requests.push(request);
          order.push(`provider:${request.capability}`);
          return { text: CHAT_REPLY, artifacts: [] };
        },
      } as unknown as AiProvider;
      const real = original as unknown as { resolve(capability: string, context?: unknown): Promise<{ provider: AiProvider }> };
      deps.router = {
        ...original,
        select: async (capability: string, context?: unknown) =>
          chatProviderId !== null && capability === 'GENERAL_CHAT' ? otherChat : (await real.resolve(capability, context)).provider,
        resolve: async (capability: string, context?: unknown) =>
          chatProviderId !== null && capability === 'GENERAL_CHAT' ? { provider: otherChat, source: 'OWNER_SELECTED' } : real.resolve(capability, context),
        isStillEligible: () => true,
      };
      try {
        const start = marks();
        await send(text);
        return order.slice(start.order).filter((step) => step === 'select').length;
      } finally {
        deps.router = original;
      }
    };
    selectorAnswer = answer('jira.issues');
    // A local chat model (the owner switched with 모델 변경) or another remote provider: the text never goes to the selector.
    expect(await chatTurn('ollama-local-chat', '지라 쪽 내 건들 좀 훑어볼래')).toBe(0);
    expect(await chatTurn('other-remote-chat', '지라 쪽 내 건들 좀 훑어볼래 2')).toBe(0);
    // The same provider (the default composition: chat and selection both resolve to the Claude CLI instance) calls once.
    expect(await chatTurn(null, '지라 쪽 내 건들 좀 훑어볼래 3')).toBe(1);
    // The personal-data route is pinned to the same provider by resolution, so it may select as well.
    selectorAnswer = none;
    const start = marks();
    await send('내 통장 잔액 얼마야?');
    expect(intents.at(-1)?.capability).toBe('POLICY_SENSITIVE_CHAT');
    expect(order.slice(start.order).filter((step) => step === 'select')).toHaveLength(1);
  });

  it('D7: an open question ends with the next owner turn even when another route answers it', async () => {
    const ctx = context();
    selectorAnswer = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
    expect((await send('이슈 쪽 상황 좀 볼래', ctx)).reply.text).toContain('어떤 걸 찾으세요?');
    const session = await sessions.openForContext(ctx, ownerActor.id);
    expect(session.metadata?.[core.NL_PENDING_METADATA_KEY]).toBeDefined();
    // A Class A command answers this turn; the question is gone afterwards.
    await send('할 일 추가: 질문 정리', ctx);
    expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.NL_PENDING_METADATA_KEY]).toBeUndefined();
    // "1" is no longer an answer: it is routed as a new message (the selector is asked, answers none, chat replies).
    selectorAnswer = none;
    const start = marks();
    const reply = await send('1', ctx);
    expect(selected.length).toBe(start.selected);
    expect(order.slice(start.order)).toContain('select');
    expect(reply.reply.text).toBe(CHAT_REPLY);
  });

  it('Class A precedence: anchored commands and writes never reach the selector', async () => {
    selectorAnswer = answer('todo.list');
    for (const text of ['할 일 추가: 보고서 제출', '기억해: 나는 커피를 좋아해', '30분 뒤에 스트레칭 알려줘', '모델 변경: claude', '알림 목록']) {
      const start = marks();
      await send(text);
      expect(order.slice(start.order), text).not.toContain('select');
      expect(selected.length, text).toBe(start.selected);
    }
  });

  // ── S1: ADR-0120 D6 Phase C (QUOKY_NL_PHASE=c) ──────────────────────────────────────────────────────────────────

  /** The reply text with the per-turn numbering that differs between two sends (to-do ids, times) left as is. */
  const turnOf = async (text: string, ctx?: ConversationContext) => {
    const start = marks();
    const result = await send(text, ctx);
    return {
      result,
      selects: order.slice(start.order).filter((step) => step === 'select').length,
      order: order.slice(start.order),
      claims: claims.slice(start.claims).map((claim) => claim.handlerId),
      served: selected.slice(start.selected).map((served) => served.command),
      hits: probes.slice(start.probes).filter((probe) => probe.grammarId !== undefined),
      requests: requests.slice(start.requests),
    };
  };

  it('S1: classBProbe is pure — over the whole corpus it reads nothing, calls no desk, connector or provider, and writes no session state', async () => {
    const internals = runtime as unknown as {
      turnHandlerRegistry: readonly ConversationTurnHandler[];
      turnHandlerContext(message: InboundMessage, session: unknown, actor: Actor, anchor: null): import('@quoky/core').TurnHandlerContext;
    };
    const ctxBase = context();
    const session = await sessions.openForContext(ctxBase, ownerActor.id);
    const before = { ...marks(), metadata: JSON.stringify(session.metadata ?? {}) };
    let hits = 0;
    for (const golden of CORPUS.cases) {
      const ctx = internals.turnHandlerContext({ id: `probe-${golden.id}`, context: ctxBase, text: golden.text, receivedAt: new Date().toISOString() }, session, ownerActor, null);
      for (const handler of internals.turnHandlerRegistry) if (handler.classBProbe?.(ctx)) hits += 1;
    }
    expect(hits).toBeGreaterThan(200);
    const after = marks();
    expect({ readers: after.readers, connectors: after.connectors, desk: after.desk, requests: after.requests, claims: after.claims }).toEqual({
      readers: before.readers,
      connectors: before.connectors,
      desk: before.desk,
      requests: before.requests,
      claims: before.claims,
    });
    expect(JSON.stringify((await sessions.openForContext(ctxBase, ownerActor.id)).metadata ?? {})).toBe(before.metadata);
  });

  it('S1 Phase C: on every routing-corpus turn without a probe hit (turn-handler, intent-routing, reminder/to-do precedence), Phase C makes the same claims as Phase A', async () => {
    const texts: string[] = [];
    for (const file of ['turn-handler-routing.v1.json', 'intent-routing.v1.json', 'reminder-todo-precedence.v1.json']) {
      const suite = JSON.parse(readFileSync(join(__dirname, '../../../../packages/core/src/application/golden', file), 'utf8')) as { cases: Array<{ text: string }> };
      for (const golden of suite.cases) texts.push(golden.text);
    }
    expect(texts.length).toBeGreaterThan(600);
    const failures: string[] = [];
    let hits = 0;
    selectorAnswer = none;
    for (const text of texts) {
      const phaseA = await withPhase('a', 'active', () => turnOf(text));
      const phaseC = await withPhase('c', 'active', () => turnOf(text));
      if (phaseC.hits.length > 0) {
        hits += 1;
        continue;
      }
      if (JSON.stringify(phaseC.claims) !== JSON.stringify(phaseA.claims)) failures.push(`${text.slice(0, 40)}: claims ${phaseA.claims} -> ${phaseC.claims}`);
      if (phaseC.selects !== phaseA.selects) failures.push(`${text.slice(0, 40)}: selects ${phaseA.selects} -> ${phaseC.selects}`);
      if (phaseC.result.status !== phaseA.result.status) failures.push(`${text.slice(0, 40)}: status ${phaseA.result.status} -> ${phaseC.result.status}`);
    }
    expect(failures).toEqual([]);
    expect(hits).toBeGreaterThan(0);
  }, 600_000);

  it('S1 Phase C: Class A precedence is untouched — anchors, writes, memory, model, reminders and item summaries never reach the selector and answer as in Phase A', async () => {
    const classA = [
      '할 일 추가: 보고서 제출',
      '완료 처리: 1',
      '기억해: 나는 커피를 좋아해',
      '30분 뒤에 스트레칭 알려줘',
      '모델 변경: claude',
      '알림 목록',
      '1번 메일 요약해줘',
      'PROJ-1에 댓글: 확인했습니다',
      '#dev에 배포 완료라고 올려줘',
      '내일 오후 3시에 회의 잡아줘',
      '드라이브에 파일 하나 만들어줘',
      '이 프로젝트 구조 설명해줘',
    ];
    selectorAnswer = answer('todo.list');
    for (const text of classA) {
      const phaseA = await withPhase('a', 'active', () => turnOf(text));
      const phaseC = await withPhase('c', 'active', () => turnOf(text));
      // No Class B probe hits and no selection is added: a turn Phase A sent to chat may still select after classify.
      expect(phaseC.hits, text).toEqual([]);
      expect(phaseC.selects, text).toBe(phaseA.selects);
      if (phaseA.selects === 0) expect(phaseC.order.includes('select'), text).toBe(false);
      expect(phaseC.served, text).toEqual([]);
      expect(phaseC.claims, text).toEqual(phaseA.claims);
      expect(phaseC.result.status, text).toBe(phaseA.result.status);
    }
    // Read-only Class A answers are byte-identical between the phases.
    for (const text of ['알림 목록', '모델 변경: claude', '드라이브에 파일 하나 만들어줘']) {
      const phaseA = await withPhase('a', 'active', () => turnOf(text));
      const phaseC = await withPhase('c', 'active', () => turnOf(text));
      expect(phaseC.result.reply.text, text).toBe(phaseA.result.reply.text);
    }
  });

  it('S1 Phase C: a Class B hit runs selection first (before the grammar and the classifier) and the selected read answers', async () => {
    await withPhase('c', 'active', async () => {
      selectorAnswer = answer('calendar.events', { range: 'this-week' });
      const turn = await turnOf('이번 주 일정 보여줘');
      expect(turn.hits.map((hit) => hit.grammarId)).toEqual(['calendar-question']);
      expect(turn.order[0]).toBe('select');
      expect(turn.order).not.toContain('classify');
      expect(turn.claims).toEqual([]);
      expect(turn.served).toEqual([expect.objectContaining({ entryId: 'calendar.events', args: { range: 'this-week' } })]);
    });
  });

  it('S1 Phase C: `none` falls back to the classifier and honest chat (D9), never to the grammar; a question is asked, not listed', async () => {
    await withPhase('c', 'active', async () => {
      selectorAnswer = none;
      const turn = await turnOf('내 지라 이슈 보여줘');
      expect(turn.selects).toBe(1);
      expect(turn.order.indexOf('select')).toBeLessThan(turn.order.indexOf('classify'));
      expect(turn.claims).toEqual([]);
      expect(turn.result.reply.text).toBe(CHAT_REPLY);
      const chat = turn.requests.find((request) => request.capability !== SELECTION)!;
      expect(chat.prompt).toContain('Quoky is connected to these sources right now');

      selectorAnswer = JSON.stringify({ entryId: 'jira.issues', args: {}, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'github.items', args: {} }] });
      const asked = await turnOf('내 지라 이슈 보여줄래');
      expect(asked.claims).toEqual([]);
      expect(asked.result.reply.text).toContain('어떤 걸 찾으세요?');
    });
  });

  it('S1 Phase C fallback order: provider down, malformed output, family or locality mismatch and the credential guard each let the grammar answer exactly as in Phase A', async () => {
    const text = '이번 주 일정 알려줘';
    const phaseA = await withPhase('a', 'active', () => turnOf(text));
    expect(phaseA.claims).toEqual(['calendar']);
    const deps = (runtime as unknown as { deps: { router: Record<string, unknown> } }).deps;
    const original = deps.router;
    const real = original as unknown as { resolve(capability: string, context?: unknown): Promise<{ provider: AiProvider }> };
    const withChat = async <T,>(chat: Partial<AiProvider>, run: () => Promise<T>): Promise<T> => {
      const resolved = async (capability: string, context?: unknown) => {
        const provider = (await real.resolve(capability, context)).provider;
        return capability === 'GENERAL_CHAT' ? ({ ...provider, ...chat } as AiProvider) : provider;
      };
      deps.router = { ...original, select: resolved, resolve: async (capability: string, context?: unknown) => ({ provider: await resolved(capability, context), source: 'DEFAULT' }), isStillEligible: () => true };
      try {
        return await run();
      } finally {
        deps.router = original;
      }
    };
    const causes: Array<[string, () => Promise<Awaited<ReturnType<typeof turnOf>>>, number]> = [
      ['provider down', async () => { selectorAnswer = () => { throw new core.AiProviderError(core.AiFailureKind.UNAVAILABLE, 'selector down'); }; return turnOf(text); }, 1],
      ['malformed', async () => { selectorAnswer = 'Sure, here is your calendar.'; return turnOf(text); }, 1],
      ['family mismatch', async () => { selectorAnswer = answer('calendar.events', { range: 'this-week' }); return withChat({ id: 'other-remote-chat', family: 'other-remote-chat' }, () => turnOf(text)); }, 0],
      ['locality mismatch', async () => { selectorAnswer = answer('calendar.events', { range: 'this-week' }); return withChat({ executionLocality: 'LOCAL' }, () => turnOf(text)); }, 0],
    ];
    for (const [cause, run, selects] of causes) {
      const turn = await withPhase('c', 'active', run);
      expect(turn.hits.map((hit) => hit.grammarId), cause).toEqual(['calendar-question']);
      expect(turn.selects, cause).toBe(selects);
      expect(turn.claims, cause).toEqual(['calendar']);
      expect(turn.served, cause).toEqual([]);
      expect(turn.result.reply.text, cause).toBe(phaseA.result.reply.text);
    }
    // The pre-egress credential guard: no call at all, the grammar answers as in Phase A.
    const token = ['xox', 'b', '-', '1'.repeat(12), '-', 'A'.repeat(24)].join('');
    const credentialText = `슬랙에서 ${token} 검색해줘`;
    const credentialA = await withPhase('a', 'active', () => turnOf(credentialText));
    const credentialC = await withPhase('c', 'active', () => turnOf(credentialText));
    expect(credentialC.hits.map((hit) => hit.grammarId)).toEqual(['work-lookup.search']);
    expect(credentialC.selects).toBe(0);
    expect(credentialC.requests.some((request) => request.capability === SELECTION)).toBe(false);
    expect(credentialC.claims).toEqual(credentialA.claims);
    selectorAnswer = none;
  });

  it('S1 Phase C fallback order: every unavailable or skipped decision (timeout, too long, credential, mismatches) runs the grammar; `none` never does', async () => {
    const service = (runtime as unknown as { deps: { nlSelection: { decide: (turn: unknown) => Promise<unknown> } } }).deps.nlSelection;
    const decisions: Array<[string, unknown, boolean]> = [
      ['timeout (unavailable)', { kind: 'unavailable' }, true],
      ['too-long', { kind: 'skip', reason: 'too-long' }, true],
      ['credential', { kind: 'skip', reason: 'credential' }, true],
      ['chat-provider-differs', { kind: 'skip', reason: 'chat-provider-differs' }, true],
      ['chat-locality-differs', { kind: 'skip', reason: 'chat-locality-differs' }, true],
      ['chat-provider-unknown', { kind: 'skip', reason: 'chat-provider-unknown' }, true],
      ['none', { kind: 'none' }, false],
    ];
    for (const [cause, decision, grammarAnswers] of decisions) {
      const spy = vi.spyOn(service, 'decide').mockResolvedValue(decision);
      try {
        const turn = await withPhase('c', 'active', () => turnOf('다음 주 일정 보여줘'));
        expect(spy, cause).toHaveBeenCalledTimes(1);
        expect(turn.claims, cause).toEqual(grammarAnswers ? ['calendar'] : []);
        if (!grammarAnswers) expect(turn.result.reply.text, cause).toBe(CHAT_REPLY);
      } finally {
        spy.mockRestore();
      }
    }
  });

  it('S1 Phase C: the classifier\'s personal-work surface is a Class B route — selection first, the surface only when the selector did not run or failed', async () => {
    // The work-chat grammar already claims the usual surface phrasings, so the classifier result is forced for a neutral
    // text that no handler answers (the route is what is under test, not the regex).
    const classifier = (runtime as unknown as { deps: { classifier: { classify: (message: InboundMessage) => Promise<Intent> } } }).deps.classifier;
    const surfaceIntent = { type: 'LOOKUP', capability: 'READONLY_LOOKUP', confidence: 1, requiresWork: false, summary: 's', raw: { kind: 'personal-work-surface' } } as unknown as Intent;
    const forced = async (text: string) => {
      vi.mocked(classifier.classify).mockImplementationOnce(async () => {
        order.push('classify');
        intents.push(surfaceIntent);
        return surfaceIntent;
      });
      return turnOf(text);
    };
    const phaseA = await withPhase('a', 'active', () => forced('음 오늘 뭐부터 손대지'));
    expect(phaseA.selects).toBe(0);
    expect(phaseA.result.reply.text).toContain('지금 확인할 작업이에요');
    await withPhase('c', 'active', async () => {
      selectorAnswer = answer('todo.list');
      const selectedTurn = await forced('음 오늘 뭐부터 손대지 1');
      expect(selectedTurn.order).toEqual(['classify', 'select']);
      expect(selectedTurn.served).toEqual([expect.objectContaining({ entryId: 'todo.list' })]);
      selectorAnswer = () => {
        throw new Error('selector down');
      };
      const fallback = await forced('음 오늘 뭐부터 손대지 2');
      expect(fallback.selects).toBe(1);
      expect(fallback.served).toEqual([]);
      expect(fallback.result.reply.text).toBe(phaseA.result.reply.text);
      // Live UAT R9: a selector that RAN and answered `none` wins over the surface clause — the turn is chat.
      selectorAnswer = none;
      const declined = await forced('음 오늘 뭐부터 손대지 3');
      expect(declined.selects).toBe(1);
      expect(declined.served).toEqual([]);
      expect(declined.result.reply.text).toBe(CHAT_REPLY);
    });
    selectorAnswer = none;
  });

  it('S1: c with mode shadow (refused at startup) is inert in the runtime too — the grammar answers, no selector call, no agreement; active Phase C logs content-free agreement', async () => {
    const service = (runtime as unknown as { deps: { nlSelection: { lastShadowRun: Promise<void>; deps: { logger: { info: (event: string, fields?: Record<string, unknown>) => void } } } } }).deps.nlSelection;
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const spy = vi.spyOn(service.deps.logger, 'info').mockImplementation((event, fields) => void lines.push({ event, ...(fields ? { fields } : {}) }));
    try {
      const text = '위클리카 관련 지라 이슈 보여줘';
      const phaseA = await withPhase('a', 'active', () => turnOf(text));
      selectorAnswer = answer('jira.issues', { keyword: '위클리카' });
      const shadow = await withPhase('c', 'shadow', async () => {
        const turn = await turnOf(text);
        await service.lastShadowRun;
        return turn;
      });
      expect(shadow.claims).toEqual(phaseA.claims);
      expect(shadow.result.reply.text).toBe(phaseA.result.reply.text);
      expect(shadow.hits).toEqual([]);
      expect(shadow.selects).toBe(0);
      expect(lines.filter((line) => line.event === 'nl_selection.agreement')).toEqual([]);
      // Active Phase C logs the agreement, and it carries neither the text nor an argument value.
      selectorAnswer = answer('github.items', { keyword: '위클리카' });
      await withPhase('c', 'active', () => turnOf('위클리카 관련 지라 이슈 보여줘요'));
      const all = lines.filter((line) => line.event === 'nl_selection.agreement');
      expect(all.at(-1)?.fields).toMatchObject({ grammarId: 'work-lookup.my-items', entryId: 'github.items', outcome: 'execute', mode: 'active', agree: false, agreeEntry: false });
      expect(JSON.stringify(all)).not.toMatch(/위클리카|지라|보여/);
    } finally {
      spy.mockRestore();
      selectorAnswer = none;
    }
  });

  it('S1 c-shadow: Phase A stays live — the grammar reply is handed back before the background selection starts, only the agreement is logged, and no session or preference state changes', async () => {
    const service = (runtime as unknown as { deps: { nlSelection: { lastShadowRun: Promise<void>; deps: { logger: { info: (event: string, fields?: Record<string, unknown>) => void } } } } }).deps.nlSelection;
    const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const spy = vi.spyOn(service.deps.logger, 'info').mockImplementation((event, fields) => void lines.push({ event, ...(fields ? { fields } : {}) }));
    try {
      const text = '다음 주 일정 알려줘';
      const phaseA = await withPhase('a', 'active', () => turnOf(text));
      const ctx = context();
      await withPhase('c-shadow', 'active', async () => {
        selectorAnswer = answer('calendar.events', { range: 'next-week' });
        const start = marks();
        const result = await send(text, ctx);
        order.push('replied');
        const stateAtReply = JSON.stringify((await sessions.openForContext(ctx, ownerActor.id)).metadata ?? {});
        const preferencesAtReply = JSON.stringify((await storage.actors.get(ownerActor.id))?.metadata ?? {});
        await (runtime as unknown as { lastAfterReplyRun: Promise<void> }).lastAfterReplyRun;
        await service.lastShadowRun;
        const turnOrder = order.slice(start.order);
        // The grammar answered exactly as in Phase A, and the selector ran once, only after the reply was handed back.
        expect(result.reply.text).toBe(phaseA.result.reply.text);
        expect(claims.slice(start.claims).map((claim) => claim.handlerId)).toEqual(['calendar']);
        expect(selected.length).toBe(start.selected);
        expect(turnOrder.filter((step) => step === 'select')).toHaveLength(1);
        expect(turnOrder.indexOf('replied')).toBeLessThan(turnOrder.indexOf('select'));
        expect(lines.filter((line) => line.event === 'nl_selection.agreement').at(-1)?.fields).toMatchObject({
          grammarId: 'calendar-question',
          entryId: 'calendar.events',
          outcome: 'execute',
          mode: 'shadow',
          agree: true,
        });
        expect(JSON.stringify((await sessions.openForContext(ctx, ownerActor.id)).metadata ?? {})).toBe(stateAtReply);
        expect(JSON.stringify((await storage.actors.get(ownerActor.id))?.metadata ?? {})).toBe(preferencesAtReply);

        // Fall-through messages keep Phase A's live selection.
        selectorAnswer = answer('jira.issues');
        const fallThrough = await turnOf('지라 쪽 내 건들 좀 훑어볼래 c-shadow');
        expect(fallThrough.order.slice(0, 2)).toEqual(['classify', 'select']);
        expect(fallThrough.served).toEqual([expect.objectContaining({ entryId: 'jira.issues' })]);
      });
    } finally {
      spy.mockRestore();
      selectorAnswer = none;
    }
  });

  it('S1: off, a, c and c-shadow behave distinctly on one grammar-hit message', async () => {
    const text = '모레 일정 보여줘';
    const runIn = async (phase: 'a' | 'c' | 'c-shadow', mode: 'off' | 'active') =>
      withPhase(phase, mode, async () => {
        selectorAnswer = answer('calendar.events', { range: 'day-after-tomorrow' });
        const before = order.length;
        const turn = await turnOf(text);
        await (runtime as unknown as { lastAfterReplyRun: Promise<void> }).lastAfterReplyRun;
        await (runtime as unknown as { deps: { nlSelection: { lastShadowRun: Promise<void> } } }).deps.nlSelection.lastShadowRun;
        return { ...turn, selectsTotal: order.slice(before).filter((step) => step === 'select').length };
      });
    const off = await runIn('a', 'off');
    const a = await runIn('a', 'active');
    const c = await runIn('c', 'active');
    const shadow = await runIn('c-shadow', 'active');
    // off and a: the grammar answers, no selector call at all.
    for (const turn of [off, a]) {
      expect(turn.claims).toEqual(['calendar']);
      expect(turn.selects).toBe(0);
    }
    // c: the selector answers first and serves the read; the grammar does not.
    expect(c.claims).toEqual([]);
    expect(c.selects).toBe(1);
    expect(c.served).toEqual([expect.objectContaining({ entryId: 'calendar.events' })]);
    // c-shadow: the grammar answers within the turn (no selection in it), the selector runs once after the reply.
    expect(shadow.claims).toEqual(['calendar']);
    expect(shadow.selects).toBe(0);
    expect(shadow.served).toEqual([]);
    expect(shadow.selectsTotal).toBe(1);
    expect(shadow.result.reply.text).toBe(a.result.reply.text);
    expect([off.selectsTotal, a.selectsTotal, c.selectsTotal]).toEqual([0, 0, 1]);
    selectorAnswer = none;
  });

  it('S1: "그 중에 …" after an intervening chat turn asks the numbered question in Phase C too (the selector is told there is no previous selection)', async () => {
    await withPhase('c', 'active', async () => {
      const ctx = context();
      selectorAnswer = answer('calendar.events', { range: 'this-week' });
      await send('이번 주 일정 알려줘', ctx);
      selectorAnswer = none;
      expect((await send('요즘 날씨가 너무 덥다', ctx)).reply.text).toBe(CHAT_REPLY);
      expect((await sessions.openForContext(ctx, ownerActor.id)).metadata?.[core.LAST_SELECTION_METADATA_KEY]).toBeUndefined();
      selectorAnswer = JSON.stringify({ entryId: 'calendar.events', args: { keyword: '스크럼' }, ambiguity: 'NEEDS_CLARIFICATION', alternatives: [{ entryId: 'jira.issues', args: { keyword: '스크럼' } }] });
      const start = marks();
      const asked = await send('그 중에 스크럼 건만', ctx);
      expect(lastPrevious(start.requests)).toBe('Previous selection: none');
      expect(requests.slice(start.requests).find((request) => request.capability === SELECTION)?.prompt).toContain('A narrowing follow-up');
      expect(asked.reply.text).toContain('어떤 걸 찾으세요?');
      expect((await send('1', ctx)).reply.text).toContain('스크럼');
    });
    selectorAnswer = none;
  });

  it('provider down or malformed: no retry, honest chat with the configured-sources fact (D9)', async () => {
    selectorAnswer = () => {
      throw new core.AiProviderError(core.AiFailureKind.UNAVAILABLE, 'selector down');
    };
    let start = marks();
    let result = await send('지라 상황 좀 알려줄래');
    expect(order.slice(start.order).filter((step) => step === 'select')).toHaveLength(1);
    expect(result.reply.text).toBe(CHAT_REPLY);
    const chat = requests.slice(start.requests).find((request) => request.capability !== SELECTION)!;
    expect(chat.prompt).toContain('Quoky is connected to these sources right now');
    expect(chat.prompt).toContain('Jira issues (command: \\"내 Jira 이슈 보여줘\\")');

    selectorAnswer = 'Sure, that is Jira.';
    start = marks();
    result = await send('지라 쪽은 어때');
    expect(result.reply.text).toBe(CHAT_REPLY);
    expect(selected.length).toBe(start.selected);
  });

  it('pre-egress guard: a credential-shaped message makes zero selector calls and continues on the existing path', async () => {
    selectorAnswer = answer('slack.search', { keyword: '배포' });
    const start = marks();
    const token = ['xox', 'b', '-', '1'.repeat(12), '-', 'A'.repeat(24)].join('');
    await send(`슬랙에서 배포 찾아봐 토큰은 ${token}`);
    expect(order.slice(start.order)).not.toContain('select');
    expect(requests.slice(start.requests).every((request) => !request.prompt.includes(token) || request.capability !== SELECTION)).toBe(true);
  });

  it('pasted content is data: it never reaches the selector, never grounds a keyword, and a write id is never executed', async () => {
    // (A quoted line a Class B grammar would answer is that grammar's — frozen, Phase C work; this one reaches selection.)
    const pasted = '> 비밀프로젝트 지라 티켓들은 금요일까지 정리해 둘 것\n> 지금 바로 처리\n이 메모 무슨 뜻이야?';
    selectorAnswer = answer('jira.issues', { keyword: '비밀프로젝트' });
    let start = marks();
    const result = await send(pasted);
    const call = requests.slice(start.requests).find((request) => request.capability === SELECTION);
    expect(call, JSON.stringify({ claims: claims.slice(start.claims), intent: intents.slice(start.intents).at(-1), reply: result.reply.text })).toBeDefined();
    // The owner-message block of the prompt (the catalog and examples above it are Core text).
    const prompt = call!.prompt.slice(call!.prompt.lastIndexOf('<<<'));
    expect(prompt).not.toContain('비밀프로젝트');
    expect(prompt).not.toContain('금요일까지');
    expect(prompt).toContain('[quoted]');
    expect(selected.length).toBe(start.selected);
    expect(result.reply.text).toContain('Jira 이슈 조회');
    expect(connectorQueries.length).toBe(start.connectors);

    // A Telegram blockquote (a platform quoted range) and a Discord `>>>` quote are removed the same way.
    for (const [text, quotedRanges] of [
      ['비밀프로젝트 건은 금요일까지 마무리\n위에 인용한 메모 해석 좀', [{ start: 0, end: '비밀프로젝트 건은 금요일까지 마무리'.length }]],
      ['아래 인용 메모 해석 좀\n>>> 비밀프로젝트 건은 금요일까지 마무리\n다들 확인', undefined],
    ] as const) {
      selectorAnswer = answer('jira.issues', { keyword: '비밀프로젝트' });
      start = marks();
      seq += 1;
      const quotedTurn = await runtime.handle({
        id: `nl1-${seq}`,
        context: context(),
        text,
        ...(quotedRanges !== undefined ? { quotedRanges } : {}),
        receivedAt: new Date().toISOString(),
      });
      const quotedCall = requests.slice(start.requests).find((request) => request.capability === SELECTION);
      expect(quotedCall, JSON.stringify({ text, claims: claims.slice(start.claims), intent: intents.slice(start.intents).at(-1), order: order.slice(start.order), reply: quotedTurn.reply.text })).toBeDefined();
      const ownerBlock = quotedCall!.prompt.slice(quotedCall!.prompt.lastIndexOf('<<<'));
      expect(ownerBlock).not.toContain('비밀프로젝트');
      expect(ownerBlock).toContain('[quoted]');
      expect(selected.length).toBe(start.selected);
      expect(quotedTurn.reply.text).toContain('Jira 이슈 조회');
    }

    selectorAnswer = answer('jira.create', { summary: 'x' });
    start = marks();
    expect((await send('지라에 티켓 하나 만들어 놔')).reply.text).toBe(CHAT_REPLY);
    expect(selected.length).toBe(start.selected);
  });

  it('DM-only entries in a channel: the handler answers that it is DM-only and reads nothing', async () => {
    for (const [entryId, text] of [
      ['mail.list', '메일함에 새로 온 거 있나 봐줘'],
      ['drive.files', '드라이브 최근 거 좀'],
      ['brief.today', '오늘 하루 정리 좀 해줘'],
    ] as const) {
      selectorAnswer = answer(entryId, entryId === 'mail.list' ? { unread: true } : {});
      const start = marks();
      const result = await send(text, context(false));
      expect(result.reply.text, entryId).toMatch(/DM/);
      expect(readerCalls.length, entryId).toBe(start.readers);
    }
    selectorAnswer = answer('brief.today');
    const start = marks();
    const brief = await send('오늘 하루 정리 좀 해줘 지금');
    expect(brief.reply.text).toContain('오늘의 브리핑');
    expect(readerCalls.slice(start.readers).some((call) => call.startsWith('calendar:'))).toBe(true);
    expect(requests.slice(start.requests).filter((request) => request.capability !== SELECTION)).toHaveLength(0);
  });

  it('off and shadow: off never calls the service; shadow calls the selector once, acts on nothing and logs no content', async () => {
    const deps = (runtime as unknown as { deps: { nlSelection?: unknown } }).deps;
    const original = deps.nlSelection;
    try {
      const decide = vi.fn();
      deps.nlSelection = { mode: 'off', decide };
      let start = marks();
      const off = await send('지라 이슈 정리 좀');
      expect(decide).not.toHaveBeenCalled();
      expect(off.reply.text).toBe(CHAT_REPLY);
      expect(requests.slice(start.requests).find((request) => request.capability !== SELECTION)?.prompt).not.toContain('Quoky is connected to these sources');

      const lines: Array<{ event: string; fields?: Record<string, unknown> }> = [];
      const shadow = new core.NlSelectionService({
        mode: 'shadow',
        router: { select: async () => app().selector },
        sessions,
        actors: storage.actors,
        timeZone: 'Asia/Seoul',
        logger: { info: (event, fields) => void lines.push({ event, ...(fields ? { fields } : {}) }), warn: () => undefined, error: () => undefined },
      });
      deps.nlSelection = shadow;
      selectorAnswer = answer('jira.issues', { keyword: '위클리카' });
      start = marks();
      const reply = await send('위클리카 지라 건 정리 좀');
      await shadow.lastShadowRun;
      expect(reply.reply.text).toBe(CHAT_REPLY);
      expect(selected.length).toBe(start.selected);
      expect(order.slice(start.order).filter((step) => step === 'select')).toHaveLength(1);
      expect(lines.find((line) => line.event === 'nl_selection.shadow')?.fields).toMatchObject({ entryId: 'jira.issues', agree: false, grammarId: 'chat' });
      expect(JSON.stringify(lines)).not.toMatch(/위클리카|지라/);
    } finally {
      deps.nlSelection = original;
    }
  });

  function app(): { selector: AiProvider } {
    const selector = {
      // The same id as the chat provider of this composition (D6/D8: the selector must be the chat turn's own provider).
      id: 'claude-cli',
      capabilities: [{ capability: SELECTION, priority: 1 }],
      isAvailable: async () => true,
      execute: async (request: AiRequest) => {
        requests.push(request);
        order.push('select');
        return { text: typeof selectorAnswer === 'function' ? selectorAnswer() : selectorAnswer, artifacts: [] };
      },
    } as unknown as AiProvider;
    return { selector };
  }
});

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
