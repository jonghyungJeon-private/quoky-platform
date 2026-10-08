import { describe, expect, it } from 'vitest';
import { MAX_RAW_BODY_BYTES, decodeHtmlEntities, decodeMimeHeader, extractBodyText, htmlToText, parseSender } from './mime';

/**
 * Review P2-1: hostile mail must not block the event loop. Each input below was quadratic (or worse) before the fix —
 * 32k unclosed `<style>` took about 2 s, so a full-size mail could take minutes. Linear code handles each in a few
 * milliseconds; the 500 ms bound leaves room for a loaded CI host while still failing on any quadratic regression.
 */
const BOUND_MS = 500;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe('MIME helpers are linear on hostile input (review P2-1)', () => {
  it.each([
    ['32k unclosed <style>', '<style>'.repeat(32_000)],
    ['256k unclosed <script', '<script'.repeat(36_000)],
    ['100k unclosed comments', '<!--'.repeat(100_000)],
    ['512k lone "<"', '<'.repeat(512 * 1024)],
    ['"<a" without ">" (bounded-repetition rescan)', '<a'.repeat(200_000)],
    ['250k spaces between words', `a${' '.repeat(250_000)}b`],
    ['250k " \\n" pairs', ' \n'.repeat(250_000)],
    ['unclosed style after text', `visible text<style>${'x'.repeat(400_000)}`],
  ])('htmlToText: %s', (_label, html) => {
    const { ms } = timed(() => htmlToText(html));
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('keeps the meaning of the HTML it reduces', () => {
    expect(htmlToText('<p>A<!-- hidden --></p><STYLE>p{}</STYLE><div>B<br/>C</div><ul><li>x</li></ul>a < b')).toBe('A\nB\nC\n- x\na < b');
    expect(htmlToText('before<style>never shown')).toBe('before');
    expect(htmlToText('before<!-- never closed')).toBe('before');
  });

  it.each([
    ['parseSender on 2 MB of "<"', () => parseSender('<'.repeat(2_000_000))],
    ['parseSender on a long run of spaces before ">"', () => parseSender(`<a>${' '.repeat(500_000)}x>`)],
    ['decodeMimeHeader on 1M "=?"', () => decodeMimeHeader('=?'.repeat(500_000))],
    ['decodeHtmlEntities on 1M "&"', () => decodeHtmlEntities('&'.repeat(1_000_000))],
  ])('%s', (_label, fn) => {
    expect(timed(fn).ms).toBeLessThan(BOUND_MS);
  });

  it('a body part is cut at 512 KiB before any processing and reported as truncated', () => {
    const data = Buffer.from(`<p>${'가'.repeat(400_000)}</p>`, 'utf8').toString('base64url');
    const { value, ms } = timed(() => extractBodyText({ mimeType: 'text/html', body: { data } }));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(value.truncated).toBe(true);
    expect(Buffer.byteLength(value.text, 'utf8')).toBeLessThanOrEqual(MAX_RAW_BODY_BYTES);
  });
});
