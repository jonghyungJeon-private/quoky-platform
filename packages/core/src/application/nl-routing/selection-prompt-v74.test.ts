import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NL_ACTION_ENTRIES, nlItemSummarizeEntry } from './action-entries';
import { NL_CATALOG_ENTRY_IDS, type NlCatalogEntry } from './catalog';
import { parseSelectionOutput } from './selection-output';
import {
  NL_ACTION_PROMPT_VERSION,
  NL_ACTION_R2_PROMPT_VERSION,
  NL_ACTIVE_PROMPT_REVS,
  NL_CANDIDATE_PROMPT_VERSIONS,
  NL_PREVIOUS_READ_PROMPT_VERSION,
  NL_SELECTION_PROMPT_VERSION,
  NL_V77_PROMPT_VERSIONS,
  NL_V79_PROMPT_VERSIONS,
  buildSelectionPrompt,
  nlPromptVersionFor,
} from './selection-prompt';
import { NL_WAVE1_ENTRIES } from './wave1-entries';
import { AGENT_PLAN_PREVIOUS_PROMPT_VERSION, AGENT_PLAN_PROMPT_VERSION, agentPlanPromptVersion, buildAgentPlanPrompt } from '../agent/plan-prompt';

// Enablement of `nl-select.v74` (read) and `agent-plan.v11` (planner) by default (owner decision 2026-11-04, after the D12
// gates). The A6 action / R2 prompts are `nl-select.v79` / `v80` by default (owner decision 2026-11-04, D12 gates passed);
// the old v71 / v72 are built only with an explicit `rev: 'v73'`, the v75 / v76 candidates with `rev: 'v74'`. The `rev` option is explicit-only for the other direction too:
// `rev: 'v73'` builds the previous read prompt and `rev: 'v10'` the previous planner byte for byte.

const READS: readonly NlCatalogEntry[] = NL_CATALOG_ENTRY_IDS.map((id) => NL_WAVE1_ENTRIES[id]);
const ACTIONS: readonly NlCatalogEntry[] = Object.values(NL_ACTION_ENTRIES).filter((entry): entry is NlCatalogEntry => entry !== undefined);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const text = '내일 일정 알려줘';

const ACTION_CONTEXT = { referenceContext: 'last listing: mail (2 items, 1 min ago)' };
const R2_ENTRIES: readonly NlCatalogEntry[] = [...READS, ...ACTIONS.filter((entry) => entry.id !== 'item.summarize'), nlItemSummarizeEntry(['jira', 'slack'])];

describe('per-mode default revision (owner decision 2026-11-04)', () => {
  it('names the active versions: read v74, action v83, R2 v84 (candidate, gates pending); v71 / v72 are explicit v73 only', () => {
    expect(NL_SELECTION_PROMPT_VERSION).toBe('nl-select.v74');
    expect(NL_PREVIOUS_READ_PROMPT_VERSION).toBe('nl-select.v73');
    expect(NL_ACTION_PROMPT_VERSION).toBe('nl-select.v83');
    expect(NL_ACTION_R2_PROMPT_VERSION).toBe('nl-select.v84');
    expect(NL_ACTIVE_PROMPT_REVS).toEqual({ read: 'v74', action: 'v83' });
    expect(NL_CANDIDATE_PROMPT_VERSIONS).toEqual({ action: 'nl-select.v75', r2: 'nl-select.v76' });
  });

  it('maps (mode, rev?) to the version id of the prompt that is built', () => {
    expect(nlPromptVersionFor('read')).toBe('nl-select.v74');
    expect(nlPromptVersionFor('read', 'v73')).toBe('nl-select.v73');
    expect(nlPromptVersionFor('read', 'v74')).toBe('nl-select.v74');
    expect(nlPromptVersionFor('action')).toBe('nl-select.v83');
    expect(nlPromptVersionFor('action', 'v81')).toBe('nl-select.v81');
    expect(nlPromptVersionFor('action', 'v79')).toBe('nl-select.v79');
    expect(nlPromptVersionFor('action', 'v73')).toBe('nl-select.v71');
    expect(nlPromptVersionFor('action', 'v74')).toBe('nl-select.v75');
    expect(nlPromptVersionFor('r2')).toBe('nl-select.v84');
    expect(nlPromptVersionFor('r2', 'v81')).toBe('nl-select.v82');
    expect(nlPromptVersionFor('r2', 'v79')).toBe('nl-select.v80');
    expect(nlPromptVersionFor('r2', 'v73')).toBe('nl-select.v72');
    expect(nlPromptVersionFor('r2', 'v74')).toBe('nl-select.v76');
  });

  it('the default read prompt is byte-identical to the gated v74 read text (pinned sha256)', () => {
    expect(sha(buildSelectionPrompt({ entries: READS, text }))).toBe(PINNED_V74_READ);
    expect(sha(buildSelectionPrompt({ entries: READS, text, rev: 'v74' }))).toBe(PINNED_V74_READ);
  });

  it('explicit rev v73 still builds the previous read prompt byte for byte', () => {
    expect(sha(buildSelectionPrompt({ entries: READS, text, rev: 'v73' }))).toBe(PINNED_V73_READ);
  });

  it('the rollback revs are byte-identical to before: explicit v81 / v79 are the pinned v79 / v80 bytes (v81 / v82 split the same text); explicit v73 is the old v71 / v72 bytes', () => {
    const action = buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, actions: ACTION_CONTEXT, rev: 'v81' });
    expect(sha(action)).toBe(PINNED_V79_ACTION);
    expect(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, actions: ACTION_CONTEXT, rev: 'v79' })).toBe(action);
    expect(sha(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, actions: ACTION_CONTEXT, rev: 'v73' }))).toBe(PINNED_V71_ACTION);
    const r2 = buildSelectionPrompt({ entries: R2_ENTRIES, text, actions: ACTION_CONTEXT, rev: 'v81' });
    expect(sha(r2)).toBe(PINNED_V80_R2);
    expect(buildSelectionPrompt({ entries: R2_ENTRIES, text, actions: ACTION_CONTEXT, rev: 'v79' })).toBe(r2);
    expect(sha(buildSelectionPrompt({ entries: R2_ENTRIES, text, actions: ACTION_CONTEXT, rev: 'v73' }))).toBe(PINNED_V72_R2);
    // The candidates are explicit-only.
    expect(sha(buildSelectionPrompt({ entries: R2_ENTRIES, text, actions: ACTION_CONTEXT, rev: 'v74' }))).toBe(PINNED_V76_R2);
  });

  it('the version ids follow the default: v73 is v71 / v72, absent is v83 / v84', () => {
    expect(nlPromptVersionFor('action', 'v73')).toBe('nl-select.v71');
    expect(nlPromptVersionFor('r2', 'v73')).toBe('nl-select.v72');
    expect(nlPromptVersionFor('action')).toBe(nlPromptVersionFor('action', 'v83'));
    expect(nlPromptVersionFor('r2')).toBe(nlPromptVersionFor('r2', 'v83'));
  });
});

describe('nl-select.v74 (rev v74)', () => {
  const v73 = buildSelectionPrompt({ entries: READS, text, rev: 'v73' });
  const v74 = buildSelectionPrompt({ entries: READS, text });

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
    expect(a6.length).toBeLessThan(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, actions, rev: 'v73' }).length);
  });

  it('pins the v74 read and v75 candidate action bytes (a change needs the next version and its gate run)', () => {
    expect(sha(buildSelectionPrompt({ entries: READS, text, rev: 'v74' }))).toBe(PINNED_V74_READ);
    expect(sha(buildSelectionPrompt({ entries: [...READS, ...ACTIONS], text, rev: 'v74', actions: { referenceContext: 'last listing: mail (2 items, 1 min ago)' } }))).toBe(PINNED_V74_ACTION);
  });
});

describe('nl-select.v77 / v78 (rev v77, action and R2 only)', () => {
  const entries = [...READS, ...ACTIONS];
  const v75 = buildSelectionPrompt({ entries, text, rev: 'v74', actions: ACTION_CONTEXT });
  const v77 = buildSelectionPrompt({ entries, text, rev: 'v77', actions: ACTION_CONTEXT });
  const v76 = buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v74', actions: ACTION_CONTEXT });
  const v78 = buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v77', actions: ACTION_CONTEXT });

  it('names the versions and rejects v77 in read mode', () => {
    expect(NL_V77_PROMPT_VERSIONS).toEqual({ action: 'nl-select.v77', r2: 'nl-select.v78' });
    expect(nlPromptVersionFor('action', 'v77')).toBe('nl-select.v77');
    expect(nlPromptVersionFor('r2', 'v77')).toBe('nl-select.v78');
    expect(() => nlPromptVersionFor('read', 'v77')).toThrow(/v77/);
    expect(() => buildSelectionPrompt({ entries: READS, text, rev: 'v77' })).toThrow(/v77/);
  });

  it('keeps v71 / v72 / v75 / v76 / read v73 / v74 bytes and pins v77 / v78', () => {
    expect(sha(buildSelectionPrompt({ entries, text, rev: 'v73', actions: ACTION_CONTEXT }))).toBe(PINNED_V71_ACTION);
    expect(sha(buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v73', actions: ACTION_CONTEXT }))).toBe(PINNED_V72_R2);
    expect(sha(v75)).toBe(PINNED_V74_ACTION);
    expect(sha(v76)).toBe(PINNED_V76_R2);
    expect(sha(buildSelectionPrompt({ entries: READS, text }))).toBe(PINNED_V74_READ);
    expect(sha(v77)).toBe(PINNED_V77_ACTION);
    expect(sha(v78)).toBe(PINNED_V78_R2);
  });

  it('is the v75 / v76 text plus the F1 / F3 / F4 lines (generic rules, no phrase list)', () => {
    for (const [added, base] of [[v77, v75], [v78, v76]] as const) {
      const baseLines = new Set(base.split('\n'));
      const extra = added.split('\n').filter((line) => !baseLines.has(line));
      const kept = base.split('\n').filter((line) => !new Set(added.split('\n')).has(line));
      expect(extra.join('\n')).toContain('then it is reminder.create also when the thing is a meeting or an appointment');
      expect(extra.join('\n')).toContain('only when the owner affirmatively asks to be notified later');
      expect(extra.join('\n')).not.toContain('explicit reminder or notification word');
      expect(extra.join('\n')).toContain('is not part of the span');
      expect(extra.join('\n')).toContain('even a vague one, goes in `when`');
      // The only v75 line that goes away is the rule-2 line carrying the stale "sets a reminder: none".
      expect(kept).toHaveLength(0);
      expect(added).not.toContain('sets a reminder: none');
    }
    expect(v75).not.toContain('a leading clause that only says when');
  });

  it('puts the lines in rule 8 only and keeps rule 5 intact', () => {
    expect(v77.indexOf('is reminder.create also when')).toBeGreaterThan(v77.indexOf('8. Action entries'));
    expect(v77).toContain('5. Use only the arg names and values listed for the chosen entry. Omit every arg the owner did not imply; never guess.');
    expect(v77.indexOf('rule 5 does not omit it')).toBeGreaterThan(v77.indexOf('8. Action entries'));
  });
});

describe('nl-select.v79 / v80 (rev v79 = v77 with the Korean glosses restored)', () => {
  const entries = [...READS, ...ACTIONS];
  const v77 = buildSelectionPrompt({ entries, text, rev: 'v77', actions: ACTION_CONTEXT });
  const v79 = buildSelectionPrompt({ entries, text, rev: 'v79', actions: ACTION_CONTEXT });
  const v78 = buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v77', actions: ACTION_CONTEXT });
  const v80 = buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v79', actions: ACTION_CONTEXT });
  const stripGlosses = (prompt: string, list: readonly NlCatalogEntry[]): string => {
    let out = prompt;
    for (const entry of list) {
      const gloss = ` (${entry.description.ko})`;
      const lines = out.split('\n').map((line) => (line.startsWith(`- ${entry.id}: `) && line.endsWith(gloss) ? line.slice(0, -gloss.length) : line));
      out = lines.join('\n');
    }
    return out;
  };

  it('names the versions and rejects v79 in read mode', () => {
    expect(NL_V79_PROMPT_VERSIONS).toEqual({ action: 'nl-select.v79', r2: 'nl-select.v80' });
    expect(nlPromptVersionFor('action', 'v79')).toBe('nl-select.v79');
    expect(nlPromptVersionFor('r2', 'v79')).toBe('nl-select.v80');
    expect(() => nlPromptVersionFor('read', 'v79')).toThrow(/v79/);
    expect(() => buildSelectionPrompt({ entries: READS, text, rev: 'v79' })).toThrow(/v79/);
  });

  it('keeps every earlier pin and pins v79 / v80', () => {
    expect(sha(buildSelectionPrompt({ entries, text, rev: 'v73', actions: ACTION_CONTEXT }))).toBe(PINNED_V71_ACTION);
    expect(sha(buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v73', actions: ACTION_CONTEXT }))).toBe(PINNED_V72_R2);
    expect(sha(buildSelectionPrompt({ entries, text, rev: 'v74', actions: ACTION_CONTEXT }))).toBe(PINNED_V74_ACTION);
    expect(sha(buildSelectionPrompt({ entries: R2_ENTRIES, text, rev: 'v74', actions: ACTION_CONTEXT }))).toBe(PINNED_V76_R2);
    expect(sha(v77)).toBe(PINNED_V77_ACTION);
    expect(sha(v78)).toBe(PINNED_V78_R2);
    expect(sha(buildSelectionPrompt({ entries: READS, text }))).toBe(PINNED_V74_READ);
    expect(sha(v79)).toBe(PINNED_V79_ACTION);
    expect(sha(v80)).toBe(PINNED_V80_R2);
  });

  it('has the Korean gloss on every catalog entry line in v79 / v80 and on none in v77 / v78', () => {
    for (const [with79, with77, list] of [[v79, v77, entries], [v80, v78, R2_ENTRIES]] as const) {
      for (const entry of list) {
        const line79 = with79.split('\n').find((line) => line.startsWith(`- ${entry.id}: `));
        const line77 = with77.split('\n').find((line) => line.startsWith(`- ${entry.id}: `));
        expect(line79?.endsWith(` (${entry.description.ko})`), entry.id).toBe(true);
        expect(line77?.endsWith(` (${entry.description.ko})`), entry.id).toBe(false);
      }
    }
  });

  it('is v77 / v78 plus the glosses and nothing else (S5 sentence removal stays)', () => {
    expect(stripGlosses(v79, entries)).toBe(v77);
    expect(stripGlosses(v80, R2_ENTRIES)).toBe(v78);
    expect(v79).not.toContain('Pick it whenever the message names');
    expect(v79.length).toBeGreaterThan(v77.length);
  });
});

describe('agent-plan.v11 (rev v11, the default)', () => {
  const v10 = buildAgentPlanPrompt({ entries: READS, text, rev: 'v10' });
  const v11 = buildAgentPlanPrompt({ entries: READS, text });

  it('makes v11 the default, keeps v10 buildable byte for byte, and names both versions', () => {
    expect(AGENT_PLAN_PROMPT_VERSION).toBe('agent-plan.v11');
    expect(AGENT_PLAN_PREVIOUS_PROMPT_VERSION).toBe('agent-plan.v10');
    expect(agentPlanPromptVersion()).toBe('agent-plan.v11');
    expect(agentPlanPromptVersion('v10')).toBe('agent-plan.v10');
    expect(buildAgentPlanPrompt({ entries: READS, text, rev: 'v11' })).toBe(v11);
    expect(sha(v10)).toBe(PINNED_V10);
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

  it('the default planner prompt is byte-identical to the gated v11 text (pinned sha256)', () => {
    expect(sha(v11)).toBe(PINNED_V11);
  });
});

const PINNED_V74_READ = 'c6af35974ecab3405ae42b41a95d11e3753ce7e553f6e3fde7d3cea5c955ea55';
const PINNED_V74_ACTION = 'e08bc9a7d3a91ecc04fb977929aa1875f263fae62395adac561f602c00782544';
const PINNED_V11 = 'a8869372f6257c6254bdc84842f4223ca630bda777525f35b31372900438e11d';
const PINNED_V73_READ = '974bd1183d5f7f31f4fbbc5ac98191203a14a2d565437c725b853e61711e4ed2';
const PINNED_V71_ACTION = '24bbbd3230e3475ccf7ae8618a90a74156cc3512f06b1fe0c1b6532e1c83f06f';
const PINNED_V72_R2 = '768bcf90328082066a2722180cc7a67f81cb228030a89535c02c35e563e57c34';
const PINNED_V76_R2 = '8ffb282c8e8714667ce57c2a72acdd8dfe5de2b4d0784870df174bc498dfa333';
const PINNED_V77_ACTION = 'c4313c45ab3f847b65a57e09f481561b26b073c9c2705f9871700b7c3459582f';
const PINNED_V78_R2 = 'a93c69ddf32e3a2fdfbcefc1f5bd480952dc8e12280075d460e882bea2ce19ff';
const PINNED_V79_ACTION = 'e46c310d21de33774acf628a58225f2068a6395d7227034e99ec571fc34d357a';
const PINNED_V80_R2 = 'fef5c6842cb36cbf72d770195651901da5e66b3687c9a1f996f5fb70694991fd';
const PINNED_V10 = '6543ae28546a0657c41985c4a27a4be4eb65a216759c2e031da762f1fa8892d6';
