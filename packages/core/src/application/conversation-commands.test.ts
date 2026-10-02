import { describe, expect, it } from 'vitest';
import {
  PENDING_APPROVAL_TTL_MS,
  detectConversationControl,
  pendingApprovalRemainingMs,
} from './conversation-commands';

describe('detectConversationControl (ADR-0093)', () => {
  it.each([
    ['도움말', 'help'],
    ['/help', 'help'],
    ['/HELP', 'help'],
    ['  /Help \n', 'help'],
    ['새 대화', 'reset'],
    ['  새 대화  ', 'reset'],
    ['/reset', 'reset'],
    ['/RESET', 'reset'],
  ] as const)('whole message %j → %s', (text, expected) => {
    expect(detectConversationControl(text)).toBe(expected);
  });

  it.each([
    '새 대화 기능 만들어줘',
    '새 대화 시작하는 법 알려줘',
    '도움말 좀 보여줘',
    '도움말이 필요해',
    '/helpme',
    '/help me',
    '/ help',
    'help',
    'reset',
    '/reset now',
    '새대화',
    '새  대화',
    '',
    '   ',
  ])('ordinary message %j is not a control phrase', (text) => {
    expect(detectConversationControl(text)).toBeNull();
  });
});

describe('pendingApprovalRemainingMs (ADR-0093)', () => {
  const created = '2026-10-02T09:00:00.000Z';
  const plus = (ms: number) => new Date(Date.parse(created) + ms).toISOString();

  it('is a 30-minute lifetime', () => {
    expect(PENDING_APPROVAL_TTL_MS).toBe(1_800_000);
    expect(pendingApprovalRemainingMs(created, created)).toBe(PENDING_APPROVAL_TTL_MS);
  });

  it('counts down from createdAt and reaches 0 (expired) exactly at 30 minutes', () => {
    expect(pendingApprovalRemainingMs(created, plus(10 * 60_000))).toBe(20 * 60_000);
    expect(pendingApprovalRemainingMs(created, plus(PENDING_APPROVAL_TTL_MS - 1))).toBe(1);
    expect(pendingApprovalRemainingMs(created, plus(PENDING_APPROVAL_TTL_MS))).toBe(0);
    expect(pendingApprovalRemainingMs(created, plus(PENDING_APPROVAL_TTL_MS + 1))).toBeLessThan(0);
  });

  it('fails closed on an unparseable timestamp (reported as expired)', () => {
    expect(pendingApprovalRemainingMs('not-a-date', created)).toBe(0);
    expect(pendingApprovalRemainingMs(created, 'not-a-date')).toBe(0);
  });

  it('caps a createdAt ahead of the clock (skew) at the full lifetime', () => {
    expect(pendingApprovalRemainingMs(plus(60 * 60_000), created)).toBe(PENDING_APPROVAL_TTL_MS);
  });
});
