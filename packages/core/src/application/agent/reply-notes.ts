import { isNlActionEntryId, isNlWave1EntryId, type NlWave1EntryId } from '../nl-routing/catalog';
import type { AgentPlan, AgentPlanStep } from './plan-schema';
import { AGENT_PLAN_MAX_REF_VALUES, validateAgentPlan, type AgentPlanValidationContext, type ValidatedAgentPlan } from './plan-validator';

/**
 * ADR-0121 S2 P3: the fixed, deterministic notes of an agent reply. Each is fixed text plus closed nouns and Core's own
 * counts: never an owner word, a model value or content, so a note can never carry or invent anything. Pure. The reply
 * assembler appends them after the sections (the runtime sends agent replies only once `active` is released, stage P5).
 *
 * - **The detail cap note** (owner decision (c), 2026-10-21; A1 ratification answer 8): a reference reads at most 10
 *   items in detail (ADR-0121 D2). When it read the full 10 and the source listed more, the reply says "N개 중 10개" and
 *   gives the fixed hint for the next 10. The hint's follow-up ("다음 10개") is not built in P3 (open question: it needs
 *   follow-up state, which S2 Q9 does not allow beyond the two recorded exceptions).
 * - **The relation note** (owner decision (a), 2026-10-20): when the planner marked that the owner asked for one read's
 *   items related to another read, the reads ran separately and nothing was matched (a content value is never a query);
 *   the reply says so ("회의와 관련 있는지는 확인하지 않았어요").
 * - **The action-in-plan guidance** (decision (f) of the owner's review, 2026-10-21; A6-D4): a plan that holds an A6 entry
 *   is refused (`a6-in-plan`; S2 is READ only). The reads of that plan, without the A6 step, form the remainder the
 *   one-step path may answer, and a fixed note says how to ask for the action part: one item's summary by its number
 *   after the list ("1번 요약해줘", the A6 `item.summarize` turn), any other action on its own.
 */

export type AgentNoteLanguage = 'ko' | 'en';

/** A validated plan with steps (`run`, or `clarify` before its answer); the notes are for an executed `run`. */
export type AgentStepsPlan = Extract<ValidatedAgentPlan, { readonly connectorCalls: number }>;

// ── the detail cap note ────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentRefDetailCount {
  /** How many items the referenced listing held (Core's count from the typed result). */
  readonly listed: number;
  /** The listing was cut (a full first page): `listed` is a lower bound. */
  readonly listedAtLeast?: boolean;
  /** The reference's validated `take` (at most 10). */
  readonly take: number;
  /** How many items the bulk detail read returned. */
  readonly shown: number;
}

/**
 * "N개 중 10개" plus the fixed hint for the next 10, only when the reference read the full cap (10) and the listing held
 * more. A smaller `take` is the owner's own number (nothing to add); a listing of 10 or fewer is complete. Pure.
 */
export function renderRefDetailCapNote(count: AgentRefDetailCount, language: AgentNoteLanguage): string | undefined {
  const more = count.listed > count.take || (count.listedAtLeast === true && count.listed >= count.take);
  if (count.take !== AGENT_PLAN_MAX_REF_VALUES || !more) return undefined;
  const listed = `${count.listed}${count.listedAtLeast === true ? (language === 'en' ? '+' : '개 이상') : language === 'en' ? '' : '개'}`;
  if (language === 'en') {
    return `Showing ${count.shown} of ${listed} issues in detail. To see more, say "show the next ${AGENT_PLAN_MAX_REF_VALUES}".`;
  }
  return `이슈 ${listed} 중 ${count.shown}개만 자세히 보여드렸어요. 더 보려면 '다음 ${AGENT_PLAN_MAX_REF_VALUES}개 보여줘'라고 말씀해 주세요.`;
}

// ── the relation note ─────────────────────────────────────────────────────────────────────────────────────────────

/** Closed nouns of the source a relation was asked against (decision (a) names the meetings of a calendar read). */
const RELATED_NOUN: Readonly<Record<NlWave1EntryId, { readonly ko: string; readonly en: string }>> = {
  'calendar.events': { ko: '회의', en: 'the meetings' },
  'mail.list': { ko: '메일', en: 'the mail' },
  'drive.files': { ko: '드라이브 파일', en: 'the Drive files' },
  'jira.issues': { ko: '지라 이슈', en: 'the Jira issues' },
  'jira.release': { ko: '릴리스', en: 'the release' },
  'github.items': { ko: '깃허브 항목', en: 'the GitHub items' },
  'slack.search': { ko: '슬랙 메시지', en: 'the Slack messages' },
  'confluence.search': { ko: '컨플루언스 문서', en: 'the Confluence pages' },
  'todo.list': { ko: '할 일', en: 'the to-dos' },
  'reminder.list': { ko: '알림', en: 'the reminders' },
  'brief.today': { ko: '브리핑', en: 'the brief' },
  'help.topic': { ko: '도움말', en: 'the help' },
};

/** 와 after a final vowel, 과 after a final consonant (Hangul syllable arithmetic; Latin text takes 와). */
function withAnd(noun: string): string {
  const last = noun.codePointAt(noun.length - 1) ?? 0;
  const final = last >= 0xac00 && last <= 0xd7a3 ? (last - 0xac00) % 28 : 0;
  return `${noun}${final === 0 ? '와' : '과'}`;
}

/** The fixed note of decision (a), naming the first read's source (the one the relation was asked against). Pure. */
export function renderRelatedUncheckedNote(firstEntryId: NlWave1EntryId, language: AgentNoteLanguage): string {
  const noun = RELATED_NOUN[firstEntryId];
  if (language === 'en') return `I didn't check whether these are related to ${noun.en}; each was read on its own.`;
  return `${withAnd(noun.ko)} 관련 있는지는 확인하지 않았어요.`;
}

// ── the notes of one run ──────────────────────────────────────────────────────────────────────────────────────────

/** Core's counts of one executed read step (from the typed result, never from rendered text). */
export interface AgentStepCount {
  /** Items the read listed (a listing step). */
  readonly listed?: number;
  readonly listedAtLeast?: boolean;
  /** Items a reference step's bulk detail read returned. */
  readonly shown?: number;
}

/**
 * The fixed notes of one executed `run` plan, in order: each reference step's detail cap note (step order), then the
 * relation note. `counts` is keyed by 1-based step number. Pure.
 */
export function agentReplyNotes(
  plan: AgentStepsPlan,
  counts: ReadonlyMap<number, AgentStepCount>,
  language: AgentNoteLanguage,
): string[] {
  const notes: string[] = [];
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind !== 'read' || step.ref === undefined) continue;
    const source = counts.get(step.ref.step);
    const shown = counts.get(index + 1)?.shown;
    if (source?.listed === undefined || shown === undefined) continue;
    const note = renderRefDetailCapNote(
      { listed: source.listed, ...(source.listedAtLeast === true ? { listedAtLeast: true } : {}), take: step.ref.take, shown },
      language,
    );
    if (note !== undefined) notes.push(note);
  }
  const first = plan.steps.find((step) => step.kind === 'read');
  if (plan.related === true && first?.kind === 'read' && isNlWave1EntryId(first.entry.id)) notes.push(renderRelatedUncheckedNote(first.entry.id, language));
  return notes;
}

// ── the action-in-plan guidance ───────────────────────────────────────────────────────────────────────────────────

/** `item-read`: every refused A6 step is the one ITEM_READ entry (`item.summarize`, A6-D1); `action`: any other A6 entry. */
export type AgentA6InPlanKind = 'item-read' | 'action';

export interface AgentA6InPlanGuidance {
  readonly kind: AgentA6InPlanKind;
  /** The plan's reads without the A6 steps, validated as a `run` plan; absent when nothing valid remains. */
  readonly remainder?: AgentStepsPlan;
  readonly note: string;
}

/**
 * Decision (f): for a plan the validator refuses `a6-in-plan`, the read remainder (the A6 steps removed, with the
 * summaries and references that depended on them; the rest renumbered and validated by the same validator) and the fixed
 * note. `undefined` for any plan that is not refused `a6-in-plan`. The remainder is a candidate only: the runtime decides
 * whether to answer it (stage P5). Pure.
 */
export function a6InPlanGuidance(plan: AgentPlan, ctx: AgentPlanValidationContext, language: AgentNoteLanguage): AgentA6InPlanGuidance | undefined {
  if (plan.kind !== 'steps') return undefined;
  const refused = validateAgentPlan(plan, ctx);
  if (refused.ok || refused.reason !== 'a6-in-plan') return undefined;
  const a6 = plan.steps.flatMap((step, index) => (step.kind === 'read' && isNlActionEntryId(step.entryId) ? [{ index: index + 1, entryId: step.entryId }] : []));
  const kind: AgentA6InPlanKind = a6.every((step) => step.entryId === 'item.summarize') ? 'item-read' : 'action';
  const removed = new Set(a6.map((step) => step.index));
  const renumber = new Map<number, number>();
  const kept: AgentPlanStep[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const number = index + 1;
    if (removed.has(number)) continue;
    if (step.kind === 'read') {
      if (step.ref !== undefined) {
        const source = renumber.get(step.ref.step);
        if (source === undefined) {
          removed.add(number);
          continue;
        }
        kept.push({ ...step, ref: { ...step.ref, step: source } });
      } else {
        kept.push(step);
      }
      renumber.set(number, kept.length);
    } else {
      if (step.from.some((from) => removed.has(from))) continue;
      kept.push({ ...step, from: step.from.map((from) => renumber.get(from) as number) });
    }
  }
  const note = renderA6InPlanNote(kind, language);
  if (!kept.some((step) => step.kind === 'read')) return { kind, note };
  const remainder = validateAgentPlan({ kind: 'steps', form: 'steps', steps: kept, ambiguity: plan.ambiguity, alternatives: [] }, ctx);
  return remainder.ok && remainder.plan.kind === 'run' ? { kind, remainder: remainder.plan, note } : { kind, note };
}

/** The fixed note of the action part of a refused plan (decision (f)). Never a yes/no question: nothing is pending. */
export function renderA6InPlanNote(kind: AgentA6InPlanKind, language: AgentNoteLanguage): string {
  if (kind === 'item-read') {
    return language === 'en'
      ? 'To summarize one item, ask by its number once you see the list, like "summarize number 1".'
      : "한 항목 요약은 목록을 보신 뒤 번호로 말씀해 주세요. 예: '1번 요약해줘'";
  }
  return language === 'en'
    ? "I didn't make the change you asked for together with the lookup. Please ask for it on its own."
    : '추가·변경·취소 같은 작업은 조회와 함께 하지 않았어요. 따로 한 번 더 말씀해 주세요.';
}
