import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiExecutionLocality, AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import { answerConsentTurn } from '../consent-answer/consent-answer';
import { isOwnerYes } from '../consent-answer/consent-yes';
import { ConsentPendingStore, summaryConsentPending, type BoundConsent } from '../consent-answer/consent-pending';
import {
  estimateInputTokens,
  mintSummaryConsentToken,
  mintSummaryEgressGrantForTest,
  newSummaryRunToken,
  quarantinedSummarize,
  setSummaryGrantsForTest,
  type AgentSourceDocument,
  type QuarantinedSummarizerRoute,
} from './quarantined-summary';
import { consentTokenFor, yesBound } from './summary-consent.test-support';
import { renderSummaryConsentQuestion, SUMMARY_CONSENT_QUESTION_VERSION, SUMMARY_CONSENT_SOURCE_NAMES } from './summary-consent-question';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const RUN = newSummaryRunToken();
afterEach(() => setSummaryGrantsForTest());

describe('round 2 (finding 1): a consent token needs the owner\'s yes, recorded only by the answer pipeline', () => {
  const scope = { actorId: 'a', conversationKey: 'c' };
  const open = (store: ConsentPendingStore): void =>
    store.open(summaryConsentPending({ scope, language: 'en', createdAtMs: 0, recipient: 'Claude', sources: [{ source: 'mail', itemIds: ['m1'] }], runRef: 'r1' }));
  const mint = (bound: BoundConsent) => mintSummaryConsentToken({ bound, runRef: 'r1', run: RUN, step: 1, reads: [{ entryId: 'mail.list', itemIds: ['m1'] }] });

  it('open, claim and bind WITHOUT the pipeline: bound, but no token', () => {
    const store = new ConsentPendingStore();
    open(store);
    const claimed = store.claim(scope, 1);
    if (!claimed.ok) throw new Error('claim');
    const bound = store.bind(claimed.claim, 2);
    expect(bound).toBeDefined();
    expect(mint(bound as BoundConsent)).toBeUndefined();
  });

  it('a closed yes through the pipeline mints exactly once', async () => {
    const store = new ConsentPendingStore();
    open(store);
    const decision = await answerConsentTurn(store, { scope, ownerDm: true, text: '응', atMs: 1 }, { mode: 'off' }, () => 2);
    expect(decision.kind).toBe('bound');
    if (decision.kind !== 'bound') return;
    expect(mint(decision.bound)).toBeDefined();
    expect(mint(decision.bound)).toBeUndefined();
  });

  it('a classifier yes and a classifier yes-and-more mint; no, other and unclear leave no token', async () => {
    const run = async (label: string, text = 'sure, go ahead') => {
      const store = new ConsentPendingStore();
      open(store);
      return answerConsentTurn(store, { scope, ownerDm: true, text, atMs: 1 }, { mode: 'on', classify: async () => label as never }, () => 2);
    };
    for (const label of ['yes', 'yes-and-more']) {
      const decision = await run(label);
      expect(decision.kind, label).toBe('bound');
      if (decision.kind === 'bound') expect(mint(decision.bound), label).toBeDefined();
    }
    for (const label of ['no', 'other', 'unclear']) {
      const decision = await run(label);
      expect(decision.kind, label).not.toBe('bound');
      expect('bound' in decision, label).toBe(false);
    }
    const closedNo = await run('yes', '아니');
    expect(closedNo.kind).toBe('cancelled');
  });

  it('a structural copy of a yes-bound consent is no yes', () => {
    const store = new ConsentPendingStore();
    open(store);
    const bound = yesBound(store, scope);
    expect(mint({ ...bound } as BoundConsent)).toBeUndefined();
    expect(mint(bound)).toBeDefined();
  });

  it('an instance with a replaced bind that returns a forged bound consent gets no brand and no token', () => {
    const store = new ConsentPendingStore();
    open(store);
    const other = new ConsentPendingStore();
    open(other);
    const real = yesBound(other, scope);
    const forged = Object.freeze({ pending: real.pending, boundAtMs: 2 }) as BoundConsent;
    store.bind = () => forged;
    void answerConsentTurn(store, { scope, ownerDm: true, text: '응', atMs: 1 }, { mode: 'off' }, () => 2);
    expect(isOwnerYes(forged)).toBe(false);
    expect(mint(forged)).toBeUndefined();
  });

  it('only consent-answer.ts records a yes: one import and exactly one call site, inside bindOrLost (AST)', () => {
    const users = ROOTS_SOURCES().filter((file) => /\brecordOwnerYes\b/u.test(readFileSync(file, 'utf8')) && !file.endsWith('consent-yes.ts') && !file.endsWith('.test.ts'));
    expect(users.map((file) => relative(REPO, file))).toEqual(['packages/core/src/application/consent-answer/consent-answer.ts']);
    const source = ts.createSourceFile('consent-answer.ts', readFileSync(users[0] as string, 'utf8'), ts.ScriptTarget.Latest, true);
    let imports = 0;
    const callers: string[] = [];
    const visit = (node: ts.Node, fn: string): void => {
      if (ts.isImportSpecifier(node) && node.name.text === 'recordOwnerYes') imports += 1;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'recordOwnerYes') callers.push(fn);
      const next = ts.isFunctionDeclaration(node) && node.name !== undefined ? node.name.text : fn;
      ts.forEachChild(node, (child) => visit(child, next));
    };
    visit(source, '<top>');
    expect(imports).toBe(1);
    expect(callers).toEqual(['bindOrLost']);
  });
});

function sourcesIn(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sourcesIn(path);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}
function ROOTS_SOURCES(): string[] {
  return ['packages', 'apps'].flatMap((top) => readdirSync(join(REPO, top)).map((name) => join(REPO, top, name, 'src')).filter((path) => existsSync(path))).flatMap(sourcesIn);
}

describe('round 2 (finding 2): no non-test source imports a test-support module', () => {
  it('scans every non-test source file in packages and apps', () => {
    const files = ROOTS_SOURCES().filter((file) => !file.endsWith('.test.ts') && !file.includes('.test-support.'));
    expect(files.length).toBeGreaterThan(500);
    const offenders = files.filter((file) => /['"][^'"]*\.test-support['"]/u.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(REPO, file))).toEqual([]);
  });
});

describe('round 2 (finding 3): REMOTE calls of one step, each with a real token and no executor', () => {
  const PERMISSIVE: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  const doc = (id: string, position: number): AgentSourceDocument => ({ id, position, title: `t${position}`, author: 'a', date: '', body: `body ${id}` });
  const mail = (...ids: string[]) => ({ entryId: 'mail.list' as const, documents: ids.map((id, i) => doc(id, i + 1)), asked: ids.length, grant: mintSummaryEgressGrantForTest(1, 'mail.list', RUN) });
  const drive = (...ids: string[]) => ({ entryId: 'drive.files' as const, documents: ids.map((id, i) => doc(id, i + 1)), asked: ids.length, grant: mintSummaryEgressGrantForTest(1, 'drive.files', RUN) });
  const base = { schema: 'digest.v1' as const, summaryStep: 1, run: RUN, reserve: () => true };
  const remote = (id = 'remote-a'): AiProvider & { readonly requests: AiRequest[] } => {
    const requests: AiRequest[] = [];
    return {
      id,
      requests,
      executionLocality: 'REMOTE' as AiExecutionLocality,
      dataUse: 'no-training',
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
      isAvailable: async () => true,
      execute: async (request: AiRequest) => (requests.push(request), { text: '{"items":[{"n":1,"summary":"A short summary."}]}' }),
    };
  };
  const route = (provider: AiProvider, extra: Partial<QuarantinedSummarizerRoute> = {}): QuarantinedSummarizerRoute => ({
    selector: new CapabilityRouter(new AiProviderManager([provider]), PERMISSIVE),
    recipientLabel: () => 'Claude',
    ...extra,
  });
  const token = () =>
    consentTokenFor(RUN, 1, { recipient: 'Claude', reads: [{ entryId: 'mail.list', itemIds: ['m1'] }, { entryId: 'drive.files', itemIds: ['f1'] }] });

  it('mail and Drive are dispatched in parallel, both REMOTE, both audited', async () => {
    const provider = remote();
    const outcome = await quarantinedSummarize({ ...base, sources: [mail('m1'), drive('f1')], route: route(provider), consent: token() });
    expect(provider.requests).toHaveLength(2);
    expect(outcome.kind).toBe('summary');
    if (outcome.kind !== 'summary') return;
    expect(outcome.audits?.map((audit) => audit.locality)).toEqual(['REMOTE', 'REMOTE']);
  });

  it('a byte budget that fits one of two calls sends one REMOTE call and omits the rest, still audited REMOTE', async () => {
    const probe = remote('probe');
    await quarantinedSummarize({ ...base, sources: [mail('m1')], route: route(probe), consent: consentTokenFor(RUN, 1, { recipient: 'Claude', reads: [{ entryId: 'mail.list', itemIds: ['m1'] }] }) });
    const one = estimateInputTokens((probe.requests[0] as AiRequest).prompt);
    const provider = remote();
    const outcome = await quarantinedSummarize({ ...base, sources: [mail('m1'), drive('f1')], route: route(provider), consent: token(), remainingInputTokens: one + 1 });
    expect(provider.requests).toHaveLength(1);
    expect(outcome.kind).toBe('summary');
    if (outcome.kind !== 'summary') return;
    expect(outcome.omitted).toBeGreaterThan(0);
    expect(outcome.audits?.map((audit) => audit.locality)).toEqual(['REMOTE']);
  });

  it('one call sent, the next refused at dispatch because the recipient changed: the sent call stays disclosed as REMOTE', async () => {
    const provider = remote();
    // The label is read this many times before the first call is sent (consent check and dispatch re-check); later reads flip it.
    const LABEL_READS_BEFORE_FLIP = 3;
    let reads = 0;
    const flipping = route(provider, { recipientLabel: () => (++reads <= LABEL_READS_BEFORE_FLIP ? 'Claude' : 'Other') });
    const outcome = await quarantinedSummarize({ ...base, sources: [mail('m1'), drive('f1')], route: flipping, consent: token() });
    // The first call was sent; the second was refused at dispatch (recipient changed): nothing was sent for it.
    expect(provider.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: 'summary', omitted: 1 });
    expect(outcome.kind === 'summary' ? outcome.audits?.map((audit) => audit.locality) : undefined).toEqual(['REMOTE']);
  });
});

describe('round 2 (finding 5): the question template bytes are pinned next to the version', () => {
  it('a wording change without a version bump fails', () => {
    const lines: string[] = [];
    for (const language of ['ko', 'en'] as const) {
      for (const source of SUMMARY_CONSENT_SOURCE_NAMES) {
        for (const count of [1, 2, 11]) for (const countPlaceholder of [false, true]) lines.push(renderSummaryConsentQuestion({ language, recipient: 'R', sources: [{ source, count }] }, { countPlaceholder }));
      }
      lines.push(renderSummaryConsentQuestion({ language, recipient: 'R', sources: SUMMARY_CONSENT_SOURCE_NAMES.map((source) => ({ source, count: 2 })) }));
    }
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    expect({ version: SUMMARY_CONSENT_QUESTION_VERSION, digest }).toEqual({ version: 'summary-consent-question.v1', digest: 'e6372995413e548e888ab248505bdb8bc9c4f039ca83ad40bc18a22baf32fe65' });
  });
});
