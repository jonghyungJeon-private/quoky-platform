import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../../domain';
import { parseSurfaceGrantPhrase } from './surface-grant-phrases';

// ADR-0122 D4: the anchored owner phrases — whole message, NFC, spaces collapsed, closed polite tail, `.`/`!`; quoted,
// code-formatted or attached text never matches.

const msg = (text: string, extra: Partial<InboundMessage> = {}) => ({ text, ...extra });

describe('the anchored grant phrases', () => {
  it.each([
    ['이 채널 권한', { kind: 'list' }],
    ['이 채널 권한 보여줘', { kind: 'list' }],
    ['이 채널 권한 보여 주세요.', { kind: 'list' }],
    ['이채널 권한 보여줘!', { kind: 'list' }],
    ['채널 권한 목록', { kind: 'list-all' }],
    ['이 채널 권한 모두 해제', { kind: 'revoke-channel' }],
    ['이 채널 권한 모두 해제해줘', { kind: 'revoke-channel' }],
    ['이 채널 권한 전부 해제해 주세요', { kind: 'revoke-channel' }],
    ['모든 채널 권한 해제', { kind: 'revoke-all' }],
    ['모든 채널 권한 해제해줘.', { kind: 'revoke-all' }],
    ['이 채널에 캘린더 허용 해제', { kind: 'revoke', groups: ['calendar'], unknown: [] }],
    ['이 채널에 Jira 내 담당 허용 해제해줘', { kind: 'revoke', groups: ['jira-mine'], unknown: [] }],
    ['이 채널에 캘린더, GitHub 허용 해제', { kind: 'revoke', groups: ['calendar', 'github'], unknown: [] }],
    ['이 채널에 Jira 릴리스 허용 해제', { kind: 'revoke', groups: ['jira-project'], unknown: [] }],
    ['이 채널에 메일 허용 해제', { kind: 'revoke', groups: ['mail'], unknown: [] }],
    ['이 채널에 아무거나 허용 해제', { kind: 'revoke', groups: [], unknown: ['아무거나'] }],
    ['이 채널에 캘린더 허용', { kind: 'grant', groups: ['calendar'], unknown: [] }],
    ['이 채널에 Slack 검색, 코드 작업 허용해줘', { kind: 'grant', groups: ['slack-search', 'code'], unknown: [] }],
  ] as const)('%s', (text, expected) => {
    expect(parseSurfaceGrantPhrase(msg(text))).toEqual(expected);
  });

  it.each([
    '이 채널 권한 좀 알려줄래?',
    'Jira 여기서도 보이게 해줘',
    '이 채널에 캘린더 허용해도 돼?',
    '채널 권한이 뭐야',
    '이 채널 권한 모두 해제하지 마',
    '이 채널 권한 보여줘 그리고 일정도',
    '권한',
  ])('near-miss %s is ordinary text', (text) => {
    expect(parseSurfaceGrantPhrase(msg(text))).toBeUndefined();
  });

  it('quoted, code-formatted, multi-line and attached messages never match', () => {
    expect(parseSurfaceGrantPhrase(msg('이 채널 권한 모두 해제', { quotedRanges: [{ start: 0, end: 5 }] }))).toBeUndefined();
    expect(parseSurfaceGrantPhrase(msg('이 채널 권한 모두 해제', { formatting: { code: true } }))).toBeUndefined();
    expect(parseSurfaceGrantPhrase(msg('`이 채널 권한 모두 해제`'))).toBeUndefined();
    expect(parseSurfaceGrantPhrase(msg('> 이 채널 권한 모두 해제'))).toBeUndefined();
    expect(parseSurfaceGrantPhrase(msg('이 채널 권한\n모두 해제'))).toBeUndefined();
    expect(parseSurfaceGrantPhrase(msg('이 채널 권한 모두 해제', { attachments: [{ id: 'a' } as never] }))).toBeUndefined();
  });
});
