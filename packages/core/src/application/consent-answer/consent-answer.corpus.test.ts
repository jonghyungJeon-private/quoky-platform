import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, InboundMessage, Session } from '../../domain';
import type { ConversationTurnHandler, Logger } from '../../ports';
import { CalendarTurnHandler } from '../calendar/calendar-turn-handler';
import { GitBranchTurnHandler } from '../code-work/git-branch-command';
import { ConversationRuntime, type ConversationRuntimeDeps } from '../conversation-runtime';
import { containsCredentialMaterial } from '../credential-guard';
import { DriveTurnHandler } from '../drive/drive-turn-handler';
import { FeedbackSummaryTurnHandler } from '../feedback/feedback-summary-turn-handler';
import { LearningTurnHandler } from '../feedback/learning-turn-handler';
import { HelpIntentTurnHandler } from '../help-intent/help-intent-turn-handler';
import { MailTurnHandler } from '../mail/mail-turn-handler';
import { MemoryCommandTurnHandler } from '../memory-commands/memory-command-turn-handler';
import { closeness, findingKind, isShortText, normalize } from '../nl-routing/example-contamination';
import { detectConversationControl } from '../conversation-commands';
import { ReminderTurnHandler } from '../reminders/reminder-turn-handler';
import { WorkChatTurnHandler } from '../work-chat/work-chat-turn-handler';
import { buildConsentClassifierPrompt, consentClassifierQuestion } from './consent-classifier';
import { CONSENT_ANSWER_LABELS, isConsentSource, type ConsentClassifierRequest, type ConsentSource } from './consent-labels';
import { ConsentPendingStore, summaryConsentPending, topicConsentPending, type ConsentScope } from './consent-pending';
import { ConsentTurnGate } from './consent-turn-gate';

/**
 * ADR-0121 amendment A6, slice A6-S4 (A6.9 as updated by R6): the consent-answer classifier eval corpus
 * `golden/nl-consent-answer.v1.json`, checked offline against the REAL Core (no model call):
 * - the schema, the A6.9 / R6 minimums and the language shares, and the sha256 pin (any edit, the owner review included, moves it);
 * - every question is exactly what `consentClassifierQuestion` renders for the case's context (placeholders, v2 nouns, A8 recipients);
 * - every stage is what the REAL runtime does (A6-S4 review round 1, Codex P2 / CA P3): each reply goes through a real
 *   `ConversationRuntime`'s `handleConsentGate` (its own `isConsentControlTurn` and `turnHandlerClaims` over the production turn-handler
 *   set) and the real `ConsentTurnGate` with a spy classifier: a control turn forfeits, a handler-claimed turn is `other` before the
 *   call, `structural-fail` and `fast-path` cases never reach the classifier, and each `classifier` case reaches it exactly once with
 *   exactly `{ question, reply }`;
 * - the owner verdicts and the A6.11 question 6 marks are present with the gold of their source case;
 * - no reply is credential-shaped, no shown value leaks into the question or the reply, and no reply is copied into the prompt.
 */

const CORPUS_FILE = new URL('../golden/nl-consent-answer.v1.json', import.meta.url);
/** Moves with ANY byte of the corpus (owner edits included); the frozen value goes into the measurement note after the owner review. */
const CORPUS_SHA256 = '40318f1fbcafc0ab33f27c77ed005a75e9c70d70b66eb71308c4b767740e0777';

type Stage = 'classifier' | 'structural-fail' | 'fast-path' | 'control-forfeit' | 'handler-claimed';
interface CorpusCase {
  readonly id: string;
  readonly lang: 'ko' | 'en';
  readonly consent: 'rule-1' | 'a2-topic';
  readonly question: string;
  readonly reply: string;
  readonly gold: (typeof CONSENT_ANSWER_LABELS)[number];
  readonly stage: Stage;
  readonly origin: 'owner-verdict' | 'drafted';
  readonly category: string;
  readonly ref?: string;
  readonly ownerMark?: { readonly status: string; readonly recommended: string; readonly source: string };
  readonly context: {
    readonly flow: 'agent-m2' | 'a8-unexpected' | 'd8-lookup' | 'a2-topic';
    readonly language: 'ko' | 'en';
    readonly recipient: string;
    readonly sources?: readonly string[];
    readonly shown: { readonly canary: string; readonly counts?: readonly number[]; readonly topic?: string };
  };
  readonly note?: string;
}
interface Corpus {
  readonly version: number;
  readonly name: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly stages: Record<string, string>;
  readonly categories: Record<string, string>;
  readonly cases: readonly CorpusCase[];
}

const TEXT = readFileSync(CORPUS_FILE, 'utf8');
const CORPUS = JSON.parse(TEXT) as Corpus;
const CASES = CORPUS.cases;
const NOW = 1_800_000_000_000;
const DM: ConversationContext = { platform: 'test', channelId: 'dm-1', userId: 'owner-user', direct: true };
const OWNER: Actor = { id: 'owner-actor', displayName: 'Owner', identities: [], createdAt: '2026-10-01T00:00:00.000Z' };
const SCOPE: ConsentScope = { actorId: OWNER.id, conversationKey: ConsentTurnGate.conversationKeyOf(DM) };
const SESSION = { id: 'session-1', context: DM } as unknown as Session;

/**
 * The turn handlers production registers that have a pure `surfaceClaim` (apps/quoky `turn-handlers.providers.ts`: code work,
 * work chat (both modes), reminders, feedback and learning, memory commands, calendar, mail, Drive and help intent; the
 * model-selection handler has no `surfaceClaim`). Only `surfaceClaim` is read here, and it reads no dependency but the time zone.
 */
const noDeps = new Proxy({}, { get: () => undefined }) as never;
const productionHandlers = (): ConversationTurnHandler[] => [
  new GitBranchTurnHandler(noDeps),
  new WorkChatTurnHandler({ mode: 'mutation' } as never),
  new WorkChatTurnHandler({ mode: 'lookup' } as never),
  new ReminderTurnHandler(noDeps),
  new FeedbackSummaryTurnHandler(noDeps),
  new LearningTurnHandler(noDeps),
  new MemoryCommandTurnHandler(noDeps),
  new CalendarTurnHandler(noDeps),
  new MailTurnHandler(noDeps),
  new DriveTurnHandler(noDeps),
  new HelpIntentTurnHandler(noDeps),
];

function pendingOf(c: CorpusCase) {
  const base = { scope: SCOPE, language: c.context.language, createdAtMs: NOW - 5_000, recipient: c.context.recipient };
  return c.consent === 'a2-topic'
    ? topicConsentPending({ ...base, topic: c.context.shown.topic as string })
    : summaryConsentPending({
        ...base,
        runRef: `run-${c.id}`,
        sources: (c.context.sources ?? []).map((source, index) => ({
          source: source as ConsentSource,
          itemIds: Array.from({ length: c.context.shown.counts?.[index] ?? 1 }, (_, item) => `${c.id}-${source}-${item}`),
        })),
      });
}

/**
 * The stage the REAL runtime gives the case: a real `ConversationRuntime` (production handler set, the gate composed) runs its own
 * `handleConsentGate` exactly as `handle` calls it (`control` = `detectConversationControl`, no other owner step), and the gate's
 * closed log line names what happened. The spy classifier answers the gold label. No hand copy of the control or claim rules.
 */
async function actualStage(c: CorpusCase): Promise<{ stage: Stage | 'unknown'; requests: ConsentClassifierRequest[]; reason: string }> {
  const store = new ConsentPendingStore();
  store.open(pendingOf(c));
  const requests: ConsentClassifierRequest[] = [];
  const lines: { outcome: string; reason: string }[] = [];
  const logger: Logger = {
    info: (event: string, fields?: Record<string, unknown>) => {
      if (event === 'consent_gate.turn') lines.push({ outcome: String(fields?.outcome), reason: String(fields?.reason) });
    },
    warn: () => undefined,
    error: () => undefined,
  };
  const gate = new ConsentTurnGate({
    store,
    classifier: {
      mode: 'on',
      classify: async (request) => {
        requests.push(request);
        return c.gold;
      },
    },
    chargeModelCall: () => true,
    continueSummary: async () => ({ kind: 'reply', reply: { text: 'SUMMARY' } }),
    now: () => NOW,
    logger,
  });
  const deps = {
    turnHandlers: productionHandlers(),
    logger,
    memory: { recordShortTerm: async () => ({ id: 'memory-1' }), recordAssistant: async () => undefined },
  } as unknown as ConversationRuntimeDeps;
  const runtime = new ConversationRuntime(deps, { clock: () => new Date(NOW).toISOString() as never, consentTurnGate: gate }) as unknown as {
    handleConsentGate(message: InboundMessage, session: Session, actor: Actor, ownerStepPending: boolean, control: boolean): Promise<unknown>;
  };
  const message: InboundMessage = { id: `msg-${c.id}`, context: DM, text: c.reply, receivedAt: new Date(NOW).toISOString() as never };
  await runtime.handleConsentGate(message, SESSION, OWNER, false, detectConversationControl(c.reply) !== null);
  const reason = lines.map((line) => `${line.outcome}:${line.reason}`).join(';');
  if (requests.length > 0) return { stage: 'classifier', requests, reason };
  if (lines.some((line) => line.outcome === 'forfeit' && line.reason === 'control')) return { stage: 'control-forfeit', requests, reason };
  if (lines.some((line) => line.reason === 'handler-claimed')) return { stage: 'handler-claimed', requests, reason };
  if (lines.some((line) => line.reason === 'closed-yes' || line.reason === 'closed-no')) return { stage: 'fast-path', requests, reason };
  if (lines.some((line) => line.reason === 'structural-fail' || line.reason === 'over-caps')) return { stage: 'structural-fail', requests, reason };
  return { stage: 'unknown', requests, reason };
}

describe('A6-S4 consent-answer corpus: schema, minimums and pin', () => {
  it('has the header, the closed vocabularies and the owner-review status (not frozen)', () => {
    expect(CORPUS.version).toBe(1);
    expect(CORPUS.name).toBe('nl-consent-answer.v1');
    expect(CORPUS.status).toBe('owner-review');
    expect(CORPUS.labels).toEqual([...CONSENT_ANSWER_LABELS]);
    expect(Object.keys(CORPUS.stages).sort()).toEqual(['classifier', 'control-forfeit', 'fast-path', 'handler-claimed', 'structural-fail']);
    expect(Object.keys(CORPUS.categories).sort()).toEqual(['adversarial', 'no', 'non-answer', 'positive', 'unclear', 'yes-and-more']);
  });

  it('every case is well formed (closed keys and values, unique ids)', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const keys = new Set(['id', 'lang', 'consent', 'question', 'reply', 'gold', 'stage', 'origin', 'category', 'ref', 'ownerMark', 'context', 'note']);
    for (const c of CASES) {
      if (!/^ca-\d{3}$/u.test(c.id) || seen.has(c.id)) problems.push(`${c.id}: id`);
      seen.add(c.id);
      for (const key of Object.keys(c)) if (!keys.has(key)) problems.push(`${c.id}: key ${key}`);
      if (c.lang !== 'ko' && c.lang !== 'en') problems.push(`${c.id}: lang`);
      if (c.consent !== 'rule-1' && c.consent !== 'a2-topic') problems.push(`${c.id}: consent`);
      if (typeof c.reply !== 'string' || c.reply.trim() === '') problems.push(`${c.id}: reply`);
      if (!(CONSENT_ANSWER_LABELS as readonly string[]).includes(c.gold)) problems.push(`${c.id}: gold`);
      if (!(c.stage in CORPUS.stages)) problems.push(`${c.id}: stage`);
      if (c.origin !== 'owner-verdict' && c.origin !== 'drafted') problems.push(`${c.id}: origin`);
      if (!(c.category in CORPUS.categories)) problems.push(`${c.id}: category`);
      if ((c.consent === 'a2-topic') !== (c.context.flow === 'a2-topic')) problems.push(`${c.id}: flow`);
      if (c.consent === 'a2-topic' && (typeof c.context.shown.topic !== 'string' || c.context.sources !== undefined)) problems.push(`${c.id}: a2 context`);
      if (c.consent === 'rule-1' && (c.context.sources?.length ?? 0) !== (c.context.shown.counts?.length ?? -1)) problems.push(`${c.id}: counts`);
      if (c.context.shown.counts?.some((count) => !Number.isInteger(count) || count < 1 || count > 10)) problems.push(`${c.id}: count range`);
    }
    expect(problems).toEqual([]);
  });

  it('meets the A6.9 / R6 minimums (classifier-stage cases counted where the gate measures them) and the language shares', () => {
    const count = (predicate: (c: CorpusCase) => boolean) => CASES.filter(predicate).length;
    const classifier = (c: CorpusCase) => c.stage === 'classifier';
    expect(CASES.length).toBeGreaterThanOrEqual(300);
    expect(count((c) => c.lang === 'ko') / CASES.length).toBeGreaterThanOrEqual(0.6);
    expect(count((c) => c.lang === 'en') / CASES.length).toBeGreaterThanOrEqual(0.25);
    expect(count((c) => c.category === 'positive' && c.gold === 'yes' && classifier(c))).toBeGreaterThanOrEqual(80);
    expect(count((c) => c.category === 'no' && c.gold === 'no' && classifier(c))).toBeGreaterThanOrEqual(60);
    expect(count((c) => c.category === 'non-answer' && c.gold === 'other' && classifier(c))).toBeGreaterThanOrEqual(100);
    expect(count((c) => c.category === 'adversarial')).toBeGreaterThanOrEqual(40);
    expect(count((c) => c.category === 'unclear' && c.gold === 'unclear' && classifier(c))).toBeGreaterThanOrEqual(20);
    // r-03 (2) (owner 2026-11-24): yes-and-more at least 40, at the classifier stage like every other measured lot.
    expect(count((c) => c.category === 'yes-and-more' && c.gold === 'yes-and-more' && classifier(c))).toBeGreaterThanOrEqual(40);
    // Category and gold agree outside the adversarial set; both consents and both languages are covered per category.
    const goldOf: Record<string, string> = { positive: 'yes', no: 'no', 'non-answer': 'other', unclear: 'unclear', 'yes-and-more': 'yes-and-more' };
    expect(CASES.filter((c) => c.category !== 'adversarial' && goldOf[c.category] !== c.gold).map((c) => c.id)).toEqual([]);
    for (const category of Object.keys(CORPUS.categories)) {
      for (const consent of ['rule-1', 'a2-topic']) expect(count((c) => c.category === category && c.consent === consent), `${category} ${consent}`).toBeGreaterThan(0);
      for (const lang of ['ko', 'en']) expect(count((c) => c.category === category && c.lang === lang), `${category} ${lang}`).toBeGreaterThan(0);
    }
  });

  it('is pinned by sha256 (an edit, the owner review included, must update this pin and the summary)', () => {
    expect(createHash('sha256').update(TEXT).digest('hex')).toBe(CORPUS_SHA256);
  });
});

describe('A6-S4 consent-answer corpus: the questions are exactly what the classifier sees', () => {
  it('each question equals consentClassifierQuestion for its context (placeholders only, no digit)', () => {
    const mismatches = CASES.filter((c) => {
      const rendered = consentClassifierQuestion(
        c.consent === 'a2-topic'
          ? { kind: 'topic-consent', language: c.context.language, recipient: c.context.recipient }
          : { kind: 'summary-consent', language: c.context.language, recipient: c.context.recipient, sources: (c.context.sources ?? []).map((source) => ({ source: source as ConsentSource })) },
      );
      return rendered === '' || rendered !== c.question || /\d/u.test(c.question);
    });
    expect(mismatches.map((c) => c.id)).toEqual([]);
  });

  it('covers the v2 thread nouns, the A8.5 unexpected recipients, the A8.6 D8 lookup and every consent source', () => {
    const sources = new Set(CASES.flatMap((c) => c.context.sources ?? []));
    expect([...sources].every(isConsentSource)).toBe(true);
    expect([...sources].sort()).toEqual(['calendar', 'confluence', 'drive', 'github', 'jira', 'mail', 'mail-thread', 'slack', 'slack-thread']);
    const a8 = CASES.filter((c) => c.context.flow === 'a8-unexpected');
    expect(a8.length).toBeGreaterThanOrEqual(20);
    expect(a8.every((c) => c.context.recipient !== 'Claude' && c.context.shown.counts?.length === 1 && c.context.shown.counts[0] === 1)).toBe(true);
    expect(new Set(a8.map((c) => c.context.recipient))).toEqual(new Set(['Codex', 'OpenAI', 'Gemini']));
    expect(CASES.filter((c) => c.context.flow === 'd8-lookup').length).toBeGreaterThanOrEqual(15);
    for (const thread of ['mail-thread', 'slack-thread']) {
      expect(CASES.filter((c) => c.context.sources?.includes(thread) && c.context.language === 'ko').length, thread).toBeGreaterThan(0);
      expect(CASES.filter((c) => c.context.sources?.includes(thread) && c.context.language === 'en').length, thread).toBeGreaterThan(0);
    }
  });

  it('no shown value (canary, topic or any of its tokens) appears in a question or a reply, and no reply is credential-shaped', () => {
    const leaks: string[] = [];
    for (const c of CASES) {
      const values = [c.context.shown.canary, ...(c.context.shown.topic !== undefined ? [c.context.shown.topic, ...c.context.shown.topic.split(/\s+/u).filter((token) => token.length >= 2)] : [])];
      for (const value of values) if (c.question.includes(value) || c.reply.includes(value)) leaks.push(`${c.id}: ${value}`);
      if (containsCredentialMaterial(c.reply)) leaks.push(`${c.id}: credential-shaped`);
    }
    expect(leaks).toEqual([]);
  });

  it('no reply is copied into the classifier prompt (the contamination measures; the prompt has no example)', () => {
    const lines = buildConsentClassifierPrompt({ question: '', reply: '' }).split('\n').filter((line) => line.trim() !== '');
    const findings: string[] = [];
    for (const reply of new Set(CASES.map((c) => c.reply))) {
      if (isShortText(reply)) continue;
      for (const line of lines) {
        const kind = findingKind(closeness(reply, line));
        if (kind === 'exact' || kind === 'near' || (kind === 'containment' && Array.from(normalize(reply).replace(/ /g, '')).length >= 10)) findings.push(`${kind}: ${JSON.stringify(reply)} ~ ${JSON.stringify(line)}`);
      }
    }
    expect(findings).toEqual([]);
  });
});

describe('A6-S4 consent-answer corpus: every stage is what the real pipeline does', () => {
  it('control turns forfeit, claimed turns are other, structural and fast-path cases never call the classifier, classifier cases call it once with exactly { question, reply }', async () => {
    const wrong: string[] = [];
    for (const c of CASES) {
      const actual = await actualStage(c);
      if (actual.stage !== c.stage) wrong.push(`${c.id} ${JSON.stringify(c.reply)}: ${c.stage} -> ${actual.stage}`);
      if (actual.stage === 'classifier') {
        if (actual.requests.length !== 1) wrong.push(`${c.id}: ${actual.requests.length} calls`);
        else if (JSON.stringify(actual.requests[0]) !== JSON.stringify({ question: c.question, reply: c.reply })) wrong.push(`${c.id}: request ${JSON.stringify(actual.requests[0])}`);
      }
      if (actual.stage === 'fast-path' && !actual.reason.includes(c.gold === 'yes' ? 'closed-yes' : 'closed-no')) wrong.push(`${c.id}: fast path ${actual.reason}`);
      // A natural reply the structural checks cancel (gold yes / no) must say so: the recorded usability cost (the apostrophes).
      if (actual.stage === 'structural-fail' && c.gold !== 'other' && !(c.note ?? '').includes('usability cost')) wrong.push(`${c.id}: structural gold ${c.gold}`);
      // A binding reply a handler claims (or a command forfeits) is not measured: it must say it is the recorded residual.
      if ((actual.stage === 'handler-claimed' || actual.stage === 'control-forfeit') && c.gold !== 'other' && !(c.note ?? '').includes('residual')) wrong.push(`${c.id}: ${actual.stage} gold ${c.gold}`);
      if (actual.stage === 'unknown') wrong.push(`${c.id}: no stage (${actual.reason})`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('A6-S4 consent-answer corpus: the apostrophe finding (owner / ADR question, production unchanged)', () => {
  it('a contraction with the ASCII or the typographic apostrophe (U+2019) is cancelled structurally, never sent to the classifier', () => {
    const apostrophes = CASES.filter((c) => /[A-Za-z]['\u2019][A-Za-z]/u.test(c.reply));
    expect(apostrophes.filter((c) => c.reply.includes('\u2019')).map((c) => c.reply).sort()).toEqual(['don\u2019t', 'that\u2019s fine']);
    expect(apostrophes.filter((c) => c.reply.includes("'")).length).toBeGreaterThanOrEqual(3);
    expect(apostrophes.filter((c) => c.stage !== 'structural-fail').map((c) => c.id)).toEqual([]);
  });
});

describe('A6-S4 consent-answer corpus: owner verdicts and the A6.11 question 6 marks', () => {
  const golden = (path: string): unknown => JSON.parse(readFileSync(new URL(`../golden/${path}`, import.meta.url), 'utf8'));
  const sr1 = new Map((golden('agent-redteam.s2-read.v1.json') as { cases: { id: string; text: string }[] }).cases.map((c) => [c.id, c.text] as const));
  const a2 = new Map((golden('a2/s2-answer.redteam.v1.json') as { cases: { id: string; ownerReply?: string }[] }).cases.map((c) => [c.id, c.ownerReply] as const));
  const byRef = new Map(CASES.filter((c) => c.ref !== undefined).map((c) => [c.ref as string, c] as const));

  it('each SR-1 / A2 owner verdict of A6.1, A6.8, R2 a6-06, R8 and r-01 is a case with the reply of its source case and the decided gold', () => {
    const expected: Record<string, string> = {
      'rt-s2r-462': 'yes-and-more', 'rt-s2r-463': 'yes', 'rt-s2r-468': 'yes', 'rt-s2r-469': 'yes', 'rt-s2r-470': 'yes', 'rt-s2r-472': 'yes-and-more',
      'rt-s2r-483': 'other', 'rt-s2r-484': 'other', 'rt-s2r-485': 'other', 'rt-s2r-487': 'yes', 'rt-s2r-488': 'yes',
      'rt-s2a-120': 'yes', 'rt-s2a-123': 'yes', 'rt-s2a-124': 'yes', 'rt-s2a-125': 'yes', 'rt-s2a-130': 'yes-and-more', 'rt-s2a-136': 'yes',
      // r-01 (owner, 2026-11-24): 473 is yes-and-more (the recommendation `other` was not taken).
      'rt-s2r-473': 'yes-and-more',
    };
    for (const [ref, gold] of Object.entries(expected)) {
      const c = byRef.get(ref);
      expect(c, ref).toBeDefined();
      expect(c?.origin, ref).toBe('owner-verdict');
      expect(c?.gold, ref).toBe(gold);
      expect(c?.reply, ref).toBe(ref.startsWith('rt-s2r') ? sr1.get(ref) : a2.get(ref));
    }
  });

  it('marks the 17 A6.11 question 6 replies (r-04 kept the recommended label) and R8 473 (r-01: yes-and-more) as owner-decided 2026-11-24', () => {
    const q6: Record<string, string> = {
      'rt-s2a-118': 'yes', 'rt-s2a-119': 'yes', 'rt-s2a-121': 'yes', 'rt-s2a-126': 'yes', 'rt-s2a-127': 'yes', 'rt-s2a-128': 'yes', 'rt-s2a-131': 'yes', 'rt-s2a-133': 'yes',
      'rt-s2a-138': 'yes', 'rt-s2a-139': 'yes', 'rt-s2a-122': 'no', 'rt-s2a-129': 'no', 'rt-s2a-132': 'unclear', 'rt-s2a-134': 'unclear', 'rt-s2a-137': 'unclear',
      'rt-s2a-140': 'unclear', 'rt-s2a-141': 'unclear',
    };
    expect(Object.keys(q6)).toHaveLength(17);
    for (const [ref, label] of [...Object.entries(q6), ['rt-s2r-473', 'other'] as const]) {
      const c = byRef.get(ref);
      expect(c, ref).toBeDefined();
      expect(c?.ownerMark?.status, ref).toBe('owner-decided-2026-11-24');
      expect(c?.origin, ref).toBe('owner-verdict');
      expect(c?.ownerMark?.recommended, ref).toBe(label);
      expect(c?.gold, ref).toBe(ref === 'rt-s2r-473' ? 'yes-and-more' : label);
      expect(c?.stage, ref).toBe('classifier');
      expect(c?.reply, ref).toBe(ref.startsWith('rt-s2r') ? sr1.get(ref) : a2.get(ref));
    }
    expect(CASES.filter((c) => c.ownerMark !== undefined)).toHaveLength(18);
    expect(CASES.filter((c) => c.ownerMark?.status === 'recommended-pending-owner')).toEqual([]);
  });
});
