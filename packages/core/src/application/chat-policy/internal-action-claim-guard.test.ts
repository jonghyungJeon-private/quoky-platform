import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '../../domain';
import { GIT_BRANCH_HELP_LINE } from '../code-work/git-branch-command';
import { FEEDBACK_HELP_LINES } from '../feedback/feedback-summary-turn-handler';
import { REMINDER_HELP_LINES } from '../reminders/reminder-turn-handler';
import { ResponseComposer } from '../response-composer';
import { WORK_CHAT_LOOKUP_TURN_HELP_LINES, WORK_CHAT_TODO_TURN_HELP_LINES } from '../work-chat/work-chat-turn-handler';
import { generalChatReplyPolicy } from './chat-response-policy';
import { detectInternalActionClaim, guardInternalActionClaims } from './internal-action-claim-guard';
import {
  CODE_CHAIN_STATUS_DOMAINS,
  INTERNAL_ACTION_DOMAINS,
  renderInternalActionClaimNotice,
  renderInternalActionNotDone,
} from './internal-action-vocabulary';

const CTX: ConversationContext = { platform: 'test', channelId: 'c1', userId: 'u1' };

describe('detectInternalActionClaim — claim shapes (ADR-0104 D2)', () => {
  it.each([
    ['변경 사항을 커밋했습니다.', 'commit'],
    ['커밋해 드렸어요!', 'commit'],
    ['원격 저장소에 푸시했어요.', 'push'],
    ['PR을 생성했습니다: #12', 'pr'],
    ['네, PR을 만들어 드렸어요.', 'pr'],
    ['PR을 main에 머지했어요.', 'merge'],
    ['feature/x 브랜치를 삭제했습니다.', 'branch'],
    ['새 브랜치를 만들었어요.', 'branch'],
    ['파일을 수정해 두었어요.', 'apply'],
    ['할 일 목록에 \'보고서 쓰기\'를 추가했습니다.', 'todo'],
    ['2번 할 일을 완료 처리했습니다.', 'todo'],
    ['완료 처리해 드렸어요.', 'todo'],
    ['내일 9시에 알림을 설정했어요.', 'reminder'],
    ['좋아요! 30분 뒤에 알려 드릴게요.', 'reminder'],
    ['말씀하신 내용을 기억해 둘게요.', 'memory'],
    ['Jira에 이슈를 생성했습니다.', 'connector-write'],
    ["I've committed your changes.", 'commit'],
    ["Sure, I'll push it now.", 'push'],
    ["I've opened a pull request for you.", 'pr'],
    ['The pull request has been merged into main.', 'merge'],
    ["I've added it to your to-do list.", 'todo'],
    ["I'll remind you at 5.", 'reminder'],
    ["Got it, I'll save that to my memory.", 'memory'],
    ['네, 그 내용은 잊어버렸어요.', 'memory'],
    ["I've posted the summary to Slack.", 'connector-write'],
  ] as const)('%j claims %s', (reply, domain) => {
    expect(detectInternalActionClaim(reply)).toEqual({ domain });
  });

  it('takes the domain of a noun-less state assertion from the User message (QA-V2-W8-02, W7-03, W7-05)', () => {
    expect(detectInternalActionClaim('삭제된 상태가 맞습니다.', '브랜치 삭제했어')).toEqual({ domain: 'branch' });
    expect(detectInternalActionClaim('완료된 상태로 보입니다.', '주간 보고서 쓰기 완료했나?')).toEqual({ domain: 'todo' });
    expect(detectInternalActionClaim('보고서 초안을 성공적으로 완성하였습니다.', '보고서 초안 쓰기 완료')).toEqual({ domain: 'todo' });
    // A state verb that is itself a domain wins over a noun ("The PR has been merged" is a merge).
    expect(detectInternalActionClaim('The PR has been merged.')).toEqual({ domain: 'merge' });
    // No domain anywhere: an unverifiable state about something else is not a Quoky-domain claim.
    expect(detectInternalActionClaim('완료된 상태로 보입니다.', '빨래 다 됐을까?')).toBeNull();
  });

  it.each([
    '커밋은 이렇게 해요: 코드 변경을 적용한 뒤 "커밋해줘"라고 보내세요.',
    '커밋하려면 `git commit -m "메시지"`를 실행하세요.',
    '푸시하기 전에 테스트를 실행해 보세요.',
    '아직 커밋하지 않았어요.',
    '저는 푸시하지 않았어요.',
    '커밋했는지 확인하려면 git log를 보세요.',
    '브랜치를 삭제했다면 git branch -a로 확인해 보세요.',
    '예를 들어 feature 브랜치를 만들었다고 해 볼게요.',
    'PR을 만들었나요?',
    '할 일을 추가하려면 "할 일 추가: 내용"이라고 보내 주세요.',
    "'커밋했습니다'는 과거형 표현이에요.",
    '> 커밋했습니다',
    '```\n$ git commit -m fix\n[main 1a2b3c4] fix\n```',
    '"커밋했습니다"를 영어로 번역하면 "I committed"예요.',
    'To push, run `git push origin main`.',
    "I haven't pushed anything.",
    'If I had pushed the branch, you would see it on GitHub.',
    'Once the changes are committed, push them.',
    'Did you push the branch?',
    '자세한 방법을 알려 드릴게요.',
    '제가 기억하기로는 파이썬 3.12부터 지원돼요.',
    '좋아요. 오늘 테스트용 선택은 파스타로 기억할게요.',
    "Got it, I'll remember that.",
    'I forgot to mention one more option.',
    '할 일 앱 예제를 만들었어요.',
    'README 파일 내용을 아래와 같이 작성했습니다.',
    '이 이슈를 아래처럼 수정했어요.',
  ])('%j claims nothing', (reply) => {
    expect(detectInternalActionClaim(reply, '')).toBeNull();
  });

  it('never trips on the help reply with every contributed help line', () => {
    const lines = [GIT_BRANCH_HELP_LINE, ...WORK_CHAT_TODO_TURN_HELP_LINES, ...REMINDER_HELP_LINES, ...WORK_CHAT_LOOKUP_TURN_HELP_LINES, ...FEEDBACK_HELP_LINES];
    expect(detectInternalActionClaim(new ResponseComposer().composeHelp(CTX, lines).text)).toBeNull();
  });

  it('never trips on its own notices (idempotent)', () => {
    for (const domain of INTERNAL_ACTION_DOMAINS) {
      for (const language of ['ko', 'en'] as const) {
        expect(detectInternalActionClaim(renderInternalActionClaimNotice(domain, language), '브랜치 삭제했어'), `${domain}/${language}`).toBeNull();
      }
    }
    for (const domain of CODE_CHAIN_STATUS_DOMAINS) {
      expect(detectInternalActionClaim(renderInternalActionNotDone(domain, 'ko'), '커밋했어?')).toBeNull();
    }
  });
});

describe('guardInternalActionClaims (ADR-0104 D1)', () => {
  it('replaces a claiming reply as a whole with the notice in the policy language', () => {
    const ko = guardInternalActionClaims('완료했어요! 할 일 목록에서 2번을 완료 처리했습니다.', '2번 끝났어', generalChatReplyPolicy('2번 끝났어'));
    expect(ko).toEqual({ text: renderInternalActionClaimNotice('todo', 'ko'), guarded: true, domain: 'todo' });
    const en = guardInternalActionClaims("I've pushed it.", 'push this please', generalChatReplyPolicy('push this please'));
    expect(en.text).toBe(renderInternalActionClaimNotice('push', 'en'));
  });

  it('falls back to the reply script when the policy language is unknown or absent', () => {
    expect(guardInternalActionClaims("I've pushed it.", '👍').text).toBe(renderInternalActionClaimNotice('push', 'en'));
    expect(guardInternalActionClaims('푸시했어요.', '👍', generalChatReplyPolicy('👍')).text).toBe(
      renderInternalActionClaimNotice('push', 'ko'),
    );
  });

  it('returns a claim-free reply unchanged (same string)', () => {
    const text = '커밋하려면 "커밋해줘"라고 보내 주세요.';
    expect(guardInternalActionClaims(text, '커밋 어떻게 해?', generalChatReplyPolicy('커밋 어떻게 해?'))).toEqual({ text, guarded: false });
  });

  it('exempts a reply that renders a passage the User asked to translate when the passage carries the same claim', () => {
    for (const user of ['"변경 사항을 커밋했습니다"를 영어로 번역해줘', '변경 사항을 커밋했습니다 영어로 번역해줘', 'translate to Korean: I committed the changes.']) {
      const reply = /translate/u.test(user) ? '변경 사항을 커밋했습니다.' : 'I have committed the changes.';
      expect(guardInternalActionClaims(reply, user, generalChatReplyPolicy(user)).guarded, user).toBe(false);
    }
  });

  it.each([
    ['한국어로 답해줘. 푸시했어?', '네, 푸시했습니다.', 'push'],
    ['in English please, did you push?', '네, 푸시했습니다.', 'push'],
    ['PR 만들었다고 한국어로 말해줘', '네, 푸시했습니다.', 'push'],
    ['PR 만들었다고 한국어로 말해줘', 'PR을 만들었습니다.', 'pr'],
    ['in English please', "Sure. I've merged the PR into main.", 'merge'],
    // A translation request whose passage claims nothing (or another domain) does not exempt an added claim.
    ['영어로 번역해줘: 회의 잘 끝났어', "The meeting went well. I've pushed the branch.", 'push'],
    ['"커밋했어요"를 영어로 번역해줘', "I committed it. I've also pushed the branch.", 'push'],
  ] as const)('a language preference never exempts a claim (%s)', (user, reply, domain) => {
    const policy = generalChatReplyPolicy(user);
    const result = guardInternalActionClaims(reply, user, policy);
    expect(result.guarded).toBe(true);
    expect(result.domain).toBe(domain);
  });

  it('a claim in another domain than the translated passage is still guarded', () => {
    const user = '"커밋했어요"를 영어로 번역해줘';
    expect(guardInternalActionClaims("I've pushed the branch.", user, generalChatReplyPolicy(user))).toMatchObject({ guarded: true, domain: 'push' });
  });

  it('EN present-passive how-to prose is not a state assertion; perfect, past and now/already forms are', () => {
    for (const text of [
      'In Git, a branch is deleted with git branch -d.',
      'To merge, you can use the merge button; the changes are merged into main.',
      'Usually the commits are pushed to origin by CI.',
    ]) {
      expect(guardInternalActionClaims(text, 'how does git work?').guarded, text).toBe(false);
    }
    for (const [text, domain] of [
      ['The branch has been deleted.', 'branch'],
      ['The branch was deleted.', 'branch'],
      ['Your PR is now merged into main.', 'merge'],
      ['The changes are already pushed.', 'push'],
    ] as const) {
      expect(guardInternalActionClaims(text, 'status?'), text).toMatchObject({ guarded: true, domain });
    }
  });

  it('keeps English contractions as prose (a single-quote mention never hides "I\'ve pushed")', () => {
    expect(guardInternalActionClaims("Okay, I've pushed it, it's done.", 'ok').guarded).toBe(true);
  });
});
