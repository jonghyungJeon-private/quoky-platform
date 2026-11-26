import { describe, expect, it } from 'vitest';
import { AiFailureKind, AiProviderError, Capability, buildConsentClassifierPrompt, type AiProvider, type AiRequest } from '@quoky/core';
import {
  CONSENT_LOCAL_DIGEST12,
  CONSENT_LOCAL_MODEL,
  NL_CONSENT_ANSWER_EVAL_GATE,
  TIMED_OUT_LATENCY_MS,
  buildConsentAnswerPlan,
  classifierSeesContent,
  computeConsentAnswerPlanDigest,
  consentAnswerGateVerdict,
  loadConsentAnswerCorpus,
  runConsentAnswerEvaluation,
  summarizeConsentAnswer,
  validateConsentAnswerCorpus,
  type ConsentEvalCase,
  type ConsentEvalCorpus,
  type ConsentEvalLabel,
  type ConsentEvalRecord,
} from './nl-consent-answer-eval';
import { EXIT_BLOCKED, EXIT_GATE_FAILED, EXIT_INVALID, EXIT_NON_GATING, EXIT_OK, EXIT_USAGE, runCli, type CliDeps } from './nl-intent-eval-cli';

// A6-S4 `eval:nl --mode consent-answer` offline: the plan with zero model calls, its Strict digest, the refusal while the corpus
// awaits the owner's review, the R6 gate verdicts on synthetic results, `classifier-sees-content`, and the content-free payload
// through the REAL adapter. Fake providers only; nothing is spawned and no model is called.

const NOW = '2026-11-26T03:00:00.000Z';
const { corpus, sha256 } = loadConsentAnswerCorpus();
const OWNER_REVIEW: ConsentEvalCorpus = { ...corpus, status: 'owner-review' };
const classifierCases = corpus.cases.filter((golden) => golden.stage === 'classifier');
const byPrompt = new Map(classifierCases.map((golden) => [buildConsentClassifierPrompt({ question: golden.question, reply: golden.reply }), golden] as const));

/** A classifier that answers each case's gold unless `override` says otherwise; it records every request it receives. */
function scriptedProvider(override: (golden: ConsentEvalCase) => string | Error | undefined = () => undefined, id = 'claude-cli'): AiProvider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    id,
    capabilities: [{ capability: Capability.INTENT_SELECTION, priority: 1 }],
    supportsStrongerIntentSelection: true,
    isAvailable: async () => true,
    execute: async (request) => {
      calls.push(request);
      const golden = byPrompt.get(request.prompt);
      if (golden === undefined) return { text: '{"label":"unclear"}', artifacts: [] };
      const forced = override(golden);
      if (forced instanceof Error) throw forced;
      return { text: forced ?? JSON.stringify({ label: golden.gold }), artifacts: [] };
    },
  };
}

function deps(
  provider: () => AiProvider = () => scriptedProvider(),
  load: () => { corpus: ConsentEvalCorpus; sha256: string } = () => ({ corpus, sha256 }),
): CliDeps & { out: string[]; err: string[]; written: Array<{ name: string; contents: string }>; created: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const written: Array<{ name: string; contents: string }> = [];
  const created: string[] = [];
  return {
    out,
    err,
    written,
    created,
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    now: () => NOW,
    loadCorpus: () => {
      throw new Error('not used');
    },
    writeReport: (name, contents) => {
      written.push({ name, contents });
      return `/reports/${name}`;
    },
    createProvider: (model, effort, tier) => {
      created.push(`remote:${model}:${effort ?? '-'}:${tier ?? '-'}`);
      return provider();
    },
    createLocalProvider: (model, digest12) => {
      created.push(`local:${model}:${digest12}`);
      return provider();
    },
    canary: async () => true,
    loadConsentAnswerCorpus: load,
  };
}

const digestOf = (out: readonly string[]): string => /plan digest \(sha256\): ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] ?? '';
const approvedLoad = () => ({ corpus, sha256 });
const ownerReviewLoad = () => ({ corpus: OWNER_REVIEW, sha256 });

async function strictRun(provider: () => AiProvider, args: readonly string[]): Promise<{ code: number; d: ReturnType<typeof deps> }> {
  const planned = deps(provider, approvedLoad);
  await runCli(['--mode', 'consent-answer', ...args], planned);
  const d = deps(provider, approvedLoad);
  const code = await runCli(['--mode', 'consent-answer', ...args, '--approved-plan-digest', digestOf(planned.out)], d);
  return { code, d };
}

describe('the consent-answer corpus as the eval reads it', () => {
  it('is schema-valid, is owner-approved, and has one (question, reply) per classifier case', () => {
    expect(validateConsentAnswerCorpus(corpus)).toEqual([]);
    expect(corpus.status).toBe('approved');
    expect(byPrompt.size).toBe(classifierCases.length);
    expect(classifierCases.length).toBeGreaterThanOrEqual(300);
  });
});

describe('the plan: offline, zero model calls, bound by its digest', () => {
  it('prints the digest and a parseable call cap for each arm; nothing is constructed, nothing is called', async () => {
    for (const arm of ['remote', 'local'] as const) {
      const d = deps(() => {
        throw new Error('no provider in a plan');
      });
      expect(await runCli(['--mode', 'consent-answer', '--arm', arm], d)).toBe(EXIT_OK);
      expect(d.created).toEqual([]);
      const text = d.out.join('\n');
      expect(digestOf(d.out)).toMatch(/^[0-9a-f]{64}$/);
      expect(text).toContain(`model calls this plan authorises: at most ${classifierCases.length * 3} (${classifierCases.length} cases x 3 run(s)`);
      expect(text).toContain('status approved');
      expect(text).toContain('nothing was executed');
      const plan = JSON.parse(text.slice(text.indexOf('{'), text.indexOf('\n}') + 2)) as Record<string, unknown>;
      expect(plan.arm).toBe(arm);
      expect(plan.model).toBe(arm === 'local' ? CONSENT_LOCAL_MODEL : 'sonnet');
      expect(plan.effort).toBe(arm === 'local' ? undefined : 'low');
      expect(plan.localDigest12).toBe(arm === 'local' ? CONSENT_LOCAL_DIGEST12 : undefined);
      expect(plan.promptVersion).toBe('consent-answer.v1');
      expect(plan.questionVersion).toBe('summary-consent-question.v2');
      expect(plan.corpusSha256).toBe(sha256);
      if (arm === 'local') expect(text).toContain('no call uses the Claude 5 h window');
    }
  });

  it('binds the arm, the model, the effort, the runs and the corpus into the digest', () => {
    const base = { arm: 'remote' as const, model: 'sonnet', effort: 'low', runs: 3, concurrency: 4 };
    const digest = computeConsentAnswerPlanDigest(buildConsentAnswerPlan(corpus, sha256, base));
    for (const changed of [{ ...base, effort: 'medium' }, { ...base, model: 'haiku' }, { ...base, runs: 1 }]) expect(computeConsentAnswerPlanDigest(buildConsentAnswerPlan(corpus, sha256, changed))).not.toBe(digest);
    expect(computeConsentAnswerPlanDigest(buildConsentAnswerPlan(corpus, 'other-sha', base))).not.toBe(digest);
    expect(computeConsentAnswerPlanDigest(buildConsentAnswerPlan(corpus, sha256, { arm: 'local', model: CONSENT_LOCAL_MODEL, runs: 3, concurrency: 4 }))).not.toBe(digest);
    expect(() => buildConsentAnswerPlan(corpus, sha256, { arm: 'local', model: 'llama3.1', runs: 3, concurrency: 4 })).toThrow();
  });

  it('refuses a missing arm, the local arm with --model / --effort, and options of other modes', async () => {
    expect(await runCli(['--mode', 'consent-answer'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'local', '--model', 'haiku'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'local', '--effort', 'low'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--entries', 'jira.issues'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--timeout-ms', '5000'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'help-scope', '--arm', 'remote'], deps())).toBe(EXIT_USAGE);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--runs', '9'], deps())).toBe(EXIT_USAGE);
  });
});

describe('the Strict run', () => {
  it('is refused while the corpus is owner-review, even with the right digest: no provider is constructed', async () => {
    const planned = deps(undefined, ownerReviewLoad);
    await runCli(['--mode', 'consent-answer', '--arm', 'remote'], planned);
    const d = deps(undefined, ownerReviewLoad);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--approved-plan-digest', digestOf(planned.out)], d)).toBe(EXIT_BLOCKED);
    expect(d.created).toEqual([]);
    expect(d.err.join('\n')).toContain('status is owner-review, not approved');
  });

  it('a mismatched digest is refused before anything is constructed', async () => {
    const d = deps(undefined, approvedLoad);
    expect(await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--approved-plan-digest', '0'.repeat(64)], d)).toBe(EXIT_BLOCKED);
    expect(d.created).toEqual([]);
  });

  it('a classifier that answers every gold passes all 3 runs in each arm; the report is content-free', async () => {
    for (const arm of ['remote', 'local'] as const) {
      const provider = scriptedProvider(undefined, arm === 'local' ? 'ollama-cli' : 'claude-cli');
      const { code, d } = await strictRun(() => provider, ['--arm', arm]);
      expect(code).toBe(EXIT_OK);
      expect(d.created).toEqual([arm === 'local' ? `local:${CONSENT_LOCAL_MODEL}:${CONSENT_LOCAL_DIGEST12}` : 'remote:sonnet:low:stronger']);
      expect(provider.calls).toHaveLength(classifierCases.length * 3);
      expect(d.out.join('\n')).toContain(`consent-answer gate (${arm}, consent-answer.v1): PASSED in all 3 run(s)`);
      const report = d.written[0]?.contents ?? '';
      expect(JSON.parse(report).verdict).toBe('PASSED');
      // No reply and no question text in the report (replies of 4+ characters are distinctive enough to search for).
      for (const golden of corpus.cases.filter((c) => Array.from(c.reply).length >= 4)) expect(report.includes(JSON.stringify(golden.reply).slice(1, -1)), golden.id).toBe(false);
      expect(report.includes(corpus.cases[0]?.question ?? '?')).toBe(false);
    }
  });

  it('one non-answer read as yes fails the gate (a wrong capture), with the case id named', async () => {
    const victim = classifierCases.find((golden) => golden.gold === 'other') as ConsentEvalCase;
    const { code, d } = await strictRun(() => scriptedProvider((golden) => (golden.id === victim.id ? '{"label":"yes"}' : undefined)), ['--arm', 'remote']);
    expect(code).toBe(EXIT_GATE_FAILED);
    expect(d.out.join('\n')).toContain(`wrong captures 1 [${victim.id}]`);
  });

  it('a provider outage is INVALID (exit 5), never PASSED or FAILED', async () => {
    const down = (): AiProvider => scriptedProvider(() => new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'limit'));
    const planned = deps(down, approvedLoad);
    await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--runs', '1'], planned);
    const d = { ...deps(down, approvedLoad), canary: async () => 'provider-execution_failed' };
    const code = await runCli(['--mode', 'consent-answer', '--arm', 'remote', '--runs', '1', '--approved-plan-digest', digestOf(planned.out)], d);
    expect(code).toBe(EXIT_INVALID);
    expect(d.out.join('\n')).not.toContain('PASSED');
  });

  it('a single passing run is NON-GATING (exit 4): the gate needs 3 runs', async () => {
    const { code, d } = await strictRun(() => scriptedProvider(), ['--arm', 'remote', '--runs', '1']);
    expect(code).toBe(EXIT_NON_GATING);
    expect(d.out.join('\n')).toContain('NON-GATING');
  });
});

describe('the R6 gate on synthetic results', () => {
  const record = (gold: ConsentEvalLabel, label: ConsentEvalLabel, extra: Partial<ConsentEvalRecord> = {}, id = `${gold}-${label}`): ConsentEvalRecord => ({ run: 1, id, gold, label, outcome: 'answered', latencyMs: 1_000, contentFired: [], ...extra });
  const clean = (): ConsentEvalRecord[] => [
    ...Array.from({ length: 20 }, (_, i) => record('yes', 'yes', {}, `y${i}`)),
    ...Array.from({ length: 20 }, (_, i) => record('no', 'no', {}, `n${i}`)),
    ...Array.from({ length: 20 }, (_, i) => record('other', 'other', {}, `o${i}`)),
    ...Array.from({ length: 5 }, (_, i) => record('yes-and-more', 'yes-and-more', {}, `m${i}`)),
    ...Array.from({ length: 5 }, (_, i) => record('unclear', 'unclear', {}, `u${i}`)),
  ];
  const passes = (records: ConsentEvalRecord[]) => summarizeConsentAnswer(records).gatePassed;

  it('passes a clean run; a yes read as unclear (a re-ask) or as yes-and-more is counted, not failed', () => {
    expect(passes(clean())).toBe(true);
    const counted = clean();
    counted[0] = record('yes', 'unclear', {}, 'y0');
    counted[1] = record('yes', 'yes-and-more', {}, 'y1');
    const summary = summarizeConsentAnswer(counted);
    expect(summary.gatePassed).toBe(true);
    expect(summary.yesReadAsUnclear).toBe(1);
    expect(summary.yesReadAsYesAndMore).toBe(1);
    expect(summary.yesRecall.hits).toBe(19);
  });

  it('a wrong capture is any non-binding gold labelled yes OR yes-and-more, the unclear gold included', () => {
    for (const [gold, label] of [['other', 'yes'], ['other', 'yes-and-more'], ['no', 'yes'], ['unclear', 'yes-and-more']] as const) {
      const records = clean();
      records.push(record(gold, label));
      const summary = summarizeConsentAnswer(records);
      expect(summary.wrongCaptures, `${gold}->${label}`).toBe(1);
      expect(summary.gatePassed).toBe(false);
    }
  });

  it('yes recall, no recall and yes-and-more recall each need 95 % (yes-and-more gates: owner r-03 (1), 2026-11-24)', () => {
    const lowYes = clean();
    lowYes[0] = record('yes', 'other', {}, 'y0');
    lowYes[1] = record('yes', 'no', {}, 'y1');
    expect(summarizeConsentAnswer(lowYes).yesRecall.rate).toBeLessThan(0.95);
    expect(passes(lowYes)).toBe(false);
    const lowNo = clean();
    lowNo[20] = record('no', 'unclear', {}, 'n0');
    lowNo[21] = record('no', 'other', {}, 'n1');
    expect(passes(lowNo)).toBe(false);
    const yamAsYes = clean().map((r) => (r.gold === 'yes-and-more' ? { ...r, label: 'yes' as const } : r));
    const summary = summarizeConsentAnswer(yamAsYes);
    expect(summary.yesAndMoreRecall.rate).toBe(0);
    expect(summary.yesAndMoreReadAsYes).toBe(5);
    expect(NL_CONSENT_ANSWER_EVAL_GATE.yesAndMoreRecall).toMatchObject({ bar: 0.95, gating: true });
    expect(summary.gatePassed).toBe(false);
    // At the bar: 19 of 20 yes-and-more read right passes; 18 of 20 fails.
    const yam = (misses: number) => [...clean().filter((r) => r.gold !== 'yes-and-more'), ...Array.from({ length: 20 }, (_, i) => record('yes-and-more', i < misses ? 'yes' : 'yes-and-more', {}, `m${i}`))];
    expect(summarizeConsentAnswer(yam(1)).yesAndMoreRecall.rate).toBe(0.95);
    expect(passes(yam(1))).toBe(true);
    expect(passes(yam(2))).toBe(false);
  });

  it('a content firing, a harness error or a p95 over the 10 s bound fails the run', () => {
    const fired = clean();
    fired[0] = record('yes', 'yes', { contentFired: ['shown-value'] }, 'y0');
    expect(passes(fired)).toBe(false);
    const errored = clean();
    errored[0] = record('yes', 'unclear', { outcome: 'error', error: 'Error' }, 'y0');
    expect(passes(errored)).toBe(false);
    const noCall = clean();
    noCall[0] = record('other', 'unclear', { outcome: 'no-call' }, 'o0');
    expect(passes(noCall)).toBe(false);
    const slow = clean().map((r, i) => (i < 10 ? { ...r, latencyMs: 10_001 } : r));
    expect(summarizeConsentAnswer(slow).latency.p95).toBe(10_001);
    expect(passes(slow)).toBe(false);
  });

  it('a timed-out call counts as over the p95 bound, whatever its measured time (CA P2: no pass or fail on timer jitter)', () => {
    expect(TIMED_OUT_LATENCY_MS).toBe(Number.POSITIVE_INFINITY);
    // 10 of 70 calls cut at the deadline: measured ~10 000 ms would sit at the bound; recorded as Infinity they are over it.
    const timedOut = clean().map((r, i) => (i < 10 ? { ...r, label: 'unclear' as const, outcome: 'timeout' as const, latencyMs: TIMED_OUT_LATENCY_MS } : r));
    const summary = summarizeConsentAnswer(timedOut);
    expect(summary.latency.p95).toBe(Number.POSITIVE_INFINITY);
    expect(summary.timeouts).toBe(10);
    expect(summary.gatePassed).toBe(false);
    // A few timeouts below the 5 % tail leave p95 finite (they still count as timeouts).
    const rare = clean().map((r, i) => (i === 25 ? { ...r, label: 'unclear' as const, outcome: 'timeout' as const, latencyMs: TIMED_OUT_LATENCY_MS } : r));
    expect(summarizeConsentAnswer(rare).latency.p95).toBe(1_000);
  });

  it('the verdict: PASSED needs 3 passing runs; an outage without a hard failure is INVALID; a hard failure is FAILED even under an outage', () => {
    const ok = summarizeConsentAnswer(clean());
    const bad = summarizeConsentAnswer([...clean(), record('other', 'yes')]);
    const soft = summarizeConsentAnswer(clean().map((r, i) => (i < 3 ? { ...r, label: 'unclear' as const } : r)));
    expect(consentAnswerGateVerdict({ summaries: [ok, ok, ok], runs: 3 })).toBe('PASSED');
    expect(consentAnswerGateVerdict({ summaries: [ok], runs: 1 })).toBe('NON-GATING');
    expect(consentAnswerGateVerdict({ summaries: [ok, soft, ok], runs: 3 })).toBe('FAILED');
    expect(consentAnswerGateVerdict({ summaries: [ok, ok, ok], runs: 3, invalidReason: 'provider-limit' })).toBe('INVALID');
    expect(consentAnswerGateVerdict({ summaries: [ok, soft, ok], runs: 3, invalidReason: 'provider-limit' })).toBe('INVALID');
    expect(consentAnswerGateVerdict({ summaries: [ok, bad, ok], runs: 3, invalidReason: 'provider-limit' })).toBe('FAILED');
    expect(consentAnswerGateVerdict({ summaries: [], runs: 3 })).toBe('FAILED');
  });
});

describe('classifier-sees-content (A6.10) and the content-free payload', () => {
  const rule1 = classifierCases.find((golden) => golden.consent === 'rule-1') as ConsentEvalCase;
  const topic = classifierCases.find((golden) => golden.consent === 'a2-topic') as ConsentEvalCase;
  const request = (golden: ConsentEvalCase, prompt = buildConsentClassifierPrompt({ question: golden.question, reply: golden.reply })): AiRequest => ({ capability: Capability.INTENT_SELECTION, prompt, timeoutMs: 10_000, intentSelectionTier: 'stronger' });

  it('a request with exactly the fixed prompt around the question and the reply is clean', () => {
    expect(classifierSeesContent(request(rule1), rule1)).toEqual([]);
    expect(classifierSeesContent(request(topic), topic)).toEqual([]);
  });

  it('fires on a count, the topic or a topic token, the canary, an extra field, another capability or any other prompt', () => {
    const withCount = buildConsentClassifierPrompt({ question: rule1.question.replace(/\{(개수|count)\}/u, '3'), reply: rule1.reply });
    expect(classifierSeesContent(request(rule1, withCount), rule1)).toEqual(expect.arrayContaining(['prompt-differs', 'digit']));
    const topicText = topic.context.shown.topic as string;
    const withTopic = buildConsentClassifierPrompt({ question: topic.question.replace('{주제}', topicText), reply: topic.reply });
    expect(classifierSeesContent(request(topic, withTopic), topic)).toEqual(expect.arrayContaining(['prompt-differs', 'shown-value']));
    const token = topicText.split(/\s+/u).find((part) => Array.from(part).length >= 2) as string;
    expect(classifierSeesContent(request(topic, buildConsentClassifierPrompt({ question: `${topic.question} ${token}`, reply: topic.reply })), topic)).toContain('shown-value');
    expect(classifierSeesContent(request(rule1, `${rule1.context.shown.canary}\n${request(rule1).prompt}`), rule1)).toEqual(expect.arrayContaining(['prompt-differs', 'shown-value']));
    expect(classifierSeesContent({ ...request(rule1), systemPrompt: 'history' } as AiRequest, rule1)).toContain('extra-field:systemPrompt');
    expect(classifierSeesContent({ ...request(rule1), capability: Capability.GENERAL_CHAT }, rule1)).toContain('capability');
  });

  it('through the REAL adapter every request of every classifier case is clean: the question and the reply, nothing else', async () => {
    const provider = scriptedProvider();
    const plan = buildConsentAnswerPlan(corpus, sha256, { arm: 'remote', model: 'sonnet', effort: 'low', runs: 1, concurrency: 8 });
    const records = await runConsentAnswerEvaluation({ cases: corpus.cases, plan, provider });
    expect(records).toHaveLength(classifierCases.length);
    expect(records.filter((r) => r.contentFired.length > 0 || r.outcome !== 'answered' || r.label !== r.gold).map((r) => r.id)).toEqual([]);
    expect(provider.calls.every((call) => call.capability === Capability.INTENT_SELECTION && call.intentSelectionTier === 'stronger' && call.timeoutMs === 10_000)).toBe(true);
    // No count and no shown value anywhere before the reply block of any request.
    for (const call of provider.calls) {
      const golden = byPrompt.get(call.prompt) as ConsentEvalCase;
      const head = call.prompt.slice(0, call.prompt.lastIndexOf('\n<reply>\n'));
      expect(/\d/u.test(head), golden.id).toBe(false);
      expect(head.includes(golden.context.shown.canary), golden.id).toBe(false);
    }
  });

  it('a malformed, a late or a failed answer is unclear (fail closed) and is recorded as such', async () => {
    const plan = buildConsentAnswerPlan(corpus, sha256, { arm: 'remote', model: 'sonnet', effort: 'low', runs: 1, concurrency: 1 });
    const one = { ...plan, caseIds: [rule1.id], calls: 1 };
    const malformed = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: one, provider: scriptedProvider(() => 'yes') });
    expect(malformed[0]).toMatchObject({ label: 'unclear', outcome: 'malformed', raw: 'yes' });
    let t = 0;
    const late = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: one, provider: scriptedProvider(() => { t += 20_000; return '{"label":"yes"}'; }), clock: () => t });
    expect(late[0]).toMatchObject({ label: 'unclear', outcome: 'timeout', latencyMs: Number.POSITIVE_INFINITY });
    const deadline = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: one, provider: scriptedProvider(() => new AiProviderError(AiFailureKind.TIMEOUT, 'late')) });
    expect(deadline[0]).toMatchObject({ label: 'unclear', outcome: 'timeout', latencyMs: Number.POSITIVE_INFINITY });
    const failed = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: one, provider: scriptedProvider(() => new Error('boom')) });
    expect(failed[0]).toMatchObject({ label: 'unclear', outcome: 'error' });
    expect(Number.isFinite(failed[0]?.latencyMs)).toBe(true);
  });

  it('the remote arm copies the real provider\'s stronger-tier declaration; the local arm declares it for the measured model (CA P3)', async () => {
    const remote = buildConsentAnswerPlan(corpus, sha256, { arm: 'remote', model: 'sonnet', effort: 'low', runs: 1, concurrency: 1 });
    const local = buildConsentAnswerPlan(corpus, sha256, { arm: 'local', model: CONSENT_LOCAL_MODEL, runs: 1, concurrency: 1 });
    const withoutTier = (): AiProvider & { calls: AiRequest[] } => {
      const { supportsStrongerIntentSelection: _tier, ...rest } = scriptedProvider();
      return rest as AiProvider & { calls: AiRequest[] };
    };
    const remoteNoTier = withoutTier();
    const refused = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: { ...remote, caseIds: [rule1.id], calls: 1 }, provider: remoteNoTier });
    // Production refuses a provider without the stronger tier: no call, a harness error (never a silent upgrade).
    expect(refused[0]).toMatchObject({ label: 'unclear', outcome: 'no-call' });
    expect(remoteNoTier.calls).toHaveLength(0);
    expect(summarizeConsentAnswer(refused).harnessErrors).toBe(1);
    const declared = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: { ...remote, caseIds: [rule1.id], calls: 1 }, provider: scriptedProvider() });
    expect(declared[0]).toMatchObject({ outcome: 'answered', label: rule1.gold });
    const localNoTier = withoutTier();
    const measured = await runConsentAnswerEvaluation({ cases: corpus.cases, plan: { ...local, caseIds: [rule1.id], calls: 1 }, provider: localNoTier });
    expect(measured[0]).toMatchObject({ outcome: 'answered', label: rule1.gold });
    expect(localNoTier.calls).toHaveLength(1);
  });
});
