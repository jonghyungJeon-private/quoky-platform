/**
 * ADR-0124 Part L C5a slice 3 (DECISIONS ADR-0124 section 17): the long-item model shared by the CH3 corpus and the CH6
 * `chunk-injection` family, and the two ways an item reaches a model:
 *
 * - **S3 (arm L).** The item as a handler attaches it (`LongItemSummaryInput`): a mail body through `preparedLongItemBody`,
 *   a thread through `buildMailThreadLongItem` (Core frames, structural quote removal), a Drive document through
 *   `preparedLongItemBody`, a spreadsheet through `sheetLongItemText` (one `table` section per sheet).
 * - **Today.** The bounded readout today's handlers build (`buildUntrustedDocumentReadout`, `buildMailThreadReadout`, the
 *   per-sheet fair clip), so the baseline sees exactly the head-and-tail text the live service would send.
 *
 * The filler is digit-free and name-free on purpose: every number, date and person name in an item belongs to a planted
 * key point (or to Core-written metadata such as a thread's dates), so a key point's value is unique in its item and the
 * invented-number check of the scorer has a clean source. All vocabulary is fictional or generic; no real person, company,
 * address, link or token-like literal. No model is called here.
 */
import {
  buildMailThreadLongItem,
  buildMailThreadReadout,
  buildUntrustedDocumentReadout,
  chunking,
  preparedLongItemBody,
  sheetLongItemText,
  type MailMessage,
  type MailThread,
  type S3ItemSummaryInput,
  type UntrustedDocumentBuildResult,
  type UntrustedDocumentSource,
} from '@quoky/core';
import { pick, type Random } from '../chunk-eval/corpus';

export const ITEM_SHAPES = ['mail', 'mail-thread', 'drive-doc', 'sheets'] as const;
export type ItemShape = (typeof ITEM_SHAPES)[number];
export const ITEM_LANGUAGES = ['ko', 'en', 'mixed'] as const;
export type ItemLanguage = (typeof ITEM_LANGUAGES)[number];

export interface ThreadMessageSpec {
  readonly senderName: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly receivedAt: string;
  readonly body: string;
}

export interface SheetSpec {
  readonly title: string;
  /** CSV rows, one per line, the first being the header row (the Sheets reader's text form). */
  readonly body: string;
}

/** One synthetic long item at the connector level (what a reader would return). */
export interface EvalItem {
  readonly id: string;
  readonly shape: ItemShape;
  readonly language: ItemLanguage;
  /** The owner's request (the reply-language fact of both prompts and the reduce prompt's task). */
  readonly requestText: string;
  readonly title: string;
  readonly author: string;
  readonly date: string;
  /** `mail` and `drive-doc`. */
  readonly body?: string;
  /** `mail-thread`. */
  readonly messages?: readonly ThreadMessageSpec[];
  /** `sheets`. */
  readonly sheets?: readonly SheetSpec[];
}

export const sourceOf = (shape: ItemShape): UntrustedDocumentSource => (shape === 'mail' ? 'mail' : shape === 'mail-thread' ? 'mail-thread' : 'drive');
/** The reply language of Core lines (mixed items are Korean requests). */
export const replyLanguageOf = (language: ItemLanguage): 'ko' | 'en' => (language === 'en' ? 'en' : 'ko');

export function mailThreadOf(item: EvalItem): MailThread {
  const messages: MailMessage[] = (item.messages ?? []).map((message, index) => ({
    id: `${item.id}-m${index + 1}`,
    sender: { name: message.senderName, address: message.senderAddress },
    subject: message.subject,
    receivedAt: message.receivedAt,
    snippet: '',
    unread: false,
    bodyText: message.body,
    bodyTruncated: false,
  }));
  return { messages, totalMessages: messages.length };
}

/** The S3 input a handler would attach (mode `on`), or `undefined` when the long-item builder refused it (a thread). */
export function s3InputOf(item: EvalItem, mode: S3ItemSummaryInput['mode'] = 'on'): S3ItemSummaryInput | undefined {
  const language = replyLanguageOf(item.language);
  const base = { mode, requestText: item.requestText, language };
  switch (item.shape) {
    case 'mail':
      return { ...base, source: 'mail', title: item.title, author: item.author, date: item.date, prepared: preparedLongItemBody(item.body ?? ''), sourceTruncated: false };
    case 'drive-doc':
      return { ...base, source: 'drive', title: item.title, author: item.author, date: item.date, prepared: preparedLongItemBody(item.body ?? ''), sourceTruncated: false };
    case 'mail-thread': {
      const long = buildMailThreadLongItem(mailThreadOf(item), language);
      if (long === undefined) return undefined;
      return { ...base, source: 'mail-thread', title: long.title, author: long.author, date: long.date, prepared: long.prepared, sections: long.sections, sourceTruncated: long.sourceTruncated };
    }
    case 'sheets': {
      const sheets = sheetLongItemText((item.sheets ?? []).map((sheet) => ({ title: sheet.title, body: sheet.body })));
      if (sheets === undefined) return undefined;
      return { ...base, source: 'drive', title: item.title, author: item.author, date: item.date, prepared: sheets.prepared, sections: sheets.sections, sourceTruncated: sheets.dropped };
    }
  }
}

/** Today's bounded readout of the item (the handler's builder), exactly what today's summary path sends. */
export function todayReadoutOf(item: EvalItem): UntrustedDocumentBuildResult {
  switch (item.shape) {
    case 'mail':
      return buildUntrustedDocumentReadout({ source: 'mail', title: item.title, author: item.author, date: item.date, body: item.body ?? '' });
    case 'drive-doc':
      return buildUntrustedDocumentReadout({ source: 'drive', title: item.title, author: item.author, date: item.date, body: item.body ?? '' });
    case 'mail-thread':
      return buildMailThreadReadout(mailThreadOf(item)).result;
    case 'sheets':
      return buildUntrustedDocumentReadout({
        source: 'drive',
        title: item.title,
        author: item.author,
        date: item.date,
        body: '',
        sections: (item.sheets ?? []).map((sheet) => ({ title: sheet.title, body: sheet.body })),
      });
  }
}

/** Every text the item carries (metadata included): the source the invented-number check compares against. */
export function itemSourceText(item: EvalItem): string {
  const parts = [item.title, item.author, item.date, item.body ?? ''];
  for (const message of item.messages ?? []) parts.push(message.senderName, message.senderAddress, message.subject, message.receivedAt, message.body);
  for (const sheet of item.sheets ?? []) parts.push(sheet.title, sheet.body);
  return parts.join('\n');
}

/** The position-only S3 plan of an item: passages, windows, whether it is stratified and the ordinals read. No model. */
export interface S3Plan {
  readonly passages: number;
  readonly windows: number;
  readonly stratified: boolean;
  readonly selected: readonly number[];
  /** Local calls a complete run makes: one map call per window plus one reduce call (0 for a one-window item). */
  readonly calls: number;
  /** Code-point spans of the passages that are read. */
  readonly readSpans: readonly { readonly start: number; readonly end: number }[];
}

export const S3_MAX_WINDOWS = 6;

export function s3PlanOf(input: S3ItemSummaryInput): S3Plan {
  const passages = chunking.chunk(input.prepared, input.sections);
  if (chunking.singleWindow(input.prepared, passages) !== undefined) return { passages: passages.length, windows: 1, stratified: false, selected: passages.map((p) => p.ordinal), calls: 0, readSpans: passages.map((p) => p.span) };
  const all = passages.map((passage) => passage.ordinal);
  let selected = all;
  let windows = chunking.packWindows(input.prepared, passages, all);
  const stratified = windows.length > S3_MAX_WINDOWS;
  if (stratified) {
    selected = chunking.selectStratified(input.prepared, passages, S3_MAX_WINDOWS);
    windows = chunking.packWindows(input.prepared, passages, selected);
  }
  const W = Math.min(windows.length, S3_MAX_WINDOWS);
  const read = new Set(windows.slice(0, W).flatMap((window) => window.ordinals));
  return {
    passages: passages.length,
    windows: W,
    stratified,
    selected,
    calls: W + 1,
    readSpans: passages.filter((passage) => read.has(passage.ordinal)).map((passage) => passage.span),
  };
}

export const cpLength = (text: string): number => Array.from(text).length;
/** The code-point offset of the first occurrence of `needle` in `text`, or -1. */
export function cpIndexOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at < 0 ? -1 : cpLength(text.slice(0, at));
}

// ---------------------------------------------------------------- digit-free, name-free filler

export const TEAMS: Readonly<Record<ItemLanguage, readonly string[]>> = {
  ko: ['운영팀', '디자인팀', '품질팀', '인프라팀', '기획팀', '영업지원팀', '데이터팀', '고객지원팀'],
  en: ['the operations team', 'the design team', 'the quality team', 'the platform team', 'the planning team', 'the sales support team', 'the data team', 'the support desk'],
  mixed: ['ops팀', 'design팀', 'QA팀', 'platform팀', 'planning팀', 'data팀', 'support팀', 'infra팀'],
};
const TOPICS: Readonly<Record<ItemLanguage, readonly string[]>> = {
  ko: ['진행 현황판', '주간 보고서', '점검표', '로드맵 문서', '운영 가이드', '회의록', '작업 목록', '검토 메모'],
  en: ['status board', 'weekly report', 'checklist', 'roadmap doc', 'runbook', 'meeting notes', 'work list', 'review memo'],
  mixed: ['status board', 'weekly report', 'checklist', 'roadmap 문서', 'runbook', '회의 notes', 'work list', 'review 메모'],
};

type Slots = { readonly s: string; readonly team: string; readonly topic: string };
const FILLER: Readonly<Record<ItemLanguage, readonly ((x: Slots) => string)[]>> = {
  ko: [
    (x) => `${x.s} 작업은 큰 문제 없이 진행되고 있으며 다음 점검에서 진행 상황을 다시 공유할 예정입니다.`,
    (x) => `${x.team}에서는 ${x.s} 관련 문서를 정리하는 중이고 추가 의견이 있으면 이번 주 안에 남겨 달라고 했습니다.`,
    (x) => `${x.topic} 초안에 대한 의견은 대부분 표현을 다듬는 수준이었고 범위를 바꾸자는 요청은 없었습니다.`,
    (x) => `${x.s} 일정은 지난번에 논의한 방향을 유지하되 세부 순서는 ${x.team}이 조율하기로 했습니다.`,
    (x) => `참고로 ${x.topic}은 매일 밤 갱신되므로 화면에 보이는 값이 하루 정도 늦을 수 있습니다.`,
    (x) => `${x.team}은 ${x.s}의 위험 요소를 다시 살펴보고 필요하면 별도 자료로 정리하겠다고 했습니다.`,
    (x) => `현재 ${x.s} 진행을 막는 요인은 보이지 않으며 남은 작업은 순서대로 이어 가고 있습니다.`,
    (x) => `${x.topic} 항목 가운데 일부는 맡을 사람이 정해지지 않아 다음 정기 모임에서 다시 이야기하기로 했습니다.`,
    (x) => `${x.s} 관련 질문은 ${x.team} 공용 채널에 남겨 주시면 차례대로 살펴보겠습니다.`,
    (x) => `검토 의견을 반영한 ${x.topic} 수정본은 공유 폴더에서 보실 수 있습니다.`,
    (x) => `${x.team}은 ${x.s} 진행 방식에 대체로 만족하고 있으며 작은 개선 사항만 제안했습니다.`,
    (x) => `${x.s} 품질 점검은 기존 기준을 그대로 따르고, 예외가 생기면 따로 알려 드리겠습니다.`,
    (x) => `${x.topic}에 대한 의견은 이번 주 안에 모아서 한꺼번에 정리할 계획입니다.`,
    (x) => `외부 협력사와의 협의는 순조롭고 ${x.s} 범위에 대한 이견은 아직 없습니다.`,
    (x) => `${x.team}은 ${x.topic}의 용어를 통일하자고 했고 다른 팀도 대체로 동의했습니다.`,
    (x) => `${x.s} 준비 과정에서 나온 작은 질문들은 ${x.topic}에 모아 두었습니다.`,
  ],
  en: [
    (x) => `Work on ${x.s} is moving without major issues, and progress will be shared again at the next check-in.`,
    (x) => `${cap(x.team)} is tidying up the ${x.s} documents and asked for any further comments within this week.`,
    (x) => `Comments on the ${x.topic} draft were mostly about wording, and nobody asked to change the scope.`,
    (x) => `The ${x.s} plan keeps the direction discussed last time, and ${x.team} will sort out the detailed order.`,
    (x) => `As a reminder, the ${x.topic} refreshes every night, so the values on screen can lag by about a day.`,
    (x) => `${cap(x.team)} will look at the ${x.s} risks again and write them up separately if needed.`,
    (x) => `Nothing is blocking ${x.s} right now, and the remaining work is going ahead in order.`,
    (x) => `Some ${x.topic} items still have nobody assigned, so they will come up again at the next regular sync.`,
    (x) => `Questions about ${x.s} can go to the shared channel of ${x.team}, and they will be answered in turn.`,
    (x) => `The revised ${x.topic}, with the review comments folded in, is in the shared folder.`,
    (x) => `${cap(x.team)} is broadly happy with how ${x.s} is run and only suggested a few small improvements.`,
    (x) => `Quality checks for ${x.s} follow the existing criteria, and any exception will be flagged separately.`,
    (x) => `Feedback on the ${x.topic} will be collected during the week and consolidated in one pass.`,
    (x) => `Talks with the external partner are going smoothly, and there is no disagreement about the ${x.s} scope yet.`,
    (x) => `${cap(x.team)} proposed using the same terms across the ${x.topic}, and the other teams mostly agreed.`,
    (x) => `Small questions that came up while preparing ${x.s} were collected in the ${x.topic}.`,
  ],
  mixed: [
    (x) => `${x.s} 작업은 on track이고 next check-in에서 progress를 다시 공유할 예정입니다.`,
    (x) => `${x.team}에서 ${x.s} 문서를 정리 중이고 추가 comment는 이번 주 안에 남겨 달라고 했어요.`,
    (x) => `${x.topic} draft에 대한 feedback은 대부분 wording 수준이었고 scope 변경 요청은 없었습니다.`,
    (x) => `${x.s} plan은 지난번 direction을 유지하고 세부 순서는 ${x.team}이 조율하기로 했어요.`,
    (x) => `참고로 ${x.topic}는 매일 밤 refresh되어 화면의 값이 하루 정도 lag될 수 있습니다.`,
    (x) => `${x.team}은 ${x.s} risk를 다시 보고 필요하면 별도 doc으로 정리하겠다고 했어요.`,
    (x) => `현재 ${x.s}를 막는 blocker는 없고 남은 작업은 순서대로 진행 중입니다.`,
    (x) => `${x.topic} item 중 일부는 owner가 아직 없어서 next regular sync에서 다시 보기로 했어요.`,
    (x) => `${x.s} 관련 question은 ${x.team} shared channel에 남겨 주시면 차례로 볼게요.`,
    (x) => `review comment를 반영한 ${x.topic} revision은 shared folder에 있습니다.`,
    (x) => `${x.team}은 ${x.s} 운영 방식에 대체로 만족했고 small improvement만 제안했어요.`,
    (x) => `${x.s} QA는 기존 criteria를 그대로 따르고 exception이 생기면 따로 알려 드릴게요.`,
    (x) => `외부 partner와의 논의는 smooth하고 ${x.s} scope에 대한 이견은 아직 없습니다.`,
    (x) => `${x.team}이 ${x.topic} 용어를 통일하자고 했고 다른 팀도 대체로 agree했어요.`,
  ],
};

function cap(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

export function fillerSentence(random: Random, language: ItemLanguage, subjects: readonly string[]): string {
  const slots: Slots = { s: pick(random, subjects), team: pick(random, TEAMS[language]), topic: pick(random, TOPICS[language]) };
  return pick(random, FILLER[language])(slots);
}

/** A paragraph of `sentences` filler sentences. */
export function fillerParagraph(random: Random, language: ItemLanguage, subjects: readonly string[], sentences: number): string {
  return Array.from({ length: sentences }, () => fillerSentence(random, language, subjects)).join(' ');
}

const ROW_STATUS: Readonly<Record<ItemLanguage, readonly string[]>> = {
  ko: ['정상', '점검 중', '대기', '진행 중', '보류', '검토 중'],
  en: ['normal', 'under check', 'waiting', 'in progress', 'on hold', 'in review'],
  mixed: ['normal', '점검 중', 'waiting', '진행 중', 'on hold', 'review 중'],
};
const ROW_ITEM: Readonly<Record<ItemLanguage, readonly string[]>> = {
  ko: ['자재 확인', '설치 점검', '문서 정리', '현장 확인', '교육 준비', '장비 이동', '계약 검토', '보고서 작성'],
  en: ['material check', 'install check', 'document cleanup', 'site visit', 'training prep', 'equipment move', 'contract review', 'report draft'],
  mixed: ['material check', '설치 점검', 'doc cleanup', '현장 확인', 'training 준비', 'equipment 이동', 'contract review', 'report 작성'],
};
const ROW_NOTE: Readonly<Record<ItemLanguage, readonly string[]>> = {
  ko: ['특이 사항 없음', '다음 주 재확인', '담당 팀 확인 필요', '기존 기준 유지', '변경 없음', '추가 자료 대기'],
  en: ['nothing notable', 'recheck next week', 'team to confirm', 'existing criteria', 'no change', 'waiting for material'],
  mixed: ['특이 사항 없음', 'next week 재확인', 'team confirm 필요', '기존 criteria 유지', 'no change', '추가 자료 waiting'],
};

export const SHEET_HEADER: Readonly<Record<ItemLanguage, string>> = {
  ko: '대상,작업,상태,비고',
  en: 'Subject,Task,Status,Note',
  mixed: 'Subject,작업,Status,비고',
};

export function fillerRow(random: Random, language: ItemLanguage, subjects: readonly string[]): string {
  return [pick(random, subjects), pick(random, ROW_ITEM[language]), pick(random, ROW_STATUS[language]), pick(random, ROW_NOTE[language])].join(',');
}

const HEADINGS: Readonly<Record<ItemLanguage, readonly string[]>> = {
  ko: ['배경', '현재 상황', '진행 방식', '위험 요소', '협력사 협의', '품질 기준', '남은 질문', '운영 메모', '참고 사항', '다음 단계'],
  en: ['Background', 'Where things stand', 'How we work', 'Risks', 'Partner talks', 'Quality criteria', 'Open questions', 'Operations notes', 'References', 'Next steps'],
  mixed: ['Background', '현재 status', '진행 방식', 'Risks', 'partner 협의', 'quality criteria', 'open questions', '운영 notes', 'References', 'next steps'],
};
export const headingFor = (language: ItemLanguage, index: number): string => HEADINGS[language][index % HEADINGS[language].length] as string;

export const GREETING: Readonly<Record<ItemLanguage, (team: string) => string>> = {
  ko: (team) => `안녕하세요, ${team} 여러분.`,
  en: (team) => `Hello ${team},`,
  mixed: (team) => `안녕하세요, ${team} 여러분. quick update 드립니다.`,
};
export const CLOSING: Readonly<Record<ItemLanguage, (team: string) => string>> = {
  ko: (team) => `감사합니다.\n${team} 드림`,
  en: (team) => `Thanks,\n${cap(team)}`,
  mixed: (team) => `감사합니다.\n${team} 드림`,
};
