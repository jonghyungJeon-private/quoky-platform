import { nlRangeLabel } from '../nl-routing/symbolic-time';
import { AGENT_PLAN_MAX_READS, AGENT_PLAN_MAX_REF_VALUES, type ValidatedAgentPlan } from './plan-validator';

/**
 * The owner's review of 2026-10-21, decision (h): the deterministic reply to an unbounded plan. Nothing was read; the reply
 * names the bound and asks whether to read the bounded suggestion instead ("이번 달부터 볼까요?"). Fixed text plus closed
 * catalog labels and Core's own period label only: never an owner word, a model value or content. Pure.
 *
 * The runtime sends it only once `active` is released (stage S2 P5); `shadow` logs the ask's closed fields.
 */
export type AgentUnboundedAsk = Extract<ValidatedAgentPlan, { kind: 'ask' }>;

export function renderUnboundedAsk(ask: AgentUnboundedAsk, language: 'ko' | 'en'): string {
  const reads = ask.suggestion.flatMap((step) => (step.kind === 'read' ? [step] : []));
  const summarized = ask.suggestion.some((step) => step.kind === 'summarize');
  switch (ask.bound) {
    case 'per-period': {
      const first = reads[0];
      const period = first?.range !== undefined ? nlRangeLabel(first.range, language) : language === 'en' ? 'this month' : '이번 달';
      const label = first !== undefined ? first.entry.label[language] : '';
      if (language === 'en') {
        return `Reading ${label} one day, week or month at a time over a long period is more than one request can do. Shall I ${summarized ? 'summarize' : 'show'} ${period} in one go instead?`;
      }
      return `기간을 날마다·주마다·달마다 나눠 읽는 건 한 번에 할 수 없어요. 대신 ${period} 것부터 한 번에 ${summarized ? '정리할까요' : '볼까요'}? (${label})`;
    }
    case 'reads': {
      const labels = reads.map((step) => step.entry.label[language]).join(', ');
      if (language === 'en') return `I can read at most ${AGENT_PLAN_MAX_READS} sources in one request. Shall I start with the first ${reads.length} (${labels})?`;
      return `한 번에 ${AGENT_PLAN_MAX_READS}곳까지만 읽을 수 있어요. 앞의 ${reads.length}개(${labels})부터 볼까요?`;
    }
    case 'refs':
      if (language === 'en') return `I can open at most ${AGENT_PLAN_MAX_REF_VALUES} issues in detail at once. Shall I start with the first ${AGENT_PLAN_MAX_REF_VALUES}?`;
      return `이슈 상세는 한 번에 ${AGENT_PLAN_MAX_REF_VALUES}개까지 볼 수 있어요. 처음 ${AGENT_PLAN_MAX_REF_VALUES}개부터 볼까요?`;
  }
}
