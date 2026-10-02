/**
 * One affirmative-execution guard for every approved git / hosting / workspace execution gate (Codex wave-8
 * re-review).
 *
 * The per-step grammars in `ConversationRuntime` (commit / push / PR creation / merge / main sync / local + remote
 * branch cleanup / final workspace apply) CLASSIFY which step a phrase talks about. Classification alone is not
 * authorization: "푸시 실행해도 돼?", "do not execute approved merge", "main 동기화하지 마", "커밋 실행했어" all name a
 * step without commanding it. Every gate that would perform a mutation therefore ALSO requires
 * {@link isAffirmativeExecutionCommand}: a short, present-tense, un-negated, non-hypothetical imperative. When it
 * fails, the gate falls back to its non-mutating "already approved / not executed" reply (or ordinary routing) —
 * it never executes.
 *
 * Deliberately conservative and whole-message: any rejection signal anywhere in the text vetoes execution (a
 * mixed "A 하지 말고 B 실행해" is not executed; the user can re-send the plain command). Each gate still requires
 * its OWN target noun via its step grammar — this guard never makes a phrase executable on its own.
 */

/** A command is short; longer free text (reports, pasted logs, quoted instructions) is never an execution command. */
export const MAX_EXECUTION_COMMAND_CHARS = 120;

/** Questions and permission/possibility asks — with or without a question mark. */
const QUESTION =
  /[?？]|해도\s*(돼|되|될|괜찮)|되나|하나요|할까|될까|할지|될지|되는지|하는지|할래|가능(해|한가|할까|하나|한지|한|$)|맞(아|나)|인가|어때|어떻게|어떤|왜|뭐|무엇|^\s*(can|could|should|shall|may|would|will|does|did|is|are|was|were)\b|\b(can|could|should|may)\s+(i|we|you)\b|\bis\s+it\b|\bwhether\b|\bok(ay)?\s+to\b|\bhow\b|\bwhat\b|\bwhy\b/i;

/** Negation / prohibition / stop / hold (KO + EN), anywhere in the message. */
const NEGATION =
  /지\s*마|지\s*말|말고|말아|하지\s*않|않(아|을|겠|고|는|기)|안\s*(해|하|할|돼|되|함)|못\s*(해|하)|금지|없이|멈춰|중지|중단|그만|취소|보류|\bnot\b|\bno\b|n['’]t\b|\bnever\b|\bwithout\b|\bstop\b|\bcancel\b|\bhold\s+off\b|\babort\b/i;

/** Past tense / statement / completion report. ("merged" is NOT listed: "delete local merged branch" is a command.) */
const PAST_OR_STATEMENT =
  /했|됐|되었|완료|끝났|끝냈|마쳤|이미|\balready\b|\bdone\b|\bexecuted\b|\bfinished\b|\bcompleted\b|\bwas\b|\bwere\b|\b(has|have)\s+been\b|\b(pushed|committed|synced|deleted|removed|applied)\b/i;

/** Reported speech, hypotheticals / conditionals, and explanation / summary requests. */
const REPORTED_OR_HYPOTHETICAL =
  /라고|라는|라던|랬|다고|하면|하려면|한다면|된다면|할\s*때|설명|알려|방법|의미|뜻|요약|로그|기록|이력|\b(said|says|told)\b|\bif\b|\bwhen\b|\bunless\b|\bexplain\b|\bsummar/i;

/** Why a phrase is not an affirmative execution command (`null` → it is one). Exposed for tests and diagnostics. */
export type ExecutionCommandRejection = 'empty' | 'too-long' | 'question' | 'negation' | 'past-or-statement' | 'reported-or-hypothetical';

export function executionCommandRejection(text: string): ExecutionCommandRejection | null {
  if (typeof text !== 'string') return 'empty';
  const t = text.trim();
  if (t.length === 0) return 'empty';
  if (t.length > MAX_EXECUTION_COMMAND_CHARS) return 'too-long';
  if (QUESTION.test(t)) return 'question';
  if (NEGATION.test(t)) return 'negation';
  if (PAST_OR_STATEMENT.test(t)) return 'past-or-statement';
  if (REPORTED_OR_HYPOTHETICAL.test(t)) return 'reported-or-hypothetical';
  return null;
}

/**
 * True iff `text` is a short, affirmative, present-tense imperative: no question / permission ask, no negation or
 * stop word, no past-tense / completion statement, no reported speech, hypothetical or explanation request. It says
 * nothing about WHICH step is commanded — the caller's step grammar (with its own target noun) decides that.
 */
export function isAffirmativeExecutionCommand(text: string): boolean {
  return executionCommandRejection(text) === null;
}
