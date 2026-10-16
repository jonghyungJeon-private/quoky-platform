import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ADR-0120 A6 R5a (proposal decision 2, §9): the creator audit. Every place that creates a to-do or a reminder carries a
// `// creator-origin: <class>` marker on the line before the call, so no creator can store non-owner text unclassified:
// a deictic referent is read only from items whose creator is classified here. A new creator without a marker fails this
// test; one that stores non-owner text needs an origin marker (D2) before its items can be referents.

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CLASSES = ['owner-text', 'owner-text-or-brief', 'event-linked'] as const;
const CREATOR = /\bcreateReminderDraft\(|\.work\.create\(|\bcreateWorkItem\(|\bworkItems\.(?:create|insert)\(/;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

function creators(): Array<{ readonly file: string; readonly line: number; readonly marker: string | undefined }> {
  const found: Array<{ file: string; line: number; marker: string | undefined }> = [];
  for (const area of ['packages', 'apps']) {
    for (const pkg of readdirSync(join(ROOT, area))) {
      const src = join(ROOT, area, pkg, 'src');
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sources(src)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((text, index) => {
          if (!CREATOR.test(text) || /^\s*(?:export\s+)?(?:async\s+)?function\b/.test(text) || /^\s*(?:\/\/|\*)/.test(text)) return;
          const marker = lines.slice(Math.max(0, index - 3), index).map((line) => /creator-origin:\s*([a-z-]+)/.exec(line)?.[1]).find((value) => value !== undefined);
          found.push({ file: file.slice(ROOT.length), line: index + 1, marker });
        });
      }
    }
  }
  return found;
}

describe('the to-do / reminder creator audit (A6 R5a decision 2)', () => {
  const all = creators();

  it('finds the known creators (the scan itself has not rotted)', () => {
    const files = all.map((creator) => creator.file);
    expect(files.filter((file) => file.endsWith('work-chat/work-chat-service.ts'))).toHaveLength(1);
    expect(files.filter((file) => file.endsWith('reminders/reminder-conversation-service.ts'))).toHaveLength(3);
  });

  it('every creator carries a known origin classification', () => {
    const unclassified = all.filter((creator) => creator.marker === undefined || !(CLASSES as readonly string[]).includes(creator.marker));
    expect(unclassified.map((creator) => `${creator.file}:${creator.line}`)).toEqual([]);
  });
});
