import { describe, expect, it } from 'vitest';
import { nlSelectionForWorkChatCommand, workChatCommandForSelection } from './work-chat-selection';
import { detectWorkChatCommand } from './work-chat-command';

describe('workChatCommandForSelection — Jira status (ADR-0120 follow-up)', () => {
  it('carries in-progress to the personal-work options, with the role and a keyword', () => {
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: { status: 'in-progress', keyword: '결제', role: 'reporter' }, language: 'ko' })).toMatchObject({
      kind: 'lookup',
      source: 'jira',
      text: '결제',
      personalWork: { status: 'in-progress', role: 'reporter' },
    });
  });

  it('live UAT R8: carries the closed sort to the personal-work options and ignores a name outside the set', () => {
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: { status: 'in-progress', sort: 'oldest' }, language: 'ko' })).toMatchObject({
      personalWork: { status: 'in-progress', sort: 'oldest' },
    });
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: { sort: 'recently-updated' }, language: 'ko' })).toMatchObject({ personalWork: { sort: 'recently-updated' } });
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: { sort: 'created ASC' }, language: 'ko' })).not.toHaveProperty('personalWork');
  });

  it('keeps the default open status out of the options', () => {
    expect(workChatCommandForSelection({ entryId: 'jira.issues', args: {}, language: 'ko' })).not.toHaveProperty('personalWork');
  });
});

describe('nlSelectionForWorkChatCommand — the reverse mapping of a grammar listing (ADR-0120 follow-up 2)', () => {
  const selectionOf = (text: string) => {
    const command = detectWorkChatCommand(text);
    return command === null ? null : nlSelectionForWorkChatCommand(command);
  };

  it('maps every listing the grammar answers to its catalog entry with canonical args', () => {
    expect(selectionOf('내 지라 이슈 보여줘')).toEqual({ entryId: 'jira.issues', args: {} });
    expect(selectionOf('위클리카 관련 jira 이슈 보여줘')).toEqual({ entryId: 'jira.issues', args: { keyword: '위클리카' } });
    expect(selectionOf('이번 주 마감인 jira 이슈 알려줘')).toEqual({ entryId: 'jira.issues', args: { window: 'due', range: 'this-week' } });
    expect(selectionOf('내 GitHub 리뷰 요청 보여줘')).toEqual({ entryId: 'github.items', args: { query: 'review-requests' } });
    expect(selectionOf('내 깃허브 PR 목록 알려줘')).toEqual({ entryId: 'github.items', args: {} });
    expect(selectionOf('슬랙에서 배포 검색해줘')).toEqual({ entryId: 'slack.search', args: { keyword: '배포' } });
    expect(selectionOf('내 할 일 보여줘')).toEqual({ entryId: 'todo.list', args: {} });
  });

  it('has no equivalent for a to-do write, a hint or a usage line', () => {
    expect(selectionOf('할 일 추가: 보고서')).toBeNull();
    expect(selectionOf('Slack 검색')).toBeNull();
  });

  it('declines a listing that carries a role, a window, a status or a keyword the phrase cannot express, only with the yield option', () => {
    for (const text of [
      '내 지라 이슈 어제 업데이트된 거 보여줘',
      '내 jira 이슈 진행중인 거 보여줘',
      '어제 업데이트된 위클리카 관련 jira 이슈',
      '이번 주 마감인 스크럼 이슈 알려줘',
      '내 깃허브 PR 중에 로그인 관련 보여줘',
    ]) {
      expect(detectWorkChatCommand(text, { yieldToSelection: true }), text).toBeNull();
      // Without the option (flag off, the code-change shield, every other caller) the grammar is unchanged.
      expect(detectWorkChatCommand(text), `${text} (off)`).not.toBeNull();
    }
    // The wildcard-bearing due phrase must not hide a keyword between the period and 마감 (amendment A2, Codex P2).
    const due = '이번 주 스크럼 마감 이슈 알려줘';
    expect(detectWorkChatCommand(due, { yieldToSelection: true })).toBeNull();
    expect(detectWorkChatCommand(due)).toEqual({ kind: 'lookup', source: 'jira', query: 'due-this-week' });
    // Never claimed by the grammar either way.
    for (const text of ['내가 만든 지라 이슈 보여줘', '내 깃허브 PR 중 버그 관련 보여줘']) {
      expect(detectWorkChatCommand(text, { yieldToSelection: true }), text).toBeNull();
      expect(detectWorkChatCommand(text), `${text} (off)`).toBeNull();
    }
  });

  it('keeps hits that have no leftover qualifier', () => {
    for (const text of ['내 Jira 이슈 보여줘', 'jira 이슈 보여줘', '이번 주 마감인 jira 이슈 알려줘', '내 GitHub 리뷰 요청 보여줘', 'show my work on Jira']) {
      expect(detectWorkChatCommand(text, { yieldToSelection: true }), text).toEqual(detectWorkChatCommand(text));
      expect(detectWorkChatCommand(text, { yieldToSelection: true }), text).not.toBeNull();
    }
  });
});

describe('todo.list status (owner-approved status filter, 2026-10-15)', () => {
  it('maps a non-default status to the read-only status view and back; the open list and its count are unchanged', () => {
    expect(workChatCommandForSelection({ entryId: 'todo.list', args: { status: 'canceled' }, language: 'ko' })).toEqual({ kind: 'todo.list', status: 'canceled' });
    expect(workChatCommandForSelection({ entryId: 'todo.list', args: { status: 'all', count: true }, language: 'ko' })).toEqual({ kind: 'todo.list', status: 'all' });
    expect(workChatCommandForSelection({ entryId: 'todo.list', args: {}, language: 'ko' })).toEqual({ kind: 'todo.list' });
    expect(workChatCommandForSelection({ entryId: 'todo.list', args: { count: true }, language: 'ko' })).toEqual({ kind: 'todo.summary' });
    expect(nlSelectionForWorkChatCommand({ kind: 'todo.list', status: 'completed' })).toEqual({ entryId: 'todo.list', args: { status: 'completed' } });
  });
});

