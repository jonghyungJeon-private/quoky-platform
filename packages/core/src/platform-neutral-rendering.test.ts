import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PLT-0 source scan (ARCHITECTURE.md §2.2, "the Core knows nothing concrete", for rendering): no Core module names
 * Discord or writes a chat platform's markup. Core emits platform-neutral content (`domain/message-content.ts`);
 * each platform adapter renders it (Discord: `packages/adapter-discord/src/rendering.ts`). Test files are exempt:
 * they may hold legacy delivered text as fixtures.
 */

const SRC = __dirname;

function coreSources(dir: string = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...coreSources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

/** Platform markup a Core module must never write; each pattern names what it catches. */
const FORBIDDEN: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'the platform name Discord', pattern: /discord/i },
  // A zero-width space after `@` / `<` (or before `@`): the Discord mention / channel / link neutralization trick.
  { name: 'zero-width mention neutralization', pattern: /[@<](?:​|\\u200b)|(?:​|\\u200b)@/ },
  // `<@${id}>`, `<#${id}>`, `<@&${id}>`: chat mention and channel-reference syntax built from data.
  { name: 'mention or channel reference syntax', pattern: /<[@#][!&]?\$\{/ },
  // `<${url}>`: Discord's link-embed suppression.
  { name: 'angle-bracket link embed suppression', pattern: /<\$\{[^}]*\}>/ },
  // The character class that backslash-escapes Discord Markdown in untrusted text.
  { name: 'Discord Markdown escaping', pattern: /\\\\\*_~`\|>/ },
  // `{ ...reply, text: … }` keeps a stale `content` (the adapter would render the old body): use withOutboundBody.
  { name: 'text rewritten by spread on an outbound carrier', pattern: /\.\.\.\s*[\w.]*\b(?:reply|message|outbound|notification|notice|composed)\w*\s*,\s*text\s*:/i },
];

describe('Core is platform-neutral in rendering (PLT-0)', () => {
  const files = coreSources();

  it('scans every non-test Core module', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((file) => file.endsWith(join('domain', 'message-content.ts')))).toBe(true);
    expect(files.some((file) => file.endsWith(join('application', 'message-rendering.ts')))).toBe(true);
  });

  it('no Core module names Discord or writes a chat platform\'s markup', () => {
    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const { name, pattern } of FORBIDDEN) {
          if (pattern.test(line)) hits.push(`${relative(SRC, file)}:${index + 1} ${name}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('each pattern catches the markup Core used to write (the scan is not vacuous)', () => {
    const legacy = [
      'export function escapeDiscordText(text: string): string {',
      ".replace(/@/g, '@​')",
      "reference: `<#${id}>`",
      'return `<${url}>`;',
      ".replace(/[\\\\*_~`|>[\\]]/g, '\\\\$&')",
      'return { ...reply, text: clampToMessageBudget(`${notice.text}\\n\\n${reply.text}`) };',
    ];
    legacy.forEach((line, index) => expect((FORBIDDEN[index] as { pattern: RegExp }).pattern.test(line), line).toBe(true));
  });
});
