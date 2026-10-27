import { afterEach, describe, expect, it } from 'vitest';
import * as core from '@quoky/core';
import { loadContextEvalCorpus, quotedSegments } from './tools/context-eval';
import { bootContextEvalWorld, type ContextEvalWorld } from './tools/context-eval-harness';
import { instantiatePlaceholders } from './tools/context-eval-runner';

/**
 * Owner decision D2 (2026-10-26): Core's own copy quotes only commands that resolve deterministically. Every quoted command
 * in a catalog entry's usage (KO and EN) is sent alone in a fresh DM over the production AppModule with the selector
 * answering none; it must be answered without chat. Read entries are checked under `deployed`, action entries where
 * they act (`actions-local`). A selector-only entry (jira.release, brief.today) shows an unquoted example instead.
 */
const NONE = JSON.stringify({ entryId: 'none', args: {}, ambiguity: 'CLEAR', alternatives: [] });
let world: ContextEvalWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function chatBound(profile: 'deployed' | 'actions-local', entries: readonly core.NlCatalogEntry[]): Promise<string[]> {
  const { corpus } = loadContextEvalCorpus();
  world = await bootContextEvalWorld(profile, { select: async () => NONE, chat: async () => 'x', summarize: async () => 'x' });
  const owner = await world.beginScenario(0, corpus.worlds.office ?? {});
  const failures: string[] = [];
  for (const entry of entries) {
    for (const language of ['ko', 'en'] as const) {
      for (const command of quotedSegments(entry.usage[language])) {
        const turn = await world.turn(owner, instantiatePlaceholders(command), world.freshDm());
        if (turn.chatPrompts.length > 0) failures.push(`${entry.id} ${language}: ${command}`);
      }
    }
  }
  return failures;
}

describe('catalog usage commands resolve deterministically (owner decision D2)', () => {
  it('every quoted read-entry usage command is answered without chat (deployed)', async () => {
    expect(await chatBound('deployed', Object.values(core.NL_WAVE1_ENTRIES))).toEqual([]);
  }, 120_000);

  it('every quoted action-entry usage command is answered without chat where actions act (actions-local)', async () => {
    const actions = Object.values(core.NL_ACTION_ENTRIES).filter((entry): entry is core.NlCatalogEntry => entry !== undefined);
    expect(await chatBound('actions-local', actions)).toEqual([]);
  }, 120_000);

  it('selector-only entries quote no command', () => {
    for (const id of ['jira.release', 'brief.today'] as const) {
      const entry = core.NL_WAVE1_ENTRIES[id];
      expect(quotedSegments(entry.usage.ko), id).toEqual([]);
      expect(quotedSegments(entry.usage.en), id).toEqual([]);
    }
  });
});
