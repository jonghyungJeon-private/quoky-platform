/**
 * Git-operation request shape (live QA 2026-10-07, "git rebase와 merge 차이를 간단히 설명해줘").
 *
 * The anchored code-chain detectors (merge / PR create / push / main sync / branch cleanup / commit) match a git word
 * plus a request verb. Before this module, a verb anywhere in the sentence counted, so a concept question that ends
 * in "설명해줘" or "알려줘" was read as a merge request and got the merge-disabled refusal. QA-V2-W8-01 fixed the same
 * class for push. These helpers name the shapes that are never a git-operation request, so a detector or a bare-word
 * reply can step aside and let the turn reach ordinary chat.
 *
 * Pure, deterministic and provider-free. They only REMOVE a trigger and never create a positive intent. They are never
 * consulted by an execution gate: the approved-execution allow-list (`EXECUTION_PHRASES`) stays exact.
 */

/**
 * A git status / result ask ("PR 상태가 뭐야?", "CI 결과 알려줘", "머지됐어?"). It keeps the deterministic read-only status
 * replies, so a status ask is never treated as a concept question.
 */
const GIT_STATUS_ASK =
  /상태|결과|진행\s*상황|됐|되었|돼\s*있|통과|열려\s*있|\bstatus\b|\bci\b|체크(?!\s*아웃)|\bchecks?\b|\bmergeable\b|\bmerged\b|\bpushed\b|\bdeleted\b|\bsynced\b/i;

/**
 * Concept / explanation / comparison / how-to markers. Each marker asks about something and never requests the action:
 * "차이", "비교", "설명해줘", "뭐야", "란?", "어떻게 동작해", "해결법", "what's the difference", "explain git merge".
 * "어떻게 됐어" (a status ask) is deliberately not a marker.
 */
const GIT_CONCEPT_MARKERS: readonly RegExp[] = [
  /차이|비교|장단점|\bvs\.?(?=\s|$)|\bversus\b/i,
  /설명\s*(?:을|를)?\s*(?:좀\s*)?(?:해|부탁|가능)|가르쳐/,
  /뭐(?:야|예요|에요|지|냐|니|임|가\s*(?:달라|다르))|뭔(?:가요|데|지|가)|무엇(?:이|인)|무슨\s*(?:뜻|의미|차이|역할)/,
  /\S(?:이)?란\s*(?:[?？]|뭐|무엇|$)/,
  /뜻(?:이|은|을|\s*알려|\s*좀|\s*[?？]|$)|의미(?:가|는|를|이|야)|개념|원리|역할(?:이|은|을)?\s*(?:뭐|알려|설명)/,
  /어떻게\s*(?:동작|작동|돌아가|되는\s*(?:거|건|지)|하는|하나|하지|하면|해야|해\s*[?？]|해요|쓰|써|사용|해결|처리)/,
  /(?:동작|작동)\s*(?:방식|원리)/,
  /방법|[가-힣]는\s*법|해결법|사용법/,
  /언제\s*(?:써|쓰|사용|해야|하는)|왜\s*(?:써|쓰|사용|필요|해야|하는)/,
  /(?:전략|컨벤션|규칙|원칙|팁|가이드)\s*(?:을|를|이|은|좀)?\s*(?:알려|설명|추천|정리|비교|뭐)/,
  /\bwhat(?:'s|\s+is|\s+are|\s+does|\s+do)\b|\bhow\s+(?:do|does|can|should|would|to)\b/i,
  /\bexplain\b|\bexplanation\b|\bdifferences?\b|\bcompare\b|\bcomparison\b|\bmeaning\b|\bconcepts?\b/i,
  /\btell\s+me\s+about\b|\bwhy\s+(?:do|does|would|should|is|are)\b|\bwhen\s+(?:to|should|do)\b|\bpros\s+and\s+cons\b|\bbest\s+practices?\b/i,
];

/**
 * A request whose own verb is a non-git one: summarizing, translating, reviewing, recommending, writing ("머지 로그
 * 요약해줘", "푸시 로직을 검토해줘", "summarize the merge log"). The git word is only its topic.
 */
const TOPIC_VERB_TAIL =
  /(?:요약|번역|검토|리뷰|분석|추천|작성|조사)\s*(?:을|를)?\s*(?:좀\s*)?(?:해\s*줘요?|해\s*주세요|해\s*줄래요?|해\s*봐|해)\s*[.!~?？]*$|(?:써|찾아|알아봐)\s*(?:줘요?|주세요|줄래요?)\s*[.!~?？]*$/;
const TOPIC_VERB_HEAD = /^\s*(?:please\s+)?(?:summarize|translate|review|analy[sz]e|recommend|describe|document)\b/i;

/**
 * A git operation verb attached to its own git word ("머지해줘", "머지하고 …", "PR 만들어", "main 동기화해", "브랜치
 * 삭제해", "merge the PR"). A topic tail on another verb never hides such a request ("머지하고 릴리즈 노트 작성해줘").
 */
const GIT_OPERATION_ATTACHED =
  /(?:머지|병합|푸시|배포|릴리즈|커밋|리베이스|동기화|최신화)\s*(?:을|를)?\s*(?:좀\s*)?(?:해|하고|하자|한\s*(?:다음|뒤|후)|시켜|진행|실행|승인)|(?:\bpr\b|풀\s*리퀘|pull\s*request)\s*(?:을|를)?\s*(?:만들|생성|열|올려)|브랜치\s*(?:을|를)?\s*(?:삭제|정리|지워|제거)|\b(?:merge|push|deploy|release|commit|rebase|sync)\s+(?:this|it|the|now|pr|main|to|approved)\b/i;

/**
 * A concept / explanation / comparison / how-to question about git ("git rebase와 merge 차이를 간단히 설명해줘", "merge
 * conflict 해결법 알려줘", "머지 전략 비교해줘", "rebase란?", "explain git merge"). A status ask is never one.
 */
export function isGitConceptQuestion(text: string): boolean {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length === 0 || GIT_STATUS_ASK.test(t)) return false;
  return GIT_CONCEPT_MARKERS.some((re) => re.test(t));
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
