import { describe, expect, it } from 'vitest';
import { ConnectorQueryError } from '@quoky/core';
import {
  JiraIssueCommentWriter,
  JiraIssueTransitionWriter,
  plainTextDocument,
  findApprovedTransition,
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
    { id: '11', name: 'Start progress', to: { id: '3', name: 'In Progress' } },
    { id: '21', name: 'Resolve', to: { id: '10002', name: 'Done' } },
    { id: '31', name: 'Review', to: { id: '10005', name: 'In Review' } },
  ],
};

/** The pre-write issue read: the issue still answers to `key` (a moved issue answers with its new key). */
function issue(key: string): Response {
  return json(200, { id: '10001', key, fields: { project: { key: key.split('-')[0] } } });
}

function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value) + String((value as Error)?.message ?? '');
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'));
}

describe('JiraIssueCommentWriter (ADR-0112 D2/D4)', () => {
  it('posts the owner text verbatim as ADF to the allowlisted issue and returns SENT with the comment link', async () => {
    const fake = fakeFetch(issue('PROJ-7'), json(201, { id: '10042', self: 'https://example.atlassian.net/rest/api/3/issue/1/comment/10042' }));
    const writer = new JiraIssueCommentWriter(config(fake.fetchImpl));
    const outcome = await writer.addComment({ issueKey: 'PROJ-7', text: '배포 완료\n\n*not bold* <b>x</b>' });
    expect(outcome).toEqual({
      status: 'SENT',
      externalRef: '10042',
      url: 'https://example.atlassian.net/browse/PROJ-7?focusedCommentId=10042',
    });
    expect(fake.calls).toHaveLength(2);
    expect([fake.calls[0]!.init?.method, fake.calls[0]!.url]).toEqual([
      'GET', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7?fields=project',
    ]);
    const call = fake.calls[1]!;
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
      const fake = fakeFetch(issue('PROJ-1'), reply);
      const outcome = await new JiraIssueCommentWriter(config(fake.fetchImpl)).addComment({ issueKey: 'PROJ-1', text: 'hi' });
      expect(outcome).toEqual(expected);
      expect(fake.calls).toHaveLength(2);
      assertNoSecrets(outcome);
    }
  });

  it('refuses (TARGET_CHANGED) when the approved key now names a moved issue, and a failed issue read is NOT_SENT', async () => {
    const moved = fakeFetch(issue('OTHER-5'));
    expect(await new JiraIssueCommentWriter(config(moved.fetchImpl)).addComment({ issueKey: 'PROJ-1', text: 'hi' })).toEqual({
      status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
    });
    expect(moved.calls).toHaveLength(1);
    for (const [reply, reason] of [
      [json(404, {}), 'NOT_FOUND'],
      [json(403, {}), 'FORBIDDEN'],
      [json(500, {}), 'UNAVAILABLE'],
      [new Error('offline'), 'UNAVAILABLE'],
      [json(200, { id: '1' }), 'UNAVAILABLE'],
    ] as const) {
      const fake = fakeFetch(reply);
      expect(await new JiraIssueCommentWriter(config(fake.fetchImpl)).addComment({ issueKey: 'PROJ-1', text: 'hi' })).toEqual({
        status: 'NOT_SENT', reason, retryable: false,
      });
      expect(fake.calls).toHaveLength(1);
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

describe('JiraIssueTransitionWriter (ADR-0112 D2/D5: the approved transition id only)', () => {
  const APPROVED = { issueKey: 'PROJ-7', transitionId: '21', toStatusId: '10002' } as const;

  it('re-reads the issue and the transitions, and performs exactly the approved transition id once', async () => {
    const fake = fakeFetch(issue('PROJ-7'), json(200, TRANSITIONS), new Response(null, { status: 204 }));
    const writer = new JiraIssueTransitionWriter(config(fake.fetchImpl));
    const outcome = await writer.transition(APPROVED);
    expect(outcome).toEqual({ status: 'SENT', externalRef: 'PROJ-7:21', url: 'https://example.atlassian.net/browse/PROJ-7' });
    expect(fake.calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7?fields=project'],
      ['GET', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7/transitions'],
      ['POST', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7/transitions'],
    ]);
    expect(JSON.parse(String(fake.calls[2]!.init?.body))).toEqual({ transition: { id: '21' } });
  });

  it('lists transitions as bounded, untrusted options with the destination status id for the preview', async () => {
    const fake = fakeFetch(
      json(200, {
        transitions: [
          { id: '5', name: 'Go\u0000 live', to: { id: '7', name: 'Live\nnow' } },
          { id: '6', name: 'No id', to: { name: 'Somewhere' } },
        ],
      }),
    );
    const options = await new JiraIssueTransitionWriter(config(fake.fetchImpl)).listTransitions('PROJ-1');
    expect(options).toEqual([
      { id: '5', name: 'Go live', toStatus: 'Live now', toStatusId: '7' },
      { id: '6', name: 'No id', toStatus: 'Somewhere', toStatusId: '' },
    ]);
  });

  it('Codex P1: the approved transition is gone and its old name now leads elsewhere — NOT_SENT, never a name match', async () => {
    // Approved: "Finish" (21) → Done (10002). Now a transition NAMED "Done" exists, but it leads to Closed.
    const drifted = {
      transitions: [
        { id: '41', name: 'Done', to: { id: '6', name: 'Closed' } },
        { id: '42', name: 'Finish', to: { id: '6', name: 'Closed' } },
      ],
    };
    const fake = fakeFetch(issue('PROJ-7'), json(200, drifted));
    expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(APPROVED)).toEqual({
      status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
    });
    expect(fake.calls.map((call) => call.init?.method)).toEqual(['GET', 'GET']);
  });

  it('the approved transition id still exists but now leads to another status — NOT_SENT', async () => {
    const drifted = { transitions: [{ id: '21', name: 'Resolve', to: { id: '6', name: 'Closed' } }] };
    const fake = fakeFetch(issue('PROJ-7'), json(200, drifted));
    expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(APPROVED)).toEqual({
      status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('the approved transition id was removed (even with the same destination still reachable) — NOT_SENT', async () => {
    const drifted = { transitions: [{ id: '99', name: 'Resolve', to: { id: '10002', name: 'Done' } }] };
    const fake = fakeFetch(issue('PROJ-7'), json(200, drifted));
    expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(APPROVED)).toEqual({
      status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
    });
    expect(fake.calls).toHaveLength(2);
  });

  it('the approved key now names a moved issue — NOT_SENT before the transitions are even read', async () => {
    const fake = fakeFetch(issue('OTHER-3'));
    expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(APPROVED)).toEqual({
      status: 'NOT_SENT', reason: 'TARGET_CHANGED', retryable: false,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('a failed pre-check read is NOT_SENT (the transition never left)', async () => {
    for (const [reply, reason] of [
      [json(404, {}), 'NOT_FOUND'],
      [json(401, {}), 'UNAUTHORIZED'],
      [json(500, {}), 'UNAVAILABLE'],
      [new Error('offline'), 'UNAVAILABLE'],
      [json(200, { nope: true }), 'UNAVAILABLE'],
    ] as const) {
      const fake = fakeFetch(issue('PROJ-1'), reply);
      expect(
        await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition({ ...APPROVED, issueKey: 'PROJ-1' }),
      ).toEqual({ status: 'NOT_SENT', reason, retryable: false });
      expect(fake.calls).toHaveLength(2);
    }
  });

  it('a transport failure or 5xx on the transition POST is UNCERTAIN, with no retry', async () => {
    for (const [reply, reason] of [[new Error('reset'), 'TRANSPORT'], [json(502, {}), 'SERVER_ERROR']] as const) {
      const fake = fakeFetch(issue('PROJ-7'), json(200, TRANSITIONS), reply);
      expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(APPROVED)).toEqual({
        status: 'UNCERTAIN', reason,
      });
      expect(fake.calls).toHaveLength(3);
    }
  });

  it('refuses a non-allowlisted issue or malformed bound ids before any network call', async () => {
    const fake = fakeFetch();
    const writer = new JiraIssueTransitionWriter(config(fake.fetchImpl));
    expect(await writer.transition({ ...APPROVED, issueKey: 'OTHER-1' })).toMatchObject({ reason: 'TARGET_NOT_ALLOWED' });
    for (const ids of [
      { transitionId: '', toStatusId: '10002' },
      { transitionId: 'Done', toStatusId: '10002' },
      { transitionId: '21', toStatusId: '' },
      { transitionId: '21', toStatusId: 'Done' },
    ]) {
      expect(await writer.transition({ ...APPROVED, ...ids })).toMatchObject({ reason: 'INVALID_REQUEST' });
    }
    const error = await writer.listTransitions('OTHER-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorQueryError);
    expect(fake.calls).toHaveLength(0);
  });

  it('findApprovedTransition matches by ids only and never by a name', () => {
    const options = [
      { id: '1', name: 'Done', toStatus: 'Closed', toStatusId: '6' },
      { id: '2', name: 'Finish', toStatus: 'Done', toStatusId: '10002' },
      { id: '3', name: 'Unknown', toStatus: 'X', toStatusId: '' },
    ];
    expect(findApprovedTransition(options, '2', '10002')?.id).toBe('2');
    expect(findApprovedTransition(options, '1', '10002')).toBeUndefined();
    expect(findApprovedTransition(options, '9', '10002')).toBeUndefined();
    expect(findApprovedTransition(options, '3', '')).toBeUndefined();
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
