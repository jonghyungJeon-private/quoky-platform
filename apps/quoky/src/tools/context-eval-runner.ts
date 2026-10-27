/**
 * The context eval runner: drives every scenario of the corpus through one booted world (`context-eval-harness.ts`, the
 * production `AppModule`) and scores each turn (`context-eval.ts`). The selection source decides what kind of run it is:
 *
 * - `real` (Strict, `context-eval-cli.ts --mode run`): the app's own router prompt goes to a real model (the deployed
 *   selection model), behind the CLI's outage guard and the plan's hard call cap;
 * - `oracle` (dry, no model): the scenario's own `oracle` answer, i.e. a perfect selector, so the run measures Core's part
 *   of context handling (pending answers, reference binding, carry-over, honest copy, writes) on its own;
 * - `none` (dry, no model): the selector always answers none, i.e. the deterministic path alone (a provider outage).
 *
 * Chat is a fixed stub unless a real chat provider is given. Setup messages never reach a model. Suggestion probes
 * (owner decision D2, 2026-10-26): a command in Core's own copy is probed on the deterministic path only (the selector
 * answers none); a command the chat model suggested is probed with the real selector in a Strict run (`real`), at most
 * {@link CONTEXT_EVAL_CHAT_PROBES_PER_TURN} per reply, and on the deterministic path otherwise. Never the chat model.
 */
import type { AiProvider, AiRequest } from '@quoky/core';
import {
  CONTEXT_EVAL_CHAT_PROBES_PER_TURN,
  type WriteExpectation,
  awaitsAnswer,
  consumeWrites,
  extractSuggestions,
  observedWrites,
  fixtureStringsOf,
  scoreScenario,
  scoreTurn,
  servedEntry,
  type CapabilityNouns,
  type ContextEvalCorpus,
  type ContextEvalScenario,
  type ContextEvalTurn,
  type ScenarioScore,
  type TurnScore,
} from './context-eval';
import { profileActs, type ContextEvalProfile, type ContextEvalProviders, type ContextEvalWorld, type TurnObservation } from './context-eval-harness';

/** The chat stub's reply: neutral (no claim, no incapability, no quoted command). */
export const CONTEXT_EVAL_STUB_CHAT = '(평가용 대화 응답 자리표시자)';
export const CONTEXT_EVAL_STUB_SUMMARY = '(평가용 요약 자리표시자)';
const NONE = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });

export type SelectionSource =
  | { readonly kind: 'real'; readonly provider: AiProvider }
  | { readonly kind: 'oracle' }
  | { readonly kind: 'none' };

export interface RunnerOptions {
  readonly profile: ContextEvalProfile;
  readonly selection: SelectionSource;
  /** A real chat provider (Strict runs only); the stub otherwise. */
  readonly chat?: AiProvider;
  /** Catalog nouns of what Quoky can do in this run (the false-incapability detector's vocabulary). */
  readonly capabilityNouns: CapabilityNouns;
  readonly onScenario?: (record: ScenarioRecord) => void;
}

export interface TurnRecord {
  readonly turn: number;
  /** The owner text actually sent (an echo turn's suggestion), or undefined when skipped. */
  readonly sent?: string;
  readonly entry?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly chat: boolean;
  readonly pending?: string;
  readonly selectionCalls: number;
  /** What the router prompt carried as context (the previous selection's entry, the reference context line). */
  readonly selectorSaw?: TurnObservation['selectorSaw'];
  /** Quoky's reply, bounded (synthetic fixtures only: for diagnosis in the report file, never printed). */
  readonly reply?: string;
  readonly suggestions: readonly string[];
  readonly unparseable: readonly string[];
  /** D2: the subset of `suggestions` the chat model wrote (probed with the real selector in Strict runs). */
  readonly chatSuggestions?: readonly string[];
  /** D2: chat-suggested commands beyond the per-reply probe bound (reported, not probed). */
  readonly unprobed?: readonly string[];
  readonly failed: readonly string[];
}

export interface ScenarioRecord {
  readonly run: number;
  readonly score: ScenarioScore;
  readonly turns: readonly TurnRecord[];
}

/**
 * A suggestion as the owner would send it: Quoky's copy writes templates with placeholders (`N`, `번호`, `<내용>`); the probe
 * fills them with a sample value. Everything else is sent as written.
 */
export function instantiatePlaceholders(suggestion: string): string {
  return suggestion
    .replace(/<[^<>]{1,20}>/gu, '테스트')
    .replace(/(?<![\p{L}\p{N}])N(?=번|[^\p{L}\p{N}]|$)/gu, '1')
    .replace(/(?<![\p{L}\p{N}])번호(?![\p{L}\p{N}])/gu, '1');
}

/** Every write the scenario declares on any turn (the safety-only scoring's allowance). */
export function mergeWrites(all: ReadonlyArray<WriteExpectation | undefined>): WriteExpectation {
  const merged: Record<string, unknown> = {};
  for (const writes of all) {
    for (const [name, value] of Object.entries(writes ?? {})) {
      if (Array.isArray(value)) merged[name] = [...((merged[name] as string[] | undefined) ?? []), ...value];
      else if (typeof value === 'number') merged[name] = ((merged[name] as number | undefined) ?? 0) + value;
      else if (value === true || merged[name] === undefined) merged[name] = value;
    }
  }
  return merged as WriteExpectation;
}

/** The read entry the immediately previous turn listed (the #280 condition), if it showed a listing. */
function listingOf(previous: TurnObservation | undefined): string | undefined {
  // A listing, not a question: a turn that went to chat or left a question or an approval open showed no listing.
  if (previous === undefined || previous.chatPrompts.length > 0 || awaitsAnswer(previous)) return undefined;
  const entry = servedEntry(previous)?.entryId;
  return entry !== undefined && READ_LISTINGS.has(entry) ? entry : undefined;
}

/** The read entries that show the owner a listing. */
const READ_LISTINGS: ReadonlySet<string> = new Set(['calendar.events', 'mail.list', 'drive.files', 'jira.issues', 'jira.release', 'todo.list', 'reminder.list', 'slack.search']);

/** The oracle selector output of a turn (dry mode only). */
export function oracleOutput(turn: ContextEvalTurn | undefined): string {
  const oracle = turn?.oracle;
  if (oracle === undefined || (oracle.entryId === 'none' && oracle.answer === undefined)) return NONE;
  return JSON.stringify({
    entryId: oracle.entryId,
    args: oracle.args ?? {},
    ambiguity: oracle.ambiguity ?? 'CLEAR',
    alternatives: (oracle.alternatives ?? []).map((alternative) => ({ entryId: alternative.entryId, args: alternative.args ?? {} })),
    ...(oracle.answer !== undefined ? { answer: oracle.answer } : {}),
  });
}

/** The scenario is scored in full only when the profile can act as it requires; otherwise on the hard checks only. */
export function scoredUnder(scenario: ContextEvalScenario, profile: ContextEvalProfile): 'full' | 'safety' {
  const acts = profileActs(profile);
  for (const requirement of scenario.requires ?? []) {
    if (requirement === 'actions' && !acts.actions) return 'safety';
    if (requirement === 'itemR2' && !acts.itemR2) return 'safety';
  }
  return 'full';
}

export class ContextEvalRunner {
  constructor(
    private readonly world: ContextEvalWorld,
    private readonly corpus: ContextEvalCorpus,
    private readonly options: RunnerOptions,
  ) {}

  /** The chat model's raw replies of the current turn (D2: which suggestions the chat model wrote). */
  private chatOutputs: string[] = [];

  private providers(turn: ContextEvalTurn | undefined, mode: 'scored' | 'quiet' | 'probe-selector'): ContextEvalProviders {
    const { selection, chat } = this.options;
    const stubChat = async (): Promise<string> => CONTEXT_EVAL_STUB_CHAT;
    if (mode === 'quiet') return { select: async () => NONE, chat: stubChat, summarize: async () => CONTEXT_EVAL_STUB_SUMMARY };
    // D2: a chat-suggested command is probed through the real selector (a Strict run); chat stays the stub.
    if (mode === 'probe-selector') {
      return {
        select: async (request: AiRequest) => (selection.kind === 'real' ? (await selection.provider.execute(request)).text : NONE),
        chat: stubChat,
        summarize: async () => CONTEXT_EVAL_STUB_SUMMARY,
      };
    }
    return {
      select: async (request: AiRequest) => {
        if (selection.kind === 'oracle') return oracleOutput(turn);
        if (selection.kind === 'none') return NONE;
        return (await selection.provider.execute(request)).text;
      },
      chat:
        chat === undefined
          ? stubChat
          : async (request: AiRequest) => {
              const text = (await chat.execute(request)).text;
              this.chatOutputs.push(text);
              return text;
            },
      summarize: async () => CONTEXT_EVAL_STUB_SUMMARY,
    };
  }

  async runScenario(scenario: ContextEvalScenario, index: number, run: number): Promise<ScenarioRecord> {
    const { world } = this;
    const fixtures = this.corpus.worlds[scenario.world] ?? {};
    const scored = scoredUnder(scenario, this.options.profile);
    const owner = await world.beginScenario(index, fixtures);
    const ownerTexts: string[] = [];
    const fixtureTexts = fixtureStringsOf(fixtures);
    let harnessError: string | undefined;
    const observations: Array<TurnObservation | undefined> = [];
    const sent: Array<string | undefined> = [];
    const ownerTextsAt: string[][] = [];
    const offered: string[][] = [];
    const suggestions: string[][] = [];
    const chatWritten: string[][] = [];
    const unprobedAt: string[][] = [];
    const chatTexts: string[][] = [];
    const verdicts = new Map<string, boolean>();
    try {
      try {
        // Setup: deterministic grammar messages; any model call here is a corpus error.
        for (const step of scenario.setup ?? []) {
          world.providers = this.providers(undefined, 'quiet');
          ownerTexts.push(step.text);
          const observation = await world.turn(owner, step.text, step.context === 'channel' ? owner.channel : owner.dm);
          if (observation.selectionCalls > 0 || observation.chatPrompts.length > 0) harnessError = 'setup-not-deterministic';
          if (observation.blockedFetches.length > 0) harnessError = 'unstubbed-fetch';
        }
        for (const turn of scenario.turns) {
          let text = turn.text;
          if (turn.echoSuggestion === true) {
            const previous = observations.at(-1);
            const earlier = observations.slice(0, -1).flatMap((entry) => (entry === undefined ? [] : [entry.reply]));
            text = previous === undefined ? undefined : extractSuggestions(previous.reply, ownerTexts, fixtureTexts, earlier)[0];
          }
          sent.push(text);
          if (text === undefined) {
            observations.push(undefined);
            ownerTextsAt.push([...ownerTexts]);
            continue;
          }
          ownerTexts.push(text);
          ownerTextsAt.push([...ownerTexts]);
          world.providers = this.providers(turn, 'scored');
          this.chatOutputs = [];
          const observation = await world.turn(owner, text, turn.context === 'channel' ? owner.channel : owner.dm);
          if (observation.blockedFetches.length > 0) harnessError = 'unstubbed-fetch';
          observations.push(observation);
          chatTexts[observations.length - 1] = [...this.chatOutputs];
        }
        // A reply's suggestions are judged against the owner's words up to that turn: a later echo of a suggestion is not the
        // owner's earlier wording, so it still gets probed.
        // Suggestion probes: every command a reply suggested, sent alone in a fresh DM with the selector answering none.
        // Replies that leave the conversation waiting (a question, a choice, an approval) suggest answers in context; those
        // are exercised by the echo scenarios, not probed out of context.
        const earlierReplies = (position: number): string[] => observations.slice(0, position).flatMap((entry) => (entry === undefined ? [] : [entry.reply]));
        for (const [position, observation] of observations.entries()) offered.push(observation === undefined ? [] : extractSuggestions(observation.reply, ownerTextsAt[position] ?? [], fixtureTexts, earlierReplies(position)));
        for (const [position, observation] of observations.entries()) suggestions.push(observation === undefined || awaitsAnswer(observation) ? [] : (offered[position] ?? []));
        // D2: a suggestion the chat model wrote (it appears in that turn's raw chat reply) vs Core's own fixed copy.
        const compact = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim();
        for (const [position, observation] of observations.entries()) {
          const raw = (chatTexts[position] ?? []).map(compact);
          const fromChat = observation !== undefined && observation.chatPrompts.length > 0 ? (suggestions[position] ?? []).filter((suggestion) => raw.some((reply) => reply.includes(compact(suggestion)))) : [];
          chatWritten.push(fromChat.slice(0, CONTEXT_EVAL_CHAT_PROBES_PER_TURN));
          unprobedAt.push(fromChat.slice(CONTEXT_EVAL_CHAT_PROBES_PER_TURN));
        }
        for (const [position, list] of suggestions.entries()) {
          for (const suggestion of list) {
            if ((unprobedAt[position] ?? []).includes(suggestion)) continue;
            const viaSelector = (chatWritten[position] ?? []).includes(suggestion) && this.options.selection.kind === 'real';
            const key = `${viaSelector ? 'chat' : 'core'}\u0000${suggestion}`;
            if (verdicts.has(key)) continue;
            world.providers = this.providers(undefined, viaSelector ? 'probe-selector' : 'quiet');
            const probe = await world.turn(owner, instantiatePlaceholders(suggestion), world.freshDm());
            verdicts.set(key, probe.chatPrompts.length === 0);
          }
        }
      } catch (error) {
        // A throw mid-scenario still scores the turns it observed: a hard failure seen before the throw is kept (hard
        // failures take precedence over an INVALID outage).
        harnessError = `error:${error instanceof Error ? error.name : 'unknown'}`;
      }
      let cardSeen = false;
      // Safety-only scoring: the scenario's declared writes, used up as turns make them (any turn may make one, none twice).
      let scenarioWrites = mergeWrites(scenario.turns.map((entry) => entry.expect.writes));
      const scores: TurnScore[] = [];
      const records: TurnRecord[] = [];
      for (const [position, turn] of scenario.turns.slice(0, observations.length).entries()) {
        const observation = observations[position];
        const isChat = (suggestion: string): boolean => (chatWritten[position] ?? []).includes(suggestion) && this.options.selection.kind === 'real';
        const unparseable = (suggestions[position] ?? []).filter((suggestion) => verdicts.get(`${isChat(suggestion) ? 'chat' : 'core'}\u0000${suggestion}`) === false);
        const unparseableChat = unparseable.filter((suggestion) => (chatWritten[position] ?? []).includes(suggestion));
        const priorObservation = observations.slice(0, position).filter((entry): entry is TurnObservation => entry !== undefined).at(-1);
        const listingShown = position > 0 ? listingOf(observations[position - 1]) : undefined;
        const score = scoreTurn(
          position + 1,
          {
            turn,
            observation,
            ...(priorObservation !== undefined ? { previousReply: priorObservation.reply, previousReplyWasChat: priorObservation.chatPrompts.length > 0 } : {}),
            unparseable,
            unparseableChat,
            cardSeenBefore: cardSeen,
            suggestions: offered[position] ?? [],
            scenarioWrites,
            ...(listingShown !== undefined ? { listingShown } : {}),
          },
          { fixtures, ownerTexts: ownerTextsAt[position] ?? ownerTexts, capabilityNouns: this.options.capabilityNouns, scored, chatIsStub: this.options.chat === undefined },
        );
        if (observation !== undefined && Object.keys(observation.after.anchors).length > 0) cardSeen = true;
        if (observation !== undefined) scenarioWrites = consumeWrites(scenarioWrites, observedWrites(observation));
        scores.push(score);
        const entry = observation === undefined ? undefined : servedEntry(observation);
        records.push({
          turn: position + 1,
          ...(sent[position] !== undefined ? { sent: sent[position] } : {}),
          ...(entry !== undefined ? { entry: entry.entryId, args: entry.args } : {}),
          chat: (observation?.chatPrompts.length ?? 0) > 0,
          ...(observation?.session.pending !== undefined ? { pending: observation.session.pending.kind } : {}),
          selectionCalls: observation?.selectionCalls ?? 0,
          ...(observation?.selectorSaw !== undefined ? { selectorSaw: observation.selectorSaw } : {}),
          ...(observation !== undefined ? { reply: observation.reply.slice(0, 2000) } : {}),
          suggestions: suggestions[position] ?? [],
          unparseable,
          ...((chatWritten[position] ?? []).length > 0 ? { chatSuggestions: chatWritten[position] } : {}),
          ...((unprobedAt[position] ?? []).length > 0 ? { unprobed: unprobedAt[position] } : {}),
          failed: score.checks.filter((check) => !check.pass).map((check) => `${check.name}${check.detail !== undefined ? `: ${check.detail}` : ''}`),
        });
      }
      const record = { run, score: scoreScenario(scenario, scores, scored, harnessError), turns: records };
      this.options.onScenario?.(record);
      return record;
    } catch (error) {
      const record = { run, score: scoreScenario(scenario, [], scored, `error:${error instanceof Error ? error.name : 'unknown'}`), turns: [] };
      this.options.onScenario?.(record);
      return record;
    }
  }

  async runAll(scenarioIds: readonly string[], run: number): Promise<ScenarioRecord[]> {
    const records: ScenarioRecord[] = [];
    const selected = this.corpus.scenarios.filter((scenario) => scenarioIds.includes(scenario.id));
    for (const [index, scenario] of selected.entries()) records.push(await this.runScenario(scenario, index, run));
    return records;
  }
}
