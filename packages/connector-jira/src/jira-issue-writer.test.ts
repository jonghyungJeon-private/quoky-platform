import { describe, expect, it } from 'vitest';
import type { ConnectorWriteTransportGuard } from '@quoky/core';
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


/** UNC-1: what the platform fetch throws (`TypeError('fetch failed')` with the transport error as `cause`). */
function fetchFailed(code: string, message = `${code} test`): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
}


/** UNC-1: a recording transport guard (what the composition root injects) that answers NOT_SENT for a thrown request. */
function recordingGuard(): { guard: ConnectorWriteTransportGuard; begun: string[]; classified: unknown[]; ended: number } {
  const log = { begun: [] as string[], classified: [] as unknown[], ended: 0 };
  const guard: ConnectorWriteTransportGuard = {
    begin(target) {
      log.begun.push(target.toString());
      return {
        classifyFailure(error) {
          log.classified.push(error);
          return { status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false };
        },
        end() {
          log.ended += 1;
        },
      };
    },
  };
  return Object.assign(log, { guard });
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
      // UNC-1: without an injected classifier every thrown request is UNCERTAIN (fail safe), whatever its cause.
      [fetchFailed('ENOTFOUND'), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
      [fetchFailed('ECONNREFUSED'), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
      [fetchFailed('ECONNRESET', 'read ECONNRESET'), { status: 'UNCERTAIN', reason: 'TRANSPORT' }],
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
    for (const [reply, reason] of [
      [new Error('reset'), 'TRANSPORT'],
      [fetchFailed('ECONNRESET', 'read ECONNRESET'), 'TRANSPORT'],
      [json(502, {}), 'SERVER_ERROR'],
    ] as const) {
      const fake = fakeFetch(issue('PROJ-7'), json(200, TRANSITIONS), reply);
      expect(await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(APPROVED)).toEqual({
        status: 'UNCERTAIN', reason,
      });
      expect(fake.calls).toHaveLength(3);
    }
  });

  it('UNC-1: only the comment / transition POST runs inside a transport-guard window (not the pre-reads)', async () => {
    const thrown = fetchFailed('ENOTFOUND');
    const rec = recordingGuard();
    const transition = fakeFetch(issue('PROJ-7'), json(200, TRANSITIONS), thrown);
    expect(
      await new JiraIssueTransitionWriter(config(transition.fetchImpl, { transportGuard: rec.guard })).transition(APPROVED),
    ).toEqual({ status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false });
    expect(transition.calls).toHaveLength(3);
    const comment = fakeFetch(issue('PROJ-1'), thrown);
    expect(
      await new JiraIssueCommentWriter(config(comment.fetchImpl, { transportGuard: rec.guard })).addComment({ issueKey: 'PROJ-1', text: 'hi' }),
    ).toEqual({ status: 'NOT_SENT', reason: 'UNAVAILABLE', retryable: false });
    expect(comment.calls).toHaveLength(2);
    expect(rec.begun).toEqual([
      'https://example.atlassian.net/rest/api/3/issue/PROJ-7/transitions',
      'https://example.atlassian.net/rest/api/3/issue/PROJ-1/comment',
    ]);
    expect(rec.classified).toEqual([thrown, thrown]);
    expect(rec.ended).toBe(2);
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

  // PINNED PREMISE of the A7 drafter relaxation (owner 2026-11-26): an unescaped inert `[readme]` is no Jira wiki page link only because the body is
  // an ADF document of bare `type:'text'` nodes over REST v3 (no wiki-markup body). A change of renderer must revisit the drafter relaxation.
  // ADR-0121 A7-S4a (A7-S3 note, review round 3 item 4): the comment is sent as plain ADF text nodes, one paragraph per `\n` line. ADF is
  // a structured document: no wiki markup is parsed out of a text node, so a doubled backslash (a forced line break in Jira WIKI markup),
  // `{code}`, `[x|y]`, `*bold*` or `!img!` stay inert characters inside ONE paragraph. The rendered line count of a comment is
  // therefore exactly the payload's line count (the proposal port bounds it at 9), not one more per `\\`.
  it('plainTextDocument renders exactly one paragraph per payload line: a backslash pair or wiki markup adds no line and no markup', () => {
    const payload = ['[Quoky 요약] 출처: Slack 메시지 2건', 'a \\\\ b', '{code}x{code} *b* !img.png! [a|b] h1. t', '\\\\'].join('\n');
    const document = plainTextDocument(payload) as { content: Array<{ type: string; content: Array<{ type: string; text: string; marks?: unknown }> }> };
    expect(document.content).toHaveLength(payload.split('\n').length);
    expect(document.content.map((paragraph) => paragraph.type)).toEqual(['paragraph', 'paragraph', 'paragraph', 'paragraph']);
    expect(document.content.map((paragraph) => paragraph.content.map((node) => node.text).join(''))).toEqual(payload.split('\n'));
    // Every node is a bare text node: no mark, no link, no mention, no hard break.
    for (const paragraph of document.content) for (const node of paragraph.content) expect(Object.keys(node).sort()).toEqual(['text', 'type']);
    expect(JSON.stringify(document)).not.toMatch(/hardBreak|"marks"|inlineCard|mention/u);
  });
});

// ── ADR-0112 amendment 3: O4 comment delete undo, O5 transition revert ─────────────────────────────────────────────

const STAMP = '2026-11-16T09:00:00.000+0000';
const NOT_SENT = (reason: string) => ({ status: 'NOT_SENT', reason, retryable: false });

function comment(overrides: Record<string, unknown> = {}): Response {
  return json(200, {
    id: '10042', created: STAMP, updated: STAMP,
    author: { accountId: 'acct-quoky' }, updateAuthor: { accountId: 'acct-quoky' }, ...overrides,
  });
}

function perms(own: boolean, all: boolean): Response {
  return json(200, { permissions: {
    DELETE_OWN_COMMENTS: { havePermission: own }, DELETE_ALL_COMMENTS: { havePermission: all },
  } });
}

const myself = (accountId = 'acct-quoky'): Response => json(200, { accountId });
const DELETE_REQUEST = { issueKey: 'PROJ-7', commentId: '10042', expected: { version: STAMP } } as const;
const COMMENT_URL = 'https://example.atlassian.net/rest/api/3/issue/PROJ-7/comment/10042';

describe('JiraIssueCommentWriter O4: version, inspectComment, deleteComment', () => {
  it('addComment returns the version only when updated is a bounded stamp equal to created', async () => {
    const cases: Array<[Record<string, unknown>, string | undefined]> = [
      [{ created: STAMP, updated: STAMP }, STAMP],
      [{ created: STAMP, updated: '2026-11-16T09:00:01.000+0000' }, undefined],
      [{ created: STAMP }, undefined],
      [{ created: 'a b', updated: 'a b' }, undefined],
      [{ created: 5, updated: 5 }, undefined],
      [{ created: 'x'.repeat(201), updated: 'x'.repeat(201) }, undefined],
    ];
    for (const [extra, version] of cases) {
      const fake = fakeFetch(issue('PROJ-7'), json(201, { id: '10042', ...extra }));
      const outcome = await new JiraIssueCommentWriter(config(fake.fetchImpl)).addComment({ issueKey: 'PROJ-7', text: 'hi' });
      expect(outcome).toMatchObject({ status: 'SENT', externalRef: '10042' });
      expect('version' in outcome ? (outcome as { version?: string }).version : undefined).toBe(version);
    }
  });

  it('inspectComment refuses a non-allowlisted issue or malformed id before any network call', async () => {
    const fake = fakeFetch();
    const writer = new JiraIssueCommentWriter(config(fake.fetchImpl));
    for (const [key, id] of [['OTHER-1', '1'], ['PROJ-1', 'abc'], ['PROJ-1', ''], ['PROJ-1', '1/../2']] as const) {
      const error = await writer.inspectComment(key, id).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ConnectorQueryError);
      expect((error as ConnectorQueryError).reason).toBe('UNSUPPORTED_QUERY');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('inspectComment: issue 404 and comment 404 are absent; a moved issue is moved', async () => {
    const run = (...replies: Reply[]) => {
      const fake = fakeFetch(...replies);
      return new JiraIssueCommentWriter(config(fake.fetchImpl)).inspectComment('PROJ-7', '10042');
    };
    expect(await run(json(404, {}))).toEqual({ kind: 'absent' });
    expect(await run(issue('OTHER-2'))).toEqual({ kind: 'moved' });
    expect(await run(issue('PROJ-7'), json(404, {}))).toEqual({ kind: 'absent' });
    const error = await run(json(500, {})).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorQueryError);
  });

  it('inspectComment reports unedited and deletable, reading only (GET) with the expected URLs', async () => {
    const fake = fakeFetch(issue('PROJ-7'), comment(), perms(true, false), myself());
    const state = await new JiraIssueCommentWriter(config(fake.fetchImpl)).inspectComment('PROJ-7', '10042');
    expect(state).toEqual({ kind: 'present', commentId: '10042', version: STAMP, unedited: true, deletable: true });
    expect(fake.calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7?fields=project'],
      ['GET', COMMENT_URL],
      ['GET', 'https://example.atlassian.net/rest/api/3/mypermissions?issueKey=PROJ-7&permissions=DELETE_OWN_COMMENTS%2CDELETE_ALL_COMMENTS'],
      ['GET', 'https://example.atlassian.net/rest/api/3/myself'],
    ]);
  });

  it('inspectComment: an edited comment (updated differs, or another account updated it) is not unedited', async () => {
    for (const edit of [
      { updated: '2026-11-16T10:00:00.000+0000' },
      { updateAuthor: { accountId: 'acct-other' } },
      { updateAuthor: {} },
      { author: {}, updateAuthor: {} },
    ]) {
      const fake = fakeFetch(issue('PROJ-7'), comment(edit), perms(false, true));
      const state = await new JiraIssueCommentWriter(config(fake.fetchImpl)).inspectComment('PROJ-7', '10042');
      expect(state).toMatchObject({ kind: 'present', unedited: false });
    }
  });

  it('inspectComment: a malformed version or a different id throws INVALID_RESPONSE', async () => {
    for (const bad of [{ updated: 'has space' }, { updated: 12 }, { id: '999' }]) {
      const fake = fakeFetch(issue('PROJ-7'), comment(bad));
      const error = await new JiraIssueCommentWriter(config(fake.fetchImpl)).inspectComment('PROJ-7', '10042').catch((c: unknown) => c);
      expect((error as ConnectorQueryError).reason).toBe('INVALID_RESPONSE');
    }
  });

  it('inspectComment permission: all, own (author is me), own (author is not me), none, unexpected shape', async () => {
    const run = async (...tail: Reply[]) => {
      const fake = fakeFetch(issue('PROJ-7'), comment(), ...tail);
      return new JiraIssueCommentWriter(config(fake.fetchImpl)).inspectComment('PROJ-7', '10042').catch((c: unknown) => c);
    };
    expect(await run(perms(false, true))).toMatchObject({ deletable: true });
    expect(await run(perms(true, false), myself('acct-quoky'))).toMatchObject({ deletable: true });
    expect(await run(perms(true, false), myself('acct-other'))).toMatchObject({ deletable: false });
    expect(await run(perms(false, false))).toMatchObject({ deletable: false });
    for (const bad of [
      json(200, {}),
      json(200, { permissions: { DELETE_OWN_COMMENTS: { havePermission: true } } }),
      json(200, { permissions: { DELETE_OWN_COMMENTS: { havePermission: 'yes' }, DELETE_ALL_COMMENTS: { havePermission: false } } }),
    ]) {
      expect(((await run(bad)) as ConnectorQueryError).reason).toBe('INVALID_RESPONSE');
    }
    expect(((await run(perms(true, false), json(200, {}))) as ConnectorQueryError).reason).toBe('INVALID_RESPONSE');
  });

  it('deleteComment sends exactly one DELETE to the comment path and returns SENT with the comment id', async () => {
    const fake = fakeFetch(issue('PROJ-7'), comment(), perms(false, true), comment(), new Response(null, { status: 204 }));
    const outcome = await new JiraIssueCommentWriter(config(fake.fetchImpl)).deleteComment(DELETE_REQUEST);
    expect(outcome).toEqual({ status: 'SENT', externalRef: '10042' });
    // Review round 1 (P3): permission first, then the final comment read, then the DELETE at once.
    expect(fake.calls.map((call) => `${call.init?.method ?? 'GET'} ${new URL(call.url).pathname}`).slice(-3)).toEqual([
      'GET /rest/api/3/mypermissions',
      `GET ${new URL(COMMENT_URL).pathname}`,
      `DELETE ${new URL(COMMENT_URL).pathname}`,
    ]);
    const deletes = fake.calls.filter((call) => call.init?.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(COMMENT_URL);
    expect(deletes[0]!.init?.body).toBeUndefined();
    expect(deletes[0]!.init?.redirect).toBe('error');
    assertNoSecrets(outcome);
  });

  it('deleteComment refuses a non-allowlisted issue, a bad id or a bad version before any network call', async () => {
    const fake = fakeFetch();
    const writer = new JiraIssueCommentWriter(config(fake.fetchImpl));
    expect(await writer.deleteComment({ ...DELETE_REQUEST, issueKey: 'OTHER-1' })).toEqual(NOT_SENT('TARGET_NOT_ALLOWED'));
    expect(await writer.deleteComment({ ...DELETE_REQUEST, commentId: 'x1' })).toEqual(NOT_SENT('INVALID_REQUEST'));
    expect(await writer.deleteComment({ ...DELETE_REQUEST, expected: { version: '' } })).toEqual(NOT_SENT('INVALID_REQUEST'));
    expect(await writer.deleteComment({ ...DELETE_REQUEST, expected: { version: 'a b' } })).toEqual(NOT_SENT('INVALID_REQUEST'));
    expect(fake.calls).toHaveLength(0);
  });

  it('deleteComment: a moved issue is TARGET_CHANGED and nothing else is read', async () => {
    const fake = fakeFetch(issue('OTHER-2'));
    expect(await new JiraIssueCommentWriter(config(fake.fetchImpl)).deleteComment(DELETE_REQUEST)).toEqual(NOT_SENT('TARGET_CHANGED'));
    expect(fake.calls).toHaveLength(1);
  });

  it('deleteComment: edited, edited by another account or a version mismatch is TARGET_CHANGED with no DELETE', async () => {
    for (const edit of [
      { updated: '2026-11-16T10:00:00.000+0000' },
      { updateAuthor: { accountId: 'acct-other' } },
    ]) {
      const fake = fakeFetch(issue('PROJ-7'), comment(edit), perms(false, true));
      expect(await new JiraIssueCommentWriter(config(fake.fetchImpl)).deleteComment(DELETE_REQUEST)).toEqual(NOT_SENT('TARGET_CHANGED'));
      expect(fake.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
    }
    const fake = fakeFetch(issue('PROJ-7'), comment(), perms(false, true));
    const outcome = await new JiraIssueCommentWriter(config(fake.fetchImpl)).deleteComment({
      ...DELETE_REQUEST, expected: { version: '2026-11-15T09:00:00.000+0000' },
    });
    expect(outcome).toEqual(NOT_SENT('TARGET_CHANGED'));
    expect(fake.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  });

  it('deleteComment: a gone comment is NOT_FOUND, no permission is FORBIDDEN, a failed pre-read is NOT_SENT; no DELETE', async () => {
    const run = async (...replies: Reply[]) => {
      const fake = fakeFetch(issue('PROJ-7'), ...replies);
      const outcome = await new JiraIssueCommentWriter(config(fake.fetchImpl)).deleteComment(DELETE_REQUEST);
      expect(fake.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
      return outcome;
    };
    expect(await run(json(404, {}))).toEqual(NOT_SENT('NOT_FOUND'));
    expect(await run(comment(), perms(false, false))).toEqual(NOT_SENT('FORBIDDEN'));
    expect(await run(comment(), perms(true, false), myself('acct-other'))).toEqual(NOT_SENT('FORBIDDEN'));
    expect(await run(json(500, {}))).toEqual(NOT_SENT('UNAVAILABLE'));
    expect(await run(comment(), json(200, {}))).toEqual(NOT_SENT('UNAVAILABLE'));
  });

  it('review round 1 (P3): a comment edited or gone after the permission check (the final read) is never deleted', async () => {
    const edited = fakeFetch(issue('PROJ-7'), comment(), perms(false, true), comment({ updated: '2026-11-16T10:09:00.000+0900' }));
    expect(await new JiraIssueCommentWriter(config(edited.fetchImpl)).deleteComment(DELETE_REQUEST)).toEqual(NOT_SENT('TARGET_CHANGED'));
    expect(edited.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
    const gone = fakeFetch(issue('PROJ-7'), comment(), perms(false, true), json(404, {}));
    expect(await new JiraIssueCommentWriter(config(gone.fetchImpl)).deleteComment(DELETE_REQUEST)).toEqual(NOT_SENT('NOT_FOUND'));
    expect(gone.calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  });

  it('deleteComment: DELETE 404 is NOT_FOUND, 500 is UNCERTAIN, and a thrown request is classified by the guard', async () => {
    const pre = (): Reply[] => [issue('PROJ-7'), comment(), perms(false, true), comment()];
    const notFound = fakeFetch(...pre(), json(404, {}));
    expect(await new JiraIssueCommentWriter(config(notFound.fetchImpl)).deleteComment(DELETE_REQUEST)).toEqual(NOT_SENT('NOT_FOUND'));
    const serverError = fakeFetch(...pre(), json(500, {}));
    expect(await new JiraIssueCommentWriter(config(serverError.fetchImpl)).deleteComment(DELETE_REQUEST)).toEqual({
      status: 'UNCERTAIN', reason: 'SERVER_ERROR',
    });
    const thrown = fetchFailed('ENOTFOUND');
    const rec = recordingGuard();
    const failed = fakeFetch(...pre(), thrown);
    expect(
      await new JiraIssueCommentWriter(config(failed.fetchImpl, { transportGuard: rec.guard })).deleteComment(DELETE_REQUEST),
    ).toEqual(NOT_SENT('UNAVAILABLE'));
    expect(rec.begun).toEqual([COMMENT_URL]);
    expect(rec.classified).toEqual([thrown]);
    expect(rec.ended).toBe(1);
  });
});

describe('JiraIssueTransitionWriter O5: readIssueStatus and fromStatusId', () => {
  const REVERT = { issueKey: 'PROJ-7', transitionId: '21', toStatusId: '10002', fromStatusId: '3' } as const;
  const withStatus = (key: string, statusId: string): Response =>
    json(200, { key, fields: { project: { key: 'PROJ' }, status: { id: statusId, name: 'In Progress' } } });

  it('readIssueStatus returns the key, status id and a bounded name from one GET', async () => {
    const fake = fakeFetch(json(200, { key: 'PROJ-7', fields: { status: { id: '3', name: 'In\u0000 Progress' } } }));
    const readout = await new JiraIssueTransitionWriter(config(fake.fetchImpl)).readIssueStatus('PROJ-7');
    expect(readout).toEqual({ issueKey: 'PROJ-7', statusId: '3', statusName: 'In Progress' });
    expect(fake.calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['GET', 'https://example.atlassian.net/rest/api/3/issue/PROJ-7?fields=status'],
    ]);
  });

  it('readIssueStatus: not allowlisted, a failed read or a malformed answer throws a ConnectorQueryError', async () => {
    const none = fakeFetch();
    const writer = new JiraIssueTransitionWriter(config(none.fetchImpl));
    expect(await writer.readIssueStatus('OTHER-1').catch((c: unknown) => c)).toBeInstanceOf(ConnectorQueryError);
    expect(none.calls).toHaveLength(0);
    const failed = fakeFetch(json(404, {}));
    const notFound = await new JiraIssueTransitionWriter(config(failed.fetchImpl)).readIssueStatus('PROJ-7').catch((c: unknown) => c);
    expect((notFound as ConnectorQueryError).reason).toBe('NOT_FOUND');
    for (const bad of [
      json(200, {}),
      json(200, { key: 'PROJ-7', fields: {} }),
      json(200, { key: 'PROJ-7', fields: { status: { id: 'x', name: 'A' } } }),
      json(200, { fields: { status: { id: '3' } } }),
    ]) {
      const fake = fakeFetch(bad);
      const error = await new JiraIssueTransitionWriter(config(fake.fetchImpl)).readIssueStatus('PROJ-7').catch((c: unknown) => c);
      expect((error as ConnectorQueryError).reason).toBe('INVALID_RESPONSE');
    }
  });

  it('a matching fromStatusId sends the transition (identity read asks for project and status)', async () => {
    const fake = fakeFetch(withStatus('PROJ-7', '3'), json(200, TRANSITIONS), new Response(null, { status: 204 }));
    const outcome = await new JiraIssueTransitionWriter(config(fake.fetchImpl)).transition(REVERT);
    expect(outcome).toMatchObject({ status: 'SENT', externalRef: 'PROJ-7:21' });
    expect(fake.calls[0]!.url).toBe('https://example.atlassian.net/rest/api/3/issue/PROJ-7?fields=project%2Cstatus');
    expect(fake.calls.map((call) => call.init?.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('a mismatching or unreadable status is refused before any transitions read or POST', async () => {
    const mismatch = fakeFetch(withStatus('PROJ-7', '10002'));
    expect(await new JiraIssueTransitionWriter(config(mismatch.fetchImpl)).transition(REVERT)).toEqual(NOT_SENT('TARGET_CHANGED'));
    expect(mismatch.calls).toHaveLength(1);
    const moved = fakeFetch(withStatus('OTHER-3', '3'));
    expect(await new JiraIssueTransitionWriter(config(moved.fetchImpl)).transition(REVERT)).toEqual(NOT_SENT('TARGET_CHANGED'));
    const unreadable = fakeFetch(issue('PROJ-7'));
    expect(await new JiraIssueTransitionWriter(config(unreadable.fetchImpl)).transition(REVERT)).toEqual(NOT_SENT('UNAVAILABLE'));
    expect(unreadable.calls).toHaveLength(1);
  });

  it('a non-digit fromStatusId is INVALID_REQUEST with no network call', async () => {
    const fake = fakeFetch();
    const writer = new JiraIssueTransitionWriter(config(fake.fetchImpl));
    for (const fromStatusId of ['', 'Done', '3 ']) {
      expect(await writer.transition({ ...REVERT, fromStatusId })).toEqual(NOT_SENT('INVALID_REQUEST'));
    }
    expect(fake.calls).toHaveLength(0);
  });
});
