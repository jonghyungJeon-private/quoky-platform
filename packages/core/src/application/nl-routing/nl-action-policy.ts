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
  externalPerHour: 10,
  externalPerDay: 30,
});

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TRACKED_ACTORS = 256;

/** In-memory sliding windows per (actor, risk). A breach answers with the fixed cap reply; nothing else counts. */
export class NlActionCaps {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly caps: typeof NL_ACTION_CAPS = NL_ACTION_CAPS) {}

  /** Whether one more execution of `risk` stays within the caps at `nowMs`. */
  allows(actorId: string, risk: NlCatalogRisk, nowMs: number): boolean {
    const times = this.prune(actorId, risk, nowMs);
    const lastHour = times.filter((at) => nowMs - at < HOUR_MS).length;
    switch (risk) {
      case 'LOCAL_WRITE':
        return lastHour < this.caps.localWritePerHour && times.length < this.caps.localWritePerDay;
      case 'ITEM_READ':
        return lastHour < this.caps.itemReadPerHour;
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

export type NlActionResult = 'executed' | 'previewed' | 'asked' | 'refused' | 'undone' | 'capped' | 'shadow';

export interface NlActionAudit {
  readonly entryId: string;
  readonly risk: NlCatalogRisk;
  readonly refKind: NlRefKind | 'match' | 'none';
  readonly resolution: NlResolutionOutcome;
  readonly result: NlActionResult;
  readonly latencyMs?: number;
  readonly target?: NlItemTarget;
  /** A closed reason for an ask or refusal (never a value). */
  readonly reason?: string;
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
    ...(target === undefined ? {} : { targetSource: target.source }),
    ...(local && target.id !== undefined ? { targetId: target.id } : {}),
    ...(target !== undefined && target.label !== undefined ? { targetLabel: target.label } : {}),
    ...(!local && target?.listingAt !== undefined ? { targetListingAt: target.listingAt } : {}),
  };
}

// ── answering a target question by label (A6-D2) ──────────────────────────────────────────────────────────────────

export type NlLabelChoice = { readonly kind: 'pick'; readonly index: number } | { readonly kind: 'cancel' } | { readonly kind: 'none' };

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
    return index >= 0 ? { kind: 'pick', index } : { kind: 'none' };
  }
  if (ordinals.length === 1 && numbers.length === 0) {
    const index = (ordinals[0] as number) - 1;
    return index >= 0 && index < labels.length ? { kind: 'pick', index } : { kind: 'none' };
  }
  return { kind: 'none' };
}

// ── fixed copy ───────────────────────────────────────────────────────────────────────────────────────────────────

type Lang = 'ko' | 'en';

const NOUN: Readonly<Record<NlItemSource, { ko: string; en: string }>> = {
  todo: { ko: '할 일', en: 'to-do' },
  reminder: { ko: '알림', en: 'reminder' },
  mail: { ko: '메일', en: 'mail' },
  drive: { ko: '드라이브 파일', en: 'Drive file' },
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

/** A6-D6 stale-command guard and every "say it again" answer. */
export function renderRestate(language: Lang): string {
  return language === 'en' ? 'Please tell me again what to do and which item.' : '무엇을/어느 항목을 다시 말씀해 주세요.';
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
  const foundNoun = extra.found !== undefined ? NOUN[extra.found][language] : undefined;
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
        ? `The most recent list I showed is a ${foundNoun ?? 'different'} list. Which ${noun} do you mean?`
        : `가장 최근에 보여 드린 건 ${foundNoun ?? '다른'} 목록이에요. 어느 ${noun}인지 다시 말씀해 주세요.`;
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

/** The answer when "되돌려줘" has nothing to undo, or must not undo (ratification record A). */
export function renderUndoUnresolved(outcome: 'no-action' | 'undo-of-undo' | 'echo-mismatch' | 'stale', language: Lang): string {
  switch (outcome) {
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
