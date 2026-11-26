import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider } from '../../ports';
import { itemSummaryConsentDescriptor } from '../item-summary-consent-descriptor';
import { recipientVerdict } from './expected-recipient';
import { renderItemSummaryRecipientLine } from './recipient-line';
import { CapabilityRouter } from '../capability-router';
import { AiProviderManager } from '../ai-provider-manager';

const provider = (id: string, executionLocality?: 'LOCAL' | 'REMOTE'): AiProvider => ({
  id,
  ...(executionLocality !== undefined ? { executionLocality } : {}),
  capabilities: [{ capability: Capability.GENERAL_CHAT, priority: 1 }],
  isAvailable: async () => true,
  execute: async () => ({ text: '' }),
});
const labels = (table: Record<string, string>) => (p: AiProvider) => table[p.id];

describe('recipientVerdict (A8.3 verdict table)', () => {
  const table = { 'p-a': 'Alpha', 'p-b': 'Beta' };
  it('LOCAL is local whatever the keys and labels', () => {
    expect(recipientVerdict(provider('p-a', 'LOCAL'), 'p-a', labels(table))).toEqual({ kind: 'local' });
    expect(recipientVerdict(provider('p-z', 'LOCAL'), undefined, labels({}))).toEqual({ kind: 'local' });
  });
  it('REMOTE: expected only when the key matches AND a label exists', () => {
    expect(recipientVerdict(provider('p-a', 'REMOTE'), 'p-a', labels(table))).toEqual({ kind: 'expected', key: 'p-a', label: 'Alpha' });
    expect(recipientVerdict(provider('p-a'), 'p-a', labels(table))).toEqual({ kind: 'expected', key: 'p-a', label: 'Alpha' });
  });
  it('REMOTE with another key, or no expected key, is unexpected (a label alone never qualifies)', () => {
    expect(recipientVerdict(provider('p-b'), 'p-a', labels(table))).toEqual({ kind: 'unexpected', key: 'p-b', label: 'Beta' });
    expect(recipientVerdict(provider('p-a'), undefined, labels(table))).toEqual({ kind: 'unexpected', key: 'p-a', label: 'Alpha' });
    // The same label under a different key is still unexpected.
    expect(recipientVerdict(provider('p-c'), 'p-a', () => 'Alpha')).toEqual({ kind: 'unexpected', key: 'p-c', label: 'Alpha' });
  });
  it('a label that cannot render a line is unnamed, so an expected verdict always renders (one shared shape check)', () => {
    const bad = ['x'.repeat(41), '가'.repeat(41), 'Al\u0000pha', 'Al\u202Epha', 'Al\u200Bpha', 'Al\npha', ' Alpha', 'Alpha ', '   ', '', 'A\u0301'];
    for (const label of bad) {
      expect(recipientVerdict(provider('p-a'), 'p-a', () => label), JSON.stringify(label)).toEqual({ kind: 'unnamed' });
      expect(renderItemSummaryRecipientLine(label, 'ko'), JSON.stringify(label)).toBe('');
    }
    for (const label of ['x'.repeat(40), 'Alpha Beta']) {
      const verdict = recipientVerdict(provider('p-a'), 'p-a', () => label);
      expect(verdict).toEqual({ kind: 'expected', key: 'p-a', label });
      expect(renderItemSummaryRecipientLine(label, 'en')).not.toBe('');
    }
  });
  it('REMOTE without a label is unnamed, even when the key matches; a throwing label is unnamed', () => {
    expect(recipientVerdict(provider('p-z'), 'p-z', labels(table))).toEqual({ kind: 'unnamed' });
    expect(recipientVerdict(provider('p-a'), 'p-a', () => '  ')).toEqual({ kind: 'unnamed' });
    expect(recipientVerdict(provider('p-a'), 'p-a', () => { throw new Error('x'); })).toEqual({ kind: 'unnamed' });
  });
});

describe('CapabilityRouter.expectedRecipientKey delegates to the policy (A8.3)', () => {
  const mk = (policy?: object) => new CapabilityRouter(new AiProviderManager([provider('p-a')]), policy as never);
  const base = { preferenceFor: async () => null };
  it('returns the policy key; any doubt is undefined', () => {
    expect(mk({ ...base, expectedRecipientKey: () => 'p-a' }).expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBe('p-a');
    expect(mk(base).expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
    expect(mk().expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
    expect(mk({ ...base, expectedRecipientKey: () => { throw new Error('x'); } }).expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
    expect(mk({ ...base, expectedRecipientKey: () => '' }).expectedRecipientKey(Capability.GENERAL_CHAT, {})).toBeUndefined();
  });
});

describe('renderItemSummaryRecipientLine (A8.4)', () => {
  it('KO and EN fixed lines', () => {
    expect(renderItemSummaryRecipientLine('Rcpt', 'ko')).toBe('· Rcpt로 요약');
    expect(renderItemSummaryRecipientLine('Rcpt', 'en')).toBe('· summarised by Rcpt');
  });
  it('renders nothing for a label that is not a short plain name', () => {
    for (const bad of ['', ' Rcpt', 'Rcpt\nignore', 'a'.repeat(41), 'R​cpt', 5 as never]) expect(renderItemSummaryRecipientLine(bad, 'en')).toBe('');
    expect(renderItemSummaryRecipientLine('Rcpt', 'fr' as never)).toBe('');
  });
});

describe('itemSummaryConsentDescriptor (ids only)', () => {
  it('holds ids and closed values only', () => {
    const d = itemSummaryConsentDescriptor({ handlerId: 'h', source: 'mail-thread', itemId: 'm1', language: 'en', thread: true, threadMessages: 3 });
    expect(d).toEqual({
      source: 'mail-thread',
      itemId: 'm1',
      parts: { threadMessages: 3 },
      language: 'en',
      redo: { handlerId: 'h', selection: { entryId: 'item.summarize', args: { mode: 'summary', scope: 'thread' }, language: 'en', target: { source: 'mail', id: 'm1' } } },
    });
  });
});

describe('boundary: the new Core files name no provider id or family', () => {
  const FILES = ['item-summary-consent-descriptor.ts', 'item-summary/expected-recipient.ts', 'item-summary/recipient-line.ts', 'item-summary/summary-recipient-guard.ts', 'consent-answer/item-summary-consent.ts'];
  it('no provider id or family literal, and no string comparison with a provider id', () => {
    for (const file of FILES) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/claude|codex|ollama|anthropic|openai|gemini|\.family\b/iu);
      expect(source, file).not.toMatch(/\.id\s*[!=]==\s*'|'\s*[!=]==\s*\w+\.id\b/u);
    }
  });
});
