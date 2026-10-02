import { describe, expect, it } from 'vitest';
import approvalCorpus from './approval-decision.v1.json';
import baselineFile from './baseline.v1.json';
import controlCorpus from './conversation-control.v1.json';
import intentCorpus from './intent-routing.v1.json';
import registrationCorpus from './project-registration.v1.json';
import precedenceCorpus from './reminder-todo-precedence.v1.json';
import strayCorpus from './stray-decision.v1.json';
import {
  evaluateGoldenSuite,
  evaluateGoldenSuiteAsync,
  formatGoldenSummary,
  goldenMatches,
  mustPassFailures,
  ratchetViolations,
  validateGoldenCases,
} from './golden-eval';
import type { GoldenBaselineFile, GoldenCase, GoldenSuiteFile, GoldenSuiteResult } from './golden-eval';
import { interpretApprovalDecision, interpretStrayDecisionUtterance } from '../approval-decision';
import type { CapabilityRouter } from '../capability-router';
import { detectConversationControl } from '../conversation-commands';
import { IntentClassifier, detectProjectRegistration } from '../intent-classifier';
import type { InboundMessage } from '../../domain';

interface IntentExpected {
  type: string;
  capability?: string;
  rawKind?: string;
}
interface IntentCase extends GoldenCase<IntentExpected> {
  ctx?: { hasActiveProject?: boolean };
}
interface PendingCase extends GoldenCase<{ handler: string }> {
  pending: boolean;
  blockedBy: string;
}

const baseline = baselineFile as unknown as GoldenBaselineFile;
const asSuite = <C extends GoldenCase>(file: unknown): GoldenSuiteFile<C> => file as GoldenSuiteFile<C>;

const intents = asSuite<IntentCase>(intentCorpus);
const approvals = asSuite<GoldenCase<string>>(approvalCorpus);
const strays = asSuite<GoldenCase<string | null>>(strayCorpus);
const controls = asSuite<GoldenCase<string | null>>(controlCorpus);
const registrations = asSuite<GoldenCase<{ path: string; absolute: boolean } | null>>(registrationCorpus);
const precedence = asSuite<PendingCase>(precedenceCorpus);

const classifier = new IntentClassifier({} as unknown as CapabilityRouter);

async function predictIntent(golden: IntentCase): Promise<unknown> {
  const message = { text: golden.text, context: {} } as unknown as InboundMessage;
  const intent = await classifier.classify(message, golden.ctx);
  const raw = intent.raw as { kind?: unknown } | undefined;
  return {
    type: intent.type,
    capability: intent.capability,
    ...(typeof raw?.kind === 'string' ? { rawKind: raw.kind } : {}),
  };
}

const predictors = {
  'approval-decision': (golden: GoldenCase<string>) => interpretApprovalDecision(golden.text),
  'stray-decision': (golden: GoldenCase<string | null>) => interpretStrayDecisionUtterance(golden.text),
  'conversation-control': (golden: GoldenCase<string | null>) => detectConversationControl(golden.text),
  'project-registration': (golden: GoldenCase<unknown>) => detectProjectRegistration(golden.text),
} as const;

async function runAll(): Promise<GoldenSuiteResult[]> {
  return [
    await evaluateGoldenSuiteAsync(intents.cases, predictIntent, intents.suite),
    evaluateGoldenSuite(approvals.cases, predictors['approval-decision'], approvals.suite),
    evaluateGoldenSuite(strays.cases, predictors['stray-decision'], strays.suite),
    evaluateGoldenSuite(controls.cases, predictors['conversation-control'], controls.suite),
    evaluateGoldenSuite(registrations.cases, predictors['project-registration'], registrations.suite),
  ];
}

describe('golden corpora are well formed', () => {
  it.each([
    ['intent-routing', intents],
    ['approval-decision', approvals],
    ['stray-decision', strays],
    ['conversation-control', controls],
    ['project-registration', registrations],
    ['reminder-todo-precedence', precedence],
  ] as const)('%s', (name, file) => {
    expect(file.suite).toBe(name);
    expect(file.version).toBe(1);
    expect(file.cases.length).toBeGreaterThan(0);
    expect(validateGoldenCases(file.cases)).toEqual([]);
  });

  it('seeds the live UAT misroutes and approval phrasings (owner-curated, never auto-added)', () => {
    const intentText = new Set(intents.cases.map((c) => c.text));
    for (const text of ['새 대화 기능 만들어줘', '이 프로젝트 등록해줘: ../../etc', '7/3 회의 등록해줘', '승인']) {
      expect(intentText.has(text), text).toBe(true);
    }
    const approvalByText = new Map(approvals.cases.map((c) => [c.text, c.expected]));
    expect(approvalByText.get('승인')).toBe('approve');
    expect(approvalByText.get('진행하지 마')).toBe('deny');
    for (const text of ['승인 👍', '승인?', '진행해도 돼', '진행 상황 알려줘']) {
      expect(approvalByText.get(text), text).toBe('ambiguous');
    }
    expect(strays.cases.find((c) => c.text === '승인')?.expected).toBe('approve');
    const controlByText = new Map(controls.cases.map((c) => [c.text, c.expected]));
    expect(controlByText.get('/HELP')).toBe('help');
    expect(controlByText.get('도움말 ')).toBe('help');
    expect(controlByText.get('도움말 좀 알려줘')).toBeNull();
    expect(controlByText.get('새 대화 기능 만들어줘')).toBeNull();
    const registrationByText = new Map(registrations.cases.map((c) => [c.text, c.expected]));
    expect(registrationByText.get('7/3 회의 등록해줘')).toBeNull();
    expect(registrationByText.get('이 프로젝트 등록해줘: ../../etc')).toEqual({ path: '../../etc', absolute: false });
  });
});

describe('golden evaluation against the real deterministic Core', () => {
  it('passes every mustPass case and holds the accuracy ratchet', async () => {
    const results = await runAll();
    for (const result of results) {
      // One summary line per suite (ADR-0098 D7).
      console.info(formatGoldenSummary(result));
      expect(mustPassFailures(result), `${result.suite} mustPass failures`).toEqual([]);
      expect(ratchetViolations(result, baseline.suites[result.suite]), result.suite).toEqual([]);
      expect(result.accuracy).toBeGreaterThanOrEqual(baseline.suites[result.suite]?.minAccuracy ?? 1);
    }
  });

  it('has a baseline entry for exactly the scored suites', async () => {
    const results = await runAll();
    expect(Object.keys(baseline.suites).sort()).toEqual(results.map((r) => r.suite).sort());
    expect(baseline.version).toBe(1);
  });

  it('keeps the pending reminder/to-do precedence placeholders out of scoring', () => {
    expect(precedence.cases.every((c) => c.pending && !c.mustPass && c.blockedBy.length > 0)).toBe(true);
    expect(Object.keys(baseline.suites)).not.toContain('reminder-todo-precedence');
    // One pinned case per ADR-0100 D1 anchored head (17 heads), plus the unanchored placeholders.
    const anchored = precedence.cases.filter((c) => c.expected.handler === 'work-chat.mutation');
    expect(anchored).toHaveLength(17);
  });
});

describe('mutation self-check (an altered prediction must fail the suite)', () => {
  it('fails the approval suite when a decision is flipped', () => {
    const flip = (golden: GoldenCase<string>): unknown => {
      const actual = interpretApprovalDecision(golden.text);
      return golden.id === approvals.cases[0]?.id ? (actual === 'approve' ? 'deny' : 'approve') : actual;
    };
    const result = evaluateGoldenSuite(approvals.cases, flip, approvals.suite);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ id: approvals.cases[0]?.id, mustPass: true });
    expect(mustPassFailures(result).length).toBeGreaterThan(0);
    expect(result.accuracy).toBeLessThan(1);
    expect(ratchetViolations(result, baseline.suites[approvals.suite]).length).toBeGreaterThan(0);
  });

  it('fails the intent suite when the classifier is replaced by an always-chat stub', async () => {
    const result = await evaluateGoldenSuiteAsync(
      intents.cases,
      async () => ({ type: 'CHAT', capability: 'GENERAL_CHAT' }),
      intents.suite,
    );
    expect(result.failures.length).toBeGreaterThan(0);
    expect(mustPassFailures(result).length).toBeGreaterThan(0);
    expect(ratchetViolations(result, baseline.suites[intents.suite]).length).toBeGreaterThan(0);
  });

  it('fails a suite whose corpus has shrunk below the baseline size', async () => {
    const results = await runAll();
    const first = results[0] as GoldenSuiteResult;
    const shrunk: GoldenSuiteResult = { ...first, total: first.total - 1 };
    const entry = baseline.suites[first.suite];
    expect(ratchetViolations(shrunk, entry).some((v) => v.includes('cases <'))).toBe(true);
  });

  it('reports a missing baseline entry as a violation', async () => {
    const results = await runAll();
    expect(ratchetViolations(results[0] as GoldenSuiteResult, undefined)).toHaveLength(1);
  });
});

describe('golden-eval scorer', () => {
  const cases: GoldenCase<unknown>[] = [
    { id: 'a', text: 'a', expected: { type: 'X' }, source: 't', mustPass: true },
    { id: 'b', text: 'b', expected: null, source: 't', mustPass: false },
    { id: 'c', text: 'c', expected: 'approve', source: 't', mustPass: true },
  ];

  it('reports total, correct, accuracy and failures with expected/actual', () => {
    const result = evaluateGoldenSuite(
      cases,
      (golden) => ({ a: { type: 'X', extra: 1 }, b: undefined, c: 'deny' })[golden.id],
      'demo',
    );
    expect(result).toMatchObject({ suite: 'demo', total: 3, correct: 1 });
    expect(result.accuracy).toBeCloseTo(1 / 3);
    expect(result.failures).toEqual([
      { id: 'b', expected: null, actual: undefined, mustPass: false },
      { id: 'c', expected: 'approve', actual: 'deny', mustPass: true },
    ]);
  });

  it('scores an empty suite as 1 and matches expected-subset objects, arrays and null strictly', () => {
    expect(evaluateGoldenSuite([], () => undefined, 'empty').accuracy).toBe(1);
    expect(goldenMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(goldenMatches({ a: 1 }, null)).toBe(false);
    expect(goldenMatches(null, undefined)).toBe(false);
    expect(goldenMatches([1, 2], [1, 2])).toBe(true);
    expect(goldenMatches([1, 2], [1])).toBe(false);
  });

  it('flags duplicate ids and malformed cases', () => {
    const bad = [
      { id: 'x', text: 'a', expected: 1, source: 's', mustPass: true },
      { id: 'x', text: 'b', expected: 1, source: '', mustPass: true },
    ] as GoldenCase[];
    expect(validateGoldenCases(bad)).toEqual(['duplicate id: x', 'x: missing source']);
  });
});
