import { describe, expect, it } from 'vitest';
import {
  chunkText,
  deliverChunks,
  deliverPreview,
  deliverWithNotice,
  DISCORD_SAFE_LIMIT,
  PARTIAL_FAILURE_NOTICE,
  planPreviewDelivery,
  wrapDiffPart,
  type PreviewSenders,
} from './delivery';
import { buildCanonicalDiff, type PreviewArtifact } from '@quoky/core';

describe('chunkText', () => {
  it('returns [] for empty and a single chunk for short text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('hello')).toEqual(['hello']);
  });

  it('splits long text into ≤ maxLen chunks without losing non-whitespace', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line-${i} some words here`).join('\n');
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('prefers a newline boundary when one exists late in the window', () => {
    const text = `${'a'.repeat(70)}\n${'b'.repeat(70)}`;
    const chunks = chunkText(text, 100);
    expect(chunks[0]).toBe(`${'a'.repeat(70)}\n`);
    expect(chunks[1]).toBe('b'.repeat(70));
  });

  it('hard-cuts an over-long single token', () => {
    const chunks = chunkText('x'.repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
  });

  it('uses the Discord-safe default limit', () => {
    expect(chunkText('y'.repeat(DISCORD_SAFE_LIMIT + 10)).every((c) => c.length <= DISCORD_SAFE_LIMIT)).toBe(true);
  });
});

describe('chunkText — code-fence awareness', () => {
  const fenceCount = (chunk: string): number => chunk.split('```').length - 1;
  const code = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => `const value${i} = compute(${i}); // padding`).join('\n');

  it('closes a fence a chunk ends inside and reopens it with the same language tag', () => {
    const text = `intro\n\`\`\`ts\n${code(40)}\n\`\`\`\noutro`;
    const chunks = chunkText(text, 200);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      expect(fenceCount(c) % 2).toBe(0);
    }
    expect(chunks[0]!.endsWith('```')).toBe(true);
    for (const c of chunks.slice(1, -1)) expect(c.startsWith('```ts\n')).toBe(true);
    expect(chunks.at(-1)!.startsWith('```ts\n')).toBe(true);
    expect(chunks.at(-1)!.endsWith('outro')).toBe(true);
  });

  it('loses no code content: stripping synthetic fences and whitespace recovers the original', () => {
    const text = `\`\`\`python\n${code(60)}\n\`\`\`\n`;
    const chunks = chunkText(text, 180);
    const strip = (v: string): string => v.replace(/```[A-Za-z0-9_+.#-]*/g, '').replace(/\s/g, '');
    expect(strip(chunks.join(''))).toBe(strip(text));
  });

  it('reopens a fence without a language tag as a bare fence', () => {
    const chunks = chunkText(`\`\`\`\n${code(40)}\n\`\`\``, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(fenceCount(c) % 2).toBe(0);
    expect(chunks[1]!.startsWith('```\n')).toBe(true);
  });

  it('balances several fences and never exceeds the limit at the Discord-safe default', () => {
    const block = (lang: string): string => `\`\`\`${lang}\n${code(30)}\n\`\`\``;
    const text = [block('ts'), 'prose between blocks '.repeat(20), block('json'), block('sh')].join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_SAFE_LIMIT);
      expect(fenceCount(c) % 2).toBe(0);
    }
  });

  it('does not reopen an empty block when the next marker only closes the fence', () => {
    // Body fills the first chunk exactly up to the closing marker.
    const inner = 'x'.repeat(60);
    const text = `\`\`\`ts\n${inner}\n\`\`\`\n${'tail '.repeat(30)}`;
    const chunks = chunkText(text, 100);
    for (const c of chunks) expect(fenceCount(c) % 2).toBe(0);
    expect(chunks.some((c) => c.startsWith('```ts\n```'))).toBe(false);
  });

  it('keeps fence-free text splitting unchanged and does not touch short fenced text', () => {
    const fenced = '```ts\nconst a = 1;\n```';
    expect(chunkText(fenced, 100)).toEqual([fenced]);
    const text = `${'a'.repeat(70)}\n${'b'.repeat(70)}`;
    expect(chunkText(text, 100)).toEqual([`${'a'.repeat(70)}\n`, 'b'.repeat(70)]);
  });

  it('never splits a fence marker across two chunks', () => {
    // A hard cut would land between two backticks of the marker.
    const text = `${'z'.repeat(150)}\`\`\`ts\n${'q'.repeat(50)}\n\`\`\``;
    for (const limit of [150, 151, 152, 153, 154]) {
      const chunks = chunkText(text, limit);
      for (const c of chunks) {
        expect(c.length).toBeLessThanOrEqual(limit);
        expect(fenceCount(c) % 2).toBe(0);
      }
    }
  });

  it('delivers balanced numbered messages through deliverChunks within the Discord hard limit', async () => {
    const sent: string[] = [];
    const text = `\`\`\`ts\n${code(120)}\n\`\`\``;
    const report = await deliverChunks(text, async (c) => { sent.push(c); });
    expect(report.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    for (const m of sent) {
      expect(m.length).toBeLessThanOrEqual(2000);
      expect(fenceCount(m) % 2).toBe(0);
    }
  });
});

describe('deliverChunks', () => {
  it('numbers multi-chunk replies (i/N) and sends in order', async () => {
    const sent: string[] = [];
    const report = await deliverChunks('abcabcabc', async (c) => {
      sent.push(c);
    }, { maxLen: 3 });
    expect(report).toMatchObject({ ok: true, totalChunks: 3, sent: 3 });
    expect(sent).toEqual(['(1/3) abc', '(2/3) abc', '(3/3) abc']);
  });

  it('does not number a single chunk', async () => {
    const sent: string[] = [];
    await deliverChunks('hello', async (c) => {
      sent.push(c);
    });
    expect(sent).toEqual(['hello']);
  });

  it('empty text → nothing sent, ok', async () => {
    let calls = 0;
    const report = await deliverChunks('', async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(report).toMatchObject({ totalChunks: 0, sent: 0, ok: true });
  });

  it('stops on the first send failure and reports partial delivery (no resend)', async () => {
    const attempts: string[] = [];
    const report = await deliverChunks(
      'aaabbbccc',
      async (c) => {
        attempts.push(c);
        if (attempts.length === 2) throw new Error('discord 500');
      },
      { maxLen: 3 },
    );
    expect(report.ok).toBe(false);
    expect(report.sent).toBe(1);
    expect(report.error).toContain('discord 500');
    expect(attempts).toHaveLength(2); // third chunk never attempted
  });
});

describe('deliverWithNotice', () => {
  it('does not notify on success', async () => {
    const notified: string[] = [];
    const report = await deliverWithNotice('hi', async () => {}, async (m) => {
      notified.push(m);
    });
    expect(report.ok).toBe(true);
    expect(notified).toEqual([]);
  });

  it('sends the partial-failure notice exactly once on failure', async () => {
    const notified: string[] = [];
    const report = await deliverWithNotice(
      'aaabbb',
      async () => {
        throw new Error('send down');
      },
      async (m) => {
        notified.push(m);
      },
      { maxLen: 3 },
    );
    expect(report.ok).toBe(false);
    expect(notified).toEqual([PARTIAL_FAILURE_NOTICE]);
  });

  it('swallows a failing notice (no throw)', async () => {
    const report = await deliverWithNotice(
      'aaabbb',
      async () => {
        throw new Error('send down');
      },
      async () => {
        throw new Error('notice down');
      },
      { maxLen: 3 },
    );
    expect(report.ok).toBe(false);
  });
});

// ── Sprint 4c-Follow-up-5 (F5-C/D/E) — lossless multipart preview delivery ─────────────────────────

const artifactOf = (canonicalDiff: string, warning?: string): PreviewArtifact => ({
  previewId: 'pv-test-123',
  header: 'HDR',
  ...(warning ? { warning } : {}),
  footer: 'FTR',
  files: [{ path: 'x.ts', changeKind: 'add', unifiedDiff: canonicalDiff }],
  canonicalDiff,
  attachmentFilename: 'quoky-preview-pv-test-123.diff',
});

const bigDiff = (lines: number): string =>
  buildCanonicalDiff([
    { path: 'big.ts', changeKind: 'add', unifiedDiff: Array.from({ length: lines }, (_, i) => `+content line number ${i}`).join('\n') },
  ]);

/** Strip Discord wrappers ([n/m] + ```diff fences) to recover the canonical payload of a text part. */
const unwrap = (part: string): string =>
  part.replace(/^\[\d+\/\d+\]\n/, '').replace(/^```diff\n/, '').replace(/```$/, '');

const makeCapture = (opts: { failTextAt?: number; failAttachment?: boolean } = {}) => {
  const texts: string[] = [];
  const attachments: Array<{ diff: string; name: string; caption: string }> = [];
  const notices: string[] = [];
  let textCalls = 0;
  const senders: PreviewSenders = {
    sendText: async (t) => {
      textCalls += 1;
      if (opts.failTextAt !== undefined && textCalls === opts.failTextAt) throw new Error('text send failed');
      texts.push(t);
    },
    sendAttachment: async (diff, name, caption) => {
      if (opts.failAttachment) throw new Error('attachment send failed');
      attachments.push({ diff, name, caption });
    },
    notify: async (m) => { notices.push(m); },
  };
  return { senders, texts, attachments, notices };
};

describe('planPreviewDelivery (F5-C/D)', () => {
  it('a small diff → one text part, no [n/m] prefix, valid fence', () => {
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: '@@ -0,0 +1 @@\n+hello' }]);
    const plan = planPreviewDelivery(artifactOf(canonical));
    expect(plan.mode).toBe('text');
    if (plan.mode === 'text') {
      expect(plan.parts).toHaveLength(1);
      expect(plan.parts[0]!.startsWith('```diff\n')).toBe(true);
      expect(plan.parts[0]!.endsWith('```')).toBe(true);
      expect(unwrap(plan.parts[0]!)).toBe(canonical);
    }
  });

  it('a large diff → multiple parts, each within budget and an independently valid fence; reconstructs byte-for-byte', () => {
    const canonical = bigDiff(400);
    const plan = planPreviewDelivery(artifactOf(canonical), { safeLimit: 400, partThreshold: 1000 });
    expect(plan.mode).toBe('text');
    if (plan.mode === 'text') {
      expect(plan.parts.length).toBeGreaterThan(1);
      expect(plan.parts.every((p) => p.length <= 400)).toBe(true);
      expect(plan.parts.every((p) => /^\[\d+\/\d+\]\n```diff\n/.test(p) && p.endsWith('```'))).toBe(true);
      expect(plan.parts.map(unwrap).join('')).toBe(canonical); // CA RC3
    }
  });

  it('part count over threshold → attachment (CA RC6)', () => {
    const plan = planPreviewDelivery(artifactOf(bigDiff(2000)), { safeLimit: 200, partThreshold: 3 });
    expect(plan.mode).toBe('attachment');
  });

  it('a single diff line longer than the budget → attachment, never a mid-line split (CA RC4)', () => {
    const oversized = `@@ -0,0 +1 @@\n+${'X'.repeat(3000)}\n`;
    const plan = planPreviewDelivery(artifactOf(oversized), { safeLimit: 500 });
    expect(plan.mode).toBe('attachment');
  });
});

describe('deliverPreview (F5-C/D/E)', () => {
  it('text success → SUCCESS_TEXT_COMPLETE; header first; footer ATOMIC on the final diff message; report carries previewId', async () => {
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: '@@ -0,0 +1 @@\n+hi' }]);
    const cap = makeCapture();
    const report = await deliverPreview(artifactOf(canonical), cap.senders);
    expect(report.outcome).toBe('SUCCESS_TEXT_COMPLETE');
    expect(report.attachmentFallbackUsed).toBe(false);
    expect(report.previewId).toBe('pv-test-123'); // F5-E: report carries the artifact's previewId
    expect(cap.texts[0]).toBe('HDR');
    // F5 Finding 1: the footer is part of the FINAL message (atomic), not a separate trailing send.
    const last = cap.texts[cap.texts.length - 1]!;
    expect(last.endsWith('\nFTR')).toBe(true);
    expect(last).toContain('```diff\n');
    expect(cap.texts).not.toContain('FTR'); // no standalone footer send
    expect(cap.attachments).toHaveLength(0);
  });

  it('oversized diff → SUCCESS_ATTACHMENT_COMPLETE with the COMPLETE canonical diff', async () => {
    const oversized = `@@ -0,0 +1 @@\n+${'X'.repeat(3000)}\n`;
    const cap = makeCapture();
    const report = await deliverPreview(artifactOf(oversized), cap.senders, { safeLimit: 500 });
    expect(report.outcome).toBe('SUCCESS_ATTACHMENT_COMPLETE');
    expect(report.attachmentFallbackUsed).toBe(true);
    expect(cap.attachments).toHaveLength(1);
    expect(cap.attachments[0]!.diff).toBe(oversized); // complete, byte-for-byte
    expect(cap.attachments[0]!.name).toBe('quoky-preview-pv-test-123.diff');
    expect(cap.attachments[0]!.caption).toContain('FTR'); // caption carries the apply-boundary footer (RC9)
    expect(report.previewId).toBe('pv-test-123');
  });

  it('F5 Finding 1: the final text message contains the apply-boundary footer and stays within safeLimit', async () => {
    const canonical = bigDiff(400);
    const cap = makeCapture();
    const report = await deliverPreview(artifactOf(canonical), cap.senders, { safeLimit: 400, partThreshold: 1000 });
    expect(report.outcome).toBe('SUCCESS_TEXT_COMPLETE');
    const last = cap.texts[cap.texts.length - 1]!;
    expect(last.endsWith('\nFTR')).toBe(true); // footer atomic with the final diff part
    expect(cap.texts.every((m) => m.length <= 400)).toBe(true); // every message (incl. final+footer) within budget
  });

  it('F5 Finding 1: a failure delivering the FINAL footer-bearing message never returns SUCCESS_TEXT_COMPLETE', async () => {
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: '@@ -0,0 +1 @@\n+only' }]);
    // one diff part → sends: header(1), finalpart+footer(2). Fail the final footer-bearing message.
    const cap = makeCapture({ failTextAt: 2 });
    const report = await deliverPreview(artifactOf(canonical), cap.senders);
    expect(report.outcome).not.toBe('SUCCESS_TEXT_COMPLETE'); // footer failure is NOT swallowed
    expect(report.attachmentFallbackUsed).toBe(true);
    expect(cap.attachments[0]!.diff).toBe(canonical); // complete diff still delivered via attachment
  });

  it('F5 Finding 2: the same previewId is used across a text→attachment fallback', async () => {
    const canonical = bigDiff(400);
    const cap = makeCapture({ failTextAt: 3 });
    const report = await deliverPreview(artifactOf(canonical), cap.senders, { safeLimit: 400, partThreshold: 1000 });
    expect(report.previewId).toBe('pv-test-123'); // report id == artifact id even on fallback
    expect(report.attachmentFallbackUsed).toBe(true);
  });

  it('F5 warning: the out-of-scope warning rides the FINAL text message exactly once (with the footer)', async () => {
    const WARN = '⚠️ 범위를 벗어난 파일 other.ts';
    const canonical = bigDiff(400);
    const cap = makeCapture();
    const report = await deliverPreview(artifactOf(canonical, WARN), cap.senders, { safeLimit: 400, partThreshold: 1000 });
    expect(report.outcome).toBe('SUCCESS_TEXT_COMPLETE');
    const joined = cap.texts.join('\n');
    expect(joined.split(WARN)).toHaveLength(2); // warning appears exactly once across all messages
    const last = cap.texts[cap.texts.length - 1]!;
    expect(last).toContain(WARN);
    expect(last.endsWith('\nFTR')).toBe(true); // …warning then footer, both on the final message
    expect(cap.texts.every((m) => m.length <= 400)).toBe(true); // trailer within budget
  });

  it('F5 warning: the attachment caption includes the out-of-scope warning exactly once', async () => {
    const WARN = '⚠️ 범위를 벗어난 파일 other.ts';
    const oversized = `@@ -0,0 +1 @@\n+${'X'.repeat(3000)}\n`;
    const cap = makeCapture();
    await deliverPreview(artifactOf(oversized, WARN), cap.senders, { safeLimit: 500 });
    expect(cap.attachments).toHaveLength(1);
    expect(cap.attachments[0]!.caption.split(WARN)).toHaveLength(2); // exactly once
    expect(cap.attachments[0]!.caption).toContain('FTR');
  });

  it('F5 warning: a failure on the warning/footer-bearing final message never returns SUCCESS_TEXT_COMPLETE', async () => {
    const WARN = '⚠️ 범위를 벗어난 파일 other.ts';
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: '@@ -0,0 +1 @@\n+only' }]);
    const cap = makeCapture({ failTextAt: 2 }); // header ok, final(part+warning+footer) fails
    const report = await deliverPreview(artifactOf(canonical, WARN), cap.senders);
    expect(report.outcome).not.toBe('SUCCESS_TEXT_COMPLETE');
    expect(report.attachmentFallbackUsed).toBe(true);
    expect(cap.attachments[0]!.caption).toContain(WARN); // warning still delivered via the attachment
  });

  it('F5 warning: the no-warning path adds no warning text', async () => {
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: '@@ -0,0 +1 @@\n+hi' }]);
    const cap = makeCapture();
    await deliverPreview(artifactOf(canonical), cap.senders); // no warning
    const last = cap.texts[cap.texts.length - 1]!;
    expect(last.endsWith('\n```\nFTR')).toBe(true); // fence directly followed by footer, no warning line
  });

  it('known text failure mid-stream → attachment fallback (complete diff), PARTIAL_TEXT_ATTACHMENT_COMPLETE, no resend of remaining parts', async () => {
    const canonical = bigDiff(400);
    const cap = makeCapture({ failTextAt: 3 }); // header=1 ok, part1=2 ok, part2=3 fails
    const report = await deliverPreview(artifactOf(canonical), cap.senders, { safeLimit: 400, partThreshold: 1000 });
    expect(report.outcome).toBe('PARTIAL_TEXT_ATTACHMENT_COMPLETE');
    expect(report.attachmentFallbackUsed).toBe(true);
    expect(cap.attachments[0]!.diff).toBe(canonical); // complete despite partial text
    expect(cap.texts).toHaveLength(2); // header + part1 only; no blind resend after the failure
    expect(report.deliveredPartCount).toBe(1);
  });

  it('text failure AND attachment failure → DELIVERY_FAILED with a best-effort notice', async () => {
    const canonical = bigDiff(400);
    const cap = makeCapture({ failTextAt: 2, failAttachment: true });
    const report = await deliverPreview(artifactOf(canonical), cap.senders, { safeLimit: 400, partThreshold: 1000 });
    expect(report.outcome).toBe('DELIVERY_FAILED');
    expect(cap.notices).toContain(PARTIAL_FAILURE_NOTICE);
  });

  it('header send failure (0 diff parts) + attachment ok → SUCCESS_ATTACHMENT_COMPLETE', async () => {
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: '@@ -0,0 +1 @@\n+z' }]);
    const cap = makeCapture({ failTextAt: 1 });
    const report = await deliverPreview(artifactOf(canonical), cap.senders);
    expect(report.outcome).toBe('SUCCESS_ATTACHMENT_COMPLETE');
    expect(report.deliveredPartCount).toBe(0);
    expect(cap.attachments[0]!.diff).toBe(canonical);
  });

  it('the delivery report is length-only — no raw diff content (CA RC8)', async () => {
    const marker = 'SENSITIVE_DIFF_MARKER_XYZ';
    const canonical = buildCanonicalDiff([{ path: 'x.ts', changeKind: 'add', unifiedDiff: `@@ -0,0 +1 @@\n+${marker}` }]);
    const cap = makeCapture();
    const report = await deliverPreview(artifactOf(canonical), cap.senders);
    expect(typeof report.canonicalDiffLength).toBe('number');
    expect(JSON.stringify(report)).not.toContain(marker);
  });

  it('real-chain: a large multi-part preview reconstructs to the original canonical diff across delivered messages', async () => {
    const canonical = bigDiff(500);
    const cap = makeCapture();
    const report = await deliverPreview(artifactOf(canonical), cap.senders, { safeLimit: 600, partThreshold: 1000 });
    expect(report.outcome).toBe('SUCCESS_TEXT_COMPLETE');
    // drop the header (first); the rest are [n/m] diff parts. The LAST message has the footer appended
    // atomically (F5 Finding 1) — strip the trailing "\nFTR" before unwrapping.
    const diffParts = cap.texts.slice(1).map((m, i, arr) => (i === arr.length - 1 ? m.replace(/\nFTR$/, '') : m));
    expect(diffParts.length).toBeGreaterThan(1);
    expect(diffParts.map(unwrap).join('')).toBe(canonical); // complete delivery, byte-for-byte
  });
});

describe('wrapDiffPart (F5-C)', () => {
  it('single part → no [n/m] prefix; multi part → [n/m]; always a valid fenced block', () => {
    expect(wrapDiffPart('+a\n', 1, 1)).toBe('```diff\n+a\n```');
    expect(wrapDiffPart('+a\n', 2, 3)).toBe('[2/3]\n```diff\n+a\n```');
  });
});
