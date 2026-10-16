import { describe, expect, it } from 'vitest';
import {
  UNTRUSTED_DOCUMENT_R2_SOURCES,
  UNTRUSTED_DOCUMENT_SOURCES,
  buildUntrustedDocumentReadout,
  isR2DocumentSource,
  isSummarizableDocumentReadout,
  renderUntrustedDocumentForPrompt,
  renderUntrustedDocumentHistoryNote,
  type UntrustedDocumentSource,
} from './untrusted-document-readout';

const R2: readonly UntrustedDocumentSource[] = ['jira-issue', 'slack-message', 'slack-thread'];

function build(source: UntrustedDocumentSource, extra: Partial<Parameters<typeof buildUntrustedDocumentReadout>[0]> = {}) {
  return buildUntrustedDocumentReadout({ source, title: '결제 오류', author: '', date: '2026-10-16T00:00:00Z', body: '본문입니다', ...extra });
}

describe('A6 R2 document sources', () => {
  it('lists the three new sources', () => {
    for (const source of R2) expect(UNTRUSTED_DOCUMENT_SOURCES).toContain(source);
    expect([...UNTRUSTED_DOCUMENT_R2_SOURCES]).toEqual(R2);
  });

  it.each(R2)('%s passes isSummarizableDocumentReadout when built', (source) => {
    const result = build(source);
    if (!result.ok) throw new Error('refused');
    expect(result.readout.source).toBe(source);
    expect(isSummarizableDocumentReadout(result.readout)).toBe(true);
    expect(renderUntrustedDocumentForPrompt(result.readout)).toContain(
      { 'jira-issue': 'JIRA ISSUE', 'slack-message': 'SLACK MESSAGE', 'slack-thread': 'SLACK THREAD' }[source as 'jira-issue'],
    );
  });

  it('an unknown source still fails the re-validation', () => {
    const result = build('jira-issue');
    if (!result.ok) throw new Error('refused');
    expect(isSummarizableDocumentReadout({ ...result.readout, source: 'jira' })).toBe(false);
    expect(isSummarizableDocumentReadout({ ...result.readout, source: 'github-issue' })).toBe(false);
  });

  it('a hand-built R2 readout with a credential-shaped body is still refused', () => {
    const result = build('jira-issue');
    if (!result.ok) throw new Error('refused');
    expect(isSummarizableDocumentReadout({ ...result.readout, body: 'password: hunter2abc123XYZ' })).toBe(false);
  });

  it('sections use [Part i/n] headers for the R2 sources while drive keeps [Sheet i/n]', () => {
    const sections = [
      { title: '설명', body: '첫째' },
      { title: '댓글 1', body: '둘째' },
    ];
    for (const source of R2) {
      const result = build(source, { body: '', sections });
      if (!result.ok) throw new Error('refused');
      expect(result.readout.body).toContain('[Part 1/2] "설명"');
      expect(result.readout.body).toContain('[Part 2/2] "댓글 1"');
      expect(result.readout.body).not.toContain('[Sheet');
    }
    const drive = build('drive', { body: '', sections });
    if (!drive.ok) throw new Error('refused');
    expect(drive.readout.body).toContain('[Sheet 1/2] "설명"');
    expect(drive.readout.body).not.toContain('[Part');
    const thread = build('mail-thread', { body: '', sections });
    if (!thread.ok) throw new Error('refused');
    expect(thread.readout.body).toContain('[Part 1/2]');
  });

  it('history note nouns', () => {
    expect(renderUntrustedDocumentHistoryNote('jira-issue', 'ko')).toContain('지라 이슈 1건');
    expect(renderUntrustedDocumentHistoryNote('slack-message', 'ko')).toContain('슬랙 메시지 1건');
    expect(renderUntrustedDocumentHistoryNote('slack-thread', 'ko')).toContain('슬랙 스레드 1건');
    expect(renderUntrustedDocumentHistoryNote('jira-issue', 'en')).toContain('Jira issue');
    expect(renderUntrustedDocumentHistoryNote('slack-message', 'en')).toContain('Slack message');
    expect(renderUntrustedDocumentHistoryNote('slack-thread', 'en')).toContain('Slack thread');
    expect(renderUntrustedDocumentHistoryNote('jira-issue', 'ko')).toBe('[요청한 지라 이슈 1건을 요약해 보여 드림 — 요약 내용은 대화 기록에 남기지 않아요.]');
  });

  it('isR2DocumentSource', () => {
    for (const source of R2) expect(isR2DocumentSource(source)).toBe(true);
    for (const source of ['mail', 'drive', 'mail-thread', 'jira', 'slack', '', undefined, null, 3]) expect(isR2DocumentSource(source)).toBe(false);
  });
});
