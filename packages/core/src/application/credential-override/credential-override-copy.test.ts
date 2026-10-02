import { describe, expect, it } from 'vitest';
import type { CredentialOverrideInvalidationReason } from './credential-override';
import {
  credentialOverrideAlreadyUsed,
  credentialOverrideContentChanged,
  credentialOverrideDenied,
  credentialOverrideHardRefusalLine,
  credentialOverrideInvalidated,
  credentialOverrideNoPending,
  credentialOverridePrompt,
  credentialOverrideReprompt,
  credentialOverrideSentNotice,
} from './credential-override-copy';

const PATH = 'src/auth/user.ts';
const EMOJI = /\p{Extended_Pictographic}/u;
const REASONS: CredentialOverrideInvalidationReason[] = [
  'reset', 'denied', 'expired', 'project-changed', 'changed', 'superseded', 'inconsistent',
];

const allCopy = (): string[] => [
  credentialOverridePrompt(PATH, 12),
  credentialOverrideHardRefusalLine(),
  credentialOverrideReprompt(PATH, 60_000),
  credentialOverrideDenied(PATH),
  credentialOverrideContentChanged(PATH),
  credentialOverrideSentNotice([PATH]),
  credentialOverrideNoPending(),
  credentialOverrideAlreadyUsed(),
  ...REASONS.map((r) => credentialOverrideInvalidated(r)),
];

describe('credential-override copy (ADR-0097 D3/D7)', () => {
  it('the warning names file and line and states every consequence', () => {
    const text = credentialOverridePrompt(PATH, 12);
    expect(text).toContain(PATH);
    expect(text).toContain('12번째 줄');
    expect(text).toContain('"그래도 보내줘"');
    expect(text).toContain('외부 AI 서비스'); // external AI
    expect(text).toContain('되돌릴 수 없어요'); // cannot be recalled
    expect(text).toContain('diff'); // the diff may show the line
    expect(text).toContain('저장돼요'); // the proposal is stored locally
    expect(text).toContain('한 번'); // one time only
    expect(text).toContain('"취소"');
    expect(text).toContain('"새 대화"');
    expect(text).toContain('30분');
    expect(text).toContain('파일은 수정되지 않았어요');
  });

  it('the re-prompt says 승인 does not send and shows the remaining minutes (rounded up, never 0)', () => {
    const text = credentialOverrideReprompt(PATH, 20 * 60_000);
    expect(text).toContain(PATH);
    expect(text).toContain('"승인"');
    expect(text).toContain('보내지 않아요');
    expect(text).toContain('"그래도 보내줘"');
    expect(text).toContain('약 20분');
    expect(credentialOverrideReprompt(PATH, 1)).toContain('약 1분');
    expect(credentialOverrideReprompt(PATH, 0)).toContain('약 1분');
    expect(credentialOverrideReprompt(PATH, 61_000)).toContain('약 2분');
  });

  it('denial, content change and every invalidation say nothing was sent and the file was not modified', () => {
    expect(credentialOverrideDenied(PATH)).toContain(PATH);
    expect(credentialOverrideDenied(PATH)).toContain('보내지 않았');
    expect(credentialOverrideDenied(PATH)).toContain('수정되지 않았어요');
    expect(credentialOverrideContentChanged(PATH)).toContain(PATH);
    expect(credentialOverrideContentChanged(PATH)).toContain('다시 요청해 주세요');
    for (const reason of REASONS) {
      const text = credentialOverrideInvalidated(reason);
      expect(text).toContain('아무 파일도 AI에게 보내지 않았어요');
      expect(text).toContain('다시 요청해 주세요');
    }
    expect(credentialOverrideInvalidated('expired')).toContain('30분');
  });

  it('the sent notice lists the paths and says the send was one time only', () => {
    const text = credentialOverrideSentNotice(['src/a.ts', 'src/b.ts']);
    expect(text).toContain('src/a.ts, src/b.ts');
    expect(text).toContain('이번 한 번만');
  });

  it('the stray-phrase and already-used replies never claim a file was sent', () => {
    expect(credentialOverrideNoPending()).toContain('아무 파일도 보내지 않았어요');
    expect(credentialOverrideAlreadyUsed()).toContain('이미 한 번 사용');
    expect(credentialOverrideHardRefusalLine()).toContain('보낼 수 없어요');
  });

  it('is emoji-free and never carries content (the functions take only a path and a line)', () => {
    for (const text of allCopy()) {
      expect(text).not.toMatch(EMOJI);
      expect(text).not.toContain('demo-value');
      expect(text.trim().length).toBeGreaterThan(0);
    }
    expect(credentialOverridePrompt.length).toBe(2);
    expect(credentialOverrideReprompt.length).toBe(2);
  });
});
