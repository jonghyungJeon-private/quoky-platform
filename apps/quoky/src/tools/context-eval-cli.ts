/**
 * The multi-turn context eval CLI (owner priority 2026-10-26; docs/eval/context-eval.md).
 *
 *   pnpm eval:context -- --mode plan [--profile deployed|actions-local] [--model haiku] [--chat stub|real] [--chat-model M] [--runs N] [--scenarios a,b]
 *   pnpm eval:context -- --mode run  <the same options> --approved-plan-digest <sha256 from plan>
 *   pnpm eval:context -- --mode dry  [--profile P] [--selector oracle|none] [--scenarios a,b]
 *
 * `plan` is offline: it reads the corpus, checks its schema and prints the plan, its digest, the hard call caps and a cost
 * estimate; nothing is booted or spawned. `run` is Strict (each run needs the owner's approval of the plan digest): it
 * recomputes the digest and exits 3 BEFORE any provider is constructed unless `--approved-plan-digest` equals it. It then
 * boots the production `AppModule` per run with the chosen NL profile and synthetic connector fixtures (no live API: any
 * other URL throws), sends the app's own router prompt to the real selection model (the Claude CLI, the deployed
 * `QUOKY_NL_INTENT_MODEL`), behind the eval outage guard and a hard cap equal to the plan's call bound, scores every turn
 * and exits 0 only when the gate passes in every run. `dry` makes no model call at all: the selector is the corpus oracle
 * (a perfect selector: Core's part alone) or always none (the deterministic path alone); its report never gates.
 *
 * Exit codes: 0 pass (dry: always, after a valid corpus), 1 gate failed or schema problems, 2 usage, 3 blocked (digest),
 * 5 INVALID (provider outage, no hard failure observed). Output is content-free (ids, counts, check names); the report
 * file under data/eval/ also keeps Quoky's bounded replies for diagnosis (synthetic fixtures only).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClaudeCliProvider, DEFAULT_CLAUDE_INTENT_SELECTION_MODEL } from '@quoky/ai-cli';
import {
  Capability,
  NL_ACTION_PROMPT_VERSION,
  NL_ACTION_R2_PROMPT_VERSION,
  NL_SELECTION_PROMPT_VERSION,
  NL_WAVE1_ENTRIES,
  NL_CATALOG_ENTRY_IDS,
  NL_ACTION_ENTRY_IDS,
  type AiProvider,
} from '@quoky/core';
import {
  CANARY_CLAUSE,
  EXIT_INVALID_PROVIDER,
  formatProviderOutcomes,
  formatTrip,
  guardEvalProvider,
  hardFailureTotal,
  outageAlsoSeenNote,
  printInvalidRun,
  providerCanary,
  type CanaryResult,
  type ProviderOutageReport,
} from './eval-provider-guard';
import { gitHead as defaultGitHead } from './nl-r2-prompt-binding';
import { countingProvider } from './nl-r2-redteam-cli';
import {
  HARD_CHECKS,
  buildContextEvalPlan,
  computeContextEvalPlanDigest,
  corpusCounts,
  formatSummary,
  gatePasses,
  loadContextEvalCorpus,
  summarize,
  validateContextEvalCorpus,
  type CapabilityNouns,
  type ContextEvalCorpus,
  type ContextEvalPlan,
  type ContextEvalSummary,
} from './context-eval';
import { CONTEXT_EVAL_PROFILES, CONTEXT_EVAL_PROFILE_NAMES, type ContextEvalProfile } from './context-eval-harness';
import type { ScenarioRecord, SelectionSource } from './context-eval-runner';

export const EXIT_OK = 0;
export const EXIT_GATE_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BLOCKED = 3;
export const EXIT_INVALID = EXIT_INVALID_PROVIDER;

/** Rough per-call cost assumptions printed with the plan (USD; Haiku-class selection, Sonnet-class chat). Estimates only. */
export const COST_PER_SELECTION_CALL_USD = 0.015;
export const COST_PER_CHAT_CALL_USD = 0.06;

/**
 * The read entries the eval world configures (Jira, Slack, Calendar, Gmail, Drive, to-dos, reminders); GitHub and
 * Confluence are not configured, so a reply saying they are not connected is true.
 */
export const CONTEXT_EVAL_CONFIGURED_READS = ['jira.issues', 'jira.release', 'slack.search', 'calendar.events', 'mail.list', 'drive.files', 'todo.list', 'reminder.list'] as const;

/**
 * The false-incapability detector's vocabulary, from Core's own catalog: the source names and aliases of the configured
 * reads, and the aliases of Quoky's own lists (the to-do and reminder entries, which carry no source name).
 */
export function capabilityNouns(): CapabilityNouns {
  const sources = new Set<string>();
  const lists = new Set<string>();
  for (const id of CONTEXT_EVAL_CONFIGURED_READS) {
    const entry = NL_WAVE1_ENTRIES[id];
    const target = entry.sourceNames === undefined ? lists : sources;
    for (const word of [...(entry.sourceNames ?? []), ...entry.aliases]) if (word.length >= 2) target.add(word.toLowerCase());
  }
  return { sources: [...sources].sort(), lists: [...lists].sort() };
}

const HELP = `Multi-turn context eval (owner priority 2026-10-26; docs/eval/context-eval.md)

Offline:  pnpm eval:context -- --mode plan [options]
Strict:   pnpm eval:context -- --mode run [options] --approved-plan-digest <sha256 from plan>
Dry:      pnpm eval:context -- --mode dry [--profile P] [--selector oracle|none] [--scenarios id,id]   (no model call)

Options: --profile ${CONTEXT_EVAL_PROFILE_NAMES.join('|')} (default deployed)  --model <selection model, default ${DEFAULT_CLAUDE_INTENT_SELECTION_MODEL}>
         --chat stub|real (default stub)  --chat-model <alias, default: the Claude CLI default>  --runs <1-5, default 1>  --scenarios <id,id,...>
Gate (proposed): >= 90% of the fully scored scenarios pass; 0 of each hard check (${HARD_CHECKS.join(', ')}); 0 harness errors.
Provider outage: the eval:nl guard; an outage with no hard failure observed is INVALID (exit 5), never PASSED or FAILED.
`;

const OPTIONS = new Set(['--mode', '--profile', '--model', '--chat', '--chat-model', '--runs', '--scenarios', '--selector', '--approved-plan-digest']);

export class UsageError extends Error {}

export type ContextEvalMode = 'plan' | 'run' | 'dry' | 'help';

export function parseArguments(argv: readonly string[]): { mode: ContextEvalMode; options: Record<string, string> } {
  const tokens = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (tokens.length === 0 || tokens.includes('--help') || tokens.includes('-h')) return { mode: 'help', options: {} };
  const options: Record<string, string> = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index] as string;
    const value = tokens[index + 1];
    if (!OPTIONS.has(name)) throw new UsageError(`unknown option ${name}`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`);
    if (name in options) throw new UsageError(`${name} given more than once`);
    options[name] = value;
  }
  const mode = options['--mode'];
  if (mode !== 'plan' && mode !== 'run' && mode !== 'dry') throw new UsageError('--mode must be plan, run or dry');
  if (mode === 'run' && options['--approved-plan-digest'] === undefined) throw new UsageError('run requires --approved-plan-digest');
  if (mode !== 'run' && options['--approved-plan-digest'] !== undefined) throw new UsageError('--approved-plan-digest is only for run');
  if (mode !== 'dry' && options['--selector'] !== undefined) throw new UsageError('--selector is only for dry');
  if (mode === 'dry') for (const name of ['--model', '--chat', '--chat-model', '--runs']) if (name in options) throw new UsageError(`${name} is not an option of --mode dry`);
  const profile = options['--profile'];
  if (profile !== undefined && !(CONTEXT_EVAL_PROFILE_NAMES as readonly string[]).includes(profile)) throw new UsageError(`--profile must be ${CONTEXT_EVAL_PROFILE_NAMES.join(' or ')}`);
  const chat = options['--chat'];
  if (chat !== undefined && chat !== 'stub' && chat !== 'real') throw new UsageError('--chat must be stub or real');
  if (options['--chat-model'] !== undefined && chat !== 'real') throw new UsageError('--chat-model needs --chat real');
  const selector = options['--selector'];
  if (selector !== undefined && selector !== 'oracle' && selector !== 'none') throw new UsageError('--selector must be oracle or none');
  return { mode, options };
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError('a numeric option is not a non-negative integer');
  return Number(value);
}

/** The prompt versions every profile can render (the A6 prompt is offered under `shadow` too: actionsOffered). */
export function promptVersions(): Record<string, string> {
  return { read: NL_SELECTION_PROMPT_VERSION, actions: NL_ACTION_PROMPT_VERSION, r2: NL_ACTION_R2_PROMPT_VERSION };
}

export interface RunInput {
  readonly corpus: ContextEvalCorpus;
  readonly profile: ContextEvalProfile;
  readonly scenarioIds: readonly string[];
  readonly runs: number;
  readonly selection: SelectionSource;
  readonly chat?: AiProvider;
  readonly onScenario?: (record: ScenarioRecord) => void;
}

export interface ContextEvalDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => string;
  readonly gitHead?: () => string;
  readonly loadCorpus: () => { corpus: ContextEvalCorpus; sha256: string };
  readonly writeReport: (fileName: string, contents: string) => string;
  /** Constructed only by `run`, only after the digest matched. */
  readonly createSelectionProvider: (model: string) => AiProvider;
  readonly createChatProvider: (model: string | undefined) => AiProvider;
  readonly canary?: (provider: AiProvider) => Promise<CanaryResult>;
  /** Boots one world per run and runs the scenarios (tests inject it; production uses the real harness). */
  readonly runScenarios?: (input: RunInput) => Promise<ScenarioRecord[]>;
}

const repoRoot = resolve(__dirname, '../../../..');

export function defaultDeps(): ContextEvalDeps {
  return {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date().toISOString(),
    loadCorpus: () => loadContextEvalCorpus(),
    writeReport: (fileName, contents) => {
      const dir = resolve(repoRoot, 'data/eval');
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, fileName);
      writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
      return path;
    },
    createSelectionProvider: (model) => new ClaudeCliProvider('claude', { intentSelectionModel: model }),
    createChatProvider: (model) => new ClaudeCliProvider('claude', model !== undefined ? { model } : {}),
  };
}

/** The real runs: one booted world per run, every selected scenario in order. */
export async function runScenariosWithHarness(input: RunInput): Promise<ScenarioRecord[]> {
  const { bootContextEvalWorld } = await import('./context-eval-harness');
  const { ContextEvalRunner, CONTEXT_EVAL_STUB_CHAT, CONTEXT_EVAL_STUB_SUMMARY } = await import('./context-eval-runner');
  const records: ScenarioRecord[] = [];
  for (let run = 1; run <= input.runs; run += 1) {
    const world = await bootContextEvalWorld(input.profile, {
      select: async () => JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] }),
      chat: async () => CONTEXT_EVAL_STUB_CHAT,
      summarize: async () => CONTEXT_EVAL_STUB_SUMMARY,
    });
    try {
      const runner = new ContextEvalRunner(world, input.corpus, {
        profile: input.profile,
        selection: input.selection,
        ...(input.chat !== undefined ? { chat: input.chat } : {}),
        capabilityNouns: capabilityNouns(),
        ...(input.onScenario !== undefined ? { onScenario: input.onScenario } : {}),
      });
      records.push(...(await runner.runAll(input.scenarioIds, run)));
    } finally {
      await world.close();
    }
  }
  return records;
}

function knownEntryIds(): Set<string> {
  return new Set<string>([...NL_CATALOG_ENTRY_IDS, ...NL_ACTION_ENTRY_IDS]);
}

function printCounts(deps: ContextEvalDeps, corpus: ContextEvalCorpus): void {
  const counts = corpusCounts(corpus);
  deps.stdout(`context eval corpus: ${counts.scenarios} scenarios, ${counts.turns} turns`);
  for (const [category, slot] of Object.entries(counts.perCategory)) deps.stdout(`  ${category.padEnd(24)} ${String(slot.scenarios).padStart(2)} scenarios  ${String(slot.turns).padStart(3)} turns`);
}

function report(deps: ContextEvalDeps, summaries: readonly ContextEvalSummary[]): void {
  for (const [index, summary] of summaries.entries()) {
    deps.stdout(`run ${index + 1}/${summaries.length}:`);
    for (const line of formatSummary(summary)) deps.stdout(`  ${line}`);
  }
}

function summariesOf(records: readonly ScenarioRecord[], runs: number): ContextEvalSummary[] {
  return Array.from({ length: runs }, (_, index) => summarize(records.filter((record) => record.run === index + 1).map((record) => record.score)));
}

export async function runCli(argv: readonly string[], deps: ContextEvalDeps = defaultDeps()): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  let corpus: ContextEvalCorpus;
  let sha256: string;
  let plan: ContextEvalPlan;
  try {
    parsed = parseArguments(argv);
    if (parsed.mode === 'help') {
      deps.stdout(HELP);
      return EXIT_OK;
    }
    ({ corpus, sha256 } = deps.loadCorpus());
    const problems = validateContextEvalCorpus(corpus, knownEntryIds());
    printCounts(deps, corpus);
    deps.stdout(`schema problems: ${problems.length}`);
    for (const problem of problems.slice(0, 50)) deps.stdout(`  ${problem}`);
    if (problems.length > 0) return EXIT_GATE_FAILED;
    const profile = (parsed.options['--profile'] ?? 'deployed') as ContextEvalProfile;
    const scenarioIds = (parsed.options['--scenarios'] ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    plan = buildContextEvalPlan(corpus, sha256, {
      profile,
      promptVersions: promptVersions(),
      selectionModel: parsed.options['--model'] ?? DEFAULT_CLAUDE_INTENT_SELECTION_MODEL,
      chat: parsed.options['--chat'] === 'real' ? 'real' : 'stub',
      ...(parsed.options['--chat-model'] !== undefined ? { chatModel: parsed.options['--chat-model'] } : {}),
      runs: integer(parsed.options['--runs'], 1),
      scenarioIds,
      gitHead: (deps.gitHead ?? defaultGitHead)(),
    });
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : 'invalid arguments');
    deps.stderr(HELP);
    return EXIT_USAGE;
  }
  const runScenarios = deps.runScenarios ?? runScenariosWithHarness;

  if (parsed.mode === 'dry') {
    const selector = parsed.options['--selector'] === 'none' ? 'none' : 'oracle';
    deps.stdout(`dry run: profile ${plan.profile}, selector ${selector} (no model call), ${plan.scenarioIds.length} scenarios; never gates`);
    const startedAt = deps.now();
    const records = await runScenarios({ corpus, profile: plan.profile, scenarioIds: plan.scenarioIds, runs: 1, selection: { kind: selector } });
    const summaries = summariesOf(records, 1);
    report(deps, summaries);
    const path = deps.writeReport(`context-eval-dry-${selector}-${plan.profile}-${startedAt.replace(/[:.]/g, '-')}.json`, `${JSON.stringify({ mode: 'dry', selector, profile: plan.profile, corpusSha256: sha256, gitHead: plan.gitHead, startedAt, finishedAt: deps.now(), summaries, records }, null, 2)}\n`);
    deps.stdout(`results written to ${path}`);
    return EXIT_OK;
  }

  const digest = computeContextEvalPlanDigest(plan);
  if (parsed.mode === 'plan') {
    deps.stdout(JSON.stringify({ ...plan, profileEnv: CONTEXT_EVAL_PROFILES[plan.profile], scenarioIds: `${plan.scenarioIds.length} scenarios` }, null, 2));
    deps.stdout(`plan digest (sha256): ${digest}`);
    const cost = plan.maxSelectionCalls * COST_PER_SELECTION_CALL_USD + plan.maxChatCalls * COST_PER_CHAT_CALL_USD;
    deps.stdout(
      `model calls this plan authorises: at most ${plan.maxSelectionCalls} selection call(s) (${plan.selectionModel})` +
        (plan.maxChatCalls > 0 ? ` and ${plan.maxChatCalls} chat call(s)` : ' and 0 chat calls (stub)') +
        `, plus ${CANARY_CLAUSE}${plan.maxChatCalls > 0 ? ' per provider' : ''}; estimated cost at most ~$${cost.toFixed(2)} (assumes ~$${COST_PER_SELECTION_CALL_USD}/selection call, ~$${COST_PER_CHAT_CALL_USD}/chat call)`,
    );
    deps.stdout('nothing was executed; a run is a Strict owner step and needs --approved-plan-digest equal to this digest');
    return EXIT_OK;
  }

  if (parsed.options['--approved-plan-digest'] !== digest) {
    deps.stderr('BLOCKED: --approved-plan-digest does not match the recomputed plan digest; nothing was executed');
    return EXIT_BLOCKED;
  }
  const selector = deps.createSelectionProvider(plan.selectionModel);
  if (!(await selector.isAvailable().catch(() => false))) {
    deps.stderr('BLOCKED: the selection provider is not available; nothing was executed');
    return EXIT_BLOCKED;
  }
  const guard = guardEvalProvider(selector, {
    concurrency: 1,
    maxCalls: plan.maxSelectionCalls,
    canary: deps.canary !== undefined ? () => (deps.canary as (provider: AiProvider) => Promise<CanaryResult>)(selector) : providerCanary(selector, undefined, Capability.INTENT_SELECTION),
    onTrip: (trip) => deps.stderr(formatTrip(trip)),
  });
  const counting = countingProvider(guard.provider, plan.maxSelectionCalls);
  let chatGuard: ReturnType<typeof guardEvalProvider> | undefined;
  let chatCounting: ReturnType<typeof countingProvider> | undefined;
  if (plan.chat === 'real') {
    const chat = deps.createChatProvider(plan.chatModel);
    if (!(await chat.isAvailable().catch(() => false))) {
      deps.stderr('BLOCKED: the chat provider is not available; nothing was executed');
      return EXIT_BLOCKED;
    }
    chatGuard = guardEvalProvider(chat, {
      concurrency: 1,
      maxCalls: plan.maxChatCalls,
      canary: deps.canary !== undefined ? () => (deps.canary as (provider: AiProvider) => Promise<CanaryResult>)(chat) : providerCanary(chat, undefined, Capability.GENERAL_CHAT),
      onTrip: (trip) => deps.stderr(formatTrip(trip)),
    });
    chatCounting = countingProvider(chatGuard.provider, plan.maxChatCalls);
  }
  const startedAt = deps.now();
  let done = 0;
  const records = await runScenarios({
    corpus,
    profile: plan.profile,
    scenarioIds: plan.scenarioIds,
    runs: plan.runs,
    selection: { kind: 'real', provider: counting.provider },
    ...(chatCounting !== undefined ? { chat: chatCounting.provider } : {}),
    onScenario: () => {
      done += 1;
      if (done % 10 === 0) deps.stderr(`… ${done}/${plan.scenarioIds.length * plan.runs}`);
    },
  });
  await guard.settle();
  await chatGuard?.settle();
  const outage: ProviderOutageReport = guard.report();
  const chatOutage = chatGuard?.report();
  const invalidReason = outage.invalidReason ?? chatOutage?.invalidReason;
  const summaries = summariesOf(records, plan.runs);
  const hard = Object.fromEntries(HARD_CHECKS.map((name) => [name, summaries.reduce((sum, summary) => sum + summary.hard[name], 0)]));
  const reportName = `context-eval-${plan.profile}-${startedAt.replace(/[:.]/g, '-')}.json`;
  const counts = counting.counts();
  const chatCounts = chatCounting?.counts();
  const overBound = counts.refused > 0 || (chatCounts?.refused ?? 0) > 0;
  if (invalidReason !== undefined && hardFailureTotal(hard) === 0) {
    printInvalidRun(deps.stdout, 'context gate', plan.runs, chatOutage?.invalidReason !== undefined && outage.invalidReason === undefined ? chatOutage : outage, hard);
    const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), verdict: `INVALID (provider unavailable: ${invalidReason})`, hardFailures: hard, providerOutcomes: { selection: outage, ...(chatOutage !== undefined ? { chat: chatOutage } : {}) }, records }, null, 2)}\n`);
    deps.stdout(`results written to ${path}`);
    return EXIT_INVALID;
  }
  report(deps, summaries);
  deps.stdout(`selection: ${counts.ok} answered, ${counts.failed} failed, ${counts.refused} refused over the bound (bound ${plan.maxSelectionCalls})${overBound ? '  BOUND EXCEEDED: the evaluation fails' : ''}`);
  deps.stdout(formatProviderOutcomes(outage));
  if (chatCounts !== undefined && chatOutage !== undefined) {
    deps.stdout(`chat: ${chatCounts.ok} answered, ${chatCounts.failed} failed, ${chatCounts.refused} refused over the bound (bound ${plan.maxChatCalls})`);
    deps.stdout(formatProviderOutcomes(chatOutage));
  }
  const passed = !overBound && summaries.every((summary) => gatePasses(summary));
  deps.stdout(`context gate (>= ${plan.gate.scenarioPassRate * 100}% scenarios, 0 hard failures, 0 harness errors, every run): ${passed ? 'PASSED' : `FAILED${invalidReason !== undefined ? ` ${outageAlsoSeenNote(invalidReason)}` : ''}`}`);
  const path = deps.writeReport(reportName, `${JSON.stringify({ plan: { ...plan, digest }, startedAt, finishedAt: deps.now(), summaries, providerOutcomes: { selection: outage, ...(chatOutage !== undefined ? { chat: chatOutage } : {}) }, records }, null, 2)}\n`);
  deps.stdout(`results written to ${path}`);
  return passed ? EXIT_OK : EXIT_GATE_FAILED;
}

if (require.main === module) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = EXIT_GATE_FAILED;
    },
  );
}
