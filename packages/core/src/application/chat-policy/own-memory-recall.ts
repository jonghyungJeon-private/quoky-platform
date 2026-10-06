/**
 * Own-memory recall questions (W3-L01; ADR-0104 D3 state-aware deterministic answers, ADR-0106 memory semantics).
 *
 * Pure, provider-neutral Core module: it imports nothing and performs no I/O.
 *
 * - `detectOwnMemoryRecallQuestion` recognises a whole message in which the User asks what THEY told Quoky about
 *   themselves ("내가 좋아하는 과일이 뭐였지?", "내가 말한 고양이 이름 기억나?", "내 생일이 언제였지?",
 *   "what did I say my favourite fruit was?"). It is deliberately conservative: it needs a first-person reference, a
 *   recall-shaped ending and a concrete topic, and it never matches general-knowledge questions ("사과의 효능이
 *   뭐야?"), questions about the assistant, schedules / to-dos / reminders / code work (their own handlers and the
 *   QUAL-7 path), memory management (the ADR-0106 commands) or credentials.
 * - `hasOwnMemoryRecallHit` decides, from the turn's assembled context (the actor's active durable recall and the
 *   User's own earlier turns of this conversation, exactly what a provider would see), whether anything relevant to
 *   the question exists. Relevance is lexical and generous on purpose: any shared topic stem — or, for a preference
 *   question, any stated preference — counts as a hit, so an uncertain case keeps the existing provider flow.
 * - `renderOwnMemoryNotFound` is the fixed KO/EN truthful reply the runtime sends instead of calling a provider when
 *   there is no hit (a local model used to invent a personal fact: "그땐 귤이였어요").
 */
/** What the User asks about: a preference they stated, or anything they told Quoky. */
export type OwnMemoryRelation = 'like' | 'dislike';

export interface OwnMemoryRecallQuestion {
  readonly language: 'ko' | 'en';
  /** Lower-cased topic stems (particles and filler removed); never empty. */
  readonly topics: readonly string[];
  /** Present for a preference question ("좋아하는", "favourite", "싫어하는"). */
  readonly relation?: OwnMemoryRelation;
}

/** The structural slice of a `ContextBundle` the hit check reads (kept local so this folder imports no domain type). */
export interface OwnMemoryRecallContext {
  readonly conversationTranscript: ReadonlyArray<{
    readonly content: string;
    readonly role?: 'user' | 'assistant' | 'unknown';
    readonly provenance: string;
  }>;
  readonly durableRecall?: ReadonlyArray<{ readonly content: string }>;
}

const MAX_MESSAGE_CHARS = 80;
const END = String.raw`[\s?？!.~]*$`;

// ── Korean shapes ──────────────────────────────────────────────────────────────────────────────────────────────

const KO_LEAD = String.raw`(?:(?:혹시|근데|그런데|그러고\s*보니|아|음)[\s,]*)*`;
const KO_SUBJECT = String.raw`(?:내가|제가)`;
const KO_POSSESSIVE = String.raw`(?:내|제|나의|저의)`;
const KO_ADVERB = String.raw`(?:(?:제일|가장|젤|특히|진짜|정말)\s*)?`;
/** A preference or a "told you" relative clause before the topic ("좋아하는 과일", "말한 고양이 이름"). */
const KO_RELATIVE = String.raw`(?:좋아하는|좋아했던|좋아한다고\s*(?:한|했던)|싫어하는|싫어했던|싫어한다고\s*(?:한|했던)|말한|말했던|말해\s*준|말해\s*줬던|얘기한|얘기했던|이야기한|이야기했던|알려\s*준|알려\s*줬던|말씀드린|알려\s*드린|저장한|기억하라고\s*한)`;
/** A bounded topic (1–30 characters, letters/digits/spaces), matched lazily so the particle and ending stay outside. */
const KO_TOPIC = String.raw`([\p{L}\p{N}][\p{L}\p{N}\s'’-]{0,29}?)`;
const KO_PARTICLE = String.raw`(?:\s*(?:이|가|은|는|을|를))?\s*`;
/** Past / recall-shaped endings ("뭐였지", "언제였더라", "뭐라고 했지", "기억나?"). "기억해?" is excluded: it is also an imperative. */
const KO_RECALL_END = String.raw`(?:뭐였지|뭐였더라|뭐더라|뭐였어|뭐였죠|뭐였나요|뭐였었지|뭐였었더라|무엇이었지|뭐라고\s*했지|뭐라고\s*했더라|뭐라고\s*했었지|뭐라고\s*했어|뭐라고\s*했죠|뭐라고\s*했었죠|뭐라고\s*했나요|뭐였는지\s*(?:기억나|알아)|뭔지\s*(?:기억나|기억하|알아)|언제였지|언제였더라|언제라고\s*했지|어디였지|어디였더라|어디라고\s*했지|누구였지|누구였더라|누구라고\s*했지|기억\s*나|기억하니|기억하나|기억하세|기억하시나|기억하고\s*있)`;
/** Present-tense endings, accepted only after a preference / "told you" relative clause ("내가 좋아하는 과일이 뭐야?"). */
const KO_PRESENT_END = String.raw`(?:뭐야|뭐지|뭐예요|뭐에요|뭔데|뭐게|뭔지\s*알아)`;
const KO_TAIL = String.raw`(?:요|니|냐|나요|세요|어|어요|지|죠|요\s*\?)?`;

/** "내가 (제일) 좋아하는 X가 뭐였지?", "내가 말한 X 기억나?", "내가 좋아하는 X가 뭐야?" */
const KO_RELATIVE_SHAPE = new RegExp(
  String.raw`^${KO_LEAD}${KO_SUBJECT}\s*${KO_ADVERB}${KO_RELATIVE}\s+${KO_TOPIC}${KO_PARTICLE}(?:${KO_RECALL_END}|${KO_PRESENT_END})${KO_TAIL}${END}`,
  'iu',
);
/** "내 X가 뭐였지?", "내 X가 뭐라고 했지?", "내 X 기억나?", "내 생일이 언제였지?" (past / recall endings only). */
const KO_POSSESSIVE_SHAPE = new RegExp(
  String.raw`^${KO_LEAD}${KO_POSSESSIVE}\s+${KO_TOPIC}${KO_PARTICLE}${KO_RECALL_END}${KO_TAIL}${END}`,
  'iu',
);
/** "내가 X를 뭐라고 했지?" ("내가 고양이 이름을 뭐라고 했더라?"). */
const KO_SAID_SHAPE = new RegExp(
  String.raw`^${KO_LEAD}${KO_SUBJECT}\s+${KO_TOPIC}${KO_PARTICLE}(?:뭐라고|뭐로)\s*(?:했지|했더라|했었지|했었더라|말했지|말했더라|얘기했지|얘기했더라|했어|했죠|했나요)${KO_TAIL}${END}`,
  'iu',
);

// ── English shapes ─────────────────────────────────────────────────────────────────────────────────────────────

const EN_LEAD = String.raw`^(?:(?:hey|so|um|quoky)[\s,]+)*`;
const EN_TOPIC = String.raw`([a-z0-9][a-z0-9\s'’-]{0,39}?)`;
const EN_TAIL = String.raw`(?:\s+(?:again|earlier|before))?${END}`;
const EN_SHAPES: readonly RegExp[] = [
  // "what did I say my favourite fruit was?", "what did I tell you my dog's name is?"
  new RegExp(String.raw`${EN_LEAD}what\s+did\s+i\s+(?:say|tell\s+you|mention)\s+(?:that\s+)?my\s+${EN_TOPIC}\s+(?:was|is|were|are)${EN_TAIL}`, 'iu'),
  // "what did I tell you about my cat?"
  new RegExp(String.raw`${EN_LEAD}what\s+did\s+i\s+(?:say|tell\s+you)\s+about\s+my\s+${EN_TOPIC}${EN_TAIL}`, 'iu'),
  // "do you remember my favourite fruit?", "do you remember what my dog's name was?"
  new RegExp(String.raw`${EN_LEAD}(?:do|did)\s+you\s+remember\s+(?:what\s+)?my\s+${EN_TOPIC}(?:\s+(?:is|was|were|are))?${EN_TAIL}`, 'iu'),
  // "what's my favourite fruit (again)?"
  new RegExp(String.raw`${EN_LEAD}what(?:'s|’s|\s+is|\s+was)\s+my\s+(favou?rite\s+[a-z0-9][a-z0-9\s'’-]{0,39}?)${EN_TAIL}`, 'iu'),
  // "what's my dog's name again?"
  new RegExp(String.raw`${EN_LEAD}what(?:'s|’s|\s+is|\s+was)\s+my\s+${EN_TOPIC}\s+again${END}`, 'iu'),
  // "what was the fruit I told you about?"
  new RegExp(String.raw`${EN_LEAD}what\s+(?:is|was)\s+the\s+${EN_TOPIC}\s+i\s+(?:told\s+you(?:\s+about)?|said|mentioned)${EN_TAIL}`, 'iu'),
];

// ── topic hygiene ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Topics that belong to another route (schedules — the QUAL-7 path —, to-dos, reminders, code work, memory management)
 * or that must never be invited into a `기억해:` save (credentials). A question about any of them is not captured.
 */
const EXCLUDED_TOPIC =
  /일정|스케줄|약속|회의|미팅|캘린더|달력|알림|리마인더|할\s*일|할일|투두|to-?do|task|커밋|푸시|푸쉬|브랜치|머지|병합|pr\b|피알|프로젝트|코드|저장소|레포|이슈|지라|깃|파일|기억|메모|schedule|calendar|meeting|appointment|remind|commit|push|branch|merge|pull\s*request|project|code|repo|issue|jira|git|file|memor|note|비밀번호|패스워드|암호|토큰|계좌|카드\s*번호|주민|password|passcode|token|secret|api\s*key|account\s*number|card\s*number|pin\b/iu;
/** Topics about the assistant itself ("내가 너한테 뭐라고 했지?") — not an own-memory fact. */
const ASSISTANT_TOPIC = /^(?:너|너한테|너에게|니|네|네가|니가|당신|쿼키|quoky|you|yourself)$/iu;
/** Words that carry no topic of their own. */
const FILLER = new Set([
  // Korean
  '거', '것', '게', '건', '내용', '얘기', '이야기', '말', '그', '그거', '혹시', '요즘',
  '제일', '가장', '젤', '특히', '진짜', '정말', '좋아하는', '싫어하는', '내', '제', '나', '저', '뭐', '무엇',
  // English
  'the', 'a', 'an', 'my', 'of', 'to', 'about', 'that', 'this', 'it', 'was', 'is', 'again', 'favourite', 'favorite',
  'thing', 'things', 'stuff', 'what', 'i',
]);
/** Particles stripped from a topic word; 이/가/도/로 are kept because so many nouns end in them (고양이, 포도, 도로). */
const KO_WORD_PARTICLE = /(?:으로|에서|에게|한테|이랑|의|은|는|을|를)$/u;
const QUESTION_WORD = /^(?:뭐|무엇|언제|어디|누구|왜|어떻게|what|when|where|who|why|how)$/iu;
/**
 * Time / deixis words: "내가 방금 뭐라고 했지?", "아까 말한 거" are conversation-continuity questions answered from the
 * transcript (the Stage 2B recency path), not questions about a stored personal fact — never captured.
 */
const TEMPORAL_WORD =
  /^(?:방금|아까|금방|조금|좀|전에|이전에|예전에|어제|그제|오늘|아까전에|그때|지금|이번|저번|지난번|처음|마지막|최근|최근에|just|earlier|before|ago|yesterday|today|last|recently|now)$/iu;

function topicStems(raw: string, language: 'ko' | 'en'): string[] | null {
  const words = raw
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .split(/\s+/u)
    .map((word) => word.replace(/['’]s$/u, '').replace(/^['’-]+|['’-]+$/gu, ''))
    .filter((word) => word.length > 0);
  if (words.some((word) => QUESTION_WORD.test(word) || TEMPORAL_WORD.test(word) || ASSISTANT_TOPIC.test(word))) {
    return null;
  }
  const stems: string[] = [];
  for (const word of words) {
    // A trailing particle is dropped only when a stem of at least two characters remains ("고양이의" → "고양이",
    // "포도" stays "포도"), so a stem never collapses to one syllable that would match almost anything.
    const stripped = language === 'ko' ? word.replace(KO_WORD_PARTICLE, '') : word;
    const stem = stripped.length >= 2 ? stripped : word;
    if (ASSISTANT_TOPIC.test(stem)) return null;
    if (FILLER.has(stem) || FILLER.has(word)) continue;
    if (!stems.includes(stem)) stems.push(stem);
  }
  return stems;
}

const LIKE = /좋아|최애|favou?rite|\blike\b|\blove\b/iu;
const DISLIKE = /싫어|\bhate\b|\bdislike\b/iu;

function relationOf(text: string): OwnMemoryRelation | undefined {
  if (DISLIKE.test(text)) return 'dislike';
  if (LIKE.test(text)) return 'like';
  return undefined;
}

/**
 * The own-memory recall question a whole message asks, or `null`. Strict whole-message shape (at most 80 characters,
 * one line): a request, a general-knowledge question, a question about the assistant, or a question about schedules,
 * to-dos, reminders, code work, memory management or credentials keeps its existing routing.
 */
export function detectOwnMemoryRecallQuestion(text: string): OwnMemoryRecallQuestion | null {
  if (typeof text !== 'string') return null;
  const message = text.normalize('NFC').trim();
  if (message.length === 0 || message.length > MAX_MESSAGE_CHARS || /\n/u.test(message)) return null;

  let topic: string | undefined;
  let language: 'ko' | 'en' | undefined;
  for (const shape of [KO_RELATIVE_SHAPE, KO_POSSESSIVE_SHAPE, KO_SAID_SHAPE]) {
    const match = shape.exec(message);
    if (match?.[1] !== undefined) {
      topic = match[1];
      language = 'ko';
      break;
    }
  }
  if (topic === undefined) {
    for (const shape of EN_SHAPES) {
      const match = shape.exec(message);
      if (match?.[1] !== undefined) {
        topic = match[1];
        language = 'en';
        break;
      }
    }
  }
  if (topic === undefined || language === undefined) return null;
  if (EXCLUDED_TOPIC.test(topic)) return null;
  const topics = topicStems(topic, language);
  if (topics === null || topics.length === 0) return null;
  const relation = relationOf(message);
  return Object.freeze({
    language,
    topics: Object.freeze(topics),
    ...(relation === undefined ? {} : { relation }),
  });
}

const RELATION_EVIDENCE: Readonly<Record<OwnMemoryRelation, RegExp>> = Object.freeze({
  like: /좋아|좋은|최애|favou?rite|like|love|prefer/iu,
  dislike: /싫어|싫은|별로|hate|dislike/iu,
});

function mentions(question: OwnMemoryRecallQuestion, content: string): boolean {
  const haystack = content.normalize('NFC').toLocaleLowerCase('und');
  if (question.topics.some((stem) => haystack.includes(stem))) return true;
  return question.relation !== undefined && RELATION_EVIDENCE[question.relation].test(haystack);
}

/**
 * True when the turn's assembled context holds anything relevant to the question: an active durable recall entry
 * (archived, expired and superseded records never reach it — ADR-0106 amendment) or one of the User's own earlier
 * turns of this conversation that mentions a topic stem (or, for a preference question, any stated preference).
 * Earlier own-memory questions are not evidence (asking twice must not count as having told). Assistant turns are
 * never evidence: a reply may itself have been an invented fact.
 */
export function hasOwnMemoryRecallHit(question: OwnMemoryRecallQuestion, context: OwnMemoryRecallContext): boolean {
  for (const entry of context.durableRecall ?? []) {
    if (mentions(question, entry.content)) return true;
  }
  for (const entry of context.conversationTranscript ?? []) {
    const fromUser = entry.role === 'user' || (entry.role === undefined && entry.provenance === 'USER');
    if (!fromUser) continue;
    if (detectOwnMemoryRecallQuestion(entry.content) !== null) continue;
    if (mentions(question, entry.content)) return true;
  }
  return false;
}

/** The fixed truthful reply for an own-memory question with no recall hit (no provider is called). */
export function renderOwnMemoryNotFound(language: 'ko' | 'en'): string {
  if (language === 'en') {
    return `I don't have that in my memory. If you tell me with "remember: …", I'll save it.`;
  }
  return `그 내용은 기억에 없어요. 알려 주시면 "기억해: …"로 저장해 둘게요.`;
}
