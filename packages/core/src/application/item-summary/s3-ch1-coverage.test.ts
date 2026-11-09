import { describe, expect, it } from 'vitest';
import { AiProviderManager } from '../ai-provider-manager';
import { CapabilityRouter } from '../capability-router';
import { chunk, joinSections, packWindows, type ChunkSection } from '../chunking';
import { Capability } from '../../domain';
import type { AiProvider } from '../../ports';
import type { UntrustedDocumentSource } from '../untrusted-document-readout';
import { S3_LIMITS, runS3ItemSummary } from './s3-item-summary';

/**
 * CA ruling on CH1 for an S3-only `on` (DECISIONS ADR-0124 section 17), condition (c): the model-free test that replaces
 * CH1 for S3. Over the CH1 shapes and lengths, every item that packs into at most 6 windows is read in full
 * (`coverage.complete`); every longer item is read by stratified coverage with its first and last passages. No model: a
 * fixed fake note.
 */

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function word(seed: number, length: number): string {
  let out = '';
  for (let at = 0; at < length; at += 1) out += LETTERS[(seed * 11 + at * 5) % 26];
  return out;
}
function sentence(seed: number): string {
  const text = [6, 3, 5, 7, 4, 2, 6, 5, 8, 3].map((length, at) => word(seed + at, length)).join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
function prose(seed: number, sentences: number): string {
  return Array.from({ length: sentences }, (_, at) => sentence(seed * 97 + at)).join(' ');
}

interface Shape {
  readonly name: string;
  readonly source: UntrustedDocumentSource;
  /** Builds an item of about `target` code points: its text and, for sectioned shapes, its sections. */
  build(target: number): { readonly prepared: string; readonly sections?: readonly ChunkSection[] };
}

function sectioned(count: number, part: (index: number, size: number) => string, frame: (index: number) => string, kind?: 'table') {
  return (target: number) => {
    const size = Math.max(60, Math.floor(target / count));
    const joined = joinSections(Array.from({ length: count }, (_, index) => ({ frame: frame(index), body: part(index, size), ...(kind !== undefined ? { kind } : {}) })));
    return { prepared: joined.text, sections: joined.sections };
  };
}
function fill(index: number, size: number): string {
  let text = '';
  for (let at = 0; text.length < size; at += 1) text += `${text.length > 0 ? ' ' : ''}${sentence(index * 131 + at)}`;
  return text;
}
function rows(index: number, size: number): string {
  const lines = ['Name | Owner | Due | Status'];
  for (let at = 0; lines.join('\n').length < size; at += 1) lines.push(`${word(index + at, 7)} | ${word(index * 3 + at, 5)} | 2026-11-${String((at % 28) + 1).padStart(2, '0')} | ${word(at, 4)}`);
  return lines.join('\n');
}

const SHAPES: readonly Shape[] = [
  { name: 'mail', source: 'mail', build: (target) => ({ prepared: Array.from({ length: Math.ceil(target / 700) }, (_, index) => prose(index, 9)).join('\n\n') }) },
  { name: 'thread (14 messages)', source: 'mail-thread', build: sectioned(14, fill, (index) => `[메시지 ${index + 1}/14]`) },
  {
    name: 'Drive document',
    source: 'drive',
    build: (target) => ({ prepared: Array.from({ length: Math.ceil(target / 760) }, (_, index) => `## ${word(index, 8)}\n\n${prose(index + 500, 9)}`).join('\n\n') }),
  },
  { name: 'workbook (20 sheets)', source: 'drive', build: sectioned(20, rows, (index) => `[Sheet ${index + 1}/20] "${word(index, 6)}"`, 'table') },
  { name: 'Jira issue (40 comments)', source: 'jira-issue', build: sectioned(40, fill, (index) => (index === 0 ? '설명' : `댓글 ${index}`)) },
  { name: 'Slack thread (120 replies)', source: 'slack-thread', build: sectioned(120, fill, (index) => `참여자 ${String.fromCharCode(65 + (index % 26))}`) },
  {
    name: 'ADR file',
    source: 'drive',
    build: (target) => ({
      prepared: Array.from({ length: Math.ceil(target / 900) }, (_, index) =>
        index % 4 === 3 ? `\`\`\`ts\nconst ${word(index, 6)} = ${index};\nexport function ${word(index + 1, 7)}() { return ${index}; }\n\`\`\`` : `### ${word(index, 9)}\n\n${prose(index + 900, 9)}`,
      ).join('\n\n'),
    }),
  },
];
const LENGTHS = [6_000, 20_000, 60_000, 87_000] as const;

function local(): AiProvider {
  return {
    id: 'local',
    executionLocality: 'LOCAL',
    capabilities: [{ capability: Capability.SUMMARIZATION, priority: 10 }],
    isAvailable: async () => true,
    execute: async (request) => ({ text: request.prompt.includes('You are the note-taker of Quoky') ? '- The part lists its items.' : 'Final summary line.' }),
  };
}

describe('CH1 replacement for S3 (CA ruling condition c): coverage over the CH1 shapes and lengths', () => {
  it.each(SHAPES.flatMap((shape) => LENGTHS.map((length) => [shape.name, length, shape] as const)))('%s, %d code points', async (_name, length, shape) => {
    const { prepared, sections } = shape.build(length);
    const passages = chunk(prepared, sections);
    const full = packWindows(prepared, passages, passages.map((passage) => passage.ordinal));
    const router = new CapabilityRouter(new AiProviderManager([local()]));
    const outcome = await runS3ItemSummary(
      { mode: 'on', source: shape.source, title: 'Item', author: '', date: '', prepared, ...(sections !== undefined ? { sections } : {}), requestText: '요약해줘', language: 'ko' },
      { selector: router, now: () => 0, wait: (_ms, signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) },
    );
    if (full.length <= 1) {
      expect(outcome.kind).toBe('S1');
      return;
    }
    if (outcome.kind !== 'summary') throw new Error(`expected a summary, got ${outcome.kind}`);
    if (full.length <= S3_LIMITS.maxWindows) {
      // Every item within the cap is read in full.
      expect(outcome.audit.stratified).toBe(false);
      expect(outcome.coverage.complete).toBe(true);
      expect(outcome.coverage.read).toBe(passages.length);
    } else {
      expect(outcome.audit).toMatchObject({ stratified: true, windows: S3_LIMITS.maxWindows });
      expect(outcome.coverage.complete).toBe(false);
      expect(outcome.coverage.read).toBeGreaterThan(0);
    }
  });

  it('the matrix exercises both sides of the cap in every shape', () => {
    for (const shape of SHAPES) {
      const sizes = LENGTHS.map((length) => {
        const { prepared, sections } = shape.build(length);
        const passages = chunk(prepared, sections);
        return packWindows(prepared, passages, passages.map((passage) => passage.ordinal)).length;
      });
      expect(sizes.some((windows) => windows > 1 && windows <= S3_LIMITS.maxWindows), `${shape.name}: ${sizes.join(',')}`).toBe(true);
      expect(sizes.some((windows) => windows > S3_LIMITS.maxWindows), `${shape.name}: ${sizes.join(',')}`).toBe(true);
    }
  });
});
