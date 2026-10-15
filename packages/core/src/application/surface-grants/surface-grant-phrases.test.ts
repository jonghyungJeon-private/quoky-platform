import { describe, expect, it } from 'vitest';
import type { InboundMessage } from '../../domain';
import { parseSurfaceGrantConfirm, parseSurfaceGrantPhrase } from './surface-grant-phrases';
import { SURFACE_GRANT_HELP_LINES, renderSurfaceAudienceLine, renderSurfaceStrongWarning } from './surface-grant-copy';
import { GRANTABLE_SURFACE_GROUPS, SURFACE_GROUPS } from './surface-groups';

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

describe('the `허용 실행` confirmation (D4.2, P2)', () => {
  const message = (text: string, extra: Partial<InboundMessage> = {}) => ({ text, ...extra }) as InboundMessage;
  it.each(['허용 실행', '허용실행', '  허용   실행 ', '허용 실행해줘', '허용 실행해 주세요', '허용 실행!'])('%s confirms', (text) => {
    expect(parseSurfaceGrantConfirm(message(text))).toBe(true);
  });
  it.each(['허용', '실행', '승인', '진행', '허용 실행할까?', '허용 실행 해제', '이 채널에 캘린더 허용', '`허용 실행`', '> 허용 실행', '허용 실행\n그리고'])('%s does not', (text) => {
    expect(parseSurfaceGrantConfirm(message(text))).toBe(false);
  });
  it('quoted, code-formatted or attachment-carrying messages never confirm', () => {
    expect(parseSurfaceGrantConfirm(message('허용 실행', { quotedRanges: [{ start: 0, end: 5 }] }))).toBe(false);
    expect(parseSurfaceGrantConfirm(message('허용 실행', { formatting: { code: true } }))).toBe(false);
    expect(parseSurfaceGrantConfirm(message('허용 실행', { attachments: [{ kind: 'text' } as never] }))).toBe(false);
  });
});

describe('the confirmation copy (D4.2 / D4.3)', () => {
  it('the audience line: an upper bound and the private flag, or the neutral line', () => {
    expect(renderSurfaceAudienceLine({ memberUpperBound: 30, restricted: true }, 'ko')).toBe('서버 인원 최대 30명 · 비공개 채널: 예');
    expect(renderSurfaceAudienceLine({ memberUpperBound: 30 }, 'ko')).toBe('서버 인원 최대 30명');
    expect(renderSurfaceAudienceLine(undefined, 'ko')).toBe('몇 명이 볼 수 있는지 확인하지 못했어요');
    expect(renderSurfaceAudienceLine({ memberUpperBound: -1 }, 'ko')).toBe('몇 명이 볼 수 있는지 확인하지 못했어요');
    expect(renderSurfaceAudienceLine({ memberUpperBound: 3, restricted: false }, 'en')).toBe('server members: at most 3 · private channel: no');
  });
  it('every strong group has a warning; the others none', () => {
    for (const id of GRANTABLE_SURFACE_GROUPS) {
      expect(renderSurfaceStrongWarning(id, 'ko') !== undefined, id).toBe(SURFACE_GROUPS[id].strong);
    }
  });
  it('the help lines name every phrase and stay within the help bound', () => {
    const joined = SURFACE_GRANT_HELP_LINES.join('\n');
    for (const phrase of ['이 채널에 캘린더 허용', '허용 실행', '이 채널 권한 보여줘', '허용 해제', '이 채널 권한 모두 해제', '채널 권한 목록', '모든 채널 권한 해제']) {
      expect(joined).toContain(phrase);
    }
    for (const line of SURFACE_GRANT_HELP_LINES) expect([...line].length).toBeLessThanOrEqual(120);
  });
});

describe('the denial hint names a phrase that works (D2.7, P2)', () => {
  it.each(GRANTABLE_SURFACE_GROUPS.map((id) => [id]))('"이 채널에 <%s label> 허용" parses to that group', (id) => {
    expect(parseSurfaceGrantPhrase(msg(`이 채널에 ${SURFACE_GROUPS[id].label.ko} 허용`))).toEqual({ kind: 'grant', groups: [id], unknown: [] });
  });
});
