import { describe, expect, it } from 'vitest';
import type { ProviderSelectionPolicy } from '../../ports/provider-selection-policy.port';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { newSummaryRunToken, summaryGrantFor, summaryReadiness, type QuarantinedSummarizerRoute } from './quarantined-summary';
import { ownerSummaryConsentSources, ownerSummaryRequests, summaryGrantBasis, type OwnerText } from './summary-grant';

// ADR-0121 A5-S3 grant-consent: the grant producer reads the summary-readout label (the five work sources join mail and Drive),
// the separable particle of "sum up" is a clause-structure rule, and the owner's English source names are catalog data. With
// every per-source switch off nothing reachable changes: the summary stays listing-only with its pre-A5 reason.

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const read = (entryId: NlWave1EntryId): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit: 3 }, provenance: {} });
const summarize = (from: number[]): ValidatedAgentStep => ({ kind: 'summarize', from, schema: 'digest.v1' });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
const grounding = (text: string): OwnerText => {
  const prepared = prepareSelectionInput(text);
  if ('skip' in prepared) throw new Error('skipped');
  return prepared;
};
const granted = (p: RunPlan, text: string): string[] => ownerSummaryRequests(p, grounding(text)).map((request) => `${request.step}:${request.entryId}`);
const one = (entryId: NlWave1EntryId): RunPlan => plan([read(entryId), summarize([1])]);

const WORK = ['calendar.events', 'jira.issues', 'jira.release', 'slack.search', 'confluence.search', 'github.items'] as const satisfies readonly NlWave1EntryId[];

describe('A5-S3: the grant producer covers the five work sources through the label', () => {
  it('grants each work source when the owner\'s own clause names it and asks a summary', () => {
    expect(granted(one('calendar.events'), '내일 일정 요약해줘')).toEqual(['2:calendar.events']);
    expect(granted(one('jira.issues'), '지라 이슈 요약해줘')).toEqual(['2:jira.issues']);
    expect(granted(one('slack.search'), '슬랙에서 배포 검색해서 요약해줘')).toEqual(['2:slack.search']);
    expect(granted(one('confluence.search'), '컨플루언스 위키 정리해줘')).toEqual(['2:confluence.search']);
    expect(granted(one('github.items'), '깃허브 PR 요약해줘')).toEqual(['2:github.items']);
  });

  it('mail and Drive grants are unchanged, and a work source the words did not ask stays ungranted', () => {
    expect(granted(plan([read('mail.list'), summarize([1])]), '메일 3개 요약해줘')).toEqual(['2:mail.list']);
    expect(granted(plan([read('drive.files'), summarize([1])]), 'summarize my drive files')).toEqual(['2:drive.files']);
    expect(granted(plan([read('jira.issues'), read('mail.list'), summarize([1, 2])]), '메일 요약해줘')).toEqual(['3:mail.list']);
    expect(granted(one('jira.issues'), '지라 이슈 보여줘')).toEqual([]);
    expect(granted(one('jira.issues'), '지라 이슈 요약하지 마')).toEqual([]);
  });

  it('names every granted source once per summarize step, sorted (the data of the one consent question, W5 amended)', () => {
    const p = plan([read('jira.issues'), read('mail.list'), summarize([1, 2])]);
    expect(ownerSummaryConsentSources(p, grounding('지라랑 메일 요약해줘'))).toEqual([{ step: 3, sources: ['jira', 'mail'] }]);
    expect(ownerSummaryConsentSources(one('github.items'), grounding('깃허브 요약해줘'))).toEqual([{ step: 2, sources: ['github'] }]);
    expect(ownerSummaryConsentSources(one('github.items'), grounding('깃허브 보여줘'))).toEqual([]);
  });
});

describe('A5-S3: the catalog\'s own English source names ground a source (data, no phrase list in the producer)', () => {
  it('pull requests, repositories and meetings name their source; "repo" and "report" name no GitHub', () => {
    expect(granted(one('github.items'), 'summarize my open pull requests')).toEqual(['2:github.items']);
    expect(granted(one('github.items'), 'summarize the open issues in my repository')).toEqual(['2:github.items']);
    // `repo` is not an alias (substring hazard in honest-chat: "report"): these two name no GitHub source.
    expect(granted(one('github.items'), 'summarize the open issues on my repo')).toEqual([]);
    expect(granted(one('github.items'), 'summarize the report')).toEqual([]);
    expect(granted(one('calendar.events'), 'summarize my meetings this week')).toEqual(['2:calendar.events']);
  });

  it('a word that only contains a source name does not name it', () => {
    expect(granted(one('github.items'), 'summarize the report')).toEqual([]);
    expect(granted(one('calendar.events'), 'summarize the meetingroom')).toEqual([]);
  });
});

describe('A5-S3: the separable particle of "sum up" (a clause-structure rule)', () => {
  const jira = one('jira.issues');
  it('a clause that holds the verb and ends in the particle with an object between is a summary request', () => {
    expect(granted(jira, 'show the jira tickets assigned to me and sum them up')).toEqual(['2:jira.issues']);
    expect(granted(jira, 'show my jira tickets and sum it up')).toEqual(['2:jira.issues']);
    expect(granted(jira, 'show my jira tickets and sum all of them up')).toEqual(['2:jira.issues']);
    expect(granted(jira, 'sum my jira tickets up')).toEqual(['2:jira.issues']);
  });

  it('fails closed: no object, a particle that is not last, too far apart, or a negation', () => {
    expect(granted(jira, 'show my jira tickets and sum')).toEqual([]);
    expect(granted(jira, 'show my jira tickets and sum them up later')).toEqual([]);
    expect(granted(jira, 'show my jira tickets and sum one two three four up')).toEqual([]);
    expect(granted(jira, 'show my jira tickets and do not sum them up')).toEqual([]);
    expect(granted(jira, 'show my jira tickets and set them up')).toEqual([]);
  });

  it('the contiguous form is unchanged', () => {
    expect(granted(jira, 'show my jira tickets and sum up')).toEqual(['2:jira.issues']);
  });
});

describe('A5-S3: with every switch off nothing reachable changes', () => {
  const policy: ProviderSelectionPolicy = { preferenceFor: async () => null, isEligible: () => true };
  const route = (on?: QuarantinedSummarizerRoute['workSummarySources']): QuarantinedSummarizerRoute => ({
    selector: new CapabilityRouter(new AiProviderManager([]), policy),
    ...(on !== undefined ? { workSummarySources: on } : {}),
  });
  const TEXT: Record<(typeof WORK)[number], string> = {
    'calendar.events': '내일 일정 요약해줘',
    'jira.issues': '지라 이슈 요약해줘',
    'jira.release': '지라 릴리즈 요약해줘',
    'slack.search': '슬랙 검색 요약해줘',
    'confluence.search': '컨플루언스 위키 요약해줘',
    'github.items': '깃허브 PR 요약해줘',
  };

  it('the producer-minted grant leaves the summary listing-only with the pre-A5 reason while the source switch is off', async () => {
    for (const entryId of WORK) {
      const p = one(entryId);
      const basis = summaryGrantBasis(p, grounding(TEXT[entryId]));
      const run = newSummaryRunToken();
      const grant = summaryGrantFor(2, entryId, run, { basis, plan: p });
      expect(grant, entryId).toBeDefined();
      const reasons = [];
      for (const on of [undefined, [], ['mail'] as never, entryId.startsWith('jira') ? ['slack' as const] : ['jira' as const]]) {
        reasons.push(await summaryReadiness({ entryId, schema: 'digest.v1', summaryStep: 2, grant, run, askedItems: 1, route: route(on as never) }));
      }
      const expected = entryId === 'jira.issues' || entryId === 'jira.release' || entryId === 'slack.search' ? 'work-text-controls-not-built' : 'no-readout-source';
      expect(reasons, entryId).toEqual([expected, expected, expected, expected]);
    }
  });

  it('with the source switch on, the grant is what lets the summary past the grant check (it still needs a provider)', async () => {
    const p = one('jira.issues');
    const run = newSummaryRunToken();
    const withGrant = summaryGrantFor(2, 'jira.issues', run, { basis: summaryGrantBasis(p, grounding('지라 이슈 요약해줘')), plan: p });
    const without = summaryGrantFor(2, 'jira.issues', run, { basis: summaryGrantBasis(p, grounding('지라 이슈 보여줘')), plan: p });
    expect(await summaryReadiness({ entryId: 'jira.issues', schema: 'digest.v1', summaryStep: 2, grant: without, run, askedItems: 1, route: route(['jira']) })).toBe('no-summary-grant');
    expect(await summaryReadiness({ entryId: 'jira.issues', schema: 'digest.v1', summaryStep: 2, grant: withGrant, run, askedItems: 1, route: route(['jira']) })).not.toBe('no-summary-grant');
  });
});
