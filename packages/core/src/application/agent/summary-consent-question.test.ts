import { describe, expect, it } from 'vitest';
import { buildConsentClassifierRequest, consentClassifierQuestion } from '../consent-answer/consent-classifier';
import { summaryConsentPending } from '../consent-answer/consent-pending';
import { SUMMARY_CONSENT_SOURCE_NAMES, renderSummaryConsentQuestion } from './summary-consent-question';

// ADR-0121 rule ① (confirm slice CS-1a): the owner-facing question, fixed reply text. KO is the owner's own wording; the
// placeholder form is what the A6-S2 classifier sees (the same template, no count).

const ko = (sources: Array<{ source: (typeof SUMMARY_CONSENT_SOURCE_NAMES)[number]; count: number }>, recipient = 'Claude') => renderSummaryConsentQuestion({ language: 'ko', recipient, sources });
const en = (sources: Array<{ source: (typeof SUMMARY_CONSENT_SOURCE_NAMES)[number]; count: number }>, recipient = 'Claude') => renderSummaryConsentQuestion({ language: 'en', recipient, sources });

describe('renderSummaryConsentQuestion', () => {
  it('KO, one source: the owner wording', () => {
    expect(ko([{ source: 'mail', count: 3 }])).toBe('메일 3건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)');
    expect(ko([{ source: 'drive', count: 1 }])).toBe('드라이브 파일 1건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)');
  });

  it('KO, several sources: parts joined with 과 (every part ends in 건), in the given order', () => {
    expect(ko([{ source: 'mail', count: 3 }, { source: 'drive', count: 2 }])).toBe('메일 3건과 드라이브 파일 2건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)');
    expect(ko([{ source: 'mail', count: 1 }, { source: 'jira', count: 4 }, { source: 'slack', count: 2 }])).toBe('메일 1건과 지라 이슈 4건과 슬랙 메시지 2건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)');
  });

  it('the closed noun table, KO and EN, one and many', () => {
    const ko1: Record<string, string> = { mail: '메일', drive: '드라이브 파일', calendar: '캘린더 일정', jira: '지라 이슈', slack: '슬랙 메시지', confluence: '컨플루언스 문서', github: '깃허브 항목' };
    const enOne: Record<string, string> = { mail: 'mail', drive: 'Drive file', calendar: 'Calendar event', jira: 'Jira issue', slack: 'Slack message', confluence: 'Confluence page', github: 'GitHub item' };
    const enMany: Record<string, string> = { mail: 'mails', drive: 'Drive files', calendar: 'Calendar events', jira: 'Jira issues', slack: 'Slack messages', confluence: 'Confluence pages', github: 'GitHub items' };
    expect([...SUMMARY_CONSENT_SOURCE_NAMES]).toEqual(['mail', 'drive', 'calendar', 'jira', 'slack', 'confluence', 'github']);
    for (const source of SUMMARY_CONSENT_SOURCE_NAMES) {
      expect(ko([{ source, count: 2 }])).toBe(`${ko1[source]} 2건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)`);
      expect(en([{ source, count: 1 }])).toBe(`I'll send 1 ${enOne[source]} to Claude to summarise it. Shall I send it? (yes/no)`);
      expect(en([{ source, count: 2 }])).toBe(`I'll send 2 ${enMany[source]} to Claude to summarise them. Shall I send them? (yes/no)`);
    }
  });

  it('EN: several sources join with commas and a final "and"; singular parts and plural "them" for a total above one', () => {
    expect(en([{ source: 'mail', count: 3 }, { source: 'drive', count: 1 }])).toBe("I'll send 3 mails and 1 Drive file to Claude to summarise them. Shall I send them? (yes/no)");
    expect(en([{ source: 'mail', count: 3 }, { source: 'drive', count: 2 }, { source: 'github', count: 1 }])).toBe(
      "I'll send 3 mails, 2 Drive files and 1 GitHub item to Claude to summarise them. Shall I send them? (yes/no)",
    );
  });

  it('the placeholder form writes every count as {개수} / {count} (plural EN) and keeps the noun and the recipient', () => {
    expect(renderSummaryConsentQuestion({ language: 'ko', recipient: 'Claude', sources: [{ source: 'mail', count: 3 }, { source: 'drive', count: 2 }] }, { countPlaceholder: true })).toBe(
      '메일 {개수}건과 드라이브 파일 {개수}건을 Claude에 보내 요약할게요. 보낼까요? (응/아니)',
    );
    expect(renderSummaryConsentQuestion({ language: 'en', recipient: 'Claude', sources: [{ source: 'mail', count: 1 }] }, { countPlaceholder: true })).toBe(
      "I'll send {count} mails to Claude to summarise them. Shall I send them? (yes/no)",
    );
    // The placeholder never carries the real count.
    expect(renderSummaryConsentQuestion({ language: 'ko', recipient: 'Claude', sources: [{ source: 'mail', count: 7 }] }, { countPlaceholder: true })).not.toMatch(/7/u);
  });

  it('the classifier sees exactly the owner question with its counts replaced (one shared template)', () => {
    const scope = { actorId: 'owner', conversationKey: 'dm' };
    for (const language of ['ko', 'en'] as const) {
      const pending = summaryConsentPending({
        scope,
        language,
        createdAtMs: 0,
        recipient: 'Claude',
        sources: [{ source: 'mail', itemIds: ['a', 'b', 'c'] }, { source: 'drive', itemIds: ['dd-file-1'] }],
        runRef: 'run-1',
      });
      const owner = renderSummaryConsentQuestion({ language, recipient: 'Claude', sources: [{ source: 'mail', count: 3 }, { source: 'drive', count: 1 }] });
      const placeholder = renderSummaryConsentQuestion({ language, recipient: 'Claude', sources: [{ source: 'mail', count: 3 }, { source: 'drive', count: 1 }] }, { countPlaceholder: true });
      expect(consentClassifierQuestion(pending)).toBe(placeholder);
      expect(buildConsentClassifierRequest(pending, 'ok').question).toBe(placeholder);
      expect(owner).not.toBe(placeholder);
      // The owner question with every count digit swapped for the placeholder is the classifier's question (EN: plural form is the one rendered).
      if (language === 'ko') expect(owner.replace(/\d+건/gu, '{개수}건')).toBe(placeholder);
    }
  });

  it('fails closed to no question: an unknown or repeated source, a bad count, a blank recipient, no source', () => {
    expect(ko([])).toBe('');
    expect(ko([{ source: 'notes' as never, count: 1 }])).toBe('');
    expect(ko([{ source: 'mail', count: 1 }, { source: 'mail', count: 2 }])).toBe('');
    expect(ko([{ source: 'mail', count: 0 }])).toBe('');
    expect(ko([{ source: 'mail', count: 1.5 }])).toBe('');
    expect(ko([{ source: 'mail', count: 1 }], '   ')).toBe('');
    expect(renderSummaryConsentQuestion({ language: 'fr' as never, recipient: 'Claude', sources: [{ source: 'mail', count: 1 }] })).toBe('');
    expect(renderSummaryConsentQuestion(null as never)).toBe('');
  });
});
