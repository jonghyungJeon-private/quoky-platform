import { describe, expect, it } from 'vitest';
import { workChatCommandForSelection } from './work-chat-selection';

describe('workChatCommandForSelection — Jira status (ADR-0120 follow-up)', () => {
  it('carries in-progress to the personal-work options, with the role and a keyword', () => {
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: { status: 'in-progress', keyword: '결제', role: 'reporter' }, language: 'ko' })).toMatchObject({
      kind: 'lookup',
      source: 'jira',
      text: '결제',
      personalWork: { status: 'in-progress', role: 'reporter' },
    });
  });

  it('keeps the default open status out of the options', () => {
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: {}, language: 'ko' })).not.toHaveProperty('personalWork');
  });
});
