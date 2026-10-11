import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseReminderMessage } from './reminder-grammar';

/**
 * BRF-2 regression sweep (Codex review): every phrase the reminder grammar was already tested or pinned on keeps its
 * pre-BRF-2 outcome. "Pre-BRF-2" is the same grammar with the event-relative path off (`eventRelative: false`), which
 * is the ADR-0101 grammar byte for byte; a phrase may differ only if it is one of the BRF-2 phrases listed below.
 *
 * Phrases: the text of every golden corpus case, and every string literal in the existing test files of the modules
 * that share or defer to the reminder grammar (reminders, calendar, mail, work chat, help intent, chat policy, the
 * conversation runtime and the app acceptance suites). The BRF-2 test files are left out (their phrases are new).
 */

const NOW = '2026-10-09T01:00:00.000Z';
const OPTIONS = { now: NOW, timeZone: 'Asia/Seoul' } as const;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const APPLICATION = join(HERE, '..');
const REPO = join(APPLICATION, '..', '..', '..', '..');

/** The BRF-2 phrases (their own tests pin them); only these may change outcome. */
const BRF2_PHRASES = new Set([
  // golden route-408..413
  '회의 10분 전에 알려줘',
  '다음 회의 30분 전에 알려줘',
  '3시 회의 15분 전에 알려줘',
  '주간 회의 10분 전에 알려줘',
  'remind me 10 minutes before my next meeting',
  '회의 전에 알려줘',
  // the BRF-2 block of apps/quoky/src/reminders/reminder-acceptance.test.ts
  '분기 리뷰 회의 10분 전에 알려줘',
]);

const BRF2_FILES = new Set(['event-reminder.test.ts', 'event-reminder-regression.test.ts']);

const FIXTURE_DIRS = [
  join(APPLICATION, 'reminders'),
  join(APPLICATION, 'calendar'),
  join(APPLICATION, 'mail'),
  join(APPLICATION, 'work-chat'),
  join(APPLICATION, 'help-intent'),
  join(APPLICATION, 'chat-policy'),
  join(APPLICATION, 'golden'),
  join(REPO, 'apps', 'quoky', 'src', 'reminders'),
];
const FIXTURE_FILES = [
  join(APPLICATION, 'conversation-runtime.test.ts'),
  join(APPLICATION, 'intent-classifier.test.ts'),
  join(REPO, 'apps', 'quoky', 'src', 'personal-v2-acceptance.test.ts'),
  join(REPO, 'apps', 'quoky', 'src', 'personal-v3-acceptance.test.ts'),
];

function testFiles(): string[] {
  const files = FIXTURE_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts') && !BRF2_FILES.has(name))
      .map((name) => join(dir, name)),
  );
  for (const file of FIXTURE_FILES) {
    try {
      readFileSync(file);
      files.push(file);
    } catch {
      // optional: a suite that does not exist in this checkout
    }
  }
  return files;
}

/** Single- and double-quoted string literals (template literals with `${}` are skipped). */
const LITERAL = /'((?:[^'\\\n]|\\.){2,300})'|"((?:[^"\\\n]|\\.){2,300})"|`((?:[^`\\$\n]|\\.){2,300})`/g;

function unescape(literal: string): string {
  return literal.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
    if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
    if (esc.startsWith('u') && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
  });
}

function fixturePhrases(): Set<string> {
  const phrases = new Set<string>();
  for (const file of testFiles()) {
    for (const m of readFileSync(file, 'utf8').matchAll(LITERAL)) {
      const raw = m[1] ?? m[2] ?? m[3];
      if (raw !== undefined) phrases.add(unescape(raw));
    }
  }
  return phrases;
}

function goldenPhrases(): Set<string> {
  const dir = join(APPLICATION, 'golden');
  const phrases = new Set<string>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.v1.json'))) {
    const suite = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { cases?: Array<{ text?: unknown }> };
    for (const golden of suite.cases ?? []) if (typeof golden.text === 'string') phrases.add(golden.text);
  }
  return phrases;
}

describe('BRF-2 regression: pre-existing reminder phrases keep their outcome', () => {
  it('every golden and fixture phrase parses exactly as the ADR-0101 grammar alone', () => {
    const phrases = new Set([...goldenPhrases(), ...fixturePhrases()]);
    // The sweep must actually cover the corpora and the reminder grammar's own fixtures.
    expect(phrases.size).toBeGreaterThan(3_000);
    expect(phrases.has('30분 뒤에 스트레칭 알려줘')).toBe(true);
    expect(phrases.has('할 일 추가: 내일 9시에 회의 알려줘')).toBe(true);

    const changed: string[] = [];
    let reminderShaped = 0;
    for (const text of phrases) {
      if (BRF2_PHRASES.has(text)) continue;
      let before: unknown;
      let after: unknown;
      try {
        before = parseReminderMessage(text, { ...OPTIONS, eventRelative: false });
      } catch (error) {
        before = { threw: error instanceof Error ? error.name : 'unknown' };
      }
      try {
        after = parseReminderMessage(text, OPTIONS);
      } catch (error) {
        after = { threw: error instanceof Error ? error.name : 'unknown' };
      }
      if ((before as { kind?: string }).kind !== 'NOT_REMINDER') reminderShaped += 1;
      if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(text);
    }
    expect(changed).toEqual([]);
    expect(reminderShaped).toBeGreaterThan(300);
  });

  it('the BRF-2 phrases are the only ones the event-relative path takes', () => {
    for (const text of BRF2_PHRASES) {
      const kind = parseReminderMessage(text, OPTIONS).kind;
      expect(['CREATE_EVENT_RELATIVE', 'CLARIFY'], text).toContain(kind);
      expect(parseReminderMessage(text, { ...OPTIONS, eventRelative: false }).kind, text).not.toBe('CREATE_EVENT_RELATIVE');
    }
  });

  // Every recurrence word of the legacy grammar (daily, weekly, sub-daily, monthly, yearly, Korean equivalents) before the
  // meeting noun hands the message back to the ADR-0101 grammar unchanged.
  const RECURRENCE_PHRASES = [
    'remind me 10 minutes before my monthly meeting',
    'remind me 10 minutes before my yearly meeting',
    'remind me 10 minutes before my annually meeting',
    'remind me 10 minutes before my hourly meeting',
    'remind me 10 minutes before my daily meeting',
    'remind me 10 minutes before my weekly meeting',
    'remind me 10 minutes before my every month meeting',
    'remind me 10 minutes before my every year meeting',
    'remind me 10 minutes before my every other week meeting',
    ...['매달', '매월', '매년', '매해', '격주', '매주', '매일', '평일', '주말', '매시간', '매분'].map(
      (word) => `${word} 회의 10분 전에 알려줘`,
    ),
  ];

  it('a recurrence word before the meeting noun keeps the legacy outcome (monthly, yearly, annually, 매달, 매월, 매년, ...)', () => {
    for (const text of RECURRENCE_PHRASES) {
      const legacy = parseReminderMessage(text, { ...OPTIONS, eventRelative: false });
      expect(parseReminderMessage(text, OPTIONS), text).toEqual(legacy);
      expect(legacy.kind, text).not.toBe('CREATE_EVENT_RELATIVE');
    }
    for (const text of [
      'remind me 10 minutes before my monthly meeting',
      'remind me 10 minutes before my yearly meeting',
      'remind me 10 minutes before my annually meeting',
    ]) {
      expect(parseReminderMessage(text, OPTIONS), text).toEqual({ kind: 'CLARIFY', reason: 'UNSUPPORTED_RECURRENCE' });
    }
    // The legacy grammar does not claim a bare `매달 회의 …`; the pinned outcome is NOT_REMINDER, not an event reminder.
    for (const text of ['매달 회의 10분 전에 알려줘', '매월 회의 10분 전에 알려줘', '매년 회의 10분 전에 알려줘']) {
      expect(parseReminderMessage(text, OPTIONS), text).toEqual({ kind: 'NOT_REMINDER' });
    }
  });
});
