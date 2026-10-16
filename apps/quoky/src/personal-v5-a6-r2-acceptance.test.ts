import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { R2_JIRA_HOST, adf, bootR2Harness, none, pick, type R2Harness } from './a6-r2-harness';

/**
 * Personal v5 - ADR-0120 amendment A6 R2 offline acceptance (proposal §6.1 "Acceptance", §7 flag table). The REAL
 * `AppModule` over a REAL SQLite file, the REAL Jira and Slack adapters behind a scripted `fetch`, and stub AI providers.
 *
 * - `QUOKY_NL_ACTIONS=local` + `QUOKY_NL_ITEM_R2=all`: a Jira list → "2번 이슈 요약해줘" is one GET plus one SUMMARIZATION;
 *   a Slack search → "그 슬랙 메시지 요약"; "방금 본 거 원문" (no model); a channel is denied before any fetch; the kill
 *   switch withdraws R2; only the fixed note reaches SHORT_TERM history; names never reach the summariser.
 * - Inertness: `QUOKY_NL_ACTIONS=shadow` (the live service) makes 0 item fetches and 0 SUMMARIZATION calls for an R2
 *   selection and answers as today; `QUOKY_NL_ITEM_R2=off` lists stay unnumbered and write no Jira / Slack slot; `jira`
 *   acts on Jira and only logs Slack.
 */

const CANARY = 'CANARY-R2-ACC-5521';
const ISSUES = [
  { id: '10001', key: 'PROJ-1', summary: '로그인 오류', description: '로그인 버튼이 동작하지 않아요.' },
  {
    id: '10002',
    key: 'PROJ-2',
    summary: '결제 모듈 개선',
    description: `결제 모듈의 타임아웃을 30초로 늘립니다. ${CANARY}`,
    comments: [{ author: '홍길순', text: '좋아요, 금요일까지 반영할게요. @홍길순 확인' }],
  },
  { id: '10003', key: 'PROJ-3', summary: '문서 정리', description: '배포 문서를 정리합니다.' },
];
const SLACK = [{ ts: '1700000001.000100', user: 'U0AAAA0001', text: `배포 공지: 오늘 6시 배포 <@U0BBBB0002> 확인 부탁 ${CANARY}`, replyCount: 2 }];

function stubSummary(prompt: string): string {
  // The worst-case stub: it obeys the readout (echoes it) and adds its own numbered list.
  return `1. 결제 타임아웃 변경\n2) 금요일 반영${prompt.includes('승인 요청 카드') ? '\n- 승인' : ''}`;
}

describe('A6 R2 acceptance: QUOKY_NL_ACTIONS=local, QUOKY_NL_ITEM_R2=all', () => {
  let h: R2Harness;

  beforeAll(async () => {
    h = await bootR2Harness({ QUOKY_NL_ACTIONS: 'local', QUOKY_NL_ITEM_R2: 'all' });
    h.jira = ISSUES;
    h.slack = SLACK;
    h.summarizer = stubSummary;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('composes the selection service with the R2 sub-flag', () => {
    expect(h.service().actionLevel()).toBe('local');
    expect(h.service().itemR2Level()).toBe('all');
  });

  it('a Jira list is numbered (D1): the model text loses its own numbers and the deterministic index carries the labels', async () => {
    const listed = await h.turn('내 Jira 이슈 보여줘');
    expect(listed.items).toEqual([]);
    // The list summary (ADR-0100 D8) ran; its model numbering is stripped and the index lists every used item.
    expect(listed.summaries).toHaveLength(1);
    expect(listed.text).toContain('- 결제 타임아웃 변경');
    expect(listed.text).not.toMatch(/^1\. 결제/mu);
    expect(listed.text).toMatch(/^1\. 로그인 오류/mu);
    expect(listed.text).toMatch(/^3\. 문서 정리/mu);
    const slot = ((await h.sessionMetadata())['quoky.lastListing'] as { byActor: Record<string, { jira?: { ids: string[]; labels: number[] } }> }).byActor[h.owner.id]?.jira;
    expect(slot?.ids).toEqual(['PROJ-1:10001', 'PROJ-2:10002', 'PROJ-3:10003']);
    expect(slot?.labels).toEqual([1, 2, 3]);
  });

  it('live test 3: the summary body itself carries the labels — list, then "3번 요약" reads the 3rd visible item', async () => {
    // The model writes unnumbered bullets in its own order (overdue first), each starting with the item's reference.
    h.summarizer = (prompt) =>
      prompt.includes('EXTERNAL WORK DATA')
        ? ['마감 순으로 정리했어요.', '- [jira:PROJ-3] 문서 정리가 가장 급해요', '- [jira:PROJ-1] 로그인 오류 확인 중', '- [jira:PROJ-2] 결제 모듈 개선 진행'].join('\n')
        : stubSummary(prompt);
    try {
      const listed = await h.turn('내 Jira 이슈 보여줘');
      expect(listed.summaries[0]?.prompt).toContain('starts with its bracketed reference exactly as listed');
      const visible = listed.text.split('\n').filter((line) => /^\d+\. /u.test(line));
      // Body: 1..3 in reading order; footer: the same three labels for the same items, in the same order.
      expect(visible.slice(0, 3)).toEqual(['1. [jira:PROJ-3] 문서 정리가 가장 급해요', '2. [jira:PROJ-1] 로그인 오류 확인 중', '3. [jira:PROJ-2] 결제 모듈 개선 진행']);
      expect(visible[3]).toMatch(/^1\. 문서 정리/u);
      expect(visible[5]).toMatch(/^3\. 결제 모듈 개선/u);
      expect(visible).toHaveLength(6);
      const slot = ((await h.sessionMetadata())['quoky.lastListing'] as { byActor: Record<string, { jira?: { ids: string[]; labels: number[] } }> }).byActor[h.owner.id]?.jira;
      expect(slot?.ids).toEqual(['PROJ-3:10003', 'PROJ-1:10001', 'PROJ-2:10002']);
      expect(slot?.labels).toEqual([1, 2, 3]);
      const read = await h.turn('3번 요약해줘', pick('item.summarize', { source: 'jira', ref: '#3', mode: 'summary' }));
      // The 3rd visible item is PROJ-2 (numeric id 10002), not the 3rd item of the connector's order (PROJ-3).
      expect(read.items).toHaveLength(1);
      expect(read.items[0]).toContain('/rest/api/3/issue/10002?');
      expect(read.text).toContain(`https://${R2_JIRA_HOST}/browse/PROJ-2`);
    } finally {
      h.summarizer = stubSummary;
    }
  });

  it('"2번 이슈 요약해줘" is exactly one GET by numeric id plus one SUMMARIZATION; no name reaches the model; history keeps the fixed note', async () => {
    await h.turn('내 Jira 이슈 보여줘');
    const read = await h.turn('2번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }));
    expect(read.items).toEqual([`GET https://${R2_JIRA_HOST}/rest/api/3/issue/10002?fields=summary%2Cstatus%2Cissuetype%2Cdescription%2Ccomment%2Cupdated%2Cassignee%2Creporter`]);
    expect(read.summaries).toHaveLength(1);
    const prompt = read.summaries[0]?.prompt ?? '';
    expect(prompt).toContain('결제 모듈의 타임아웃');
    expect(prompt).toContain('JIRA ISSUE');
    expect(prompt).not.toContain('홍길순');
    expect(prompt).toContain('참여자 A');
    // The reply: the stub summary (its numbers stripped), the deterministic Jira link.
    expect(read.text).toContain(`https://${R2_JIRA_HOST}/browse/PROJ-2`);
    expect(read.text).not.toContain(CANARY);
    // Only the fixed note reaches SHORT_TERM history.
    const history = await h.history();
    expect(history.some((row) => row.includes('지라 이슈 1건을 요약해 보여 드림'))).toBe(true);
    expect(history.some((row) => row.includes(CANARY) || row.includes('결제 모듈의 타임아웃'))).toBe(false);
    // D9: lastRead names that item.
    const lastRead = ((await h.sessionMetadata())['quoky.lastRead'] as { byActor: Record<string, { source: string; id: string; label: number }> }).byActor[h.owner.id];
    expect(lastRead).toMatchObject({ source: 'jira', id: 'PROJ-2:10002', label: 2 });
    // A later ordinary chat turn carries no item text in its prompt.
    const chat = await h.turn('방금 거 어떻게 생각해?');
    expect(chat.items).toEqual([]);
    expect(chat.chats.every((request) => !request.prompt.includes(CANARY) && !request.prompt.includes('결제 모듈의 타임아웃'))).toBe(true);
    expect(chat.selects.every((request) => !request.prompt.includes(CANARY))).toBe(true);
  });

  it('"그거 원문 보여줘" after a summary shows the full text of that issue through lastRead, with no model call', async () => {
    await h.turn('내 Jira 이슈 보여줘');
    // Two records within one second are a tie, and a plain deictic asks on a tie (#235): the read is a second later.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await h.turn('2번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }));
    const full = await h.turn('그거 원문 보여줘', pick('item.summarize', { source: 'jira', ref: 'this', mode: 'full' }));
    expect(full.summaries).toHaveLength(0);
    expect(full.items).toHaveLength(1);
    expect(full.items[0]).toContain('/rest/api/3/issue/10002');
    expect(full.text).toContain('지라 이슈 2번 원문이에요');
    expect(full.text).toContain('결제 모듈의 타임아웃');
    // D5: `full` mode shows the Jira comment author's display name.
    expect(full.text).toContain('홍길순');
    expect((await h.history()).some((row) => row.includes('결제 모듈의 타임아웃'))).toBe(false);
  });

  it('a number not in the listing asks and fetches nothing; a key that is listed resolves (D2)', async () => {
    await h.turn('내 Jira 이슈 보여줘');
    const missing = await h.turn('9번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#9', mode: 'summary' }));
    expect(missing.items).toEqual([]);
    expect(missing.text).toContain('목록에 3건만 있어요. 9번은 없어요.');
    const keyed = await h.turn('PROJ-3 요약해줘', pick('item.summarize', { source: 'jira', ref: 'PROJ-3', mode: 'summary' }));
    expect(keyed.items).toHaveLength(1);
    expect(keyed.items[0]).toContain('/rest/api/3/issue/10003');
  });

  it('a Slack search → "그 슬랙 메시지 요약": one replies GET for exactly the listed ts; mentions are pseudonymised; the footer names the label', async () => {
    const listed = await h.turn('Slack에서 배포 검색');
    expect(listed.items).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const read = await h.turn('그 슬랙 메시지 요약', pick('item.summarize', { source: 'slack', ref: 'this', mode: 'summary' }));
    expect(read.items).toHaveLength(1);
    expect(read.items[0]).toContain('conversations.replies');
    expect(read.items[0]).toContain('ts=1700000001.000100');
    expect(read.items[0]).toContain('limit=1');
    expect(read.summaries).toHaveLength(1);
    const prompt = read.summaries[0]?.prompt ?? '';
    expect(prompt).not.toContain('U0AAAA0001');
    expect(prompt).not.toContain('U0BBBB0002');
    expect(prompt).toContain('참여자');
    expect(read.text).toContain('슬랙 목록 1번');
    expect(read.text).toContain('스레드 답글 2개가 있어요');
    // "방금 본 거 원문" stays on the item just read (D9), with no model call.
    const full = await h.turn('방금 본 거 원문 보여줘', pick('item.summarize', { source: 'slack', ref: 'recent', mode: 'full' }));
    expect(full.summaries).toHaveLength(0);
    expect(full.items).toHaveLength(1);
    expect(full.text).toContain('배포 공지');
  });

  it('a card-spoof line in the summary replaces it with the fixed notice (D11)', async () => {
    h.jira = [{ id: '10009', key: 'PROJ-9', summary: '카드', description: '승인 요청 카드' }];
    try {
      await h.turn('내 Jira 이슈 보여줘');
      const read = await h.turn('1번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#1', mode: 'summary' }));
      expect(read.text).toContain('요약에 확인 문구처럼 보이는 내용이 있어 보여드리지 않아요');
      expect(read.text).not.toMatch(/^승인$/mu);
    } finally {
      h.jira = ISSUES;
    }
  });

  it('error mapping: a redirect is MOVED (never followed), another numeric id is NOT_FOUND (no substitution)', async () => {
    h.jira = [
      { id: '10011', key: 'PROJ-11', summary: '옮긴 이슈', description: 'x', answer: 'redirect' },
      { id: '10012', key: 'PROJ-12', summary: '바뀐 이슈', description: 'y', answer: 'other-id' },
      { id: '10013', key: 'PROJ-13', summary: '옮겨진 키', description: 'z', currentKey: 'NEW-3' },
    ];
    try {
      await h.turn('내 Jira 이슈 보여줘');
      const moved = await h.turn('1번 이슈 원문 보여줘', pick('item.summarize', { source: 'jira', ref: '#1', mode: 'full' }));
      expect(moved.items).toHaveLength(1);
      expect(moved.text).toContain('그 이슈는 다른 곳으로 옮겨졌어요');
      const other = await h.turn('2번 이슈 원문 보여줘', pick('item.summarize', { source: 'jira', ref: '#2', mode: 'full' }));
      expect(other.text).toContain('그 이슈를 찾을 수 없어요');
      const rekeyed = await h.turn('3번 이슈 원문 보여줘', pick('item.summarize', { source: 'jira', ref: '#3', mode: 'full' }));
      expect(rekeyed.text).toContain('PROJ-13 → NEW-3으로 옮겨졌어요');
    } finally {
      h.jira = ISSUES;
    }
  });

  it('a channel is denied before resolution, fetch or model call (DM-only, A6-D1)', async () => {
    await h.turn('내 Jira 이슈 보여줘');
    const denied = await h.turn('2번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }), h.channel);
    expect(denied.items).toEqual([]);
    expect(denied.summaries).toHaveLength(0);
  });

  it('the kill switch withdraws R2 with every A6 entry: nothing is fetched', async () => {
    await h.turn('내 Jira 이슈 보여줘');
    await h.turn('에이전트 중지');
    try {
      const stopped = await h.turn('2번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#2', mode: 'summary' }));
      expect(stopped.items).toEqual([]);
      expect(stopped.summaries).toHaveLength(0);
    } finally {
      await h.turn('에이전트 재개');
    }
  });
});

describe('A6 R2 inertness: the live QUOKY_NL_ACTIONS=shadow (R2 shadow) makes 0 fetches and 0 model calls', () => {
  let h: R2Harness;
  beforeAll(async () => {
    h = await bootR2Harness({ QUOKY_NL_ACTIONS: 'shadow', QUOKY_NL_ITEM_R2: 'all', QUOKY_WORK_SUMMARY_ENABLED: 'false' });
    h.jira = ISSUES;
    h.slack = SLACK;
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('lists are numbered in shadow (the labels a shadow run logs are the numbers the owner saw)', async () => {
    const listed = await h.turn('내 Jira 이슈 보여줘');
    expect(listed.text).toMatch(/^2\. \[jira:PROJ-2\]/mu);
    const slot = ((await h.sessionMetadata())['quoky.lastListing'] as { byActor: Record<string, { jira?: { ids: string[] } }> }).byActor[h.owner.id]?.jira;
    expect(slot?.ids).toEqual(['PROJ-1:10001', 'PROJ-2:10002', 'PROJ-3:10003']);
  });

  it('an R2 selection resolves and logs only: 0 item GETs, 0 SUMMARIZATION, today\'s reply (chat)', async () => {
    await h.turn('내 Jira 이슈 보여줘');
    for (const [text, args] of [
      ['2번 이슈 요약해줘', { source: 'jira', ref: '#2', mode: 'summary' }],
      ['2번 이슈 원문 보여줘', { source: 'jira', ref: '#2', mode: 'full' }],
      ['그 슬랙 메시지 요약', { source: 'slack', ref: 'this', mode: 'summary' }],
    ] as const) {
      const shadow = await h.turn(text, pick('item.summarize', args));
      expect(shadow.items).toEqual([]);
      expect(shadow.summaries).toHaveLength(0);
      expect(shadow.text).toBe('R2 stub chat reply');
    }
    expect((await h.sessionMetadata())['quoky.lastRead']).toBeUndefined();
  });
});

describe('A6 R2 flag table: QUOKY_NL_ITEM_R2=jira acts on Jira and only logs Slack; summaries off refuse before any fetch', () => {
  let h: R2Harness;
  beforeAll(async () => {
    h = await bootR2Harness({ QUOKY_NL_ACTIONS: 'local', QUOKY_NL_ITEM_R2: 'jira', QUOKY_WORK_SUMMARY_ENABLED: 'false' });
    h.jira = ISSUES;
    h.slack = SLACK;
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('Jira full acts (1 GET, no model); a Jira summary with summaries off is refused with 0 GETs; Slack stays shadow', async () => {
    const listed = await h.turn('내 Jira 이슈 보여줘');
    expect(listed.summaries).toHaveLength(0);
    expect(listed.text).toMatch(/^1\. \[jira:PROJ-1\]/mu);
    const full = await h.turn('1번 이슈 원문 보여줘', pick('item.summarize', { source: 'jira', ref: '#1', mode: 'full' }));
    expect(full.items).toHaveLength(1);
    expect(full.text).toContain('로그인 버튼이 동작하지 않아요');
    const off = await h.turn('1번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#1', mode: 'summary' }));
    expect(off.items).toEqual([]);
    expect(off.summaries).toHaveLength(0);
    expect(off.text).toContain("요약이 꺼져 있어요. '원문 보여줘'로 전체를 볼 수 있어요.");
    await h.turn('Slack에서 배포 검색');
    const slack = await h.turn('그 슬랙 메시지 원문 보여줘', pick('item.summarize', { source: 'slack', ref: 'this', mode: 'full' }));
    expect(slack.items).toEqual([]);
    expect(slack.text).toBe('R2 stub chat reply');
  });
});

describe('A6 R2 inertness: QUOKY_NL_ITEM_R2=off keeps every list and record as before', () => {
  let h: R2Harness;
  beforeAll(async () => {
    h = await bootR2Harness({ QUOKY_NL_ACTIONS: 'local', QUOKY_WORK_SUMMARY_ENABLED: 'false' });
    h.jira = ISSUES;
    h.slack = SLACK;
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('the Jira list is unnumbered, no Jira / Slack slot is written, and item.summarize never offers Jira or Slack', async () => {
    const listed = await h.turn('내 Jira 이슈 보여줘');
    expect(listed.text).toMatch(/^- \[jira:PROJ-1\]/mu);
    expect(listed.text).not.toMatch(/^1\. /mu);
    await h.turn('Slack에서 배포 검색');
    const byActor = ((await h.sessionMetadata())['quoky.lastListing'] as { byActor?: Record<string, Record<string, unknown>> } | undefined)?.byActor?.[h.owner.id] ?? {};
    expect(byActor.jira).toBeUndefined();
    expect(byActor.slack).toBeUndefined();
    const read = await h.turn('2번 이슈 요약해줘', pick('item.summarize', { source: 'jira', ref: '#2', mode: 'full' }));
    expect(read.items).toEqual([]);
    const prompt = read.selects[0]?.prompt ?? '';
    expect(prompt).not.toMatch(/source \(required\): mail\|drive\|jira/u);
    expect(read.selects.length).toBeLessThanOrEqual(1);
  });

  it('the selector prompt offers no R2 source (the v44 A6 prompt)', async () => {
    const turn = await h.turn('아무 말', none);
    const prompt = turn.selects[0]?.prompt ?? '';
    expect(prompt).not.toContain('Jira issue or Slack message');
    expect(prompt).not.toContain('jira|slack');
  });
});

describe('A6 R2 live state: QUOKY_NL_ACTIONS=shadow with QUOKY_NL_ITEM_R2=off', () => {
  let h: R2Harness;
  beforeAll(async () => {
    h = await bootR2Harness({ QUOKY_NL_ACTIONS: 'shadow', QUOKY_NL_ITEM_R2: 'off', QUOKY_WORK_SUMMARY_ENABLED: 'false' });
    h.jira = ISSUES;
    h.slack = SLACK;
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('boots shadow with R2 off, lists stay unnumbered, and no Jira / Slack slot is written', async () => {
    expect(h.service().actionLevel()).toBe('shadow');
    expect(h.service().itemR2Level()).toBe('off');
    const listed = await h.turn('내 Jira 이슈 보여줘');
    expect(listed.text).toMatch(/^- \[jira:PROJ-1\]/mu);
    expect(listed.text).not.toMatch(/^\d+\. /mu);
    await h.turn('Slack에서 배포 검색');
    const byActor = ((await h.sessionMetadata())['quoky.lastListing'] as { byActor?: Record<string, Record<string, unknown>> } | undefined)?.byActor?.[h.owner.id] ?? {};
    expect(byActor.jira).toBeUndefined();
    expect(byActor.slack).toBeUndefined();
  });

  it('R2 phrases make 0 item fetches and 0 SUMMARIZATION calls, and the reply is today\'s chat', async () => {
    for (const [text, args] of [
      ['2번 이슈 요약해줘', { source: 'jira', ref: '#2', mode: 'summary' }],
      ['그 슬랙 메시지 원문 보여줘', { source: 'slack', ref: 'this', mode: 'full' }],
    ] as const) {
      const turn = await h.turn(text, pick('item.summarize', args));
      expect(turn.items).toEqual([]);
      expect(turn.summaries).toHaveLength(0);
      expect(turn.text).toBe('R2 stub chat reply');
    }
    expect(h.itemFetches()).toEqual([]);
    expect((await h.sessionMetadata())['quoky.lastRead']).toBeUndefined();
  });

  it('the selector prompt stays the v44 A6 prompt (no R2 source) and R1 shadow decisions are unchanged', async () => {
    for (const text of ['아무 말', '오늘 일정 알려줘']) {
      const turn = await h.turn(text, none);
      const prompt = turn.selects[0]?.prompt ?? '';
      expect(prompt).not.toContain('Jira issue or Slack message');
      expect(prompt).not.toContain('jira|slack');
      expect(prompt).not.toMatch(/source \(required\): mail\|drive\|jira/u);
      expect(turn.items).toEqual([]);
      expect(turn.summaries).toHaveLength(0);
      expect(turn.text).toBe('R2 stub chat reply');
    }
  });
});

// Keep the ADF helper referenced (fixtures above use plain text through the harness).
void adf;
