import { nlRangeLabel } from '../nl-routing/symbolic-time';
import { AGENT_PLAN_MAX_READS, AGENT_PLAN_MAX_REF_VALUES, type ValidatedAgentPlan } from './plan-validator';

/**
 * The owner's review of 2026-10-21, decision (h): the deterministic reply to an unbounded plan. Nothing was read. The
 * reply names the bound and gives a fixed phrasing hint built from the bounded suggestion ("'이번 달 일정 보여줘'처럼 말씀해
 * 주세요"). It never asks a yes/no question (CA P2): Q9 keeps no follow-up state, so "볼까요?" could not be answered; the
 * owner sends the narrower request as a new turn. Fixed text plus closed nouns and Core's own period label only: never an
 * owner word, a model value or content. Pure.
 *
 * The runtime sends it only once `active` is released (stage S2 P5); `shadow` logs the ask's closed fields.
 */
export type AgentUnboundedAsk = Extract<ValidatedAgentPlan, { kind: 'ask' }>;

/** Closed nouns for the phrasing hint, one per READ entry that can repeat over periods or be read in bulk. */
const NOUN: Readonly<Record<string, { readonly ko: string; readonly en: string }>> = {
  'calendar.events': { ko: '일정', en: 'calendar' },
  'mail.list': { ko: '메일', en: 'mail' },
  'jira.issues': { ko: '지라 이슈', en: 'Jira issues' },
  'jira.release': { ko: '릴리스 이슈', en: 'release issues' },
  'github.items': { ko: '깃허브 항목', en: 'GitHub items' },
  'reminder.list': { ko: '알림', en: 'reminders' },
  'todo.list': { ko: '할 일', en: 'to-dos' },
  'drive.files': { ko: '드라이브 파일', en: 'Drive files' },
};

export function renderUnboundedAsk(ask: AgentUnboundedAsk, language: 'ko' | 'en'): string {
  const reads = ask.suggestion.flatMap((step) => (step.kind === 'read' ? [step] : []));
  const summarized = ask.suggestion.some((step) => step.kind === 'summarize');
  switch (ask.bound) {
    case 'per-period': {
      const first = reads[0];
      const period = first?.range !== undefined ? nlRangeLabel(first.range, language) : language === 'en' ? 'this month' : '이번 달';
      const noun = NOUN[first?.entry.id ?? ''] ?? { ko: '항목', en: 'items' };
      if (language === 'en') {
        return `I can't read one day, week or month at a time over a long period in one request. Ask for one period at once, like "${summarized ? 'summarize' : 'show'} ${period}'s ${noun.en}".`;
      }
      return `기간을 날마다·주마다·달마다 나눠 읽는 건 한 번에 할 수 없어요. '${period} ${noun.ko} ${summarized ? '정리해줘' : '보여줘'}'처럼 기간을 한 번에 말씀해 주세요.`;
    }
    case 'reads': {
      const labels = reads.map((step) => step.entry.label[language]).join(', ');
      if (language === 'en') return `I can read at most ${AGENT_PLAN_MAX_READS} sources in one request. Ask for ${AGENT_PLAN_MAX_READS} or fewer at a time, for example: ${labels}.`;
      return `한 번에 ${AGENT_PLAN_MAX_READS}곳까지만 읽을 수 있어요. ${AGENT_PLAN_MAX_READS}곳 이하로 나눠 말씀해 주세요. 예: ${labels}`;
    }
    case 'refs':
      if (language === 'en') return `I can open at most ${AGENT_PLAN_MAX_REF_VALUES} issues in detail at once. Ask like "show ${AGENT_PLAN_MAX_REF_VALUES} of the release issues in detail".`;
      return `이슈 상세는 한 번에 ${AGENT_PLAN_MAX_REF_VALUES}개까지 볼 수 있어요. '릴리스 이슈 ${AGENT_PLAN_MAX_REF_VALUES}개 자세히 보여줘'처럼 ${AGENT_PLAN_MAX_REF_VALUES}개 이하로 말씀해 주세요.`;
  }
}
