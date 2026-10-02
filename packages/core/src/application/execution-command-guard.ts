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
 * mixed "A 하지 말고 B 실행해" is not executed; the user can re-send the plain command).
 *
 * AUTHORITY (orchestrator decision after the Codex wave-8 reviews): a gate executes ONLY through
 * {@link isAcceptedExecutionPhrase} — whole-message equality with the gate's closed {@link EXECUTION_PHRASES} list
 * after normalization. {@link isAffirmativeExecutionCommand} is kept inside it as a defence-in-depth veto only.
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

// ── Allow-list: the AUTHORITY for every approved execution gate (orchestrator decision after Codex wave-8 review) ──

/** An approved / direct execution gate that performs a mutation (git, hosting, workspace write, command run). */
export type ExecutionGate =
  | 'commit'
  | 'push'
  | 'prCreate'
  | 'merge'
  | 'mainSync'
  | 'localCleanup'
  | 'remoteCleanup'
  | 'patchApply'
  | 'validationTest'
  | 'validationTypecheck';

/**
 * The closed set of accepted execution phrases per gate. The FIRST entry is the documented phrase the composer / help
 * copy tells the user to send. A gate executes ONLY when the whole message equals one entry after
 * {@link normalizeExecutionPhrase} (plus an optional leading "지금"/"이제"/"now" and trailing "now"/"please") — no
 * substring, co-occurrence or regex grammar. Anything else that mentions the step gets the state's non-mutating reply,
 * which quotes the documented phrase.
 */
export const EXECUTION_PHRASES: Readonly<Record<ExecutionGate, readonly string[]>> = {
  commit: [
    '커밋 실행', '커밋 실행해줘', '승인된 커밋 실행', '승인된 커밋 실행해줘', '실제 커밋해줘', '실제로 커밋해줘',
    'execute commit', 'execute approved commit', 'run approved commit', 'commit approved changes',
  ],
  push: [
    '푸시 실행', '푸시 실행해줘', '승인된 푸시 실행해줘', 'push 실행', 'push 실행해줘', '승인된 push 실행해줘',
    '실제 푸시해줘', '실제 push 해줘', 'execute push', 'execute approved push', 'run approved push', 'push approved commit',
  ],
  prCreate: [
    'PR 생성 실행', 'PR 생성 실행해줘', 'PR 생성해줘', 'PR 만들어줘', 'PR 열어줘', '깃허브 PR 만들어줘', 'GitHub PR 만들어줘',
    'GitHub PR 열어줘', 'pull request 만들어줘', 'pull request 생성해줘', 'merge request 만들어줘', 'open a PR', 'open PR',
    'open a pull request', 'create a PR', 'create PR', 'create pull request', 'create a pull request', 'create merge request',
  ],
  merge: [
    '머지해줘', '머지 실행', '머지 실행해줘', 'PR 머지해줘', '이 PR 머지해줘', '승인된 PR 머지해줘', '실제 머지해줘', '실제로 머지해줘',
    'merge this PR', 'merge the PR', 'merge approved PR', 'merge the approved PR', 'merge now', 'execute merge',
    'execute approved merge',
  ],
  mainSync: [
    'main 동기화해줘', 'main 동기화', '로컬 main 동기화해줘', 'main 최신화해줘', '로컬 main 최신화해줘', 'main 받아와줘',
    '머지된 main 받아와줘', 'sync main', 'sync local main', 'update main', 'update local main', 'pull main',
  ],
  localCleanup: [
    '브랜치 정리해줘', '로컬 브랜치 정리해줘', '머지된 브랜치 정리해줘', '브랜치 삭제해줘', '로컬 브랜치 삭제해줘',
    'feature branch 삭제해줘', 'merged branch 정리해줘', 'cleanup local branch', 'clean up local branch', 'delete local branch',
    'delete local merged branch', 'delete merged branch',
  ],
  remoteCleanup: [
    '원격 브랜치 삭제 실행해줘', '원격 브랜치 삭제 실행', '원격 브랜치 제거 실행해줘', '원격 브랜치 정리 실행해줘',
    '원격 브랜치 삭제 진행해줘', '지금 원격 브랜치 삭제해줘', '실행해줘', '실행', '진행해', '진행해줘', 'proceed', 'go ahead',
    'execute', 'execute remote branch cleanup', 'execute remote branch deletion',
  ],
  patchApply: [
    '패치 적용해줘', '패치 적용', '최종 적용해줘', '최종 적용', '파일에 적용해줘', 'workspace에 적용해줘', 'apply patch',
    'apply to workspace',
  ],
  validationTest: ['테스트 실행해줘', '테스트 실행', '테스트 돌려줘', 'pnpm test 실행해줘', 'pnpm test', 'run tests', 'run the tests'],
  validationTypecheck: [
    '타입체크 실행해줘', '타입체크 해줘', '타입체크 돌려줘', 'typecheck 해줘', 'typecheck 실행해줘', 'pnpm typecheck 실행해줘',
    'pnpm typecheck', 'run typecheck',
  ],
};

/**
 * Normalize a message (or a list entry) for exact allow-list comparison: trim, collapse whitespace, case-fold, strip
 * trailing `.`/`!`/`~`, fold polite endings (`…해줘요`/`…해 주세요` → `…해줘`, `…줘요`/`…주세요` → `…줘`) and glue a
 * detached request verb (`실행 해줘` / `실행 해 줘` → `실행해줘`). Nothing else is rewritten.
 */
export function normalizeExecutionPhrase(text: string): string {
  if (typeof text !== 'string') return '';
  let t = text.trim().replace(/\s+/g, ' ').toLowerCase();
  t = t.replace(/[\s.!~。！]+$/u, '');
  t = t.replace(/\s*주세요$/u, '줘').replace(/줘요$/u, '줘');
  t = t.replace(/해\s+줘$/u, '해줘').replace(/\s+해줘$/u, '해줘');
  return t.trim();
}

const OPTIONAL_PREFIX = /^(지금|이제|now)\s+/u;
const OPTIONAL_SUFFIX = /\s+(now|please)$/u;

/** The normalized message plus the forms without one optional leading "지금/이제/now" and/or trailing "now/please". */
function candidateForms(text: string): string[] {
  const base = normalizeExecutionPhrase(text);
  const noPrefix = base.replace(OPTIONAL_PREFIX, '');
  const forms = new Set(
    [base, noPrefix, base.replace(OPTIONAL_SUFFIX, ''), noPrefix.replace(OPTIONAL_SUFFIX, '')].map(normalizeExecutionPhrase),
  );
  return [...forms].filter((f) => f.length > 0);
}

const NORMALIZED_PHRASES: Readonly<Record<ExecutionGate, ReadonlySet<string>>> = Object.fromEntries(
  Object.entries(EXECUTION_PHRASES).map(([gate, phrases]) => [gate, new Set(phrases.map(normalizeExecutionPhrase))]),
) as unknown as Record<ExecutionGate, ReadonlySet<string>>;

/** The documented phrase for a gate (the first allow-list entry) — what a non-mutating reply tells the user to send. */
export function documentedExecutionPhrase(gate: ExecutionGate): string {
  return EXECUTION_PHRASES[gate][0]!;
}

/**
 * True iff `text` is EXACTLY one of the gate's accepted execution phrases (after normalization and the optional
 * leading/trailing words) AND passes the {@link isAffirmativeExecutionCommand} veto (defence in depth). This is the
 * only way any approved / direct execution gate performs its mutation.
 */
export function isAcceptedExecutionPhrase(gate: ExecutionGate, text: string): boolean {
  if (!isAffirmativeExecutionCommand(text)) return false;
  const accepted = NORMALIZED_PHRASES[gate];
  return candidateForms(text).some((form) => accepted.has(form));
}
