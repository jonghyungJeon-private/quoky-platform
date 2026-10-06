import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '../../domain';
import { GIT_BRANCH_HELP_LINE } from '../code-work/git-branch-command';
import { EXECUTION_PHRASES } from '../execution-command-guard';
import { REMINDER_HELP_LINES } from '../reminders/reminder-turn-handler';
import { ResponseComposer } from '../response-composer';
import { WORK_CHAT_LOOKUP_TURN_HELP_LINES, WORK_CHAT_TODO_TURN_HELP_LINES } from '../work-chat/work-chat-turn-handler';
import {
  CODE_CHAIN_STATUS_DOMAINS,
  INTERNAL_ACTION_DOMAINS,
  INTERNAL_ACTION_LEXICON_VERSION,
  INTERNAL_ACTION_VOCABULARY,
  detectInternalActionStatusTurn,
  isInternalActionDomain,
  noticeLanguage,
  renderInternalActionClaimNotice,
  renderInternalActionNotDone,
} from './internal-action-vocabulary';

const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };

describe('internal-action vocabulary inventory (ADR-0104 D3)', () => {
  it('covers exactly the ADR-0104 D1 domains, one complete row each, at lexicon version 1', () => {
    expect(INTERNAL_ACTION_LEXICON_VERSION).toBe(1);
    expect([...INTERNAL_ACTION_DOMAINS]).toEqual([
      'commit', 'push', 'pr', 'merge', 'branch', 'apply', 'todo', 'reminder', 'memory', 'connector-write',
    ]);
    expect(Object.keys(INTERNAL_ACTION_VOCABULARY).sort()).toEqual([...INTERNAL_ACTION_DOMAINS].sort());
    for (const domain of INTERNAL_ACTION_DOMAINS) {
      const entry = INTERNAL_ACTION_VOCABULARY[domain];
      expect(entry.domain).toBe(domain);
      for (const field of ['owner', 'nouns', 'koVerbs', 'enVerbs', 'notDoneKo', 'notDoneEn', 'commandKo', 'commandEn'] as const) {
        expect(entry[field].length, `${domain}.${field}`).toBeGreaterThan(0);
      }
      expect(entry.states.length, domain).toBeGreaterThan(0);
      expect(() => new RegExp(entry.nouns, 'iu')).not.toThrow();
    }
    expect(CODE_CHAIN_STATUS_DOMAINS.every((d) => isInternalActionDomain(d))).toBe(true);
    expect(isInternalActionDomain('calendar')).toBe(false);
  });

  it('every quoted command phrase is one the runtime or a handler actually accepts (help text, help lines, execution phrases)', () => {
    const composer = new ResponseComposer();
    const contributed = [GIT_BRANCH_HELP_LINE, ...WORK_CHAT_TODO_TURN_HELP_LINES, ...REMINDER_HELP_LINES, ...WORK_CHAT_LOOKUP_TURN_HELP_LINES];
    const accepted = [
      composer.composeHelp(CTX, contributed).text,
      ...Object.values(EXECUTION_PHRASES).flat(),
      composer.composeNoPushTarget(CTX).text,
      '승인',
    ].join('\n');
    for (const domain of INTERNAL_ACTION_DOMAINS) {
      const entry = INTERNAL_ACTION_VOCABULARY[domain];
      for (const line of [entry.commandKo, entry.commandEn]) {
        const quoted = [...line.matchAll(/"([^"]+)"/gu)].map((m) => m[1] as string);
        expect(quoted.length, `${domain}: ${line}`).toBeGreaterThan(0);
        for (const phrase of quoted) {
          expect(accepted.includes(`"${phrase}"`) || accepted.split('\n').includes(phrase), `${domain}: "${phrase}"`).toBe(true);
        }
      }
    }
  });

  it('renders the fixed KO/EN notices: nothing was done, the state was not checked, plus the exact command', () => {
    for (const domain of INTERNAL_ACTION_DOMAINS) {
      const ko = renderInternalActionClaimNotice(domain, 'ko');
      expect(ko.startsWith('이 답변으로 실행된 작업은 없어요.')).toBe(true);
      expect(ko).toContain('확인하지도 않았어요');
      expect(ko).toContain(INTERNAL_ACTION_VOCABULARY[domain].commandKo);
      const en = renderInternalActionClaimNotice(domain, 'en');
      expect(en.startsWith('Nothing was done by this reply')).toBe(true);
      expect(en).toContain(INTERNAL_ACTION_VOCABULARY[domain].commandEn);
    }
    for (const domain of CODE_CHAIN_STATUS_DOMAINS) {
      const ko = renderInternalActionNotDone(domain, 'ko');
      expect(ko).toContain(`Quoky는 ${INTERNAL_ACTION_VOCABULARY[domain].notDoneKo} 않았어요.`);
      expect(ko).not.toMatch(/맞습니다|맞아요|됐어요\./u);
      expect(renderInternalActionNotDone(domain, 'en')).toContain('did not check the repository');
    }
  });

  it('picks the notice language from the policy first, then the reply script, else Korean', () => {
    expect(noticeLanguage('en', '한국어 답변')).toBe('en');
    expect(noticeLanguage('ko', 'English reply')).toBe('ko');
    expect(noticeLanguage('unknown', 'English reply only')).toBe('en');
    expect(noticeLanguage(undefined, '👍')).toBe('ko');
  });
});

describe('detectInternalActionStatusTurn (ADR-0104 D3, QA-V2-W8-02)', () => {
  it.each([
    ['커밋했어', 'commit'],
    ['커밋됐어?', 'commit'],
    ['커밋 됐나요?', 'commit'],
    ['커밋 완료', 'commit'],
    ['혹시 커밋 다 됐어?', 'commit'],
    ['did you commit?', 'commit'],
    ['푸시했어', 'push'],
    ['푸시 완료했어', 'push'],
    ['push 했어?', 'push'],
    ['did you push it?', 'push'],
    ['PR 만들었어?', 'pr'],
    ['PR 만들어졌어?', 'pr'],
    ['PR 생성됐나요?', 'pr'],
    ['has the PR been created?', 'pr'],
    ['머지됐어?', 'merge'],
    ['PR 머지됐어?', 'merge'],
    ['병합 완료됐어?', 'merge'],
    ['is it merged?', 'merge'],
    ['브랜치 삭제했어', 'branch'],
    ['브랜치 정리 완료', 'branch'],
    ['브랜치 지웠어', 'branch'],
    ['원격 브랜치 삭제됐어?', 'branch'],
    ['is the branch deleted?', 'branch'],
  ] as const)('%j → %s', (text, domain) => {
    expect(detectInternalActionStatusTurn(text)).toBe(domain);
  });

  it.each([
    'git push가 뭐야?',
    '푸시해줘',
    '커밋해줘',
    '커밋 실행',
    '커밋했으면 푸시해줘',
    '커밋 안 했어',
    '커밋 메시지 어떻게 써?',
    '푸시 알림 설정하는 법 알려줘',
    '브랜치 만들어줘 feature/x',
    '브랜치 삭제해줘 feature/x',
    '브랜치 만들었어?',
    'PR 했어',
    '보고서 초안 쓰기 완료',
    '알림 설정했어?',
    '할 일 추가됐어?',
    'did you remember?',
    'is it done?',
    '',
    '커밋했어\n그리고 푸시해줘',
    `${'커밋 '.repeat(20)}했어`,
  ])('%j is not a code-chain status turn', (text) => {
    expect(detectInternalActionStatusTurn(text)).toBeNull();
  });
});
