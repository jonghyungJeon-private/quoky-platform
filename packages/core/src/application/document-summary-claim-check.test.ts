import { describe, expect, it } from 'vitest';
import type { MessageMarkup } from '../domain';
import { guardInternalActionClaims } from './chat-policy/internal-action-claim-guard';
import { INTERNAL_ACTION_DOMAINS, renderInternalActionClaimNotice } from './chat-policy/internal-action-vocabulary';
import {
  DOCUMENT_SUMMARY_GUARD_MAX_CHARS,
  blankQuoted,
  checkDocumentSummaryClaims,
  isFixedDocumentSummaryNotice,
  joinedWrappedLines,
  renderDocumentSummaryTooLong,
  strippedOfMarkup,
} from './document-summary-claim-check';
import { containsDocumentActionClaim, renderDocumentActionClaimWithheld } from './document-summary-claim-guard';
import { renderDriveSummaryFooter } from './drive/drive-reply-renderer';
import { neutralizeLinks } from './link-neutralizer';
import { renderMailSummaryFooter, renderMailThreadSummaryFooter } from './mail/mail-reply-renderer';
import { renderMessageContent } from './message-rendering';
import { DOCUMENT_ATTRIBUTION_RETRY_RULE, DOCUMENT_ATTRIBUTION_RULE } from './prompt-composer';
import {
  DOCUMENT_SUMMARY_REPLY_MAX_CHARS,
  documentSummaryReply,
  renderUntrustedDocumentReplyWithheld,
} from './untrusted-document-readout';

// ADR-0104 D1 amendment for summary turns (owner-approved 2026-10-15): attribution by construction, one regeneration,
// guards never looser than origin/main. This file pins the check and the reply's lines; the runtime tests pin the
// regeneration.

const ASK = '1번 문서 요약해줘';
const SOURCES = ['drive', 'mail', 'mail-thread'] as const;
type Source = (typeof SOURCES)[number];
const check = (text: string, source: Source = 'drive') => checkDocumentSummaryClaims(text, ASK, source, 'ko').kind;
/** Main's verdict on a summary: the ADR-0104 guard, then the document guard on the raw and display forms. */
const mainClaims = (text: string, source: Source) =>
  guardInternalActionClaims(text, ASK).guarded ||
  containsDocumentActionClaim(text, source) ||
  containsDocumentActionClaim(neutralizeLinks(text, 'display'), source);

/** Attributed summaries in the prompt's shape (main shows them too: the document's words are quoted). */
const ATTRIBUTED = [
  "시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요.",
  "메일에서 김철수 님은 '배포했다'고 적었어요.",
  "- 상태 열에는 '배포 완료'라고 적혀 있어요.",
  'According to the sheet, the status is "merged".',
  // A real-model draft of the tracker prompt (2026-10-15 probe).
  [
    '**시트: 진행 현황**',
    "- 1주차 로그인 버그 3건: 시트에는 'Jira 티켓 등록 완료'로 표시돼 있고, 담당은 김OO, 비고는 'QA 재현됨'이에요.",
    "- 2주차 결제 화면 개선: 상태는 'PR 머지됨 / 배포 완료', 담당은 이OO, 비고는 '스테이징 확인'이에요.",
    "- 10/07 최OO 님은 '결제 버튼이 느림'이라고 적었고, 처리란에는 'PR 생성함'으로 표시돼 있어요.",
  ].join('\n'),
];

/** Every leak string from the review rounds (CA and Codex, rounds 1–4): a claim to the check on every source. */
const LEAKS = [
  // Round 1.
  '요약본이 Slack에 게시되었습니다.',
  '종형님께 Slack DM이 전송되었습니다.',
  'Assistant가 Jira 티켓을 생성했어요.',
  'Claude가 PR을 머지했어요.',
  'GPT가 Slack에 공지를 올렸어요.',
  'bot이 브랜치를 삭제했어요.',
  'The PR has been merged by "Quoky".',
  'The PR has been merged by the assistant.',
  'For you — the PR has been merged.',
  '요청하신 PR has been merged.',
  // Round 2.
  'Jira 티켓을 생성했어요.\nThe PR has been **merged**.',
  'The PR has been **merged**.',
  '요청대로 처리했어요.',
  'The PR has been\nmerged.',
  '요청하신 대로 처리했습니다.',
  '종형님께 전달 완료.',
  'For you, all set.',
  'Handled on your behalf.',
  'Took care of it myself.',
  '이건 제 계정으로 진행했어요.',
  '요약 모델이 대신 처리했어요.',
  '요청하신 건 모두 처리했습니다.',
  // Round 3.
  'Already did that.',
  '머지함.',
  '끝!',
  'The PR got merged.',
  'Successfully merged the PR.',
  // Round 4.
  "상태는 'Slack'에 요약을 게시했어요.",
  "이 답변의 상태는 '요약본을 Slack에 보냈어요'예요.",
  '방금 PR을 머지했어요.',
  'This summary was posted to Slack.',
  // Markup and wrapping.
  '<b>Merged</b> the PR.',
  '> The PR has been\n> merged.',
  '~~not~~ The PR has been merged.',
  '[The PR has been merged](https://example.com).',
];

describe('checkDocumentSummaryClaims (owner decision 2026-10-15)', () => {
  it.each(ATTRIBUTED)('an attributed summary passes: %j', (text) => {
    for (const source of SOURCES) expect(check(text, source), source).toBe('clean');
  });

  it.each(LEAKS)('a review-round leak is always a claim: %j', (text) => {
    for (const source of SOURCES) expect(check(text, source), source).toBe('claim');
  });

  it('is never looser than main: every text main withholds is withheld', () => {
    const corpus = [...ATTRIBUTED, ...LEAKS, "메일에서 김철수 님은 '답장을 보냈다'고 적었어요.", '김철수 님이 회의 요약을 보냈어요.', '제가 Jira 티켓을 생성했어요.'];
    for (const text of corpus) {
      for (const source of SOURCES) if (mainClaims(text, source)) expect(check(text, source), `${source}: ${text}`).toBe('claim');
    }
    // No exemption: a quote main's document guard reads as a mail action stays a claim.
    expect(check("메일에서 김철수 님은 '답장을 보냈다'고 적었어요.", 'mail')).toBe('claim');
  });

  it('the additions read outside quotes only: the document\'s quoted words are not read by them', () => {
    expect(check("상태 열에는 '머지함'이라고 적혀 있어요.")).toBe('clean');
    expect(check('상태 열에는 머지함.')).toBe('claim');
    expect(blankQuoted("상태는 'PR 머지됨'이고 “done”이에요")).toBe(`상태는 ${' '.repeat("'PR 머지됨'".length)}이고 ${' '.repeat('“done”'.length)}이에요`);
    expect(blankQuoted("I've read Kim's note")).toBe("I've read Kim's note");
  });

  it('the ADR-0104 chat guard itself is unchanged (it still skips every quote)', () => {
    expect(guardInternalActionClaims("'Jira 티켓 등록 완료'", ASK).guarded).toBe(false);
    expect(guardInternalActionClaims('Jira 티켓 등록 완료', ASK).guarded).toBe(true);
  });

  it('reads the text as rendered and with wrapped lines joined', () => {
    expect(strippedOfMarkup('The PR has been **merged** _now_ `x` ~~y~~ [z](https://e.com) <b>w</b>\n> quoted')).toBe(
      'The PR has been merged now x  z w\nquoted',
    );
    expect(joinedWrappedLines('- 상태:\n- The PR has been\nmerged.\n- 다음')).toBe('- 상태:\n- The PR has been merged.\n- 다음');
    expect(joinedWrappedLines('## 제목\n### 소제목')).toBe('## 제목\n### 소제목');
  });

  it('the claim notice is the ADR-0104 one when that guard matched, else the document guard\'s', () => {
    expect(checkDocumentSummaryClaims('Jira 티켓을 생성했어요.', ASK, 'drive', 'ko')).toEqual({
      kind: 'claim',
      notice: renderInternalActionClaimNotice('connector-write', 'ko'),
    });
    expect(checkDocumentSummaryClaims('끝!', ASK, 'mail', 'ko')).toEqual({ kind: 'claim', notice: renderDocumentActionClaimWithheld('ko', 'mail') });
  });

  it('withholds a summary longer than the guards read', () => {
    expect(check('- 남은 이슈는 4건이에요.\n'.repeat(Math.ceil(DOCUMENT_SUMMARY_GUARD_MAX_CHARS / 10)))).toBe('too-long');
  });

  it('every footer passes the check and says nothing was written or sent anywhere; every fixed notice is Quoky copy', () => {
    for (const language of ['ko', 'en'] as const) {
      const footers: Array<[Source, string]> = [
        ['drive', renderDriveSummaryFooter(language)],
        ['mail', renderMailSummaryFooter(language)],
        ['mail-thread', renderMailThreadSummaryFooter(3, 5, language, 1)],
      ];
      for (const [source, footer] of footers) {
        expect(checkDocumentSummaryClaims(footer, ASK, source, language).kind, `${source} ${language}`).toBe('clean');
        expect(footer).toContain(language === 'ko' ? 'Quoky는 이 답변에서 아무 곳에도 쓰거나 보내지 않았어요' : 'nothing was written or sent anywhere by Quoky in this reply');
      }
    }
    for (const source of SOURCES) {
      for (const language of ['ko', 'en'] as const) {
        expect(isFixedDocumentSummaryNotice(renderDocumentActionClaimWithheld(language, source), source)).toBe(true);
        expect(isFixedDocumentSummaryNotice(renderDocumentSummaryTooLong(language), source)).toBe(true);
        expect(isFixedDocumentSummaryNotice(renderUntrustedDocumentReplyWithheld(language), source)).toBe(true);
        for (const domain of INTERNAL_ACTION_DOMAINS) expect(isFixedDocumentSummaryNotice(renderInternalActionClaimNotice(domain, language), source)).toBe(true);
      }
      expect(isFixedDocumentSummaryNotice('시트에는 다른 내용이 있어요.', source)).toBe(false);
    }
    expect(DOCUMENT_ATTRIBUTION_RULE).toContain("시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요");
    expect(DOCUMENT_ATTRIBUTION_RETRY_RULE).toContain('STRICT ATTRIBUTION');
  });

  it('property: when the shown lines are clean, every prefix of them is clean (whatever a platform takes)', () => {
    const pool = [
      ...ATTRIBUTED.flatMap((text) => text.split('\n')),
      ...LEAKS.flatMap((text) => text.split('\n')),
      '위클리카 Dogfood 시트는 주간 도그푸딩 진행 상황을 기록한 트래커예요.',
      '- 남은 이슈는 4건이에요.',
      '- 다음 주 목표는 온보딩 개선이에요.',
      'Kim sent the deck and asked for comments.',
      '김철수 님이 회의 요약을 보냈어요.',
      'Is the PR merged',
      '- 상태:',
      `The PR has been merged ${'x'.repeat(1200)}?`,
    ];
    let seed = 20261015;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    let cleanSummaries = 0;
    for (let round = 0; round < 1500; round += 1) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 7) }, () => pool[Math.floor(random() * pool.length)] as string);
      const { shown } = documentSummaryReply(lines.join('\n'), renderDriveSummaryFooter('ko'));
      if (check(shown) !== 'clean') continue;
      cleanSummaries += 1;
      const shownLines = shown.split('\n');
      for (let count = 1; count < shownLines.length; count += 1) {
        expect(check(shownLines.slice(0, count).join('\n')), shownLines.slice(0, count).join(' / ')).toBe('clean');
      }
    }
    expect(cleanSummaries).toBeGreaterThan(40);
  });

  it('a platform that renders every code point as two still takes whole lines within the budget', () => {
    const doubling: MessageMarkup = {
      untrusted: (text: string) => text.replace(/./gsu, (char) => `\\${char}`),
      link: (url: string) => url,
      conversation: (ref) => ref.label,
      platformNote: () => '',
    };
    const footer = renderDriveSummaryFooter('ko');
    const lines = Array.from({ length: 30 }, (_, index) => `- ${index}주차: 상태 열에는 '진행 중'이라고 적혀 있어요. ${'가'.repeat(40)}`);
    const reply = documentSummaryReply(lines.join('\n'), footer);
    const rendered = renderMessageContent(reply.body, doubling);
    expect(Array.from(rendered).length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_REPLY_MAX_CHARS);
    expect(rendered.endsWith(footer)).toBe(true);
    const taken = rendered.slice(0, rendered.length - footer.length).trimEnd().split('\n').filter((line) => !line.startsWith('… (+'));
    for (const line of taken) expect(reply.shown.split('\n')).toContain(line.replace(/\\(.)/gsu, '$1'));
    // One over-long line is capped in Core, never cut by the platform.
    const long = documentSummaryReply(`시트에는 '${'가'.repeat(3000)}'로 표시돼 있어요.`, footer);
    expect(Array.from(renderMessageContent(long.body, doubling)).length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_REPLY_MAX_CHARS);
    expect(long.shown.endsWith('…')).toBe(true);
  });

  it('is linear: doubling the input at most about doubles the CPU time (quote blanking and the whole check)', () => {
    const cpuMs = (fn: () => void): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run += 1) {
        const before = process.cpuUsage();
        fn();
        const used = process.cpuUsage(before);
        best = Math.min(best, (used.user + used.system) / 1000);
      }
      return best;
    };
    const unmatched = (chars: number) => '‘“「『"'.repeat(Math.ceil(chars / 5)).slice(0, chars);
    const blankHalf = cpuMs(() => blankQuoted(unmatched(100_000)));
    const blankFull = cpuMs(() => blankQuoted(unmatched(200_000)));
    expect(blankFull).toBeLessThan(blankHalf * 3 + 5);
    const block = [
      "- 1주차: 시트에는 '로그인 화면 개선 진행 중'으로 표시돼 있어요.",
      '- 2주차: 결제 화면 QA 대기. 남은 이슈는 4건이에요.',
      "- 메일에서 김철수 님은 '배포했다'고 적었어요.",
      '- Kim sent the deck and asked for comments.',
    ].join('\n');
    const text = (chars: number) => `${block}\n`.repeat(Math.ceil(chars / (block.length + 1))).slice(0, chars);
    const half = cpuMs(() => checkDocumentSummaryClaims(text(DOCUMENT_SUMMARY_GUARD_MAX_CHARS / 2), ASK, 'drive', 'ko'));
    const full = cpuMs(() => checkDocumentSummaryClaims(text(DOCUMENT_SUMMARY_GUARD_MAX_CHARS), ASK, 'drive', 'ko'));
    expect(full).toBeLessThan(half * 3 + 5);
  });
});
