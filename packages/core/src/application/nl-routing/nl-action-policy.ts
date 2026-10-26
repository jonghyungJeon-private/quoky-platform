import type { LogFields } from '../../ports/logger.port';
import type { NlCatalogRisk, NlItemSource, NlItemTarget } from './catalog';
import { nlNumeralsIn, nlOrdinalsIn, type NlRefKind } from './action-entries';
import type { NlResolutionOutcome } from './item-reference';
import { normalizeForMatch } from './selection-input';

/**
 * The policy half of natural-language actions (ADR-0120 amendment A6-D3/D8): the flag levels, the per-actor caps, the
 * fixed owner-facing copy of every question and refusal, the label answer to a target question, and the content-free
 * audit line. Pure except for the caps' in-memory counters. Nothing here routes a message.
 */

/** A6-D8: `QUOKY_NL_ACTIONS` = `off` | `shadow` | `local` | `external`, default `off`. */
export type NlActionLevel = 'off' | 'shadow' | 'local' | 'external';
export const NL_ACTION_LEVELS: readonly NlActionLevel[] = ['off', 'shadow', 'local', 'external'];

/** Whether the level lets an A6 decision act (`local`, `external`); `shadow` only logs. */
export function actionLevelActs(level: NlActionLevel): boolean {
  return level === 'local' || level === 'external';
}

/** A6-D3 caps, per actor. EXTERNAL_WRITE previews (R3) keep their numbers here for when they are offered. */
export const NL_ACTION_CAPS = Object.freeze({
  localWritePerHour: 20,
  localWritePerDay: 100,
  itemReadPerHour: 30,
  /** A6 R2 owner decision D8: `item.summarize` a day per actor (MSIT per-token volume). */
  itemReadPerDay: 100,
  externalPerHour: 10,
  externalPerDay: 30,
});

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TRACKED_ACTORS = 256;

/** In-memory sliding windows per (actor, risk). A breach answers with the fixed cap reply; nothing else counts. */
export class NlActionCaps {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly caps: { readonly [K in Exclude<keyof typeof NL_ACTION_CAPS, 'itemReadPerDay'>]: number } & { readonly itemReadPerDay?: number } = NL_ACTION_CAPS,
  ) {}

  /** Whether one more execution of `risk` stays within the caps at `nowMs`. */
  allows(actorId: string, risk: NlCatalogRisk, nowMs: number): boolean {
    const times = this.prune(actorId, risk, nowMs);
    const lastHour = times.filter((at) => nowMs - at < HOUR_MS).length;
    switch (risk) {
      case 'LOCAL_WRITE':
        return lastHour < this.caps.localWritePerHour && times.length < this.caps.localWritePerDay;
      case 'ITEM_READ':
        return lastHour < this.caps.itemReadPerHour && times.length < (this.caps.itemReadPerDay ?? NL_ACTION_CAPS.itemReadPerDay);
      case 'EXTERNAL_WRITE':
        return lastHour < this.caps.externalPerHour && times.length < this.caps.externalPerDay;
      case 'READ':
        return true;
    }
  }

  /** Record one execution of `risk` (counted when dispatched, so a refused execution still counts: conservative). */
  note(actorId: string, risk: NlCatalogRisk, nowMs: number): void {
    if (risk === 'READ') return;
    const times = this.prune(actorId, risk, nowMs);
    times.push(nowMs);
    const key = `${actorId}\u0000${risk}`;
    this.windows.delete(key);
    this.windows.set(key, times);
    while (this.windows.size > MAX_TRACKED_ACTORS * 3) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }

  private prune(actorId: string, risk: NlCatalogRisk, nowMs: number): number[] {
    const key = `${actorId}\u0000${risk}`;
    const kept = (this.windows.get(key) ?? []).filter((at) => nowMs - at >= 0 && nowMs - at < DAY_MS);
    if (kept.length > 0) this.windows.set(key, kept);
    else this.windows.delete(key);
    return kept;
  }
}

// ── the audit line (A6-D3) ────────────────────────────────────────────────────────────────────────────────────────

export const NL_ACTION_LOG_EVENT = 'nl_action.decided';

export type NlActionResult =
  | 'executed'
  | 'previewed'
  | 'asked'
  | 'refused'
  | 'undone'
  | 'capped'
  | 'shadow'
  // A6 R5a deictic writes (§4 audit): the owner's answer to a preview.
  | 'confirmed'
  | 'declined'
  | 'expired'
  | 'changed'
  | 'stale-reply';

/** A6 R5a: the ref kind of a deictic write (`deictic:<referent kind>`; `deictic:none` when nothing resolved). */
export type NlDeicticRefKind = 'deictic:item.local' | 'deictic:owner.message' | 'deictic:none';

export interface NlActionAudit {
  readonly entryId: string;
  readonly risk: NlCatalogRisk;
  readonly refKind: NlRefKind | 'match' | 'none' | NlDeicticRefKind;
  readonly resolution: NlResolutionOutcome;
  readonly result: NlActionResult;
  readonly latencyMs?: number;
  readonly target?: NlItemTarget;
  /** A closed reason for an ask or refusal (never a value). */
  readonly reason?: string;
  /** A6-D3 correlation: the session and the turn (inbound message) ids. */
  readonly sessionId?: string;
  readonly turnId?: string;
  /** A6 R5a: the referent's shown label (a to-do number or a reminder `#N`) and whose text the payload is. */
  readonly referentLabel?: number;
  readonly payloadOrigin?: 'owner-item' | 'owner-message';
}

/**
 * The content-free fields of `nl_action.decided`: ids and closed values only. A local item is its UUID; a provider item
 * is `{ source, listing label, listing at }` (no provider id, no hash). Never text, titles or spans.
 */
export function nlActionLogFields(audit: NlActionAudit): LogFields {
  const target = audit.target;
  const local = target !== undefined && (target.source === 'todo' || target.source === 'reminder');
  return {
    entryId: audit.entryId,
    risk: audit.risk,
    refKind: audit.refKind,
    resolution: audit.resolution,
    result: audit.result,
    ...(audit.reason !== undefined ? { reason: audit.reason } : {}),
    ...(audit.latencyMs !== undefined ? { latencyMs: audit.latencyMs } : {}),
    ...(audit.sessionId !== undefined ? { sessionId: audit.sessionId } : {}),
    ...(audit.turnId !== undefined ? { turnId: audit.turnId } : {}),
    ...(target === undefined ? {} : { targetSource: target.source }),
    ...(local && target.id !== undefined ? { targetId: target.id } : {}),
    ...(target !== undefined && target.label !== undefined ? { targetLabel: target.label } : {}),
    ...(!local && target?.listingAt !== undefined ? { targetListingAt: target.listingAt } : {}),
    ...(audit.referentLabel !== undefined ? { referentLabel: audit.referentLabel } : {}),
    ...(audit.payloadOrigin !== undefined ? { payloadOrigin: audit.payloadOrigin } : {}),
  };
}

// ── answering a target question by label (A6-D2) ──────────────────────────────────────────────────────────────────

export type NlLabelChoice =
  | { readonly kind: 'pick'; readonly index: number }
  | { readonly kind: 'cancel' }
  /** A bare number or ordinal answer that names none of the offered labels (A6 R1 review: asked again, never routed). */
  | { readonly kind: 'unlisted' }
  | { readonly kind: 'none' };

const CANCEL = /^(?:취소|그만|됐어(?:요)?|아니(?:야|요)?|아뇨|안\s?해|no|nope|cancel|never\s*mind)$/u;
const ANSWER_FILLER = /(?:#|번|째|이요|에요|예요|요|으로|로|거|것|그거|이거|걸로|해\s*줘|해\s*주세요|할게|선택|그럼|음|알림|할\s?일|the|one|number|please|,|\.)/gu;

/**
 * A reply to an A6 target question: a number means the SHOWN LABEL (a to-do number, a reminder's `#N`, a list number),
 * so "3" means the same item whether it answers the question or comes later; an ordinal word means the position among the
 * candidates. Anything that is not just that (a new request) is `none`.
 */
export function resolveLabelChoice(reply: string, labels: readonly number[]): NlLabelChoice {
  const text = normalizeForMatch(reply).replace(/[!?。！？~…]+/gu, ' ').trim();
  if (text.length === 0 || text.length > 30) return { kind: 'none' };
  if (CANCEL.test(text)) return { kind: 'cancel' };
  const numbers = [...new Set(nlNumeralsIn(text))];
  const ordinals = [...new Set(nlOrdinalsIn(text))];
  const leftover = text
    .replace(/(?:첫|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:번\s*)?째/gu, ' ')
    .replace(/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gu, ' ')
    .replace(/\d+/gu, ' ')
    .replace(ANSWER_FILLER, ' ')
    .trim();
  if (leftover.length > 0) return { kind: 'none' };
  if (numbers.length === 1 && ordinals.length === 0) {
    const index = labels.indexOf(numbers[0] as number);
    return index >= 0 ? { kind: 'pick', index } : { kind: 'unlisted' };
  }
  if (ordinals.length === 1 && numbers.length === 0) {
    const index = (ordinals[0] as number) - 1;
    return index >= 0 && index < labels.length ? { kind: 'pick', index } : { kind: 'unlisted' };
  }
  return numbers.length + ordinals.length > 0 ? { kind: 'unlisted' } : { kind: 'none' };
}

// ── fixed copy ───────────────────────────────────────────────────────────────────────────────────────────────────

type Lang = 'ko' | 'en';

const NOUN: Readonly<Record<NlItemSource, { ko: string; en: string }>> = {
  todo: { ko: '할 일', en: 'to-do' },
  reminder: { ko: '알림', en: 'reminder' },
  mail: { ko: '메일', en: 'mail' },
  drive: { ko: '드라이브 파일', en: 'Drive file' },
  jira: { ko: '지라 이슈', en: 'Jira issue' },
  slack: { ko: '슬랙 메시지', en: 'Slack message' },
};

/** A shown label as the owner saw it: a reminder's `#N`, otherwise `N번`. */
export function renderShownLabel(source: NlItemSource, label: number, language: Lang): string {
  if (source === 'reminder') return `#${label}`;
  return language === 'en' ? `#${label}` : `${label}번`;
}

/** A6-D3: the fixed reply to a payload made only of deictic, ordinal or time words. */
export function renderDeicticPayload(language: Lang): string {
  return language === 'en' ? 'Please write the content itself.' : '내용을 직접 적어 주세요.';
}

/**
 * The list status views (canceled, completed / past, all) are DM-only until ADR-0122 P1 ships (owner: channels default-deny;
 * CA review): a channel gets this fixed reply and nothing is read.
 */
export function renderListStatusDmOnly(language: Lang): string {
  return language === 'en' ? 'I show canceled, finished or all items only in a DM.' : '취소·완료·지난 항목이나 전체 목록은 DM에서만 보여 드려요.';
}

/** A6 R1 review: an action the open question did not ask for is not run (that one turn; the reply ends the question). */
export function renderQuestionOpen(language: Lang): string {
  return language === 'en' ? 'A question is still open, so I did not do that. Please tell me again.' : '질문이 열려 있어 실행하지 않았어요. 다시 말씀해 주세요.';
}

/**
 * A6-D3a amendment 1 (CA P2): a local write asked for outside a DM while ADR-0122 enforcement is off; nothing ran, and no
 * target question is asked. The same copy as the handlers' A6-D1 DM-only refusal at dispatch.
 */
export function renderDmOnlyAction(language: Lang): string {
  return language === 'en' ? 'I do that only in a direct message. Nothing was changed.' : '이 작업은 DM에서만 해요. 아무것도 바꾸지 않았어요.';
}

/** A6-D6 stale-command guard and every "say it again" answer. */
export function renderRestate(language: Lang): string {
  return language === 'en' ? 'Please tell me again what to do and which item.' : '무엇을/어느 항목을 다시 말씀해 주세요.';
}

/**
 * A6-D3a amendment 1, garbled action word addendum: the question when the action word looks garbled ("3번 완룐 처리해줘"),
 * offering the closed vocabulary word it may stand for. Nothing was changed; the owner restates with the word.
 */
export function renderGarbledAction(candidate: string, language: Lang): string {
  return language === 'en'
    ? `Did you mean "${candidate}"? Nothing was changed yet. If so, please say it again with that word.`
    : `'${candidate}'(이)라고 하신 건가요? 아직 아무것도 바꾸지 않았어요. 맞으면 '${candidate}'로 다시 말씀해 주세요.`;
}

/** A Korean particle pair chosen by the word's last syllable (final consonant or not); both forms for anything else. */
function particle(word: string, afterConsonant: string, afterVowel: string): string {
  const code = (Array.from(word).at(-1) ?? '').charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${afterConsonant}(${afterVowel})`;
  return code % 28 === 0 ? afterVowel : afterConsonant;
}

/*
 * The four asks below keep NO open question (A6-D2 pending questions are content-free, so a bare "응" or "3시" could not
 * complete them). Each is a RESTATE prompt: it says what to send and never ends in a question a reply cannot bind to (live
 * test 4, turns 39-40: a question Quoky cannot act on is the anti-pattern this branch removes).
 */

/**
 * Owner decision (b) of 2026-10-19: the noun that decides the list looks like a typo of a catalog list noun ("리마이너 걸어줘").
 * Nothing was changed; the owner restates with the noun.
 */
export function renderGarbledNoun(candidate: string, language: Lang): string {
  return language === 'en'
    ? `If you meant "${candidate}", please say it again with that word. Nothing was changed yet.`
    : `'${candidate}' 말씀이시면 '${candidate}'${particle(candidate, '을', '를')} 넣어 다시 말씀해 주세요. 아직 아무것도 바꾸지 않았어요.`;
}

/**
 * Owner decision (b) of 2026-10-19: a word in the list noun's slot that is close to no known noun (the owner's own word,
 * echoed back in a DM only). Nothing was changed; the owner restates with the list.
 */
export function renderUnknownNoun(word: string, language: Lang): string {
  return language === 'en'
    ? `I don't know what "${word}" means here. Please say it again with "to-do" or "reminder". Nothing was changed yet.`
    : `'${word}'${particle(word, '이', '가')} 무슨 뜻인지 모르겠어요. '할 일'인지 '알림'인지 넣어 다시 말씀해 주세요. 아직 아무것도 바꾸지 않았어요.`;
}

/**
 * CA / Codex P2 (2026-10-19): a bare "<title> 할 일" whose title may not be a task ("회사 할 일", "정산 할 일"). The title is
 * the owner's own words (echoed in a DM only, like a receipt). The prompt gives the exact sentence to send.
 */
export function renderConfirmTitle(title: string, language: Lang): string {
  if (language === 'en') return `To add "${title}" as a to-do, please say "add ${title} to my to-dos". Nothing was added yet.`;
  return `'${title}'${particle(title, '을', '를')} 할 일로 추가하려면 "${title} 할 일에 추가해줘"라고 말씀해 주세요. 아직 아무것도 추가하지 않았어요.`;
}

/**
 * Live test 4 (2026-10-17, turns 26 / 58 / 60): a reminder request with no time. The prompt names what is missing (the time)
 * instead of the generic "무엇을/어느 항목을 다시 말씀해 주세요", with an example sentence built from the owner's own body
 * (echoed in a DM only, like a receipt) or a generic one. A following "3시" alone cannot complete it, so it asks for the
 * whole request again.
 */
export function renderAskWhen(language: Lang, body?: string): string {
  const own = body !== undefined && body.trim().length > 0 && Array.from(body).length <= 80 ? body.trim() : undefined;
  return language === 'en'
    ? `Please include the time. For example: "remind me tomorrow at 9am to ${own ?? 'call the bank'}". Nothing was created yet.`
    : `알림 시간을 함께 말씀해 주세요. 예: "내일 오전 9시에 ${own ?? '은행에 전화하기'} 알려줘". 아직 아무것도 만들지 않았어요.`;
}

/**
 * A6-D3a amendment 1, elliptical continuation (D12 gate v44 run 3): "이번엔 3번" right after "1번 완료" plausibly means
 * "complete 3 too", but the action is only inferred, so Core asks with it: "할 일 3번도 완료할까요? (응 / 아니)"; with no
 * such last action (`continued` false) the selector's inferred action: "할 일 2번을 완료할까요? (응 / 아니)". "응" runs it
 * (the open `action-target` confirmation). Content-free: the source, the shown label and the entry's closed action word.
 */
export function renderContinuationConfirm(entryId: 'todo.complete' | 'todo.cancel' | 'reminder.cancel', source: NlItemSource, label: number, language: Lang, continued = true): string {
  if (language === 'en') {
    const verb = entryId === 'todo.complete' ? 'Complete' : entryId === 'todo.cancel' ? 'Take off the list' : 'Cancel';
    return `${verb} ${NOUN[source].en} ${renderShownLabel(source, label, 'en')}${continued ? ' too' : ''}? (yes / no)`;
  }
  const verb = entryId === 'todo.complete' ? '완료할까요' : entryId === 'todo.cancel' ? '목록에서 뺄까요' : '취소할까요';
  const shown = renderShownLabel(source, label, 'ko');
  // The object particle after the shown label: "N번" closes with ㄴ (을); a reminder "#N" is read as its number, whose last
  // digit 2 / 4 / 5 / 9 (이, 사, 오, 구) ends in a vowel (를).
  const particle = continued ? '도' : /번$/u.test(shown) || !/[2459]$/u.test(shown) ? '을' : '를';
  return `${NOUN[source].ko} ${shown}${particle} ${verb}? (응 / 아니)`;
}

export function renderTimeInTitle(language: Lang): string {
  return language === 'en'
    ? 'To-dos have no time. Should this be a to-do or a reminder at that time? Please tell me again the way you want it.'
    : '할 일에는 시간을 넣지 않아요. 할 일로 둘까요, 그 시간에 알림을 만들까요? 원하는 쪽으로 다시 말씀해 주세요.';
}

export function renderTimeOutsideWhen(language: Lang): string {
  return language === 'en'
    ? 'I could not tell the time apart from what to remind you of. Please tell me again when and what.'
    : '알림 시간과 내용을 구분하기 어려워요. 언제, 무엇을 알려 드릴지 다시 말씀해 주세요.';
}

export function renderBulk(language: Lang): string {
  return language === 'en' ? 'I do one item at a time. Which one first?' : '한 번에 하나씩만 처리할게요. 어느 것부터 할지 말씀해 주세요.';
}

export function renderCapped(language: Lang): string {
  return language === 'en'
    ? 'That is more natural-language actions than I run in this period. Please try again later; exact commands still work.'
    : '지금은 자연어로 실행할 수 있는 횟수를 넘었어요. 잠시 뒤에 다시 말씀해 주세요. 정확한 명령은 그대로 동작해요.';
}

/** The A6 input guard refused a message (too long, hidden characters, an embedded command form): nothing ran. */
export function renderInputRefusal(language: Lang): string {
  return language === 'en'
    ? 'I did nothing: please ask for an action in one plain sentence (no pasted, quoted or structured text, no command inside it).'
    : '아무것도 실행하지 않았어요. 동작 요청은 한 문장으로 말씀해 주세요 (붙여넣은 내용, 인용, 명령문 없이).';
}

/** The kill switch stopped an action at dispatch (A6-D3): nothing ran. */
export function renderActionStopped(language: Lang): string {
  return language === 'en'
    ? 'Natural-language actions are stopped, so I did nothing. Exact commands still work.'
    : '자연어 실행이 멈춰 있어서 아무것도 하지 않았어요. 정확한 명령은 그대로 동작해요.';
}

export function renderActionUnavailable(language: Lang): string {
  return language === 'en' ? 'I cannot do that right now. Nothing was changed.' : '지금은 그 작업을 할 수 없어요. 아무것도 바꾸지 않았어요.';
}

/** The question or refusal of an unresolved reference (A6-D2), in the owner's own labels. Never an item's content. */
export function renderReferenceQuestion(
  outcome: Exclude<NlResolutionOutcome, 'resolved'>,
  source: NlItemSource,
  language: Lang,
  extra: { readonly found?: NlItemSource; readonly count?: number; readonly index?: number; readonly labels?: readonly number[] } = {},
): string {
  const noun = NOUN[source][language];
  switch (outcome) {
    case 'out-of-range':
      return language === 'en'
        ? `The list has only ${extra.count ?? 0} items. There is no #${extra.index ?? 0}.`
        : `목록에 ${extra.count ?? 0}건만 있어요. ${extra.index ?? 0}번은 없어요.`;
    case 'none':
      return language === 'en'
        ? `I have no recent ${noun} list to pick from. Shall I show the ${noun} list first?`
        : `고를 수 있는 최근 ${noun} 목록이 없어요. ${noun} 목록을 먼저 보여 드릴까요?`;
    case 'expired':
      return language === 'en'
        ? 'That list is too old to pick from. Shall I show it again?'
        : '그 목록은 시간이 지나서 고를 수 없어요. 목록을 다시 보여 드릴까요?';
    case 'other-source':
      return language === 'en'
        ? `I am not sure which ${noun} you mean. Ask me to show the ${noun} list again, or tell me its title.`
        : `어느 ${noun}인지 헷갈려요. '${noun} 목록'을 다시 보여 달라고 하시거나 제목으로 말씀해 주세요.`;
    case 'conflict':
    case 'ambiguous': {
      const labels = (extra.labels ?? []).map((label) => renderShownLabel(source, label, language));
      const lead = outcome === 'conflict'
        ? language === 'en'
          ? `The ${noun} I just handled and the one in the list differ.`
          : `방금 다룬 ${noun}과 목록의 ${noun}이 달라요.`
        : language === 'en'
          ? `Which ${noun} do you mean?`
          : `어느 ${noun}인가요?`;
      if (labels.length === 0) return language === 'en' ? `${lead} Please tell me the number.` : `${lead} 번호를 말씀해 주세요.`;
      return language === 'en' ? `${lead} ${labels.join(', ')} — reply with the number.` : `${lead} ${labels.join(', ')} 중에서 번호로 답해 주세요.`;
    }
    case 'stale':
      return language === 'en'
        ? `It has been over 10 minutes since that ${noun}. Which number do you mean?`
        : `방금 다룬 ${noun}에서 10분이 지났어요. 몇 번인지 말씀해 주세요.`;
  }
}

/**
 * ADR-0112 amendment 1 S3 (context eval 2026-10-26, P4): "되돌려줘" right after an approved connector write, while its R3 undo
 * is not on. Where S3 defines the sentence it is used verbatim: Slack SENT ("Slack 글 되돌리기는 아직 켜지지 않았어요. Slack에서
 * 직접 지워 주세요.") and Slack NOT_SENT ("보낸 메시지가 없어서 되돌릴 게 없어요."). The calendar and Jira sentences, and every
 * UNCERTAIN sentence (S3 gives only its meaning: check it there), are the S3 copy amendment of 2026-10-27 (DECISIONS,
 * CA review P2-1). Never names an older item, never suggests a command.
 */
/** ADR-0112 amendment 1 S3: the Slack NOT_SENT sentence, verbatim. */
export const NL_SLACK_NOT_SENT_UNDO_KO = '보낸 메시지가 없어서 되돌릴 게 없어요.';
function renderExternalUndo(external: { readonly source: 'slack' | 'jira' | 'calendar'; readonly outcome: 'SENT' | 'UNCERTAIN' | 'NOT_SENT' }, language: Lang): string {
  const ko = { slack: { thing: 'Slack 글', place: 'Slack', fix: '지워' }, jira: { thing: 'Jira 변경', place: 'Jira', fix: '고쳐' }, calendar: { thing: '캘린더 일정 변경', place: '캘린더', fix: '고쳐' } }[external.source];
  const en = { slack: { thing: 'Slack post', place: 'Slack' }, jira: { thing: 'Jira change', place: 'Jira' }, calendar: { thing: 'calendar change', place: 'your calendar' } }[external.source];
  if (external.outcome === 'NOT_SENT') {
    if (external.source === 'slack') return language === 'en' ? 'No message was sent, so there is nothing to undo.' : NL_SLACK_NOT_SENT_UNDO_KO;
    return language === 'en' ? `That ${en.thing} was not applied, so there is nothing to undo.` : `방금 ${ko.thing}은 적용되지 않아서 되돌릴 게 없어요.`;
  }
  if (external.outcome === 'UNCERTAIN') {
    return language === 'en'
      ? `I could not confirm whether that ${en.thing} went through, so I will not undo anything. Please check it in ${en.place}.`
      : `방금 ${ko.thing}은 결과를 확인하지 못해서 되돌리지 않을게요. ${ko.place}에서 직접 확인해 주세요.`;
  }
  return language === 'en'
    ? `Undoing a ${en.thing} is not on yet. Please change it in ${en.place} directly.`
    : `${ko.thing} 되돌리기는 아직 켜지지 않았어요. ${ko.place}에서 직접 ${ko.fix} 주세요.`;
}

/** The answer when "되돌려줘" has nothing to undo, or must not undo (ratification record A). */
export function renderUndoUnresolved(
  outcome: 'no-action' | 'undo-of-undo' | 'echo-mismatch' | 'stale' | 'external',
  language: Lang,
  external?: { readonly source: 'slack' | 'jira' | 'calendar'; readonly outcome: 'SENT' | 'UNCERTAIN' | 'NOT_SENT' },
): string {
  switch (outcome) {
    case 'external':
      return renderExternalUndo(external ?? { source: 'calendar', outcome: 'SENT' }, language);
    case 'no-action':
      return language === 'en' ? 'There is no recent action of mine to undo.' : '되돌릴 최근 작업이 없어요.';
    case 'undo-of-undo':
      return language === 'en' ? 'An undone action cannot be undone again.' : '되돌린 작업은 다시 되돌릴 수 없어요.';
    case 'echo-mismatch':
      return language === 'en'
        ? 'I can only undo my most recent action, and that message is not it. Which action do you mean?'
        : '가장 최근 작업만 되돌릴 수 있는데, 그 메시지는 최근 작업이 아니에요. 어떤 작업을 말씀하시는지 알려 주세요.';
    case 'stale':
      return language === 'en' ? 'More than 10 minutes have passed, so I will not undo it automatically.' : '10분이 지나서 자동으로 되돌리지 않을게요.';
  }
}
