import { describe, expect, it } from 'vitest';
import { CONNECTOR_WRITE_OPERATIONS } from '../../ports/connector-write.port';
import { NL_ACTION_ENTRY_IDS, NL_CATALOG_ENTRY_IDS } from '../nl-routing/catalog';
import { detectWorkChatCommand } from '../work-chat/work-chat-command';
import {
  STATE_BOUND_STEPS,
  surfaceClaimOf,
  surfaceGroupOfStateStep,
  surfaceGroupsOfApproval,
  surfaceGroupsOfSelection,
  surfaceGroupsOfWorkChatCommand,
  surfaceGroupsOfWriteOperation,
} from './surface-group-map';
import {
  DM_ONLY_SURFACE_GROUPS,
  GRANTABLE_SURFACE_GROUPS,
  SURFACE_GROUPS,
  SURFACE_GROUP_IDS,
  normalizeSurfaceGroupName,
  resolveSurfaceGroupAlias,
} from './surface-groups';

// ADR-0122 D1/D2: the closed group table and every map to it (exhaustive at compile time; pinned here at run time).

describe('the group table (D1)', () => {
  it('has 3 always, 11 grantable and 5 DM-only groups, each with a KO and EN label', () => {
    const byClass = (cls: string) => SURFACE_GROUP_IDS.filter((id) => SURFACE_GROUPS[id].class === cls);
    expect(byClass('always')).toEqual(['chat', 'help', 'control']);
    expect(GRANTABLE_SURFACE_GROUPS).toEqual(['jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code', 'writes']);
    expect(DM_ONLY_SURFACE_GROUPS).toEqual(['mail', 'drive', 'brief', 'nl-actions', 'agent']);
    expect(SURFACE_GROUP_IDS.filter((id) => SURFACE_GROUPS[id].strong)).toEqual(['jira-project', 'slack-search', 'code', 'writes']);
    for (const id of SURFACE_GROUP_IDS) {
      expect(SURFACE_GROUPS[id].label.ko.length).toBeGreaterThan(0);
      expect(SURFACE_GROUPS[id].label.en.length).toBeGreaterThan(0);
    }
  });

  it('aliases are unique across groups', () => {
    const seen = new Map<string, string>();
    for (const id of SURFACE_GROUP_IDS) {
      for (const alias of SURFACE_GROUPS[id].aliases) {
        const key = normalizeSurfaceGroupName(alias);
        expect(seen.get(key) ?? id, `${alias} is used twice`).toBe(id);
        seen.set(key, id);
      }
    }
  });

  it.each([
    ['Jira', 'jira-mine'],
    ['지라', 'jira-mine'],
    ['Jira 내 담당 조회', 'jira-mine'],
    ['JIRA 릴리스', 'jira-project'],
    ['Jira 프로젝트', 'jira-project'],
    ['jira 전체', 'jira-project'],
    ['GitHub 조회', 'github'],
    ['Slack 검색', 'slack-search'],
    ['슬랙', 'slack-search'],
    ['Confluence 검색', 'confluence'],
    ['캘린더 조회', 'calendar'],
    ['할 일', 'todo'],
    ['알림', 'reminder'],
    ['기억', 'memory'],
    ['코드 작업', 'code'],
    ['외부 쓰기(승인)', 'writes'],
    ['메일', 'mail'],
    ['드라이브', 'drive'],
    ['자연어 실행', 'nl-actions'],
  ] as const)('%s → %s', (name, id) => {
    expect(resolveSurfaceGroupAlias(name)).toBe(id);
  });

  it('an unknown name names no group', () => {
    expect(resolveSurfaceGroupAlias('전부')).toBeUndefined();
    expect(resolveSurfaceGroupAlias('')).toBeUndefined();
    expect(resolveSurfaceGroupAlias('조회')).toBeUndefined();
  });
});

describe('the selection map (D2.2): every catalog entry is mapped', () => {
  it('every wave-1 and action entry has at least one group; A6 entries are DM-only', () => {
    for (const entryId of NL_CATALOG_ENTRY_IDS) expect(surfaceGroupsOfSelection({ entryId, args: {} }).length, entryId).toBeGreaterThan(0);
    for (const entryId of NL_ACTION_ENTRY_IDS) expect(surfaceGroupsOfSelection({ entryId, args: {} }), entryId).toEqual(['nl-actions']);
    expect(surfaceGroupsOfSelection({ entryId: 'mail.list', args: {} })).toEqual(['mail']);
    expect(surfaceGroupsOfSelection({ entryId: 'drive.files', args: {} })).toEqual(['drive']);
    expect(surfaceGroupsOfSelection({ entryId: 'brief.today', args: {} })).toEqual(['brief']);
    expect(surfaceGroupsOfSelection({ entryId: 'help.topic', args: {} })).toEqual(['help']);
    // Interim P1 rule: the combined view needs all of its sources (the P2 permit filters instead).
    expect(surfaceGroupsOfSelection({ entryId: 'todo.list', args: {} })).toEqual(['todo', 'jira-mine', 'github']);
  });

  it.each([
    [{ scope: 'mine', release: '1.0' }, false, ['jira-mine']],
    [{ release: '1.0' }, false, ['jira-mine']],
    [{}, true, ['jira-mine']],
    [{ scope: 'all', release: '1.0' }, false, ['jira-project']],
    [{ scope: 'all' }, true, ['jira-project']],
    [{ project: 'OP26' }, false, ['jira-project']],
    [{}, false, ['jira-project']],
  ] as const)('jira.release %j (link: %s) → %j', (args, releaseLink, groups) => {
    expect(surfaceGroupsOfSelection({ entryId: 'jira.release', args }, { releaseLink })).toEqual(groups);
  });
});

describe('the work-command map (D2.1)', () => {
  it.each([
    ['할 일 추가: 보고서', ['todo']],
    ['완료 처리: 1', ['todo']],
    ['내 할 일 보여줘', ['todo', 'jira-mine', 'github']],
    ['내 Jira 이슈 보여줘', ['jira-mine']],
    ['GitHub 리뷰 요청 보여줘', ['github']],
    ['Slack에서 배포 검색', ['slack-search']],
    ['Confluence에서 배포 검색', ['confluence']],
    ['PROJ-1에 댓글: 확인했어요', ['writes', 'jira-mine']],
    ['#general에 게시: 배포 끝', ['writes', 'slack-search']],
  ] as const)('%s → %j', (text, groups) => {
    const command = detectWorkChatCommand(text);
    expect(command, text).not.toBeNull();
    expect(surfaceGroupsOfWorkChatCommand(command!)).toEqual(groups);
  });

  it('release commands follow the jira.release rows', () => {
    expect(surfaceGroupsOfWorkChatCommand({ kind: 'release', source: 'jira', scope: 'mine', release: '1.0', links: [] })).toEqual(['jira-mine']);
    expect(surfaceGroupsOfWorkChatCommand({ kind: 'release', source: 'jira', scope: 'all', release: '1.0', links: [] })).toEqual(['jira-project']);
    expect(surfaceGroupsOfWorkChatCommand({ kind: 'release', source: 'jira', scope: 'mine', project: 'OP26', links: [] })).toEqual(['jira-project']);
  });
});

describe('writes, state-bound steps and approvals', () => {
  it('every write operation needs `writes` and its service read group', () => {
    const expected: Record<string, string> = {
      ISSUE_COMMENT: 'jira-mine',
      ISSUE_TRANSITION: 'jira-mine',
      CHANNEL_POST: 'slack-search',
      CALENDAR_EVENT_CREATE: 'calendar',
      CALENDAR_EVENT_UPDATE: 'calendar',
      CALENDAR_EVENT_DELETE: 'calendar',
    };
    for (const operation of CONNECTOR_WRITE_OPERATIONS) expect(surfaceGroupsOfWriteOperation(operation)).toEqual(['writes', expected[operation]]);
  });

  it('PR status is `github`; every other state-bound step is `code`', () => {
    for (const step of STATE_BOUND_STEPS) expect(surfaceGroupOfStateStep(step), step).toBe(step === 'pr-status' ? 'github' : 'code');
  });

  it('approvals: code kinds are `code`; a write needs its family read group (all of them when unknown)', () => {
    for (const kind of ['PLAN', 'CREDENTIAL_OVERRIDE', 'APPLY', 'COMMIT', 'PUSH', 'PR', 'MERGE', 'REMOTE_BRANCH_CLEANUP'] as const) {
      expect(surfaceGroupsOfApproval(kind)).toEqual(['code']);
    }
    expect(surfaceGroupsOfApproval('CONNECTOR_WRITE', 'calendar')).toEqual(['writes', 'calendar']);
    expect(surfaceGroupsOfApproval('CONNECTOR_WRITE')).toEqual(['writes', 'jira-mine', 'slack-search', 'calendar']);
  });

  it('a claim always names at least one group', () => {
    expect(surfaceClaimOf(['todo'])).toEqual({ groups: ['todo'], onDeny: 'reply' });
    expect(surfaceClaimOf([], 'skip')).toEqual({ groups: ['code'], onDeny: 'skip' });
  });
});
