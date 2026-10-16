import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { NlArgs } from './catalog';
import { nlReadNotRequest } from './read-statement';

interface Case {
  readonly id: string;
  readonly text: string;
  readonly expect: 'none' | { readonly entryId: string; readonly args: NlArgs };
  readonly prior?: unknown;
}
const corpus = JSON.parse(readFileSync(new URL('../golden/nl-intent.v1.json', import.meta.url), 'utf8')) as { cases: Case[] };

describe('nlReadNotRequest (READ message-level structural guard)', () => {
  it('refuses no positive gold with its own gold selection (0 positives newly refused)', () => {
    const refused = corpus.cases.filter((c) => c.expect !== 'none' && nlReadNotRequest(c.text, c.expect.args) !== undefined).map((c) => c.id);
    expect(refused).toEqual([]);
  });

  it('catches a reason clause with an embedded question and a lone non-request predicate', () => {
    expect(nlReadNotRequest('내 이슈가 뭐 있는지 몰라서 정신없어', {})).toBe('reason-statement');
  });

  it('catches a quoted full request that no arg consumes, in a question about it', () => {
    expect(nlReadNotRequest('"오늘 jira 이슈 브리핑해줘" 라고 말하면 뭐가 되는지 설명해줘', { topic: 'work-lookup' })).toBe('quoted-request');
  });

  it('still reads a lone state or plain-declarative predicate after a reason clause as a statement', () => {
    for (const text of ['일이 많아서 정신없어', '이슈가 너무 많아서 지친다', '이슈 몰라서 속상하네']) expect(nlReadNotRequest(text, {}), text).toBe('reason-statement');
  });

  it('over-block guards: positive evidence only', () => {
    expect(nlReadNotRequest('"오늘 이슈 알려줘" 대신 내일 일정 보여줘', {})).toBeUndefined();
    expect(nlReadNotRequest('이슈가 많아서 요약', {})).toBeUndefined();
    expect(nlReadNotRequest('이슈가 많아서 요약하시오', {})).toBeUndefined();
    expect(nlReadNotRequest('"오늘 이슈 알려줘"라는 표현이 뭐야', {})).toBe('quoted-request');
  });

  it('keeps a quote that is an argument value, and a reason clause that ends in a request or a wider main clause', () => {
    expect(nlReadNotRequest('슬랙에서 "서버 점검 공지" 찾아줘', { keyword: '서버 점검 공지' })).toBeUndefined();
    expect(nlReadNotRequest('이슈가 뭐 있는지 몰라서 알려줘', {})).toBeUndefined();
    expect(nlReadNotRequest('급해서 jira 이슈 확인해', {})).toBeUndefined();
    for (const text of ['바빠서 확인해', '몰라서 답답해', '급하니까 보여줘', '몰라서 알려줘', '몰라서 알려줄래요', '궁금해서 확인해요', '바빠서 알려주세요', '시간 없어서 보여줘']) expect(nlReadNotRequest(text, {}), text).toBeUndefined();
    expect(nlReadNotRequest('몰라서 답답한데 이슈 뭐야?', {})).toBeUndefined();
    expect(nlReadNotRequest('이슈 몰라서 어떻게 해야 돼?', {})).toBeUndefined();
  });
});
