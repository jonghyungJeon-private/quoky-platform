import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootR2Harness, none, pick, type R2Harness } from './a6-r2-harness';

/**
 * Owner decisions of 2026-10-22, offline acceptance: the REAL `AppModule` over a REAL SQLite file, the REAL Jira adapter
 * behind a scripted `fetch`, a scripted selector.
 *  - B: a Jira project reached only by a near match is confirmed ("'… (OP26)' 프로젝트가 맞나요?"); a yes shows its release
 *    list with no selector call, a no ends the question.
 *  - A: a general help question about a named source asks Quoky or the app itself; "1" is Quoky's help, "2" a fixed note.
 */

describe('read residuals (owner decisions A and B, 2026-10-22)', () => {
  let h: R2Harness;

  beforeAll(async () => {
    h = await bootR2Harness({});
    h.jiraProjects = [
      { key: 'APPOP', name: '차란차 플랫폼 APP운영' },
      { key: 'OP25', name: '차란차 플랫폼 운영 2025' },
      { key: 'OP26', name: '차란차 플랫폼 운영 2026' },
    ];
    h.jiraVersions = { OP26: [{ id: '16591', name: '배포일_20261020(화)' }, { id: '16555', name: '배포일_20261015(목)', released: true }] };
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('B: the near project is confirmed first; a yes lists its releases without another selector call', async () => {
    const asked = await h.turn('차란차 운영 2026 릴리스 뭐뭐 있어?', pick('jira.release', { project: '차란차 운영 2026' }));
    expect(asked.text).toContain("'차란차 플랫폼 운영 2026 (OP26)' 프로젝트가 맞나요? (응 / 아니)");
    expect(h.fetched.some((url) => url.includes('/project/OP26/version'))).toBe(false);
    expect((await h.sessionMetadata())['quoky.nlPending']).toMatchObject({ kind: 'entry', confirm: true, options: [{ entryId: 'jira.release', args: { project: 'OP26' } }] });
    const yes = await h.turn('응', none);
    expect(yes.selects).toHaveLength(0);
    expect(yes.text).toContain('**차란차 플랫폼 운영 2026 (OP26) 릴리스**');
    expect(yes.text).toContain('배포일_20261015(목)');
  });

  it('B: the selector split of the same words reaches the same question; a no ends it politely', async () => {
    const asked = await h.turn('차란차 운영 2026 릴리스 뭐뭐 있어?', pick('jira.release', { project: '차란차 운영', release: '2026' }));
    expect(asked.text).toContain("'차란차 플랫폼 운영 2026 (OP26)' 프로젝트가 맞나요?");
    const no = await h.turn('아니', none);
    expect(no.selects).toHaveLength(0);
    expect(no.text).toContain('선택을 취소했어요');
    expect((await h.sessionMetadata())['quoky.nlPending']).toBeUndefined();
  });

  it('A: "how to search in Slack" asks Quoky or the app; "2" is the fixed app note, "1" Quoky help', async () => {
    const asked = await h.turn('슬랙에서 검색하는 방법 알려줘', pick('help.topic'));
    expect(asked.text).toContain('Quoky로 슬랙을 조회하는 방법을 물으신 건가요, 아니면 슬랙 앱 자체의 사용법인가요?');
    const app = await h.turn('2', none);
    expect(app.selects).toHaveLength(0);
    expect(app.text).toBe('그건 슬랙 앱 자체의 사용법이라 제가 안내해 드리긴 어려워요. 슬랙의 도움말을 확인해 주세요.');
    await h.turn('슬랙에서 검색하는 방법 알려줘', pick('help.topic'));
    const quoky = await h.turn('1', none);
    expect(quoky.selects).toHaveLength(0);
    expect(quoky.text).not.toContain('앱 자체');
    expect(quoky.text.length).toBeGreaterThan(0);
  });
});
