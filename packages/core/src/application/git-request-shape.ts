/**
 * Git-operation request shape (live QA 2026-10-07, "git rebase와 merge 차이를 간단히 설명해줘").
 *
 * The anchored code-chain detectors (merge / PR create / push / main sync / branch cleanup / commit) match a git word
 * plus a request verb. Before this module, a verb anywhere in the sentence counted, so a concept question that ends
 * in "설명해줘" or "알려줘" was read as a merge request and got the merge-disabled refusal. QA-V2-W8-01 fixed the same
 * class for push. These helpers name the shapes that are never a git-operation request, so a detector or a bare-word
 * reply can step aside and let the turn reach ordinary chat or its turn handler.
 *
 * Precedence, per clause (Codex review of f45ab9d):
 *  1. a git operation verb attached to its own git word in a clause without a concept marker ("머지해줘. 그리고 rebase와
 *     차이를 설명해줘") keeps the deterministic action handling — it is never a concept question or a topic mention;
 *  2. a status ask ("머지 가능한지 설명해줘", "PR 리뷰 어때?") keeps the live read-only status routes;
 *  3. otherwise a concept / explanation / comparison / how-to marker, or a non-git main verb, makes the turn topic-only.
 * Korean markers match whole words only (a following particle is allowed): "차이를" is a marker, "차이나" is not.
 *
 * Pure, deterministic and provider-free. They only REMOVE a trigger and never create a positive intent. They are never
 * consulted by an execution gate: the approved-execution allow-list (`EXECUTION_PHRASES`) stays exact.
 */

/** Not preceded by a Hangul syllable (the marker starts a word). */
const KO_START = '(?<![가-힣])';
/** Not followed by a Hangul syllable (the marker ends its word, after an optional particle). */
const KO_END = '(?![가-힣])';
/** Particles and copulas a Korean marker noun may carry. */
const KO_PARTICLE =
  '(?:이|가|을|를|은|는|의|도|만|에|에서|와|과|랑|이랑|로|으로|이란|란|이야|야|예요|이에요|입니다|점|점이|점을|점은|점도)?';
/** A whole Korean marker noun (with an optional particle): "차이", "차이를", "차이점이" — never "차이나". */
const koNoun = (words: string): string => `${KO_START}(?:${words})${KO_PARTICLE}${KO_END}`;

/** Clause boundaries (sentence punctuation, commas, connectives, and a Korean "-고" chain), like calendar-question. */
const CLAUSE_SPLIT = /[.!?。！？]\s+|[.!?。！？]$|[,;]\s*|\s+(?:but|then)\s+|\s*(?:그리고|하지만|근데|그런데)\s+|(?<=[가-힣]고)\s+/iu;

/**
 * A git status / result / possibility ask ("PR 상태가 뭐야?", "CI 결과 알려줘", "머지됐어?", "머지 가능한지 설명해줘",
 * "PR 리뷰 어때?"). It keeps the deterministic read-only status replies, so a status ask is never a concept question.
 * It needs a status PREDICATE — a bare review noun is not one ("PR 리뷰 어떻게 하는지 알려줘" is a how-to; Codex re-review
 * of 63ab7a0).
 */
const GIT_STATUS_ASK =
  /상태|결과|진행\s*상황|됐|되었|돼\s*있|통과|열려\s*있|가능|안전|괜찮|어때|되나|\bstatus\b|\bci\b|체크(?!\s*아웃)|\bchecks?\b|\bmergeable\b|\bmerged\b|\bpushed\b|\bdeleted\b|\bsynced\b/i;

/**
 * Concept / explanation / comparison / how-to markers. Each marker asks about something and never requests the action:
 * "차이", "비교", "설명해줘", "뭐야", "란?", "어떻게 동작해", "해결법", "what's the difference", "explain git merge".
 * "어떻게 됐어" (a status ask) is deliberately not a marker.
 */
const GIT_CONCEPT_MARKERS: readonly RegExp[] = [
  new RegExp(koNoun('차이|비교|장단점|개념|원리|의미|역할|뜻|(?:해결|사용|설정)?방법|해결법|사용법'), 'u'),
  new RegExp(`${KO_START}(?:설명|비교)\\s*(?:을|를)?\\s*(?:좀\\s*)?(?:해|부탁|가능)|${KO_START}가르쳐`, 'u'),
  /뭐(?:야|예요|에요|지|냐|니|임|가\s*(?:달라|다르))|뭔(?:가요|데|지|가)|무엇(?:이|인)|무슨\s*(?:뜻|의미|차이|역할)/u,
  /[A-Za-z0-9가-힣](?:이)?란\s*(?:[?？]|뭐|무엇|$)/u,
  /어떻게\s*(?:동작|작동|돌아가|되는\s*(?:거|건|지)|하는|하나|하지|하면|해야|해\s*[?？]|해요|쓰|써|사용|해결|처리)/u,
  new RegExp(`[가-힣]는\\s*법${KO_PARTICLE}${KO_END}`, 'u'),
  /언제\s*(?:써|쓰|사용|해야|하는)|왜\s*(?:써|쓰|사용|필요|해야|하는)/u,
  new RegExp(
    `${KO_START}(?:전략|컨벤션|규칙|원칙|팁|가이드)\\s*(?:을|를|이|은|좀)?\\s*(?:알려|설명|추천|정리|비교|뭐)`,
    'u',
  ),
  /\bvs\.?(?=\s|$)|\bversus\b/i,
  /\bwhat(?:'s|\s+is|\s+are|\s+does|\s+do)\b|\bhow\s+(?:do|does|can|should|would|to)\b/i,
  /\bexplain\b|\bexplanation\b|\bdifferences?\b|\bcompare\b|\bcomparison\b|\bmeaning\b|\bconcepts?\b/i,
  /\btell\s+me\s+about\b|\bwhy\s+(?:do|does|would|should|is|are)\b|\bwhen\s+(?:to|should|do)\b|\bpros\s+and\s+cons\b|\bbest\s+practices?\b/i,
];

/**
 * A request whose own verb is a non-git one: summarizing, translating, reviewing, recommending, writing ("머지 로그
 * 요약해줘", "푸시 로직을 검토해줘", "summarize the merge log"). The git word is only its topic.
 */
const TOPIC_VERB_TAIL =
  /(?:요약|번역|검토|리뷰|분석|추천|작성|조사)\s*(?:을|를)?\s*(?:좀\s*)?(?:해\s*줘요?|해\s*주세요|해\s*줄래요?|해\s*봐|해)\s*[.!~?？]*$|(?:써|찾아|알아봐)\s*(?:줘요?|주세요|줄래요?)\s*[.!~?？]*$/u;
const TOPIC_VERB_HEAD = /^\s*(?:please\s+)?(?:summarize|translate|review|analy[sz]e|recommend|describe|document)\b/i;

/**
 * A git operation verb attached to its own git word ("머지해줘", "머지하고 …", "PR 만들어", "main 동기화해", "브랜치
 * 삭제해", "merge the PR"). A topic tail on another verb never hides such a request ("머지하고 릴리즈 노트 작성해줘").
 */
const GIT_OPERATION_ATTACHED =
  /(?:머지|병합|푸시|배포|릴리즈|커밋|리베이스|동기화|최신화)\s*(?:을|를)?\s*(?:좀\s*)?(?:해(?!결)|하고|하자|한\s*(?:다음|뒤|후)|시켜|진행|실행|승인)|(?:\bpr\b|풀\s*리퀘|pull\s*request)\s*(?:을|를)?\s*(?:만들|생성|열|올려)|브랜치\s*(?:을|를)?\s*(?:삭제|정리|지워|제거)|\b(?:merge|push|deploy|release|commit|rebase|sync)\s+(?:this|it|the|now|pr|main|to|approved)\b|^\s*(?:please\s+)?(?:merge|push|deploy|release|commit|rebase)\b(?!\s+(?:is|vs|and|or|conflicts?|strateg))/iu;

/** An English coordinating "and"/"or" — inside a question it joins the question's own objects, never a new imperative. */
const EN_AND = /\s+(?:and|or)\s+/i;

/**
 * The clauses of `text`. An English "and"/"or" splits only after a clause with no concept marker, so "what's the
 * difference between rebase and merge" and "how to create a branch and merge it" stay one question, while "merge the
 * PR and explain rebase" keeps "merge the PR" as its own clause.
 */
function clausesOf(text: string): string[] {
  const clauses: string[] = [];
  for (const sentence of text.split(CLAUSE_SPLIT)) {
    let current = '';
    for (const part of sentence.split(EN_AND)) {
      if (current.length > 0 && hasConceptMarker(current)) {
        current = `${current} and ${part}`;
      } else {
        if (current.trim().length > 0) clauses.push(current.trim());
        current = part;
      }
    }
    if (current.trim().length > 0) clauses.push(current.trim());
  }
  return clauses;
}

function hasConceptMarker(text: string): boolean {
  return GIT_CONCEPT_MARKERS.some((re) => re.test(text));
}

/**
 * True when some clause carries a git operation verb attached to its git word and no concept marker of its own
 * ("머지해줘. 그리고 rebase와 차이를 설명해줘", "차이나 서버 변경을 푸시해줘"). Such a message keeps the deterministic action
 * handling; an explanation clause elsewhere never hides it.
 */
export function hasAttachedGitOperation(text: string): boolean {
  if (typeof text !== 'string') return false;
  return clausesOf(text).some((clause) => GIT_OPERATION_ATTACHED.test(clause) && !hasConceptMarker(clause));
}

/**
 * A concept / explanation / comparison / how-to question about git ("git rebase와 merge 차이를 간단히 설명해줘", "merge
 * conflict 해결법 알려줘", "머지 전략 비교해줘", "rebase란?", "explain git merge"). A status ask is never one, and neither is
 * a message with an attached git operation in another clause.
 */
export function isGitConceptQuestion(text: string): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0 || GIT_STATUS_ASK.test(t) || hasAttachedGitOperation(t)) return false;
  return hasConceptMarker(t);
}

/**
 * A turn that only talks ABOUT a git operation: a concept question ({@link isGitConceptQuestion}), or a request whose
 * own verb is a non-git one with no git operation verb attached to a git word. Such a turn is never a git-operation
 * request, and the anchored chain's bare-word replies (already approved / already merged / unsupported companion) do
 * not apply to it.
 */
export function isGitTopicOnlyMention(text: string): boolean {
  if (typeof text !== 'string') return false;
  if (isGitConceptQuestion(text)) return true;
  const t = text.trim();
  if (!TOPIC_VERB_TAIL.test(t) && !TOPIC_VERB_HEAD.test(t)) return false;
  return !GIT_OPERATION_ATTACHED.test(t);
}

/**
 * A request for a chain companion step — deploy / release / merge / auto-merge / reviewer / label / assignee — with the
 * request verb attached to the companion word ("배포해줘", "release 해줘", "리뷰어 alice 지정해줘", "라벨 붙여줘", "담당자
 * 지정해줘", "enable auto-merge", "deploy it"), or the bare companion word alone ("배포", "머지", "auto merge"). Free text
 * that merely contains the noun ("할 일은 담당자와 기한을 함께 적어요", "배포 일정 회의록", "라벨 디자인 아이디어") is not.
 */
const COMPANION_WORD_SRC =
  '(?:자동\\s*머지|auto\\s*-?\\s*merge|배포|릴리즈|릴리스|머지|병합|deploy|release|merge)';
const COMPANION_REQUEST_SHAPES: readonly RegExp[] = [
  new RegExp(
    `${COMPANION_WORD_SRC}\\s*(?:을|를|도)?\\s*(?:좀\\s*)?(?:해(?!결)|하자|하고|한\\s*(?:다음|뒤|후)|시켜|진행|실행|켜|걸어|설정)`,
    'iu',
  ),
  /(?:리뷰어|reviewers?|라벨|레이블|labels?|assignees?|담당자)\s*(?:을|를|도|로|으로)?\s*(?:[\w@./-]+\s*(?:을|를|로|으로)?\s*)?(?:좀\s*)?(?:지정|추가|붙여|붙이|달아|넣어|설정|정해|등록|할당|요청|바꿔|변경)/iu,
  /^\s*(?:please\s+)?(?:deploy|release|ship)\b/i,
  /\b(?:deploy|release)\s+(?:it|this|now|to|the)\b/i,
  /\b(?:add|set|assign|request)\s+(?:a\s+|the\s+)?(?:reviewers?|labels?|assignees?)\b/i,
  /\b(?:enable|turn\s+on)\s+auto[\s-]?merge\b/i,
  // Verb-first English merge and number-bearing forms (Codex re-review of 63ab7a0): "merge PR #42", "merge the pr",
  // "merge it", "merge #42", "PR #42 머지", "이 PR 머지". At the merge states they get the deterministic already-approved /
  // already-merged reply; the exact execution allow-list still decides any execution.
  /^\s*(?:please\s+)?merge\b(?!\s+(?:is|are|was|vs\.?|versus|and|or|conflicts?|strateg(?:y|ies)|commits?|requests?|queue)\b)/i,
  /\bmerge\s+(?:this|it|the|now|pr|#\s*\d+)\b/i,
  /(?:\bpr\b|풀\s*리퀘|#\s*\d+)\s*(?:을|를)?\s*(?:머지|병합)\s*(?:좀)?\s*[.!~]*$/iu,
  /^\s*(?:자동\s*머지|auto\s*-?\s*merge|배포|릴리즈|릴리스|머지|병합|deploy|release|merge|리뷰어|reviewers?|라벨|labels?|assignees?|담당자)\s*[.!?~]*$/iu,
];

export function isChainCompanionRequest(text: string): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  return t.length > 0 && COMPANION_REQUEST_SHAPES.some((re) => re.test(t));
}
