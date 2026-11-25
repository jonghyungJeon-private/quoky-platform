import { describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderSelector } from '../../ports/provider-selector.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { PAYLOAD_DRAFT_PROMPT_VERSION } from './payload-drafter';
import {
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  payloadDraftReadiness,
  quarantinedDraft,
  type AgentSourceDocument,
  type AgentSummarySource,
  type PayloadDraftRequest,
  type QuarantinedSummarizerRoute,
} from './quarantined-summary';
import { consentTokenFor } from './summary-consent.test-support';

// ADR-0121 A7-S3: the drafter's M2 call, with stub providers (no model). Rule ①, the egress label, the work-source constraints and
// the closed refusals are the summariser's own guards; this file proves the drafter goes through them and adds nothing of its own.

const RUN = newSummaryRunToken();
const PEOPLE = [{ label: '참여자 A', name: 'Dana Example' }];
const GOOD = JSON.stringify({ lines: ['참여자 A가 배포 완료를 알렸다', '자세한 내용은 https://example.test/a 참고'] });

const doc = (position: number, id = `m${position}`): AgentSourceDocument => ({ id, position, title: `t${position}`, author: 'a', date: '', body: `body ${position}` });

interface Spy extends AiProvider {
  readonly requests: AiRequest[];
}
function spy(id: string, locality: AiExecutionLocality, text: string | (() => Promise<{ text: string }>) = GOOD, extra: { readonly dataUse?: 'no-training' } = {}): Spy {
  const requests: AiRequest[] = [];
  return {
    id,
    requests,
    executionLocality: locality,
    ...(extra.dataUse !== undefined ? { dataUse: extra.dataUse } : {}),
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    isAvailable: async () => true,
    execute: async (request) => {
      requests.push(request);
      return typeof text === 'string' ? { text } : text();
    },
  };
}
const selectorOf = (...providers: Spy[]): ProviderSelector => ({
  select: async (_capability, context) => providers.find((provider) => (context?.allowedExecutionLocalities ?? []).includes(provider.executionLocality as AiExecutionLocality)),
  isStillEligible: () => true,
});

const mailSource = (documents: AgentSourceDocument[], extra: Partial<AgentSummarySource> = {}): AgentSummarySource => ({
  entryId: 'mail.list',
  documents,
  grant: mintSummaryEgressGrantForTest(1, 'mail.list', RUN),
  ...extra,
});
const request = (source: AgentSummarySource, route: QuarantinedSummarizerRoute, extra: Partial<PayloadDraftRequest> = {}): PayloadDraftRequest => ({
  source,
  participants: PEOPLE,
  summaryStep: 1,
  route,
  reserve: () => true,
  run: RUN,
  ...extra,
});
const consentFor = (entryId: NlWave1EntryId, ids: string[], recipient = 'Remote Co') => consentTokenFor(RUN, 1, { recipient, reads: [{ entryId, itemIds: ids }] });
const REMOTE_ROUTE = (provider: Spy, extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute => ({ selector: selectorOf(provider), recipientLabel: () => 'Remote Co', ...extra });

describe('the LOCAL path', () => {
  it('drafts over a local provider with a sealed request and the assembled lines', async () => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource([doc(1), doc(2)]), { selector: selectorOf(local) }));
    expect(outcome.kind).toBe('draft');
    if (outcome.kind !== 'draft') return;
    expect(outcome.draft.lines).toEqual(['Dana Example가 배포 완료를 알렸다', '자세한 내용은 https[:]/[/]example[.]test/a 참고']);
    expect(outcome.draft.named).toBe(1);
    expect(outcome.draft.locality).toBe('LOCAL');
    expect(outcome.draft.promptVersion).toBe(PAYLOAD_DRAFT_PROMPT_VERSION);
    expect(outcome.draft.label).toMatchObject({ trust: 'UNTRUSTED', derivation: 'MODEL_DERIVED' });
    expect(Object.isFrozen(outcome.draft)).toBe(true);
    expect(outcome.audit).toMatchObject({ locality: 'LOCAL', auditId: 'local-a' });
    // A sealed request: the capability, the prompt, nothing else (no tools, context, history, workspace or image).
    expect(local.requests).toHaveLength(1);
    const sent = local.requests[0] as AiRequest;
    expect(Object.keys(sent).sort()).toEqual(['capability', 'prompt']);
    expect(sent.capability).toBe(Capability.SUMMARIZATION);
    expect(sent.prompt).toContain('<<<UNTRUSTED_SPAN');
    expect(sent.prompt).toContain('ITEM 2');
    // The real names never reach the prompt (the map is host-only).
    expect(sent.prompt).not.toContain('Dana Example');
  });

  it('the draft carries no card, hash, port or send: it is a value', async () => {
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(spy('local-a', 'LOCAL')) }));
    expect(outcome.kind).toBe('draft');
    if (outcome.kind === 'draft') expect(Object.keys(outcome.draft).sort()).toEqual(['label', 'lines', 'locality', 'named', 'promptVersion']);
  });

  it('sends at most 10 items and omits the rest', async () => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource(Array.from({ length: 12 }, (_, i) => doc(i + 1)), { asked: 12 }), { selector: selectorOf(local) }));
    expect(outcome.kind).toBe('draft');
    expect((local.requests[0] as AiRequest).prompt).not.toContain('ITEM 11');
    expect((local.requests[0] as AiRequest).prompt).toContain('ITEM 10');
    if (outcome.kind === 'draft') expect(outcome.omitted).toBe(2);
  });

  it('a document outside the asked-for positions or repeated never reaches the model', async () => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource([doc(1), doc(1, 'dup'), doc(3)], { asked: 2 }), { selector: selectorOf(local) }));
    expect(outcome.kind).toBe('draft');
    expect((local.requests[0] as AiRequest).prompt).not.toContain('ITEM 2');
    if (outcome.kind === 'draft') expect(outcome.omitted).toBe(2);
  });

  it('without the mail grant nothing is sent', async () => {
    const local = spy('local-a', 'LOCAL');
    const { grant: _grant, ...noGrant } = mailSource([doc(1)]);
    expect(await quarantinedDraft(request(noGrant, { selector: selectorOf(local) }))).toEqual({ kind: 'listing-only', reason: 'no-summary-grant' });
    expect(local.requests).toHaveLength(0);
  });
});

describe('rule ①: a REMOTE draft needs the bound consent', () => {
  it('without a consent token a REMOTE provider is never used, for any label', async () => {
    const remote = spy('remote-a', 'REMOTE');
    expect(await quarantinedDraft(request(mailSource([doc(1)]), REMOTE_ROUTE(remote)))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('with a matching consent token the call goes out once, to the recipient the owner was asked about', async () => {
    const remote = spy('remote-a', 'REMOTE');
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), REMOTE_ROUTE(remote), { consent: consentFor('mail.list', ['m1']) }));
    expect(outcome.kind).toBe('draft');
    if (outcome.kind === 'draft') expect(outcome.draft.locality).toBe('REMOTE');
    expect(remote.requests).toHaveLength(1);
  });

  it('a token for other items, another step or another run does not open REMOTE', async () => {
    const remote = spy('remote-a', 'REMOTE');
    const otherItems = consentFor('mail.list', ['zz']);
    expect(await quarantinedDraft(request(mailSource([doc(1)]), REMOTE_ROUTE(remote), { consent: otherItems }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    const otherStep = consentTokenFor(RUN, 2, { recipient: 'Remote Co', reads: [{ entryId: 'mail.list', itemIds: ['m1'] }] });
    expect(await quarantinedDraft(request(mailSource([doc(1)]), REMOTE_ROUTE(remote), { consent: otherStep }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    const otherRun = consentTokenFor(newSummaryRunToken(), 1, { recipient: 'Remote Co', reads: [{ entryId: 'mail.list', itemIds: ['m1'] }] });
    expect(await quarantinedDraft(request(mailSource([doc(1)]), REMOTE_ROUTE(remote), { consent: otherRun }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('a recipient that is no longer the one asked about is refused at dispatch', async () => {
    const remote = spy('remote-a', 'REMOTE');
    const route = REMOTE_ROUTE(remote, { recipientLabel: () => 'Someone Else' });
    expect(await quarantinedDraft(request(mailSource([doc(1)]), route, { consent: consentFor('mail.list', ['m1']) }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });

  it('with no recipient name REMOTE is excluded even with a token (no question can be asked)', async () => {
    const remote = spy('remote-a', 'REMOTE');
    const route: QuarantinedSummarizerRoute = { selector: selectorOf(remote) };
    expect(await quarantinedDraft(request(mailSource([doc(1)]), route, { consent: consentFor('mail.list', ['m1']) }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
  });

  it('the readiness probe asks the question instead of drafting, and a LOCAL pick needs none (W4)', async () => {
    const remote = spy('remote-a', 'REMOTE');
    const base = { entryId: 'mail.list' as const, summaryStep: 1, grant: mintSummaryEgressGrantForTest(1, 'mail.list', RUN), run: RUN, askedItems: 3 };
    expect(await payloadDraftReadiness({ ...base, route: REMOTE_ROUTE(remote, { askSummaryConsent: true }) })).toEqual({ reason: 'consent-needed', recipient: 'Remote Co' });
    expect(await payloadDraftReadiness({ ...base, route: REMOTE_ROUTE(remote) })).toEqual({ reason: 'no-model' });
    const local = spy('local-a', 'LOCAL');
    expect(await payloadDraftReadiness({ ...base, route: { selector: selectorOf(local), askSummaryConsent: true } })).toEqual({ reason: undefined });
    expect(remote.requests).toHaveLength(0);
  });
});

describe('calendar: LOCAL only, no fallback', () => {
  const cal = (): AgentSummarySource => ({ entryId: 'calendar.events', documents: [doc(1, 'e1')], grant: mintSummaryEgressGrantForTest(1, 'calendar.events', RUN) });
  it('drafts over a local provider', async () => {
    const local = spy('local-a', 'LOCAL');
    expect((await quarantinedDraft(request(cal(), { selector: selectorOf(local), workSummarySources: ['calendar'] }))).kind).toBe('draft');
  });
  it('never goes REMOTE, even with a consent token, and sends nothing without a local provider', async () => {
    const remote = spy('remote-a', 'REMOTE', GOOD, { dataUse: 'no-training' });
    const route = REMOTE_ROUTE(remote, { workSummarySources: ['calendar'] });
    expect(await quarantinedDraft(request(cal(), route, { consent: consentFor('calendar.events', ['e1']) }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    expect(remote.requests).toHaveLength(0);
  });
  it('the readiness probe never asks to send calendar content to a remote model', async () => {
    const remote = spy('remote-a', 'REMOTE', GOOD, { dataUse: 'no-training' });
    const base = { entryId: 'calendar.events' as const, summaryStep: 1, grant: mintSummaryEgressGrantForTest(1, 'calendar.events', RUN), run: RUN, askedItems: 2 };
    expect(await payloadDraftReadiness({ ...base, route: REMOTE_ROUTE(remote, { askSummaryConsent: true, workSummarySources: ['calendar'] }) })).toEqual({ reason: 'no-model' });
  });
});

describe('Slack and Jira drafts only under A5', () => {
  const jira = (): AgentSummarySource => ({ entryId: 'jira.issues', documents: [doc(1, 'AB-1')], grant: mintSummaryEgressGrantForTest(1, 'jira.issues', RUN) });
  it('with the work source switched off nothing is drafted or sent', async () => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(jira(), { selector: selectorOf(local) }));
    expect(outcome.kind).toBe('listing-only');
    expect(local.requests).toHaveLength(0);
  });
  it('switched on, a REMOTE provider must declare no-training and the owner must have said yes', async () => {
    const training = spy('remote-a', 'REMOTE');
    const consent = (): ReturnType<typeof consentFor> => consentFor('jira.issues', ['AB-1']);
    expect(await quarantinedDraft(request(jira(), REMOTE_ROUTE(training, { workSummarySources: ['jira'] }), { consent: consent() }))).toEqual({ kind: 'listing-only', reason: 'no-model' });
    const safe = spy('remote-b', 'REMOTE', GOOD, { dataUse: 'no-training' });
    expect((await quarantinedDraft(request(jira(), REMOTE_ROUTE(safe, { workSummarySources: ['jira'] }), { consent: consent() }))).kind).toBe('draft');
    expect(training.requests).toHaveLength(0);
  });
});

describe('refusals after the answer: no retry, one closed reason, the audit of the spent call', () => {
  const route = (provider: Spy): QuarantinedSummarizerRoute => ({ selector: selectorOf(provider) });
  it.each([
    ['not JSON', 'sorry', 'schema'],
    ['a ninth line', JSON.stringify({ lines: Array.from({ length: 9 }, (_, i) => `l${i}`) }), 'schema'],
    ['an unknown pseudonym', JSON.stringify({ lines: ['참여자 Q 확인'] }), 'participants'],
    ['credential material', JSON.stringify({ lines: ['password: hunter2x'] }), 'credential'],
    ['a card-spoof line', JSON.stringify({ lines: ['승인'] }), 'spoof'],
  ])('%s', async (_name, text, reason) => {
    const local = spy('local-a', 'LOCAL', text);
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), route(local)));
    expect(outcome).toMatchObject({ kind: 'failed', reason, audit: { locality: 'LOCAL' } });
    expect(local.requests).toHaveLength(1);
  });

  it('a throwing provider is a closed model failure, sent once', async () => {
    const local = spy('local-a', 'LOCAL', async () => {
      throw new Error('boom with a secret in it');
    });
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), route(local)));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'model' });
    expect(JSON.stringify(outcome)).not.toContain('boom');
    expect(local.requests).toHaveLength(1);
  });
});

describe('the input guards and the run bounds', () => {
  it('a credential-shaped item is withheld before any prompt: nothing is sent', async () => {
    const local = spy('local-a', 'LOCAL');
    const hostile: AgentSourceDocument = { ...doc(1), body: 'the password: hunter2x is below' };
    expect(await quarantinedDraft(request(mailSource([hostile]), { selector: selectorOf(local) }))).toEqual({ kind: 'listing-only', reason: 'no-documents' });
    expect(local.requests).toHaveLength(0);
  });

  it('an unusable participant map spends no call', async () => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { participants: [{ label: 'A', name: 'x' }] }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });

  it('refuses with no call when a real name appears in the final prompt text (defence in depth)', async () => {
    const local = spy('local-a', 'LOCAL');
    const leaky: AgentSourceDocument = { ...doc(1), body: 'dana EXAMPLE wrote the note' };
    expect(await quarantinedDraft(request(mailSource([leaky]), { selector: selectorOf(local) }))).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });

  it.each(['dana   example wrote it', 'DANA  EXAMPLE wrote it'])('collapses whitespace on both sides of the real-name check: %j', async (body) => {
    const local = spy('local-a', 'LOCAL');
    const leaky: AgentSourceDocument = { ...doc(1), body };
    expect(await quarantinedDraft(request(mailSource([leaky]), { selector: selectorOf(local) }))).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });

  it('the call is charged to the run once, with its input tokens; a refusal means no call', async () => {
    const local = spy('local-a', 'LOCAL');
    const charged: number[] = [];
    await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { reserve: (tokens) => (charged.push(tokens), true) }));
    expect(charged).toHaveLength(1);
    expect(charged[0]).toBeGreaterThan(0);
    const refused = spy('local-b', 'LOCAL');
    expect(await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(refused) }, { reserve: () => false }))).toEqual({ kind: 'bound' });
    expect(refused.requests).toHaveLength(0);
  });

  it('no calls left or no input budget left is a budget refusal, with nothing reserved', async () => {
    const local = spy('local-a', 'LOCAL');
    let reserved = 0;
    const reserve = (): boolean => ((reserved += 1), true);
    expect(await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { remainingCalls: 0, reserve }))).toEqual({ kind: 'listing-only', reason: 'budget' });
    expect(await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { remainingInputTokens: 10, reserve }))).toEqual({ kind: 'listing-only', reason: 'budget' });
    expect(await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { remainingCalls: Number.NaN, reserve }))).toEqual({ kind: 'listing-only', reason: 'budget' });
    expect(reserved).toBe(0);
    expect(local.requests).toHaveLength(0);
  });

  it('an aborted run sends nothing', async () => {
    const local = spy('local-a', 'LOCAL');
    const controller = new AbortController();
    controller.abort();
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { signal: controller.signal }));
    expect(outcome.kind).toBe('failed');
    expect(local.requests).toHaveLength(0);
  });

  it('a final dispatch check that refuses sends nothing', async () => {
    const local = spy('local-a', 'LOCAL');
    const selector: ProviderSelector = { select: async () => local, isStillEligible: () => false };
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), { selector }));
    expect(outcome.kind).toBe('listing-only');
    expect(local.requests).toHaveLength(0);
  });
});

describe('review round 3: a real name before JSON encoding', () => {
  const cases: Array<[string, string, Partial<AgentSourceDocument>]> = [
    ['홍 길동', '홍\n길동', { body: '홍\n길동' }],
    ['홍길동', '홍 길동', { body: '홍 길동' }],
    ['Dana Kim', 'Dana\r\nKim', { body: 'Dana\r\nKim' }],
    ['Dana Kim', 'Dana\tKim', { body: 'Dana\tKim' }],
    ['Dana Kim', 'Dana​Kim', { body: 'Dana​Kim' }],
    ['Dana​ Kim', 'dana kim', { body: 'dana kim' }],
    ['Da­na Kim', 'Dana Kim', { body: 'Dana Kim' }],
    ['O"Brien', 'O"Brien', { body: 'O"Brien' }],
    ['Back\\slash', 'Back\\slash', { body: 'Back\\slash' }],
    ['Dana Kim', 'Dana Kim', { title: 'Dana\nKim' }],
    ['Dana Kim', 'Dana Kim', { author: 'DANA  KIM' }],
  ];
  it.each(cases)('name %j vs %j: refuses with zero provider calls', async (name, _label, fields) => {
    const local = spy('local-a', 'LOCAL');
    const document: AgentSourceDocument = { ...doc(1), ...fields };
    const outcome = await quarantinedDraft(request(mailSource([document]), { selector: selectorOf(local) }, { participants: [{ label: '참여자 A', name }] }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });
});

describe('review round 4: one shared name key (encoded, reordered punctuation, template self-match)', () => {
  const cases: Array<[string, Partial<AgentSourceDocument>]> = [
    ['Alice Smith', { body: 'Alice&#32;Smith' }],
    ['Alice Smith', { body: '&#65;lice Smith' }],
    ['Alice Smith', { body: 'Alice&#38;#32;Smith' }],
    ['Alice Smith', { body: 'Alice&Tab;Smith' }],
    ['Dana Kim', { body: 'Dana&nbsp;Kim' }],
    ['홍길동', { body: '&#54861;&#44600;&#46041;' }],
    ['홍길동', { body: '&#xD64D;길동' }],
    ["Dana O'Brien", { body: 'Dana O&#39;Brien' }],
    ['Dana Kim', { body: 'Dana-Kim' }],
    ['Dana Kim', { body: 'mail dana.kim@example.test' }],
    ['홍길동', { body: '홍.길동' }],
    ['Dana Kim', { body: 'Dana <b>Kim</b>' }],
    ['Dana Kim', { title: 'Dana&#32;Kim' }],
    ['Alice Smith', { body: '<a title="Alice Smith">note</a>' }],
    ['Alice Smith', { body: '<!-- Alice Smith -->note' }],
    ['Alice Smith', { body: '<![CDATA[Alice Smith]]>note' }],
    ['Alice Smith', { title: 'Alice', author: '', body: 'Smith' }],
    ['Alice Smith', { body: '<a first="Alice" last="Smith">note</a>' }],
    ['Alice Smith', { title: 'Smith', body: 'Alice' }],
    ['Alice Smith', { title: 'Alice', author: 'Someone Else', body: 'Smith' }],
    ['Smith, Alice', { body: 'Alice Smith' }],
    ['Alice Smith', { body: 'Smith, Alice' }],
  ];
  it.each(cases)('name %j vs %j: refuses with zero provider calls', async (name, fields) => {
    const local = spy('local-a', 'LOCAL');
    const document: AgentSourceDocument = { ...doc(1), ...fields };
    const outcome = await quarantinedDraft(request(mailSource([document]), { selector: selectorOf(local) }, { participants: [{ label: '참여자 A', name }] }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });

  it.each(['Anne', 'Ann', 'Eve', 'Ed', 'Ted', 'Don', 'Leon', 'Rose', 'Ines', 'Om', 'Li', 'Theo', 'Leo'])('the name %s no longer self-matches our template', async (name) => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource([{ ...doc(1), body: 'plain note' }]), { selector: selectorOf(local) }, { participants: [{ label: '참여자 A', name }] }));
    expect(outcome.kind).toBe('draft');
    expect(local.requests).toHaveLength(1);
  });

  it('records the false-refusal cost: a given name and a family name anywhere in the items refuse (no call)', async () => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource([{ ...doc(1), title: 'Kim', body: 'Dana from the other team' }]), { selector: selectorOf(local) }, { participants: [{ label: '참여자 A', name: 'Dana Kim' }] }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });

  it.each(['!!!', '&#32;', '<b></b>'])('a name with an empty key (%j) cannot be checked: refuses with no call', async (name) => {
    const local = spy('local-a', 'LOCAL');
    const outcome = await quarantinedDraft(request(mailSource([doc(1)]), { selector: selectorOf(local) }, { participants: [{ label: '참여자 A', name }] }));
    expect(outcome).toEqual({ kind: 'failed', reason: 'participants' });
    expect(local.requests).toHaveLength(0);
  });
});
