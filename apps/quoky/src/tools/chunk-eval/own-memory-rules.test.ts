/** ADR-0124 phase 2 P2-5: the own-memory rule families, calibration and verdict boundaries on synthetic data (offline, no model). */
import { detectOwnMemoryRecallQuestion, hasOwnMemoryRecallHit } from '@quoky/core';
import { describe, expect, it } from 'vitest';
import {
  DELTA_OPTIONS,
  SAFETY_MARGIN,
  TAU_GRID,
  buildOwnRulesReport,
  calibrateFamily,
  decide,
  f0Report,
  ownRulesLines,
  ownVerdict,
  pickTau,
  positiveStats,
  qualifies,
  rankedSemantic,
  validSemantic,
  type FamilyReport,
  type RecallEntry,
  type RuleQuestion,
  type SplitStats,
} from './own-memory-rules';
import type { OwnCategory, OwnHalf } from './memory-set-own';

const Q = detectOwnMemoryRecallQuestion('내가 좋아하는 과일이 뭐였지?') as NonNullable<ReturnType<typeof detectOwnMemoryRecallQuestion>>;
const OTHER = '전혀 상관없는 문장입니다';
const sem = (memoryId: string, score: number, content = OTHER): RecallEntry => ({ memoryId, content, retrievalMode: 'semantic', semanticScore: score });
const mk = (id: string, category: OwnCategory, half: OwnHalf, entries: RecallEntry[], gold: string[] = []): RuleQuestion => ({ id, category, half, language: 'ko', gold, question: Q, entries });
const neg = (id: string, half: OwnHalf, ...scores: number[]): RuleQuestion => mk(id, 'negative', half, scores.map((score, at) => sem(`n-${id}-${at}`, score)));
const pp = (id: string, half: OwnHalf, goldScore: number, ...others: number[]): RuleQuestion => mk(id, 'positive-paraphrase', half, [sem(`g-${id}`, goldScore), ...others.map((score, at) => sem(`o-${id}-${at}`, score))], [`g-${id}`]);

describe('rule decisions', () => {
  it('validSemantic accepts only a semantic entry with a finite score in [0, 1]', () => {
    expect(validSemantic(sem('a', 0.5))).toBe(0.5);
    expect(validSemantic(sem('a', 0))).toBe(0);
    expect(validSemantic(sem('a', 1))).toBe(1);
    expect(validSemantic(sem('a', 1.01))).toBeNull();
    expect(validSemantic(sem('a', -0.01))).toBeNull();
    expect(validSemantic(sem('a', Number.NaN))).toBeNull();
    expect(validSemantic({ memoryId: 'a', content: OTHER, retrievalMode: 'lexical', semanticScore: 0.95 })).toBeNull();
    expect(validSemantic({ memoryId: 'a', content: OTHER, retrievalMode: 'semantic' })).toBeNull();
  });

  it('F0 is the production rule: the floor is inclusive at 0.9, lexical entries never count, a topic word always hits', () => {
    const base = { family: 'F0' } as const;
    expect(decide(base, mk('q', 'negative', 'validate', [sem('a', 0.9)])).hit).toBe(true);
    expect(decide(base, mk('q', 'negative', 'validate', [sem('a', 0.8999)])).hit).toBe(false);
    expect(decide(base, mk('q', 'negative', 'validate', [{ memoryId: 'a', content: OTHER, retrievalMode: 'lexical', semanticScore: 0.99 }])).hit).toBe(false);
    const topic = decide(base, mk('q', 'positive-shared', 'validate', [sem('a', 0.1, '내가 제일 좋아하는 과일은 사과야')], ['a']));
    expect(topic.hit).toBe(true);
    expect(topic.topicIds).toEqual(['a']);
    expect(topic.semanticIds).toEqual([]);
  });

  it('offline F0 equals the real hasOwnMemoryRecallHit on a grid of scores, modes and contents', () => {
    const contents = [OTHER, '내가 제일 좋아하는 과일은 사과야', '고양이 이름은 보리야'];
    for (const content of contents) {
      for (const score of [undefined, Number.NaN, -0.1, 0, 0.5, 0.8999, 0.9, 0.95, 1, 1.2]) {
        for (const retrievalMode of [undefined, 'lexical', 'semantic'] as const) {
          const entry: RecallEntry = { memoryId: 'x', content, ...(retrievalMode === undefined ? {} : { retrievalMode }), ...(score === undefined ? {} : { semanticScore: score }) };
          const real = hasOwnMemoryRecallHit(Q, { conversationTranscript: [], durableRecall: [entry] });
          expect(decide({ family: 'F0' }, mk('q', 'negative', 'validate', [entry])).hit, JSON.stringify(entry)).toBe(real);
        }
      }
    }
  });

  it('F1 looks at the top semantic entry only, inclusive at tau', () => {
    const item = mk('q', 'negative', 'validate', [sem('low', 0.5), sem('top', 0.7)]);
    expect(decide({ family: 'F1', tau: 0.7 }, item)).toEqual({ hit: true, topicIds: [], semanticIds: ['top'] });
    expect(decide({ family: 'F1', tau: 0.71 }, item).hit).toBe(false);
  });

  it('F2 needs the gap top1 - top2 >= delta (a missing second entry counts as 0), inclusive', () => {
    const item = mk('q', 'negative', 'validate', [sem('a', 0.8), sem('b', 0.7)]);
    expect(decide({ family: 'F2', tau: 0.8, delta: 0.1 }, item).hit).toBe(true);
    expect(decide({ family: 'F2', tau: 0.8, delta: 0.15 }, item).hit).toBe(false);
    expect(decide({ family: 'F2', tau: 0.81, delta: 0.05 }, item).hit).toBe(false);
    expect(decide({ family: 'F2', tau: 0.8, delta: 0.15 }, mk('q', 'negative', 'validate', [sem('only', 0.8)])).hit).toBe(true);
    // 0.95 - 0.8 is 0.1499999... in floating point: still a gap of 0.15
    expect(decide({ family: 'F2', tau: 0.9, delta: 0.15 }, mk('q', 'negative', 'validate', [sem('a', 0.95), sem('b', 0.8)])).hit).toBe(true);
  });

  it('every family keeps the topic-word path', () => {
    const item = mk('q', 'positive-shared', 'validate', [sem('a', 0.1, '내가 제일 좋아하는 과일은 사과야')], ['a']);
    for (const spec of [{ family: 'F1', tau: 0.9 }, { family: 'F2', tau: 0.9, delta: 0.15 }] as const) expect(decide(spec, item).hit).toBe(true);
  });

  it('ranks by score, entry order breaks ties', () => {
    expect(rankedSemantic([sem('a', 0.5), sem('b', 0.7), sem('c', 0.7)]).map((r) => r.entry.memoryId)).toEqual(['b', 'c', 'a']);
  });

  it('a hit on a positive is correct only when the gold triggered it; topic-word hits report the gold separately', () => {
    const goldTopic = mk('p1', 'positive-shared', 'validate', [sem('g', 0.1, '내가 제일 좋아하는 과일은 사과야')], ['g']);
    const otherTopic = mk('p2', 'positive-shared', 'validate', [sem('x', 0.1, '과일 가게는 집 앞이야'), sem('g', 0.1)], ['g']);
    const wrongSemantic = mk('p3', 'positive-paraphrase', 'validate', [sem('x', 0.95), sem('g', 0.5)], ['g']);
    const rightSemantic = mk('p4', 'positive-paraphrase', 'validate', [sem('g', 0.95), sem('x', 0.5)], ['g']);
    const miss = mk('p5', 'positive-paraphrase', 'validate', [sem('g', 0.5)], ['g']);
    const stats = positiveStats([goldTopic, otherTopic, wrongSemantic, rightSemantic, miss], { family: 'F0' });
    expect(stats).toMatchObject({ n: 5, hits: 4, correct: 2, wrong: 2, topicHits: 2, topicHitsGold: 1 });
    expect(stats.correctRate).toBe(0.4);
    expect(stats.hitRate).toBe(0.8);
  });
});

describe('calibration', () => {
  it('picks the smallest grid tau with 0 false hits on the CALIBRATE negatives, then adds the +0.03 margin', () => {
    const items = [neg('a', 'calibrate', 0.55), neg('b', 'calibrate', 0.62), neg('c', 'validate', 0.8)];
    // a hit needs top1 >= tau, so 0.62 stops hitting at 0.63; the validate negative is not used
    expect(pickTau(items, 'F1')).toEqual({ smallestTau: 0.63, tau: 0.66 });
    expect(SAFETY_MARGIN).toBe(0.03);
  });

  it('the grid is 0.40 .. 0.90 step 0.01 and the margin may push the final tau above 0.90', () => {
    expect(TAU_GRID[0]).toBe(0.4);
    expect(TAU_GRID[TAU_GRID.length - 1]).toBe(0.9);
    expect(TAU_GRID).toHaveLength(51);
    expect(pickTau([neg('a', 'calibrate', 0.89)], 'F1')).toEqual({ smallestTau: 0.9, tau: 0.93 });
  });

  it('a top1 at or above the grid maximum, or a topic-word false hit, makes calibration FAIL (no tau gives 0 false hits)', () => {
    expect(pickTau([neg('a', 'calibrate', 0.95)], 'F1')).toEqual({ smallestTau: null, tau: null });
    const topicNegative = mk('t', 'negative', 'calibrate', [sem('a', 0.1, '내가 제일 좋아하는 과일은 사과야')]);
    expect(pickTau([topicNegative], 'F1').tau).toBeNull();
    const report = calibrateFamily([topicNegative], 'F1');
    expect(report).toMatchObject({ params: null, calibrationFailed: true, validate: null });
    expect(ownVerdict(f0Report([topicNegative]), report, calibrateFamily([topicNegative], 'F2')).choice).toBe('F0');
  });

  it('F2: per delta the smallest 0-false-hit tau; the delta with the best calibrate paraphrase rate wins; ties go to the larger delta', () => {
    // the negative has a tiny gap, so every delta clears it at the grid minimum; the paraphrase gap is large for all deltas: a tie
    const tie = [neg('n', 'calibrate', 0.8, 0.79), pp('p', 'calibrate', 0.9, 0.5)];
    const tied = calibrateFamily(tie, 'F2');
    expect(tied.params).toMatchObject({ delta: 0.15, tau: 0.43 });
    // a paraphrase with gap 0.07 is hit by delta 0.05 only: the smaller delta wins on the rate
    const small = [neg('n', 'calibrate', 0.8, 0.79), pp('p', 'calibrate', 0.9, 0.83)];
    const chosen = calibrateFamily(small, 'F2');
    expect(chosen.params).toMatchObject({ delta: 0.05 });
    expect(chosen.deltaOptions?.map((o) => o.delta)).toEqual([...DELTA_OPTIONS]);
    expect(chosen.deltaOptions?.map((o) => o.calibrateParaphraseCorrectRate)).toEqual([1, 0, 0]);
  });

  it('F2 calibrates with the gap: a negative with a high top1 but a small gap needs no high tau', () => {
    const items = [neg('n', 'calibrate', 0.85, 0.84)];
    expect(pickTau(items, 'F1')).toEqual({ smallestTau: 0.86, tau: 0.89 });
    expect(pickTau(items, 'F2', 0.05)).toEqual({ smallestTau: 0.4, tau: 0.43 });
  });
});

const split = (falseHits: number, correctRate: number): SplitStats => ({
  negatives: { n: 35, falseHits, byTopicWord: 0, bySemantic: falseHits },
  paraphrase: { n: 25, hits: 0, correct: 0, wrong: 0, topicHits: 0, topicHitsGold: 0, hitRate: correctRate, correctRate },
  shared: { n: 10, hits: 10, correct: 10, wrong: 0, topicHits: 10, topicHitsGold: 10, hitRate: 1, correctRate: 1 },
});
const family = (name: 'F0' | 'F1' | 'F2', validateFalse: number, validateRate: number, calibrated = true): FamilyReport => ({
  family: name,
  params: name === 'F0' || !calibrated ? null : { tau: 0.7, smallestTau: 0.67, ...(name === 'F2' ? { delta: 0.1 } : {}) },
  calibrationFailed: !calibrated,
  calibrate: split(0, validateRate),
  validate: split(validateFalse, validateRate),
});

describe('verdict boundaries', () => {
  const f0 = family('F0', 0, 0.1);
  it('qualifies needs 0 validate false hits and a paraphrase rate >= F0 + 0.20 (inclusive)', () => {
    expect(qualifies(family('F1', 0, 0.3), f0)).toBe(true);
    expect(qualifies(family('F1', 0, 0.2999), f0)).toBe(false);
    expect(qualifies(family('F1', 1, 0.9), f0)).toBe(false);
    expect(qualifies(family('F1', 0, 0.9, false), f0)).toBe(false);
  });

  it('prefers F1 over F2 when both qualify and the F1 rate is within 0.05 (inclusive), else F2', () => {
    expect(ownVerdict(f0, family('F1', 0, 0.6), family('F2', 0, 0.65)).choice).toBe('F1');
    expect(ownVerdict(f0, family('F1', 0, 0.6), family('F2', 0, 0.6501)).choice).toBe('F2');
    expect(ownVerdict(f0, family('F1', 0, 0.7), family('F2', 0, 0.6)).choice).toBe('F1');
  });

  it('adopts the only qualifying family; keeps F0 when none qualifies or the only candidate has a validate false hit', () => {
    expect(ownVerdict(f0, family('F1', 2, 0.9), family('F2', 0, 0.5)).choice).toBe('F2');
    expect(ownVerdict(f0, family('F1', 0, 0.5), family('F2', 1, 0.9)).choice).toBe('F1');
    expect(ownVerdict(f0, family('F1', 1, 0.9), family('F2', 1, 0.9))).toMatchObject({ choice: 'F0', qualified: [] });
    expect(ownVerdict(f0, family('F1', 0, 0.29), family('F2', 0, 0.2)).choice).toBe('F0');
  });
});

describe('full report on synthetic data', () => {
  const items: RuleQuestion[] = [
    neg('n1', 'calibrate', 0.5, 0.4),
    neg('n2', 'calibrate', 0.6, 0.5),
    neg('n3', 'validate', 0.55, 0.5),
    neg('n4', 'validate', 0.58, 0.5),
    pp('p1', 'calibrate', 0.8, 0.5),
    pp('p2', 'calibrate', 0.75, 0.6),
    pp('p3', 'validate', 0.85, 0.5),
    pp('p4', 'validate', 0.72, 0.5),
    mk('s1', 'positive-shared', 'validate', [sem('g', 0.3, '내가 제일 좋아하는 과일은 사과야')], ['g']),
  ];

  it('calibrates on the calibrate half, reports the validate half, and adopts F1 when it wins the pre-declared test', () => {
    const report = buildOwnRulesReport(items);
    expect(report.f0.validate?.paraphrase.correctRate).toBe(0);
    expect(report.f1.params?.smallestTau).toBe(0.61);
    expect(report.f1.params?.tau).toBe(0.64);
    expect(report.f1.validate?.negatives.falseHits).toBe(0);
    expect(report.f1.validate?.paraphrase.correctRate).toBe(1);
    expect(report.f1.validate?.shared.correctRate).toBe(1);
    expect(report.verdict.choice).toBe('F1');
    expect(report.grid).toHaveLength(TAU_GRID.length);
    expect(report.distributions.negativeTop1.all?.n).toBe(4);
    expect(report.distributions.goldScore['positive-paraphrase']).toMatchObject({ n: 4, unscored: 0 });
    expect(ownRulesLines(report).join('\n')).toContain('verdict (pre-declared, advisory): F1');
  });

  it('keeps F0 when a validate negative scores above the calibrated threshold', () => {
    const report = buildOwnRulesReport([...items, neg('n5', 'validate', 0.9, 0.5)]);
    expect(report.f1.validate?.negatives.falseHits).toBe(1);
    expect(report.verdict.choice).toBe('F0');
  });
});
