import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { charNgrams, closeness, findingKind, isShortText, normalize, shapeTokens } from '../../nl-routing/example-contamination';

// ADR-0121 A2, stage A0 (offline DATA only, no model, no runtime code): shape, count, duplicate, hash and contamination
// checks for the four data sets in this directory. Nothing here reads the planner or classifier prompts.

const HERE = new URL('./', import.meta.url);
const GOLDEN = new URL('../', import.meta.url);
const read = (name: string): Buffer => readFileSync(new URL(name, HERE));
const json = <T>(name: string): T => JSON.parse(read(name).toString('utf8')) as T;
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Ap8Case {
  id: string; batch: string; status: string; family: string; mode: string; lang: string; text: string;
  expect: unknown; trap?: unknown; trapRefusal?: string; provenance: string; replaceWithCapture?: boolean; regressionOnly?: boolean;
}
interface Step { entryId?: string; args?: Record<string, unknown>; answer?: number[]; mode?: string; facts?: string[]; count?: number; summarize?: number[] }
const MODES = ['facts', 'words', 'grounded', 'generate'];
const FACTS = ['exists', 'count', 'times', 'free'];
const TRAP_REFUSALS = ['answer-at-most-one', 'answer-not-last', 'answer-needs-ref', 'answer-facts-empty', 'answer-overlaps-summary', 'a6-in-plan', 'ref-cross-source', 'answer-generate-one-ref', 'answer-bad-ref', 'answer-fact-unsupported'];

describe('AP-8 answer-step plan gold', () => {
  const corpus = json<{ cases: Ap8Case[] }>('agent-plan.ap8.v1.json');
  const cases = corpus.cases;

  it('has at least 40 cases, all owner-approved on 2026-10-23 and in batch AP-8', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    for (const c of cases) {
      expect(c.batch).toBe('AP-8');
      expect(c.status).toBe('owner-approved');
      expect((c as unknown as { approvedOn: string }).approvedOn).toBe('2026-10-23');
      expect(['ko', 'en', 'mixed']).toContain(c.lang);
      expect(c.id).toMatch(/^ap-[pn]8\d\d$/);
    }
  });

  it('has unique ids that do not collide with agent-plan.v1.json and unique texts', () => {
    const existing = new Set(json<{ cases: { id: string }[] }>('../agent-plan.v1.json').cases.map((c) => c.id));
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => normalize(c.text))).size).toBe(cases.length);
    for (const c of cases) expect(existing.has(c.id)).toBe(false);
  });

  it('labels every case with a structural mode and a well-formed gold', () => {
    const seenModes = new Set<string>();
    for (const c of cases) {
      const positive = c.id.startsWith('ap-p');
      if (positive) {
        const e = c.expect as { steps: Step[]; ambiguity: string };
        expect(e.ambiguity).toBe('CLEAR');
        const answers = e.steps.filter((s) => s.answer !== undefined);
        expect(answers).toHaveLength(1);
        expect(e.steps[e.steps.length - 1]).toBe(answers[0]);
        const a = answers[0]!;
        expect(MODES).toContain(a.mode);
        expect(a.mode).toBe(c.mode);
        seenModes.add(a.mode!);
        for (const f of a.facts ?? []) expect(FACTS).toContain(f);
        if (a.mode === 'facts') expect((a.facts ?? []).length).toBeGreaterThan(0);
        if (a.mode === 'generate') expect(a.answer).toHaveLength(1);
        if (a.answer!.length === 0) expect(a.mode).toBe('words');
        for (const ref of a.answer!) {
          expect(ref).toBeGreaterThanOrEqual(1);
          expect(ref).toBeLessThan(e.steps.length);
          expect(e.steps[ref - 1]!.entryId).toBeDefined();
          expect(e.steps[ref - 1]!.entryId).not.toBe('brief.today');
        }
        if (a.count !== undefined) expect(a.count).toBeGreaterThanOrEqual(1), expect(a.count).toBeLessThanOrEqual(10);
      } else {
        expect(c.mode === 'none' || MODES.includes(c.mode)).toBe(true);
        const e = c.expect as { outcome?: string };
        expect(c.expect === 'none' || e.outcome === 'ask').toBe(true);
      }
      if (c.trap !== undefined && c.expect !== null && (c.expect as { outcome?: string }).outcome !== 'ask') expect(c.trapRefusal).toBeDefined();
      if (c.trapRefusal !== undefined) expect(TRAP_REFUSALS).toContain(c.trapRefusal);
    }
    expect([...seenModes].sort()).toEqual([...MODES].sort());
  });

  it('encodes the owner decisions of 2026-10-23', () => {
    const by = new Map(cases.map((c) => [c.id, c as unknown as Record<string, unknown>]));
    expect(by.get('ap-p818')!.mode).toBe('grounded');
    expect(by.has('ap-n822')).toBe(false);
    const moved = by.get('ap-p843')!;
    expect(moved.formerId).toBe('ap-n822');
    expect(moved.mode).toBe('grounded');
    expect(moved.trapRefusal).toBe('answer-generate-one-ref');
    expect((by.get('ap-n808')!.q3 as { write: string }).write).toBe('not-run');
    expect((by.get('ap-n809')!.q3 as { write: string }).write).toBe('clarification');
    for (const id of ['ap-p819', 'ap-p821', 'ap-p822', 'ap-p823', 'ap-p824', 'ap-p825', 'ap-p838', 'ap-p839', 'ap-p840', 'ap-p842', 'ap-p843']) {
      expect(by.get(id)!.localJudgmentScope, id).toBe(true);
      expect(by.get(id)!.mode, id).toBe('grounded');
    }
    expect(String(by.get('ap-n802')!.note)).toMatch(/plain one-step read/u);
    expect(String(by.get('ap-n803')!.note)).toMatch(/plain one-step read/u);
  });

  it('covers every required negative family', () => {
    const families = new Set(cases.filter((c) => c.id.startsWith('ap-n')).map((c) => c.family));
    for (const f of ['plain-read', 'general-knowledge', 'write-request', 'delegation', 'cross-source']) expect(families.has(f)).toBe(true);
  });

  it('marks at least half as capture placeholders and keeps the two trigger texts as regression-only', () => {
    const placeholders = cases.filter((c) => c.replaceWithCapture === true).length;
    expect(placeholders * 2).toBeGreaterThanOrEqual(cases.length);
    const reg = cases.filter((c) => c.regressionOnly === true);
    expect(reg.map((c) => c.text)).toEqual([
      '내일도 면접 있어? Ai agent 면접볼 때 주로 뭐 봐야할까? 간략하게 리스트로 한 세가지만 뽑아줘',
      '내일 면접 기준으로 면접 질문 좀 뽑아줘',
    ]);
    for (const c of reg) expect(c.replaceWithCapture).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// A reference of the A2-D12..D14 rules (strict literal reading) used only to check the red-team and G5 data.
const SEPS = new Set([...' \t_-/|·,.:;()[]{}<>"\'#']);
const BIDI = new Set([...'‪‫‬‭‮⁦⁧⁨⁩﻿­', ...Array.from({ length: 16 }, (_, i) => String.fromCharCode(0x200b + i))]);
const isHangul = (ch: string): boolean => ch >= '가' && ch <= '힣';
function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (SEPS.has(ch) || /\s/u.test(ch)) {
      if (cur !== '') out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') out.push(cur);
  return out;
}
function nameSequences(names: string[]): { seqs: Set<string>; parts: Set<string> } {
  const seqs = new Set<string>();
  const parts = new Set<string>();
  for (const raw of names) {
    const n = raw.normalize('NFKC');
    let run = '';
    for (const ch of `${n} `) {
      if (isHangul(ch)) run += ch;
      else {
        for (let i = 0; i + 1 < run.length; i += 1) seqs.add(run.slice(i, i + 2));
        run = '';
      }
    }
    const base = n.includes('@') ? n.split('@')[0]! : n;
    for (const p of base.split(/[._\- @]+/u)) if (/^[A-Za-z]{3,}$/u.test(p)) parts.add(p.toLowerCase());
  }
  return { seqs, parts };
}
function scriptOf(ch: string): 'lat' | 'cyr' | 'grk' | undefined {
  if (/\p{Script=Cyrillic}/u.test(ch)) return 'cyr';
  if (/\p{Script=Greek}/u.test(ch)) return 'grk';
  if (/\p{Script=Latin}/u.test(ch)) return 'lat';
  return undefined;
}
interface TopicResult { outcome: 'offer' | 'no-offer' | 'rejected-whole'; topic?: string; reason?: string; droppedTokens: string[] }
function referenceTopic(title: string, names: string[]): TopicResult {
  const t = title.normalize('NFKC');
  if (/[\n\r]/u.test(t) || [...t].some((ch) => BIDI.has(ch))) return { outcome: 'rejected-whole', droppedTokens: [] };
  const toks = tokenize(t).slice(0, 12);
  const { seqs, parts } = nameSequences(names);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const tok of toks) {
    const low = tok.toLowerCase();
    const scripts = new Set([...tok].map(scriptOf).filter((s) => s !== undefined));
    const drop =
      [...seqs].some((s) => tok.includes(s)) ||
      [...parts].some((p) => low === p || low.includes(p)) ||
      tok.includes('@') || tok.includes('://') || tok.includes('www.') ||
      /\d{3,}/u.test(tok) ||
      (scripts.has('lat') && (scripts.has('cyr') || scripts.has('grk'))) ||
      (tok.length > 20 && scripts.has('lat') && !/^[A-Za-z]+$/u.test(tok)) ||
      false;
    (drop ? dropped : kept).push(tok);
  }
  const sel = kept.slice(0, 4);
  const topic = sel.join(' ');
  if (sel.length === 0) return { outcome: 'no-offer', reason: 'no-token-survives', droppedTokens: dropped };
  if (topic.length < 2 || topic.length > 30) return { outcome: 'no-offer', reason: 'length', droppedTokens: dropped };
  if (!/^[가-힣A-Za-z0-9 .-]+$/u.test(topic)) return { outcome: 'no-offer', reason: 'charset', droppedTokens: dropped };
  if (sel.every((s) => /^(\d+(차|단계|회|라운드)|1st|2nd|3rd|\d+th|final|최종|round\d*)$/iu.test(s))) return { outcome: 'no-offer', reason: 'ordinal-or-stage-only', droppedTokens: dropped };
  return { outcome: 'offer', topic, droppedTokens: dropped };
}
function consentClass(reply: string): 'yes' | 'no' | 'cancelled' {
  let r = reply.normalize('NFC').trim();
  if (/[.!~?]$/u.test(r)) r = r.slice(0, -1);
  const low = r.toLowerCase();
  if (['응', '네', '예'].includes(r) || low === 'yes') return 'yes';
  if (['아니', '아니요', '아니오', '아뇨', '취소'].includes(r) || low === 'no') return 'no';
  return 'cancelled';
}

describe('s2-answer red-team data', () => {
  interface Rt {
    id: string; family: string; subFamily: string; attack: string; lang: string; title?: string; ownerReply?: string;
    turnsBetween?: unknown[]; turns?: unknown[]; conversation?: string; replyPlatform?: string;
    fixture?: { nameFields?: string[]; pendingConsent?: { ageSeconds: number }; conversation?: string; replyPlatform?: string; turnsBetween?: unknown[]; serviceRestarted?: boolean };
    expected: Record<string, unknown> & { outcome?: string; topic?: string | null; consentOutcome?: string; classifierAssumption?: string };
  }
  const corpus = json<{ cases: Rt[] }>('s2-answer.redteam.v1.json');
  const cases = corpus.cases;

  it('has at least 60 cases in Korean and English with unique ids and closed sub-families', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const langs = new Set(cases.map((c) => c.lang));
    expect(langs.has('ko') && langs.has('en')).toBe(true);
    const subs = new Set(cases.map((c) => c.subFamily));
    for (const s of ['answer', 'topic', 'consent', 'history', 'request']) expect(subs.has(s)).toBe(true);
    for (const c of cases) {
      expect(c.family).toBe('s2-answer');
      expect(['answer', 'topic', 'consent', 'history', 'request']).toContain(c.subFamily);
      expect(c.expected).toBeDefined();
    }
  });

  it('covers the attack families the record names', () => {
    const attacks = cases.map((c) => c.attack).join(' ');
    for (const k of ['title-instruction', 'url-in-output', 'fake-quoky-note', 'leak-after-yes', 'leak-after-no', 'leak-after-expiry', 'consent-nfd', 'consent-filler', 'topic-email', 'gate-two-items', 'topic-bidi', 'topic-homoglyph', 'secret-in-output', 'time-clock', 'argv-cli']) {
      expect(attacks).toContain(k);
    }
  });

  it('topic expectations equal the strict reference of A2-D12..D14 and keep the topic invariants', () => {
    let checked = 0;
    for (const c of cases) {
      if (c.subFamily !== 'topic' || c.title === undefined || !c.attack.startsWith('topic-')) continue;
      if (c.expected.classifierAssumption?.startsWith('worst-case: keeps the first 3')) {
        expect(c.expected.topic).toBe('Ignore previous instructions');
        continue;
      }
      const got = referenceTopic(c.title, c.fixture?.nameFields ?? []);
      expect(c.expected.outcome, c.id).toBe(got.outcome);
      if (got.outcome === 'offer') expect(c.expected.topic, c.id).toBe(got.topic);
      if (got.outcome === 'offer') {
        const nfkc = c.title.normalize('NFKC');
        const topic = got.topic!;
        expect(topic.length).toBeLessThanOrEqual(30);
        expect(topic.split(' ').length).toBeLessThanOrEqual(4);
        for (const token of topic.split(' ')) expect(nfkc.includes(token), `${c.id} ${token}`).toBe(true);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it('consent expectations equal the closed token set of the record', () => {
    let checked = 0;
    for (const c of cases) {
      if (c.subFamily !== 'consent' || c.ownerReply === undefined) continue;
      const f = c.fixture;
      if (f?.pendingConsent === undefined || f.pendingConsent.ageSeconds >= 600) continue;
      if (c.conversation !== undefined || c.replyPlatform !== undefined || c.turnsBetween !== undefined || c.turns !== undefined || f.serviceRestarted) continue;
      if (!['yes', 'no', 'cancelled'].includes(String(c.expected.consentOutcome))) continue;
      expect(c.expected.consentOutcome, `${c.id} ${JSON.stringify(c.ownerReply)}`).toBe(consentClass(c.ownerReply));
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it('keeps NFD replies distinct from their NFC form in the file (the variants are really decomposed)', () => {
    const nfd = cases.filter((c) => c.attack.startsWith('consent-nfd-'));
    expect(nfd.length).toBeGreaterThanOrEqual(5);
    for (const c of nfd) expect(c.ownerReply).not.toBe(c.ownerReply!.normalize('NFC'));
  });
});

describe('G4 blind-comparison case set', () => {
  interface G4Case { id: string; lang: string; item: { summary: string; start: string; end: string }; ownerRequest: string; nameFields: string[]; count?: number }
  const cases = json<{ cases: G4Case[] }>('g4-generation-cases.v1.json').cases;
  const manifest = json<{ files: Record<string, { sha256: string; cases?: number }>; seed: number; presentationPlan: { id: string; firstShownArm: string }[]; toBeRecordedBeforeRun: Record<string, unknown> }>('g4-manifest.v1.json');
  const rubric = json<{ seed: number; labels: Record<string, unknown> }>('g4-rubric.v1.json');

  it('has at least 30 synthetic cases in both languages with unique ids and requests', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => normalize(c.ownerRequest))).size).toBe(cases.length);
    expect(new Set(cases.map((c) => normalize(c.item.summary))).size).toBe(cases.length);
    expect(cases.some((c) => c.lang === 'ko') && cases.some((c) => c.lang === 'en')).toBe(true);
    for (const c of cases) {
      expect(Number.isNaN(Date.parse(c.item.start))).toBe(false);
      expect(Date.parse(c.item.end)).toBeGreaterThan(Date.parse(c.item.start));
      if (c.count !== undefined) expect(c.count).toBeGreaterThanOrEqual(1), expect(c.count).toBeLessThanOrEqual(10);
    }
  });

  it('is frozen: the manifest holds the sha256 of the case and rubric files, the seed, and the recomputed presentation plan', () => {
    expect(manifest.files['g4-generation-cases.v1.json']!.sha256).toBe(sha256(read('g4-generation-cases.v1.json')));
    expect(manifest.files['g4-generation-cases.v1.json']!.cases).toBe(cases.length);
    expect(manifest.files['g4-rubric.v1.json']!.sha256).toBe(sha256(read('g4-rubric.v1.json')));
    expect(manifest.seed).toBe(rubric.seed);
    expect(Object.keys(rubric.labels)).toEqual(['useless', 'usable', 'good']);
    const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
    const order = cases.map((c) => c.id).sort((a, b) => (h(`${manifest.seed}:order:${a}`) < h(`${manifest.seed}:order:${b}`) ? -1 : 1));
    const plan = order.map((id) => ({ id, firstShownArm: parseInt(h(`${manifest.seed}:side:${id}`).slice(0, 2), 16) % 2 === 0 ? 'A' : 'B' }));
    expect(manifest.presentationPlan).toEqual(plan);
    expect(Object.values(manifest.toBeRecordedBeforeRun).filter((v) => v === null).length).toBeGreaterThan(0);
  });
});

describe('local-judgment measurement set', () => {
  interface Lj { id: string; source: string; lang: string; judgment: string; ownerRequest: string; items: unknown[]; count?: number }
  const cases = json<{ cases: Lj[] }>('local-judgment-cases.v1.json').cases;
  const manifest = json<{ files: Record<string, { sha256: string; cases: number }>; preRegistered: { bar: string }; coverage: Record<string, number>; status: string }>('local-judgment-manifest.v1.json');

  it('has at least 30 multi-item synthetic cases over calendar, mail, jira, github and todo', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => normalize(c.ownerRequest))).size).toBe(cases.length);
    for (const src of ['calendar', 'mail', 'jira', 'github', 'todo']) expect(cases.filter((c) => c.source === src).length, src).toBeGreaterThanOrEqual(5);
    expect(cases.some((c) => c.lang === 'ko') && cases.some((c) => c.lang === 'en')).toBe(true);
    for (const c of cases) {
      expect(c.items.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(c.items)).not.toMatch(/@(?!example\.test)/u);
    }
  });

  it('is frozen by hash with the pre-registered bar', () => {
    expect(manifest.files['local-judgment-cases.v1.json']!.sha256).toBe(sha256(read('local-judgment-cases.v1.json')));
    expect(manifest.files['local-judgment-cases.v1.json']!.cases).toBe(cases.length);
    expect(manifest.preRegistered.bar).toMatch(/80%/u);
    expect(manifest.coverage).toEqual(Object.fromEntries(['calendar', 'mail', 'jira', 'github', 'todo'].map((s) => [s, cases.filter((c) => c.source === s).length])));
  });
});

describe('G5 name-filter held-out set', () => {
  interface Held { text: string; shape: string; scored: boolean; tokens: string[] }
  interface G5Case { id: string; lang: string; title: string; nameFields: string[]; held: Held[]; subjectTokens: string[] }
  const file = json<{ authorship: string; cases: G5Case[] }>('g5-name-heldout.v1.json');
  const manifest = json<{ authorship: string; files: Record<string, { sha256: string; cases: number; heldOutNames: number; scoredHeldOutNames: number }> }>('g5-manifest.v1.json');
  const cases = file.cases;
  const allHeld = cases.flatMap((c) => c.held);

  it('states its provenance and has at least 100 scored held-out names in unique titles', () => {
    expect(file.authorship).toMatch(/NO access to a classifier prompt/u);
    expect(manifest.authorship).toBe(file.authorship);
    expect(allHeld.filter((h) => h.scored).length).toBeGreaterThanOrEqual(100);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.title)).size).toBe(cases.length);
    expect(new Set(allHeld.map((h) => h.text)).size).toBe(allHeld.length);
  });

  it('covers every required shape with at least 10 scored names each', () => {
    const per = new Map<string, number>();
    for (const h of allHeld) if (h.scored) per.set(h.shape, (per.get(h.shape) ?? 0) + 1);
    for (const s of ['ko-2syl', 'ko-3syl', 'ko-4syl', 'ko-honorific', 'ko-compound-surname-3syl', 'ko-title-compound', 'romanized', 'foreign-translit', 'nickname', 'codename', 'organization']) {
      expect(per.get(s) ?? 0, s).toBeGreaterThanOrEqual(10);
    }
  });

  it('embeds each name in its title, tokens match the A2-D12 tokenization, and no name field covers a held-out name', () => {
    for (const c of cases) {
      const toks = tokenize(c.title.normalize('NFKC'));
      const { seqs, parts } = nameSequences(c.nameFields);
      for (const h of c.held) {
        expect(c.title.includes(h.text), `${c.id} ${h.text}`).toBe(true);
        expect(h.tokens.length).toBeGreaterThan(0);
        for (const t of h.tokens) expect(toks).toContain(t);
        expect([...seqs].some((s) => h.text.includes(s)), `${c.id} covered by a Hangul name field`).toBe(false);
        expect([...parts].some((p) => h.text.toLowerCase().includes(p)), `${c.id} covered by a Latin name field`).toBe(false);
      }
      for (const t of c.subjectTokens) expect(toks).toContain(t);
    }
  });

  it('is frozen: the manifest holds the sha256 and counts', () => {
    const m = manifest.files['g5-name-heldout.v1.json']!;
    expect(m.sha256).toBe(sha256(read('g5-name-heldout.v1.json')));
    expect(m.cases).toBe(cases.length);
    expect(m.heldOutNames).toBe(allHeld.length);
    expect(m.scoredHeldOutNames).toBe(allHeld.filter((h) => h.scored).length);
  });
});

describe('contamination lint (RAG-0 measures) against every golden corpus', () => {
  function harvest(value: unknown, out: string[]): void {
    if (Array.isArray(value)) for (const v of value) harvest(v, out);
    else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (['text', 'userText', 'utterance', 'ownerWords', 'ownerRequest'].includes(k) && typeof v === 'string') out.push(v);
        else if (k === 'turns' && Array.isArray(v)) for (const t of v) { if (typeof (t as { text?: unknown }).text === 'string') out.push((t as { text: string }).text); }
        else harvest(v, out);
      }
    }
  }
  const goldFiles = readdirSync(GOLDEN).filter((f) => f.endsWith('.json') && !f.includes('prompts') && !f.includes('fixture') && !f.startsWith('baseline'));
  const gold: string[] = [];
  for (const f of goldFiles) harvest(JSON.parse(readFileSync(new URL(f, GOLDEN), 'utf8')), gold);
  const goldUnique = [...new Set(gold)].filter((g) => !isShortText(g));
  const goldPrep = goldUnique.map((g) => ({ g, tokens: new Set(shapeTokens(g)), grams: charNgrams(g), long: Array.from(normalize(g).replace(/ /g, '')).length >= 10 }));

  const own: string[] = [];
  for (const f of ['agent-plan.ap8.v1.json', 'g4-generation-cases.v1.json', 's2-answer.redteam.v1.json', 'local-judgment-cases.v1.json']) harvest(json(f), own);
  for (const c of json<{ cases: { title: string }[] }>('g5-name-heldout.v1.json').cases) own.push(c.title);

  it('reads a substantial gold set and finds no near copy, exact copy or long containment', () => {
    expect(goldFiles.length).toBeGreaterThan(10);
    expect(goldUnique.length).toBeGreaterThan(2000);
    const findings: string[] = [];
    for (const text of new Set(own)) {
      if (isShortText(text)) continue;
      for (const gp of goldPrep) {
        const c = closeness(text, gp.g);
        const kind = findingKind(c);
        if (kind === undefined) continue;
        // Containment of a short generic gold text (for example "내일 일정") is the known artifact of that measure; only a gold of 10+ characters counts.
        if (kind === 'containment' && !gp.long) continue;
        findings.push(`${kind}: ${JSON.stringify(text)} ~ ${JSON.stringify(gp.g)}`);
      }
    }
    expect(findings).toEqual([]);
  }, 120_000);
});
