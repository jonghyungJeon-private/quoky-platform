import { describe, expect, it } from 'vitest';
import { guardInternalActionClaims } from './chat-policy/internal-action-claim-guard';
import { INTERNAL_ACTION_DOMAINS, renderInternalActionClaimNotice } from './chat-policy/internal-action-vocabulary';
import {
  DOCUMENT_SUMMARY_GUARD_MAX_CHARS,
  attributedQuoteForms,
  checkDocumentSummaryClaims,
  isFixedDocumentSummaryNotice,
  joinedWrappedLines,
  renderDocumentSummaryTooLong,
  strippedOfMarkup,
} from './document-summary-claim-check';
import { containsDocumentActionClaim, renderDocumentActionClaimWithheld } from './document-summary-claim-guard';
import { renderDriveSummaryFooter } from './drive/drive-reply-renderer';
import { renderMailSummaryFooter, renderMailThreadSummaryFooter } from './mail/mail-reply-renderer';
import { DOCUMENT_ATTRIBUTION_RULE, DOCUMENT_ATTRIBUTION_RETRY_RULE } from './prompt-composer';
import { renderUntrustedDocumentReplyWithheld } from './untrusted-document-readout';

// ADR-0104 D1 amendment for summary turns (owner-approved 2026-10-15): attribution by construction, one regeneration,
// strict guards. This file pins the claim check itself; the runtime tests pin the regeneration.

const ASK = '1번 문서 요약해줘';
const SOURCES = ['drive', 'mail', 'mail-thread'] as const;
const check = (text: string, source: (typeof SOURCES)[number] = 'drive') => checkDocumentSummaryClaims(text, ASK, source, 'ko').kind;

/** Attributed summaries in the prompt's shape: the document's words, quoted, with the document or a named person as subject. */
const ATTRIBUTED = [
  "시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요.",
  "메일에서 김철수 님은 '배포했다'고 적었어요.",
  "- 상태 열에는 '배포 완료'라고 적혀 있어요.",
  "- 2주차: 상태 열에는 'PR 머지됨'이라고 적혀 있어요.",
  'According to the sheet, the status is "merged".',
  'The status column says "PR merged" for week 2.',
  // A real-model draft of the tracker prompt (2026-10-15 probe): a document field names the quoted value.
  [
    '**시트: 진행 현황**',
    "- 1주차 로그인 버그 3건: 시트에는 'Jira 티켓 등록 완료'로 표시돼 있고, 담당은 김OO, 비고는 'QA 재현됨'이에요.",
    "- 2주차 결제 화면 개선: 상태는 'PR 머지됨 / 배포 완료', 담당은 이OO, 비고는 '스테이징 확인'이에요.",
    "- 2주차 '결제 화면 개선'은 상태가 'PR 머지됨 / 배포 완료'이고, 담당은 이OO예요.",
    "- 10/07 최OO 님은 '결제 버튼이 느림'이라고 적었고, 처리란에는 'PR 생성함'으로 표시돼 있어요.",
  ].join('\n'),
  [
    '위클리카 Dogfood 시트는 주간 도그푸딩 진행 상황을 기록한 트래커예요.',
    "- 1주차: 시트에는 '로그인 버그 3건 Jira 티켓 등록 완료'로 표시돼 있어요.",
    "- 2주차: 상태 열에는 'PR 머지됨'이라고 적혀 있어요.",
    "- 3주차: 시트에는 담당자 '김OO'과 상태 '진행 중'이 적혀 있어요.",
    '- 남은 이슈는 4건이에요.',
  ].join('\n'),
];

/** Every leak string from the review rounds (CA and Codex, rounds 1–3) and the hostile payloads: always a claim. */
const LEAKS = [
  // Round 1 (CA, Codex).
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
  // Round 2 (Codex, CA).
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
  // Round 3 (CA, Codex).
  'Already did that.',
  '머지함.',
  '끝!',
  'The PR got merged.',
  'Successfully merged the PR.',
  // Hostile payloads aimed at the attributed shape: an assistant marker voids the attribution.
  "시트에는 '제가 Jira 티켓 등록 완료'로 표시돼 있어요.",
  "요청하신 대로 시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요.",
  "시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요. 종형님께 전달 완료.",
  "시트에는 'Jira 티켓 생성해 드렸어요'로 표시돼 있어요.",
  "According to the sheet, \"I've merged the PR for you\".",
  "'Jira 티켓 등록 완료'",
  "상태는 '제가 PR을 머지했어요'예요.",
  "처리 칸에는 'Jira 티켓 생성해 드림'이라고 적혀 있어요.",
  "상태는 'PR 머지 완료', 요청하신 대로예요.",
  "Jira 티켓 '등록 완료' 했어요.",
  '<b>Merged</b> the PR.',
  '> The PR has been\n> merged.',
  '~~not~~ The PR has been merged.',
  '[The PR has been merged](https://example.com).',
];

describe('checkDocumentSummaryClaims (owner decision 2026-10-15)', () => {
  it.each(ATTRIBUTED)('an attributed summary passes: %j', (text) => {
    for (const source of SOURCES) expect(check(text, source), source).toBe('clean');
  });

  it.each(LEAKS)('a leak or hostile string is always a claim: %j', (text) => {
    for (const source of SOURCES) expect(check(text, source), source).toBe('claim');
  });

  it('the attributed quote is the one exemption: the document guard flags the raw text, the check masks it', () => {
    const text = "메일에서 김철수 님은 '답장을 보냈다'고 적었어요.";
    expect(containsDocumentActionClaim(text, 'mail')).toBe(true); // main's document guard on the raw text
    expect(check(text, 'mail')).toBe('clean');
    // The same words without the attribution, or with an assistant marker anywhere in the sentence, are claims.
    for (const voided of [
      "'답장을 보냈다'고 적었어요.",
      "메일에서 김철수 님은 '답장을 보냈다'고 적었고, 제가 확인했어요.",
      "메일에서 김철수 님은 '답장을 보내 드렸다'고 적었어요.",
      "요청하신 메일에서 김철수 님은 '답장을 보냈다'고 적었어요.",
      "메일에서 김철수 님께 '답장을 보냈다'고 적었어요.",
      "메일에서 김철수 님은 '답장을 보냈다' 했어요.",
    ]) {
      expect(check(voided, 'mail'), voided).toBe('claim');
    }
  });

  it('the attribution marker must be in the quote\'s own sentence, and the quote closed', () => {
    expect(check("시트를 읽었어요. 'Jira 티켓 등록 완료'.")).toBe('claim');
    // An unclosed quote is no quote: nothing is masked (the words are read as written).
    const unclosed = "시트에는 'Jira 티켓 등록 완료로 표시돼 있어요.";
    expect(attributedQuoteForms(unclosed)).toEqual({ masked: unclosed, unwrapped: unclosed });
    expect(attributedQuoteForms("시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요.").masked).not.toContain('Jira');
    expect(attributedQuoteForms("시트에는 '제가 등록 완료'로 표시돼 있어요.").unwrapped).toContain('제가 등록 완료.');
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

  it('every fixed notice is recognised as Quoky copy, and the footers and prompt rules name no actor', () => {
    for (const source of SOURCES) {
      for (const language of ['ko', 'en'] as const) {
        expect(isFixedDocumentSummaryNotice(renderDocumentActionClaimWithheld(language, source), source)).toBe(true);
        expect(isFixedDocumentSummaryNotice(renderDocumentSummaryTooLong(language), source)).toBe(true);
        expect(isFixedDocumentSummaryNotice(renderUntrustedDocumentReplyWithheld(language), source)).toBe(true);
        for (const domain of INTERNAL_ACTION_DOMAINS) expect(isFixedDocumentSummaryNotice(renderInternalActionClaimNotice(domain, language), source)).toBe(true);
      }
      expect(isFixedDocumentSummaryNotice('시트에는 다른 내용이 있어요.', source)).toBe(false);
    }
    expect(renderDriveSummaryFooter('ko')).toContain('Jira·Slack·GitHub에도 쓰지 않았어요');
    expect(renderMailSummaryFooter('en')).toContain('nothing was written to Jira, Slack or GitHub');
    expect(renderMailThreadSummaryFooter(2, 2, 'ko')).toContain('Jira·Slack·GitHub에도 쓰지 않았어요');
    expect(DOCUMENT_ATTRIBUTION_RULE).toContain("시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요");
    expect(DOCUMENT_ATTRIBUTION_RETRY_RULE).toContain('STRICT ATTRIBUTION');
  });

  it('is linear: doubling the summary at most about doubles the CPU time', () => {
    const block = [
      "- 1주차: 시트에는 '로그인 화면 개선 진행 중'으로 표시돼 있어요.",
      '- 2주차: 결제 화면 QA 대기. 남은 이슈는 4건이에요.',
      "- 메일에서 김철수 님은 '배포했다'고 적었어요.",
      '- Kim sent the deck and asked for comments.',
    ].join('\n');
    const text = (chars: number) => `${block}\n`.repeat(Math.ceil(chars / (block.length + 1))).slice(0, chars);
    const cpuMs = (input: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run += 1) {
        const before = process.cpuUsage();
        checkDocumentSummaryClaims(input, ASK, 'drive', 'ko');
        const used = process.cpuUsage(before);
        best = Math.min(best, (used.user + used.system) / 1000);
      }
      return best;
    };
    const quarter = cpuMs(text(DOCUMENT_SUMMARY_GUARD_MAX_CHARS / 4));
    const half = cpuMs(text(DOCUMENT_SUMMARY_GUARD_MAX_CHARS / 2));
    const full = cpuMs(text(DOCUMENT_SUMMARY_GUARD_MAX_CHARS));
    // Linear work doubles; a quadratic step would quadruple. A small floor absorbs timer noise on tiny inputs.
    expect(half).toBeLessThan(quarter * 3 + 5);
    expect(full).toBeLessThan(half * 3 + 5);
  });
});
