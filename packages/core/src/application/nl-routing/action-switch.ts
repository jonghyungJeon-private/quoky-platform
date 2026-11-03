import type { Actor, Id, IsoTimestamp, MessageBody, Metadata } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import { joinBody, messageBody, type MessagePart } from '../message-rendering';
import { ActorMetadataStore } from '../actor-metadata-store';
import { NL_GLUED_REQUEST_TAIL, nlIsKeystrokePrefix, nlKeystrokeCount, nlKeystrokeDistance } from './garbled-action';

/**
 * The persisted kill switch of natural-language actions (ADR-0120 amendment A6-D3, owner decision 8): stored in
 * `Actor.metadata['quoky.actionSwitch'] = { state: 'running' | 'stopped', at }` through the existing `ActorRepository`,
 * with the same re-read-and-merge write as the ADR-0120 D7 preferences: no file flag, no new port, no migration.
 *
 * - The owner flips it with the Class A control phrases `에이전트 중지` / `에이전트 재개` (owner DM). ADR-0114 maps
 *   every platform to one owner Actor, so one stop covers all of them.
 * - While it is `stopped`, every A6 entry is withdrawn from the catalog (the selector never sees them) and the anchored
 *   grammars keep working. A missing or malformed record means `running`.
 * - ADR-0121 S2 may reuse this switch by its own note (ADR-0121 D7 names a data-directory flag).
 */

export { ACTION_SWITCH_METADATA_KEY } from '../../domain/action-write-condition';
import { ACTION_SWITCH_METADATA_KEY } from '../../domain/action-write-condition';

export type NlActionSwitchState = 'running' | 'stopped';

export interface NlActionSwitchRecord {
  readonly state: NlActionSwitchState;
  readonly at?: IsoTimestamp;
}

/** The switch as stored on this actor (default `running`). Pure. */
export function readActionSwitch(actor: Pick<Actor, 'metadata'>): NlActionSwitchRecord {
  const raw = actor.metadata?.[ACTION_SWITCH_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { state: 'running' };
  const record = raw as Record<string, unknown>;
  const state = record.state === 'stopped' ? 'stopped' : 'running';
  const at = typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) ? (record.at as IsoTimestamp) : undefined;
  return { state, ...(at !== undefined ? { at } : {}) };
}

/** Pure: the actor metadata with only the switch key replaced (every other key kept as it is). */
export function withActionSwitch(metadata: Metadata | undefined, state: NlActionSwitchState, now: IsoTimestamp): Metadata {
  return { ...(metadata ?? {}), [ACTION_SWITCH_METADATA_KEY]: { state, at: now } };
}

/** The owner's control phrase (A6-D3): `에이전트 중지` stops, `에이전트 재개` resumes; anything else `undefined`. */
export function parseActionSwitchPhrase(text: string): NlActionSwitchState | undefined {
  const normalized = text.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/[.!。！]+$/u, '').trim();
  if (/^에이전트 ?중지$/u.test(normalized)) return 'stopped';
  if (/^에이전트 ?재개$/u.test(normalized)) return 'running';
  return undefined;
}

/** The closed control phrases of the switch, exactly as the owner sends them (A6-D3). */
export const ACTION_SWITCH_PHRASES: Readonly<Record<NlActionSwitchState, string>> = Object.freeze({ stopped: '에이전트 중지', running: '에이전트 재개' });
const SWITCH_HEAD = '에이전트';
/** A near miss is a short whole message; anything longer is a sentence (chat, with the honest-chat control fact). */
const NEAR_MISS_MAX_CHARS = 20;
/** The keystroke budget of a near miss over the whole phrase, and of its verb (중지 / 재개) alone. */
const NEAR_MISS_PHRASE_KEYS = 2;
const NEAR_MISS_VERB_KEYS = 1;

/**
 * What a near miss of the switch phrase is (live DM test 2026-10-20: "에이ㄴ트 재개" and "에이전트 재" got a chat reply that
 * denied the command). Detected structurally on the closed phrase set, never on a typo list:
 *  - `typo`: the whole message (one line, Hangul only, no question mark) is within {@link NEAR_MISS_PHRASE_KEYS} keystrokes of
 *    a phrase ({@link nlKeystrokeDistance}, the garbled-noun measure, with loose jamo such as the ㄴ of "에이ㄴ트" as keys),
 *    with at most {@link NEAR_MISS_VERB_KEYS} of them in the verb, so "에이전트 좋지" (two keys off in the verb) is a sentence;
 *  - `request`: the exact phrase with a glued request tail or a polite 요 ("에이전트 재개해줘", "에이전트 중지요"; the closed tail
 *    class of garbled-action);
 *  - `prefix`: the message stopped mid-phrase, key for key a strict prefix of exactly ONE phrase beyond the shared head
 *    ("에이전트 재", "에이전트 잭"); "에이전트" alone is a prefix of both and is not a near miss;
 *  - `ambiguous`: within the budget of both phrases.
 * The exact phrases are never a near miss. Pure; the text is never logged.
 */
export type NlActionSwitchNearMiss =
  | { readonly kind: 'typo' | 'request' | 'prefix'; readonly state: NlActionSwitchState }
  | { readonly kind: 'ambiguous' };

function nearPhrase(candidate: string, phrase: string): boolean {
  const verb = phrase.slice(SWITCH_HEAD.length).replace(/\s+/gu, '');
  const chars = Array.from(candidate);
  for (let split = 1; split < chars.length; split += 1) {
    const verbDistance = nlKeystrokeDistance(chars.slice(split).join(''), verb);
    if (verbDistance > NEAR_MISS_VERB_KEYS) continue;
    const total = nlKeystrokeDistance(chars.slice(0, split).join(''), SWITCH_HEAD) + verbDistance;
    if (total >= 1 && total <= NEAR_MISS_PHRASE_KEYS) return true;
  }
  return false;
}

/** The near miss this whole message is of the switch phrase, or `undefined` (an exact phrase, or anything else). */
export function nearMissActionSwitchPhrase(text: string): NlActionSwitchNearMiss | undefined {
  if (parseActionSwitchPhrase(text) !== undefined) return undefined;
  // One line only (Codex P3): a line break is checked before the whitespace is normalized ("에이전트\n재개해줘" is no near miss).
  if (/[\r\n\u2028\u2029]/u.test(text.trim())) return undefined;
  const normalized = text.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/[.!。！~]+$/u, '').trim();
  if (normalized.length === 0 || normalized.length > NEAR_MISS_MAX_CHARS || !/^[\p{Script=Hangul} ]+$/u.test(normalized)) return undefined;
  const compact = normalized.replace(/ /gu, '');
  const states = Object.keys(ACTION_SWITCH_PHRASES) as NlActionSwitchState[];
  const phraseOf = (state: NlActionSwitchState): string => ACTION_SWITCH_PHRASES[state].replace(/\s+/gu, '');
  // The glued request tail and a polite 요 or 좀 before it come off ("에이전트 재개 좀 해줘", "에이전트 중지요").
  const tail = NL_GLUED_REQUEST_TAIL.exec(compact);
  const base = (tail === null ? compact : compact.slice(0, tail.index)).replace(/(?:좀|요)$/u, '');
  const stripped = base === compact ? undefined : base;
  const requested = states.find((state) => stripped === phraseOf(state));
  if (requested !== undefined) return { kind: 'request', state: requested };
  // An unfinished message (key for key the start of a phrase) is a prefix even when it is also one key short of it.
  const prefixOf = states.filter((state) => nlIsKeystrokePrefix(compact, phraseOf(state)));
  if (prefixOf.length > 0) {
    const beyondHead = nlKeystrokeCount(compact) > nlKeystrokeCount(SWITCH_HEAD);
    return prefixOf.length === 1 && prefixOf[0] !== undefined && beyondHead ? { kind: 'prefix', state: prefixOf[0] } : undefined;
  }
  const candidates = stripped === undefined || stripped.length === 0 ? [compact] : [compact, stripped];
  const near = states.filter((state) => candidates.some((candidate) => nearPhrase(candidate, phraseOf(state))));
  if (near.length > 1) return { kind: 'ambiguous' };
  return near[0] !== undefined ? { kind: 'typo', state: near[0] } : undefined;
}

/**
 * The fixed hint naming the exact phrase(s) of a near miss. Not a question: nothing is pending. A near miss never switches
 * (owner decision 2026-10-20): the switch acts only on the exact phrase, stop and resume alike.
 */
export function renderActionSwitchHint(states: readonly NlActionSwitchState[], language: 'ko' | 'en' = 'ko'): string {
  const stop = states.includes('stopped');
  const resume = states.includes('running');
  if (language === 'en') {
    if (stop && resume) return 'To stop the agent, send "에이전트 중지"; to turn it back on, send "에이전트 재개".';
    return stop ? 'To stop the agent, send "에이전트 중지".' : 'To turn the agent back on, send "에이전트 재개".';
  }
  if (stop && resume) return '에이전트를 멈추려면 "에이전트 중지", 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
  return stop ? '에이전트를 멈추려면 "에이전트 중지"라고 보내 주세요.' : '에이전트를 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
}

export interface NlActionSwitchDeps {
  /** The live Actor repository (`StorageProvider.actors`). */
  readonly actors: { get(id: Id): Promise<Actor | null>; save(actor: Actor): Promise<Actor> };
  readonly logger: Logger;
}

/**
 * The kill switch over the existing `ActorRepository`: re-read, merge one key, save (A6-D3), through the ONE per-actor
 * metadata lock (ADR-0122 D3), so a racing preference or grant write never loses this key or brings an old one back.
 */
export class NlActionSwitch {
  private readonly metadata: ActorMetadataStore;

  constructor(private readonly deps: NlActionSwitchDeps) {
    this.metadata = new ActorMetadataStore(deps.actors);
  }

  /** The current state of `actor` (the turn's snapshot; a save made earlier in the turn is visible on the next turn). */
  state(actor: Pick<Actor, 'metadata'>): NlActionSwitchState {
    return readActionSwitch(actor).state;
  }

  /** Persist `state` for `actorId`. Returns the saved state, or `undefined` when the write failed (logged, no content). */
  async set(actorId: Id, fallback: Actor, state: NlActionSwitchState, now: IsoTimestamp): Promise<NlActionSwitchState | undefined> {
    try {
      await this.metadata.updateMetadataEntry(
        actorId,
        ACTION_SWITCH_METADATA_KEY,
        () => withActionSwitch(undefined, state, now)[ACTION_SWITCH_METADATA_KEY],
        fallback,
      );
      this.log('info', 'nl_action.switch', { state });
      return state;
    } catch (error) {
      this.log('warn', 'nl_action.switch_write_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return undefined;
    }
  }

  private log(level: 'info' | 'warn', event: string, fields: Record<string, string>): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

/** The fixed replies of the control phrases (owner DM). */
export function renderActionSwitchReply(state: NlActionSwitchState | undefined, language: 'ko' | 'en' = 'ko'): string {
  if (state === undefined) {
    return language === 'en'
      ? 'I could not save the switch. Natural-language actions keep their previous state; please try again.'
      : '스위치를 저장하지 못했어요. 자연어 실행은 이전 상태 그대로예요. 다시 시도해 주세요.';
  }
  if (state === 'stopped') {
    return language === 'en'
      ? 'Natural-language actions are stopped. Exact commands (for example "할 일 추가: …") still work. Send "에이전트 재개" to resume.'
      : '자연어 실행을 멈췄어요. 정확한 명령(예: "할 일 추가: …")은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
  }
  return language === 'en' ? 'Natural-language actions are running again.' : '자연어 실행을 다시 켰어요.';
}

/**
 * ADR-0120 A6-D3 amendment (2026-11-03): what `에이전트 중지` adds to its fixed reply when the owner had approvals open that the
 * switch governs. `closed` are the requests it closed (one line each: action kind and the target the preview showed, built
 * by the caller); `running` is how many writes had already started: those are not aborted, they finish and report. Both
 * empty: `undefined`, so the reply stays byte-identical to the plain stop reply.
 */
export function renderActionSwitchStopNotice(closed: ReadonlyArray<MessagePart>, running: number, language: 'ko' | 'en' = 'ko', failure: { readonly failed?: number; readonly scanFailed?: boolean } = {}): MessageBody | undefined {
  const failed = failure.failed ?? 0;
  if (closed.length === 0 && running === 0 && failed === 0 && failure.scanFailed !== true) return undefined;
  const parts: MessagePart[] = [];
  if (closed.length > 0) {
    parts.push(language === 'en' ? `Closed ${closed.length} open approval request(s) without running them:` : `열려 있던 승인 요청 ${closed.length}건을 실행하지 않고 닫았어요:`);
    for (const line of closed) parts.push(messageBody('- ', line));
    parts.push(language === 'en' ? 'To do one of them, resume and ask again.' : '다시 하려면 "에이전트 재개" 후 다시 말씀해 주세요.');
  }
  if (running > 0) {
    parts.push(
      language === 'en'
        ? `${running} write(s) had already started; they finish and report their result.`
        : `이미 실행이 시작된 요청 ${running}건은 중단하지 않고 끝까지 마친 뒤 결과를 알려 드려요.`,
    );
  }
  // A scan or a withdrawal that failed: the stop reply must not claim nothing was open. The switch stays stopped regardless.
  if (failure.scanFailed === true) {
    parts.push(language === 'en' ? 'I could not check for open approvals. Please check before resuming.' : '열린 승인을 확인하지 못했어요. 재개하기 전에 확인해 주세요.');
  } else if (failed > 0) {
    parts.push(language === 'en' ? `${failed} request(s) could not be closed. Please check before resuming.` : `${failed}건은 닫지 못했어요. 재개하기 전에 확인해 주세요.`);
  }
  return joinBody(parts);
}
