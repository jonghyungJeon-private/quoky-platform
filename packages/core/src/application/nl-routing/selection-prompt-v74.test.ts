import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES } from './action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { parseSelectionOutput } from './selection-output';
import { NL_ACTION_PROMPT_VERSION, NL_CANDIDATE_PROMPT_VERSIONS, NL_SELECTION_PROMPT_VERSION, buildSelectionPrompt } from './selection-prompt';
import { NL_WAVE1_ENTRIES } from './wave1-entries';
import { AGENT_PLAN_CANDIDATE_PROMPT_VERSION, AGENT_PLAN_PROMPT_VERSION, agentPlanPromptVersion, buildAgentPlanPrompt } from '../agent/plan-prompt';

// Candidate prompts `nl-select.v74` (read) / `.v75` (A6 action) / `.v76` (R2) and `agent-plan.v11`: the source-name
// principle plus the pure de-duplication S1-S5. NOT enabled anywhere: the default revision stays v73 / v10 (pinned by the
// existing tests), so a gate can build both and compare.

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const text = '내일 일정 알려줘';

describe('nl-select.v74 candidate (rev v74)', () => {
  const v73 = buildSelectionPrompt({ entries: READS, text });
  const v74 = buildSelectionPrompt({ entries: READS, text, rev: 'v74' });

  it('keeps the active version and the default text untouched', () => {
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v73');
    expect(NL_ACTION_PROMPT_VERSION).toBe('nl-select.v71');
    expect(NL_CANDIDATE_PROMPT_VERSIONS).toEqual({ read: 'nl-select.v74', action: 'nl-select.v75', r2: 'nl-select.v76' });
    expect(buildSelectionPrompt({ entries: READS, text, rev: 'v73' })).toBe(v73);
  });

  it('states ONE source-name principle in rule 1 and folds the per-source exceptions into it', () => {
    expect(v74).toContain("A source name selects that source's entry only when the message asks for that source's own data or names it as the");
    expect(v74).toContain('NEEDS_CLARIFICATION (rule 7)');
    expect(v74).not.toContain('names a source or');
    expect(v74).not.toContain('Pick it whenever the message names');
    expect(v73).toContain('names a source or a day');
    // The principle adds no example, no phrase list and no entry-specific note.
    expect(v74).not.toMatch(/드라이브.*(노래|드라이브 가|car|music)/);
  });

  it('removes only what the catalog arg lines already say (S1-S4)', () => {
    expect(v74).not.toContain('"alternatives":[]');
    expect(v74).not.toContain('Jira window: ONLY');
    expect(v74).not.toContain('Drive kind: ONLY');
    expect(v74).not.toContain('GitHub kind: pr ONLY');
    expect(v74).not.toContain('Search keyword (Slack, Confluence)');
    expect(v74).not.toContain('Jira order: sort');
    // The arg lines carry the rules, with the three cross-arg remnants moved onto them.
    expect(v74).toContain('A time word beside 할당된/배정된 ("어제 배정된") sets no window.');
    expect(v74).toContain('Never with query review-requests.');
    expect(v74).toContain('Never for a busy/free question (that is `availability`).');
    expect(v74.match(/Shared args/g)).toHaveLength(1);
    expect(v74.match(/how-many follow-up/g)).toHaveLength(1);
    // reminder.list lists no count, so it must not gain one.
    const reminder = v74.slice(v74.indexOf('- reminder.list:'), v74.indexOf('- brief.today:'));
    expect(reminder).not.toContain('count');
    // No Korean gloss at the end of an entry description (the line of an entry ends with its English text).
    for (const line of v74.split('\n').filter((l) => l.startsWith('- '))) expect(line).not.toMatch(/\([^)]*[가-힣][^)]*\)\s*$/);
  });

  it('every example output without `alternatives` still parses as the same selection', () => {
    const outputs = v74.split('\n').filter((l) => l.startsWith('Output: {')).map((l) => l.slice('Output: '.length));
    expect(outputs.length).toBeGreaterThan(30);
    for (const output of outputs) expect(parseSelectionOutput(output)).not.toBeNull();
  });

  it('is shorter than v73 and keeps the volatile tail last (prefix-cache order)', () => {
    expect(v74.length).toBeLessThan(v73.length);
    const prevAt = v74.lastIndexOf('Previous selection:');
    expect(v74.indexOf('Catalog:')).toBeLessThan(v74.indexOf('Examples:'));
    expect(v74.indexOf('Examples:')).toBeLessThan(prevAt);
    expect(v74.endsWith(`<<<\n${text}\n>>>`)).toBe(true);
  });

  it('builds the A6 and R2 candidate prompts on the v74 rule text (rule 8 still follows rule 7)', () => {
    const actions = { referenceContext: 'last listing: mail (2 items, 1 min ago)' };
    const a6 = buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, actions, rev: 'v74' });
    expect(a6).toContain('8. Action entries (only those in the catalog)');
    expect(a6.indexOf('Otherwise CLEAR; leave "alternatives" out')).toBeLessThan(a6.indexOf('8. Action entries'));
    expect(a6).toContain('reading or summarizing one listed mail is item.summarize (rule 8)');
    expect(a6).toContain("A source name selects that source's entry only when");
    expect(a6.length).toBeLessThan(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, actions }).length);
  });

  it('pins the candidate bytes (a change needs the next candidate version and its gate run)', () => {
    expect(sha(buildSelectionPrompt({ entries: READS, text, rev: 'v74' }))).toBe(PINNED_V74_READ);
    expect(sha(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, rev: 'v74', actions: { referenceContext: 'last listing: mail (2 items, 1 min ago)' } }))).toBe(PINNED_V74_ACTION);
  });
});

describe('agent-plan.v11 candidate (rev v11)', () => {
  const v10 = buildAgentPlanPrompt({ entries: READS, text });
  const v11 = buildAgentPlanPrompt({ entries: READS, text, rev: 'v11' });

  it('keeps v10 the default and names both versions', () => {
    expect(AGENT_PLAN_PROMPT_VERSION).toBe('agent-plan.v10');
    expect(AGENT_PLAN_CANDIDATE_PROMPT_VERSION).toBe('agent-plan.v11');
    expect(agentPlanPromptVersion()).toBe('agent-plan.v10');
    expect(agentPlanPromptVersion('v11')).toBe('agent-plan.v11');
    expect(buildAgentPlanPrompt({ entries: READS, text, rev: 'v10' })).toBe(v10);
  });

  it('is the v74 read prompt plus the unchanged planner rules and examples', () => {
    expect(v11.length).toBeLessThan(v10.length);
    expect(v11).toContain("A source name selects that source's entry only when");
    for (const kept of ['8. Plans (the steps form)', '9. References: for the details of the issues', '"steps": [{"entryId": "<entry id>"', 'Message: find the outage threads in slack and the outage page on confluence']) {
      expect(v11).toContain(kept);
    }
    const planRules = (prompt: string): string => prompt.slice(prompt.indexOf('8. Plans'), prompt.indexOf('Range symbols:'));
    expect(planRules(v11)).toBe(planRules(v10));
    expect(v11.endsWith(`<<<\n${text}\n>>>`)).toBe(true);
  });

  it('pins the candidate bytes', () => {
    expect(sha(v11)).toBe(PINNED_V11);
  });
});

const PINNED_V74_READ = 'c6af35974ecab3405ae42b41a95d11e3753ce7e553f6e3fde7d3cea5c955ea55';
const PINNED_V74_ACTION = 'e08bc9a7d3a91ecc04fb977929aa1875f263fae62395adac561f602c00782544';
const PINNED_V11 = 'a8869372f6257c6254bdc84842f4223ca630bda777525f35b31372900438e11d';
