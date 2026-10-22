import { describe, expect, it } from 'vitest';
import { jiraReleaseOutcomeKey, prepareSelectionInput } from '@quoky/core';
import { agentPlanEvalCases, loadAgentPlanCorpus, scoreAgentPlanOutput, scoreAgentPlanOutputInWorld } from './agent-plan-eval';
import { loadJiraWorldSnapshot, sameJiraReleaseOutcome, snapshotJiraConnector } from './jira-world-snapshot';
import { scoreReadRegression, scoreReadRegressionInWorld } from './nl-action-eval';
import { loadCorpus, scoreOutput, scoreOutputInWorld, type NlEvalCase } from './nl-intent-eval';

// Owner answer 1 of 2026-10-22 ("프로젝트 목록 스냅샷으로 채점"): jira.release scored by Core's final outcome in the snapshot
// Jira world. Offline: the snapshot connector, no network, no model.

const NOW = '2026-10-15T03:00:00.000Z';
const answer = (entryId: string, args: Record<string, unknown> = {}) => JSON.stringify({ entryId, args, ambiguity: 'CLEAR', alternatives: [] });
const CORPUS = loadCorpus().corpus;
const golden = (id: string): NlEvalCase => CORPUS.cases.find((candidate) => candidate.id === id) as NlEvalCase;
const releaseGolds = CORPUS.cases.filter((candidate) => candidate.expect !== 'none' && candidate.expect.entryId === 'jira.release');

describe('the snapshot Jira world (data, provenance in its header)', () => {
  it('holds the live-probe projects and the OP26 versions the golds presume', () => {
    const snapshot = loadJiraWorldSnapshot();
    expect(snapshot.siteHost).toBe('charancha.atlassian.net');
    expect(snapshot.projects).toContainEqual({ key: 'OP26', name: '차란차 플랫폼 운영 2026' });
    expect(snapshot.releases.OP26?.map((version) => version.id)).toContain('16555');
  });

  it('Core resolves every jira.release gold in it without error (the same path the handler runs)', async () => {
    const snapshot = loadJiraWorldSnapshot();
    for (const gold of releaseGolds) {
      if (gold.expect === 'none') continue;
      const prepared = prepareSelectionInput(gold.text);
      const key = await jiraReleaseOutcomeKey({ args: gold.expect.args, groundingText: 'skip' in prepared ? '' : prepared.groundingText, connector: snapshotJiraConnector(snapshot), siteHost: snapshot.siteHost, identity: snapshot.identity });
      expect(key, gold.id).not.toContain('failure:');
    }
  });
});

describe('a8-12 and a8-08: the observed selector outputs', () => {
  it('a8-12 {project: "차란차 운영", release: "2026"}: the same confirmation question as the gold, a hit by outcome', async () => {
    const raw = answer('jira.release', { project: '차란차 운영', release: '2026' });
    expect(scoreOutput(golden('a8-12'), raw, NOW).outcome).toBe('miss');
    expect(await scoreOutputInWorld(golden('a8-12'), raw, NOW)).toMatchObject({ outcome: 'hit', equivalent: true });
    expect((await scoreReadRegressionInWorld(golden('a8-12'), raw, NOW)).outcome).toBe('hit');
  });

  it('a8-08 {release: "OP26 20261015"}: the same release report (OP26, version 16555), a hit by outcome', async () => {
    const raw = answer('jira.release', { release: 'OP26 20261015' });
    expect(scoreOutput(golden('a8-08'), raw, NOW).outcome).toBe('miss');
    expect(await scoreOutputInWorld(golden('a8-08'), raw, NOW)).toMatchObject({ outcome: 'hit', equivalent: true });
    // {project: "OP"} is the gold's own args after the token-shape canonicalization: an exact hit.
    expect(await scoreOutputInWorld(golden('a8-08'), answer('jira.release', { project: 'OP', release: '20261015' }), NOW)).toEqual(expect.objectContaining({ outcome: 'hit' }));
    expect((await scoreOutputInWorld(golden('a8-08'), answer('jira.release', { project: 'OP', release: '20261015' }), NOW)).equivalent).toBeUndefined();
  });

  it('another outcome stays a miss: another project, a release without its project, another scope, a count', async () => {
    const misses: Array<[string, Record<string, unknown>]> = [
      ['a8-12', { project: '차란차 운영 2025' }],
      ['a8-12', { project: '차란차 운영' }],
      ['a8-12', { project: '차란차' }],
      ['a8-08', { release: '20261015' }],
      ['a8-08', { project: 'OP26' }],
      ['a8-08', { project: 'OP26', release: '20261020' }],
      ['a8-07', { project: '차란차 운영 2026', release: '20261015', scope: 'all' }],
      ['a8-11', { project: 'OP26', count: true }],
    ];
    for (const [id, args] of misses) {
      const scored = await scoreOutputInWorld(golden(id), answer('jira.release', args), NOW);
      expect(scored.outcome, `${id} ${JSON.stringify(args)}`).not.toBe('hit');
    }
  });

  it('only jira.release is compared by outcome; every other entry keeps exact args', async () => {
    const jira = CORPUS.cases.find((candidate) => candidate.expect !== 'none' && candidate.expect.entryId === 'jira.issues' && Object.keys(candidate.expect.args).length === 0) as NlEvalCase;
    expect((await scoreOutputInWorld(jira, answer('jira.issues', { status: 'all' }), NOW)).outcome).toBe(scoreOutput(jira, answer('jira.issues', { status: 'all' }), NOW).outcome);
    expect(await sameJiraReleaseOutcome('OP26 릴리스 목록', { project: 'OP26' }, { project: 'OP26' })).toBe(true);
  });

  it('the read regression keeps its exact outcome when no equivalence applies', async () => {
    // "차란차" alone names three visible projects (the ambiguous list), not the gold's confirmation question.
    const raw = answer('jira.release', { project: '차란차' });
    expect(scoreReadRegression(golden('a8-12'), raw, NOW).outcome).toBe('miss');
    expect(await scoreReadRegressionInWorld(golden('a8-12'), raw, NOW)).toEqual({ outcome: 'miss', relabeled: false, got: 'jira.release' });
  });
});

describe('the agent-plan scorer compares jira.release steps the same way', () => {
  const loaded = loadAgentPlanCorpus();
  const cases = agentPlanEvalCases(loaded.corpus, loaded.oneStep);

  it('a8-12 as a one-step case: exact by outcome; another project stays a miss', async () => {
    const one = cases.find((candidate) => candidate.id === 'a8-12');
    expect(one).toBeDefined();
    if (one === undefined) return;
    // A one-step gold is written in the selection form (as a perfect planner answers it).
    const raw = answer('jira.release', { project: '차란차 운영', release: '2026' });
    expect(scoreAgentPlanOutput(one, raw, loaded.corpus.fixture).outcome).toBe('miss');
    expect((await scoreAgentPlanOutputInWorld(one, raw, loaded.corpus.fixture)).outcome).toBe('exact');
    const other = answer('jira.release', { project: '차란차' });
    expect((await scoreAgentPlanOutputInWorld(one, other, loaded.corpus.fixture)).outcome).toBe('miss');
  });
});
