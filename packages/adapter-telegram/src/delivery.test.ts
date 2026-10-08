import { describe, expect, it } from 'vitest';
import type { PreviewArtifact } from '@quoky/core';
import {
  chunkTelegramText,
  deliverTelegramPreview,
  deliverTelegramText,
  numberChunks,
  PARTIAL_FAILURE_NOTICE,
  planTelegramPreview,
  TELEGRAM_CHUNK_LIMIT,
  TELEGRAM_MESSAGE_LIMIT,
} from './delivery';

const EMOJI = '\u{1F600}'; // one astral code point = a surrogate pair (2 UTF-16 units)

function isBrokenSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text) || /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text);
}

describe('Telegram chunking (ADR-0114 D7): lossless at 4096', () => {
  it('a short text is one chunk; empty is none', () => {
    expect(chunkTelegramText('hello')).toEqual(['hello']);
    expect(chunkTelegramText('')).toEqual([]);
  });

  it('every numbered chunk fits 4096 and the chunks join back to the exact text', () => {
    const text = Array.from({ length: 900 }, (_, i) => `줄 ${i}: ${'가나다라'.repeat(i % 7)} word${i}`).join('\n');
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const part of numberChunks(chunks)) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
  });

  it('never splits a surrogate pair, at any hard-cut position', () => {
    for (const offset of [0, 1]) {
      const text = `${'a'.repeat(offset)}${EMOJI.repeat(5000)}`;
      const chunks = chunkTelegramText(text);
      expect(chunks.join('')).toBe(text);
      for (const chunk of chunks) {
        expect(isBrokenSurrogate(chunk), `offset ${offset}`).toBe(false);
        expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_LIMIT);
      }
    }
  });

  it('keeps a fenced block byte for byte and never splits a backtick run', () => {
    const code = Array.from({ length: 600 }, (_, i) => `const v${i} = "${'x'.repeat(i % 9)}";`).join('\n');
    const text = `앞 문단\n\`\`\`\`ts\n${code}\n\`\`\`\`\n뒤 문단`;
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const [index, chunk] of chunks.entries()) {
      if (index < chunks.length - 1) expect(chunk.endsWith('`') && (chunks[index + 1] ?? '').startsWith('`')).toBe(false);
    }
    // A backtick run sitting exactly on the hard-cut boundary moves to the next chunk whole.
    const boundary = `${'y'.repeat(TELEGRAM_CHUNK_LIMIT - 2)}\`\`\`\`${'z'.repeat(10)}`;
    const cut = chunkTelegramText(boundary);
    expect(cut.join('')).toBe(boundary);
    expect(cut[1]?.startsWith('````')).toBe(true);
  });

  it('a single over-long token is hard-cut without loss', () => {
    const text = 'x'.repeat(TELEGRAM_CHUNK_LIMIT * 2 + 5);
    const chunks = chunkTelegramText(text);
    expect(chunks.map((chunk) => chunk.length)).toEqual([TELEGRAM_CHUNK_LIMIT, TELEGRAM_CHUNK_LIMIT, 5]);
  });

  it('a send failure stops, sends the notice once and reports a code, never resending', async () => {
    const sent: string[] = [];
    const notices: string[] = [];
    const text = 'z '.repeat(TELEGRAM_CHUNK_LIMIT * 2);
    const report = await deliverTelegramText(
      text,
      async (chunk) => {
        if (sent.length === 1) throw new Error('boom');
        sent.push(chunk);
      },
      async (notice) => {
        notices.push(notice);
      },
      () => 'UNAVAILABLE',
    );
    const total = chunkTelegramText(text).length;
    expect(total).toBeGreaterThan(2);
    expect(report).toEqual({ totalChunks: total, sent: 1, ok: false, errorCode: 'UNAVAILABLE' });
    expect(sent[0]?.startsWith(`(1/${total}) `)).toBe(true);
    expect(notices).toEqual([PARTIAL_FAILURE_NOTICE]);
  });
});

function artifact(diff: string, extra: Partial<PreviewArtifact> = {}): PreviewArtifact {
  return {
    previewId: 'pv-1',
    header: '변경 미리보기 <header>',
    footer: '적용하려면 `적용` & 확인',
    files: [],
    canonicalDiff: diff,
    attachmentFilename: 'change.diff',
    ...extra,
  };
}

describe('Telegram code-change previews: the fixed HTML subset, lossless', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-if (a < b && c > d) {', '+if (a <= b && "c" > d) { </pre><a href="https://evil">x</a>', ''].join('\n');

  it('escapes every character of the diff and trailer; the only tags are the adapter’s own <pre>', () => {
    const plan = planTelegramPreview(artifact(diff, { warning: '범위 밖 <파일>' }));
    expect(plan.mode).toBe('text');
    if (plan.mode !== 'text') return;
    expect(plan.parts).toHaveLength(1);
    const html = plan.parts[0] ?? '';
    expect(html.match(/<[^>]*>/g)).toEqual(['<pre>', '</pre>']);
    expect(html).toContain('&lt;/pre&gt;&lt;a href=&quot;https://evil&quot;&gt;');
    expect(html).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(html.endsWith('\n범위 밖 &lt;파일&gt;\n적용하려면 `적용` &amp; 확인')).toBe(true);
  });

  it('splits a large diff into numbered parts within 4096 (escaped), losslessly, else one document', () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `+const <v${i}> = "${'&'.repeat(i % 5)}";`);
    const big = `${lines.join('\n')}\n`;
    const plan = planTelegramPreview(artifact(big), { partThreshold: 50 });
    expect(plan.mode).toBe('text');
    if (plan.mode !== 'text') return;
    expect(plan.parts.length).toBeGreaterThan(1);
    for (const part of plan.parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const payload = plan.parts
      .map((part) => /<pre>([\s\S]*)<\/pre>/.exec(part)?.[1] ?? '')
      .map(unescape)
      .join('');
    expect(payload).toBe(big);
    expect(planTelegramPreview(artifact(big)).mode).toBe('attachment');
    expect(planTelegramPreview(artifact(`+${'x'.repeat(5000)}\n`))).toEqual({ mode: 'attachment', reason: 'oversized-line' });
  });

  it('delivers header (plain), parts (HTML) and falls back to the complete document on a part failure', async () => {
    const events: string[] = [];
    const report = await deliverTelegramPreview(artifact(diff), {
      sendPlain: async (text) => void events.push(`plain:${text}`),
      sendHtml: async () => {
        throw new Error('rejected');
      },
      sendDocument: async (content, filename) => void events.push(`doc:${filename}:${content === diff}`),
      notify: async (notice) => void events.push(`notice:${notice}`),
    });
    expect(report.outcome).toBe('SUCCESS_ATTACHMENT_COMPLETE');
    expect(events[0]).toBe('plain:변경 미리보기 <header>');
    expect(events).toContain('doc:change.diff:true');
    expect(events.at(-1)).toBe('notice:전체 diff는 첨부파일로 보내드렸어요.');
  });
});
