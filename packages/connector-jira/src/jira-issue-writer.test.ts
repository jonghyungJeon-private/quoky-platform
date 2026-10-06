import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from '@quoky/core';
import {
  JiraIssueCommentWriter,
  JiraIssueTransitionWriter,
  plainTextDocument,
  selectTransition,
  type JiraIssueWriterConfig,
} from './jira-issue-writer';

const TOKEN = 'jira-secret-token';
const EMAIL = 'dev@example.com';

type Call = { url: string; init?: RequestInit };
type Reply = Response | Error | ((call: Call) => Response | Error);

function fakeFetch(...replies: Reply[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    const next = replies.shift();
    if (next === undefined) throw new Error('unexpected call');
    const value = typeof next === 'function' ? next(call) : next;
    if (value instanceof Error) throw value;
    return value;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function config(fetchImpl: typeof fetch, overrides: Partial<JiraIssueWriterConfig> = {}): JiraIssueWriterConfig {
  return {
    host: 'example.atlassian.net', email: EMAIL, apiToken: TOKEN, allowedProjects: ['PROJ'], fetchImpl, ...overrides,
  };
}

const TRANSITIONS = {
  transitions: [
    { id: '11', name: 'Start progress', to: { name: 'In Progress' } },
    { id: '21', name: 'Resolve', to: { name: 'Done' } },
    { id: '31', name: 'Review', to: { name: 'In Review' } },
  ],
};

function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value) + String((value as Error)?.message ?? '');
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'));
}

describe('JiraIssueCommentWriter (ADR-0112 D2/D4)', () => {
  it('posts the owner text verbatim as ADF to the allowlisted issue and returns SENT with the comment link', async () => {
    const fake = fakeFetch(json(201, { id: '10042', self: 'https://example.atlassian.net/rest/api/3/issue/1/comment/10042' }));
    const writer = new JiraIssueCommentWriter(config(fake.fetchImpl));
    const outcome = await writer.addComment({ issueKey: 'PROJ-7', text: '배포 완료\n\n*not bold* <b>x</b>' });
    expect(outcome).toEqual({
      status: 'SENT',
      externalRef: '10042',
      url: 'https://example.atlassian.net/browse/PROJ-7?focusedCommentId=10042',
    });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe('https://example.atlassian.net/rest/api/3/issue/PROJ-7/comment');
    expect(call.init?.method).toBe('POST');
    expect(call.init?.redirect).toBe('error');
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(call.init?.body))).toEqual({
      body: {
        type: 'doc', version: 1, content: [
          { type: 'paragraph', content: [{ type: 'text', text: '배포 완료' }] },
          { type: 'paragraph', content: [] },
          { type: 'paragraph', content: [{ type: 'text', text: '*not bold* <b>x</b>' }] },
        ],
      },
    });
  });

  it('refuses a non-allowlisted or malformed issue key and invalid text before any network call', async () => {
    const fake = fakeFetch();
    const writer = new JiraIssueCommentWriter(config(fake.fetchImpl));
    for (const issueKey of ['OTHER-1', 'proj-1', 'PROJ-0', 'PROJ', '../PROJ-1', 'PROJ-1?x', '']) {
      expect(writer.allowsIssue(issueKey)).toBe(false);
      expect(await writer.addComment({ issueKey, text: 'hi' })).toEqual({
        status: 'NOT_SENT', reason: 'TARGET_NOT_ALLOWED', retryable: false,
      });
    }
    for (const text of ['', '   ', 'x'.repeat(4001)]) {
      expect(await writer.addComment({ issueKey: 'PROJ-1', text })).toMatchObject({ status: 'NOT_SENT', reason: 'INVALID_REQUEST' });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('classifies failures: 4xx NOT_SENT, 5xx / transport / unreadable success UNCERTAIN; never retries', async () => {
    const cases: Array<[Reply, unknown]> = [
      [json(400, { errorMessages: ['bad'] }), { status: 'NOT_SENT', reason: 'REJECTED', retryable: false }],
      [json(401, {}), { status: 'NOT_SENT', reason: 'UNAUTHORIZED', retryable: false }],
      [json(403, {}), { status: 'NOT_SENT', reason: 'FORBIDDEN', retryable: false }],
      [json(404, {}), { status: 'NOT_SENT', reason: 'NOT_FOUND', retryable: false }],
      [json(429, {}), { status: 'NOT_SENT', reason: 'RATE_LIMITED', retryable: false }],
      [json(500, {}), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [json(503, {}), { status: 'UNCERTAIN', reason: 'SERVER_ERROR' }],
      [new Error(`connect ECONNRESET ${TOKEN}`), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
      [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
      [new Response('not json', { status: 201 }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
      [json(201, { id: 42 }), { status: 'UNCERTAIN', reason: 'INVALID_RESPONSE' }],
    ];
    for (const [reply, expected] of cases) {
      const fake = fakeFetch(reply);
      const outcome = await new JiraIssueCommentWriter(config(fake.fetchImpl)).addComment({ issueKey: 'PROJ-1', text: 'hi' });
      expect(outcome).toEqual(expected);
      expect(fake.calls).toHaveLength(1);
      assertNoSecrets(outcome);
    }
  });

  it('validates its configuration with value-free messages', () => {
    const { fetchImpl, calls } = fakeFetch();
    expect(() => new JiraIssueCommentWriter(config(fetchImpl, { allowedProjects: [] }))).toThrow('project keys');
    expect(() => new JiraIssueCommentWriter(config(fetchImpl, { allowedProjects: ['proj'] }))).toThrow('project keys');
    expect(() => new JiraIssueCommentWriter(config(fetchImpl, { host: 'http://example.atlassian.net' }))).toThrow('host');
    let caught: unknown;
    try {
      new JiraIssueCommentWriter(config(fetchImpl, { email: ' ' }));
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('jira writer: a non-empty email is required');
    expect(calls).toHaveLength(0);
  });
});

describe('JiraIssueTransitionWriter (ADR-0112 D2/D5)', () => {
  it('re-reads the transitions, picks the one leading to the named status and performs it once', async () => {
    const fake = fakeFetch(json(200, TRANSITIONS), new Response(null, { status: 204 }));
    const writer = new JiraIssueTransitionWriter(config(fake.fetchImpl));
    const outcome = await writer.transition({ issueKey: 'PROJ-7', toStatus: '  done ' });
    expect(outcome).toEqual({ status: 'SENT', externalRef: 'PROJ-7:21', url: 'https://example.atlassian.net/browse/PROJ-7' });
    expect(fake.calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7/transitions'],
      ['POST', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7/transitions'],
    ]);
    expect(JSON.parse(String(fake.calls[1]!.init?.body))).toEqual({ transition: { id: '21' } });
  });

  it('lists transitions as bounded, untrusted options for the preview', async () => {
    const fake = fakeFetch(json(200, { transitions: [{ id: '5', name: 'Go\u0000 live', to: { name: 'Live\nnow' } }] }));
    const options = await new JiraIssueTransitionWriter(config(fake.fetchImpl)).listTransitions('PROJ-1');
    expect(options).toEqual([{ id: '5', name: 'Go live', toStatus: 'Live now' }]);
  });

  it('refuses an unavailable or ambiguous status without sending the transition', async () => {
    const ambiguous = {
      transitions: [
        { id: '1', name: 'A', to: { name: 'Done' } },
        { id: '2', name: 'B', to: { name: 'done' } },
      ],
    };
    for (const [body, toStatus] of [[TRANSITIONS, 'Closed'], [ambiguous, 'Done']] as const) {
      const fake = fakeFetch(json(200, body));
      expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition({ issueKey: 'PROJ-1', toStatus })).toEqual({
        status: 'NOT_SENT', reason: 'TRANSITION_UNAVAILABLE', retryable: false,
      });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('a failed pre-check read is NOT_SENT (the transition never left)', async () => {
    for (const [reply, reason] of [
      [json(404, {}), 'NOT_FOUND'],
      [json(401, {}), 'UNAUTHORIZED'],
      [json(500, {}), 'UNAVAILABLE'],
      [new Error('offline'), 'UNAVAILABLE'],
      [json(200, { nope: true }), 'UNAVAILABLE'],
    ] as const) {
      const fake = fakeFetch(reply);
      expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition({ issueKey: 'PROJ-1', toStatus: 'Done' })).toEqual({
        status: 'NOT_SENT', reason, retryable: false,
      });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('a transport failure or 5xx on the transition POST is UNCERTAIN, with no retry', async () => {
    for (const [reply, reason] of [[new Error('reset'), 'TRANSPORT'], [json(502, {}), 'SERVER_ERROR']] as const) {
      const fake = fakeFetch(json(200, TRANSITIONS), reply);
      expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition({ issueKey: 'PROJ-1', toStatus: 'Done' })).toEqual({
        status: 'UNCERTAIN', reason,
      });
      expect(fake.calls).toHaveLength(2);
    }
  });

  it('refuses a non-allowlisted issue or an invalid status before any network call', async () => {
    const fake = fakeFetch();
    const writer = new JiraIssueTransitionWriter(config(fake.fetchImpl));
    expect(await writer.transition({ issueKey: 'OTHER-1', toStatus: 'Done' })).toMatchObject({ reason: 'TARGET_NOT_ALLOWED' });
    expect(await writer.transition({ issueKey: 'PROJ-1', toStatus: ' ' })).toMatchObject({ reason: 'INVALID_REQUEST' });
    expect(await writer.transition({ issueKey: 'PROJ-1', toStatus: 'x'.repeat(101) })).toMatchObject({ reason: 'INVALID_REQUEST' });
    const error = await writer.listTransitions('OTHER-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorQueryError);
    expect(fake.calls).toHaveLength(0);
  });

  it('selectTransition matches the target status first, then the transition name', () => {
    const options = [
      { id: '1', name: 'Done', toStatus: 'Closed' },
      { id: '2', name: 'Finish', toStatus: 'Done' },
    ];
    expect(selectTransition(options, 'DONE')?.id).toBe('2');
    expect(selectTransition(options, 'closed')?.id).toBe('1');
    expect(selectTransition(options, 'finish')?.id).toBe('2');
    expect(selectTransition(options, 'nothing')).toBeUndefined();
  });

  it('plainTextDocument keeps every line verbatim', () => {
    expect(plainTextDocument('a\r\nb')).toEqual({
      type: 'doc', version: 1, content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
  });
});
