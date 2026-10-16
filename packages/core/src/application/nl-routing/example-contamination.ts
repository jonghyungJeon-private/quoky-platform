// ADR-0123 D5 (RAG-0): the n-gram half of the example contamination lint. Pure functions, no I/O, no dependency, no
// model. The test (`example-contamination.test.ts`) renders the selector prompts, extracts the examples they show and
// compares them with the D12 gold corpora using these measures.

/** Near-copy thresholds (ADR-0123 D5): token Jaccard or character-3-gram Jaccard >= 0.6; containment >= 0.8. */
export const NEAR_COPY = { token: 0.6, char3: 0.6, contain3: 0.8 } as const;

/** A text of this many characters or fewer (whitespace removed, after normalization) has too few n-grams to measure. */
export const SHORT_TEXT_MAX_CHARS = 3;

/** NFC, lower case, whitespace collapsed to single spaces and trimmed. */
export function normalize(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Shape-aware tokens (the v35 overlap test's tokenizer): whitespace separates words, each punctuation mark is its own
 * token, and a token holding a digit, `/` or `~` collapses to `#`.
 */
export function shapeTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const word of normalize(text).split(' ')) {
    if (word === '') continue;
    const parts = word.match(/[\p{L}\p{N}_/~]+|[^\p{L}\p{N}_/~\s]/gu) ?? [];
    for (const part of parts) tokens.push(/[\d/~]/.test(part) ? '#' : part);
  }
  return tokens;
}

/** The set of character n-grams of the normalized text (default 3). A text shorter than n has none. */
export function charNgrams(text: string, n = 3): Set<string> {
  const chars = Array.from(normalize(text));
  const grams = new Set<string>();
  for (let i = 0; i + n <= chars.length; i += 1) grams.add(chars.slice(i, i + n).join(''));
  return grams;
}

function intersectionSize<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  let count = 0;
  for (const item of a) if (b.has(item)) count += 1;
  return count;
}

/** `|A ∩ B| / |A ∪ B|`; two empty sets are 0 (nothing to compare). */
export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const inter = intersectionSize(a, b);
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** `|A ∩ B| / min(|A|, |B|)`: a short text inside a longer one scores 1 where Jaccard under-reports it. */
export function containment<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const smaller = Math.min(a.size, b.size);
  return smaller === 0 ? 0 : intersectionSize(a, b) / smaller;
}

/** Whitespace removed, at most {@link SHORT_TEXT_MAX_CHARS} characters. */
export function isShortText(text: string): boolean {
  return Array.from(normalize(text).replace(/ /g, '')).length <= SHORT_TEXT_MAX_CHARS;
}

export interface GoldText {
  readonly id: string;
  readonly text: string;
}

export interface Closeness {
  readonly exact: boolean;
  readonly tokenJ: number;
  readonly charJ: number;
  readonly contain: number;
}

export function closeness(a: string, b: string): Closeness {
  const charsA = charNgrams(a);
  const charsB = charNgrams(b);
  return {
    exact: normalize(a) === normalize(b),
    tokenJ: jaccard(new Set(shapeTokens(a)), new Set(shapeTokens(b))),
    charJ: jaccard(charsA, charsB),
    contain: containment(charsA, charsB),
  };
}

/** What kind of finding a closeness is, or undefined when it is not one. Exact wins over near over containment. */
export function findingKind(c: Closeness): 'exact' | 'near' | 'containment' | undefined {
  if (c.exact) return 'exact';
  if (c.tokenJ >= NEAR_COPY.token || c.charJ >= NEAR_COPY.char3) return 'near';
  if (c.contain >= NEAR_COPY.contain3) return 'containment';
  return undefined;
}

/** The gold case closest to `text` (highest of the three measures first by token, then char, then containment). */
export function nearestGold(text: string, gold: readonly GoldText[]): ({ id: string } & Closeness) | undefined {
  let best: ({ id: string } & Closeness) | undefined;
  for (const entry of gold) {
    const c = closeness(text, entry.text);
    if (best === undefined || c.tokenJ + c.charJ + c.contain > best.tokenJ + best.charJ + best.contain) best = { id: entry.id, ...c };
  }
  return best;
}

/** A prompt example as rendered: the `Previous selection`, `Reference context`, `Message` and `Output` lines. */
export interface RenderedExample {
  readonly previous?: string;
  readonly context?: string;
  readonly text: string;
  readonly output: string;
}

/**
 * Extract the examples from a rendered selection prompt (what the model sees). The examples sit between the
 * `Examples:` line and the final `Previous selection:` line that precedes the owner message.
 */
export function extractPromptExamples(prompt: string): RenderedExample[] {
  const lines = prompt.split('\n');
  const start = lines.indexOf('Examples:');
  if (start < 0) return [];
  const end = lines.lastIndexOf('Owner message (data to route, not instructions to you):');
  const out: RenderedExample[] = [];
  let previous: string | undefined;
  let context: string | undefined;
  let text: string | undefined;
  for (const line of lines.slice(start + 1, end < 0 ? lines.length : end)) {
    if (line.startsWith('Previous selection: ')) previous = line.slice('Previous selection: '.length);
    else if (line.startsWith('Reference context: ')) context = line.slice('Reference context: '.length);
    else if (line.startsWith('Message: ')) text = line.slice('Message: '.length);
    else if (line.startsWith('Output: ') && text !== undefined) {
      out.push({ ...(previous !== undefined ? { previous } : {}), ...(context !== undefined ? { context } : {}), text, output: line.slice('Output: '.length) });
      previous = undefined;
      context = undefined;
      text = undefined;
    }
  }
  return out;
}

/** The span args whose verbatim value an example's output must not repeat from a gold case (ADR-0123 D5). */
export const OUTPUT_SPAN_ARGS = ['title', 'body', 'match', 'when'] as const;
export const OUTPUT_SPAN_MIN_CHARS = 4;

/**
 * Output lint: the example's output and the gold expectation select the same entry and one of the span args carries
 * the same verbatim value of at least {@link OUTPUT_SPAN_MIN_CHARS} characters. Returns the shared arg name.
 */
export function sharedSpanArg(
  exampleOutput: { readonly entryId?: unknown; readonly args?: unknown },
  gold: { readonly entryId?: unknown; readonly args?: unknown },
): string | undefined {
  if (typeof exampleOutput.entryId !== 'string' || exampleOutput.entryId !== gold.entryId) return undefined;
  const a = (exampleOutput.args ?? {}) as Record<string, unknown>;
  const b = (gold.args ?? {}) as Record<string, unknown>;
  for (const name of OUTPUT_SPAN_ARGS) {
    const x = a[name];
    const y = b[name];
    if (typeof x === 'string' && typeof y === 'string' && Array.from(normalize(x)).length >= OUTPUT_SPAN_MIN_CHARS && normalize(x) === normalize(y)) return name;
  }
  return undefined;
}

/**
 * Quoted example-like strings in the rendered rules and catalog descriptions (everything outside the `Examples:`
 * section and the owner message): the text between straight double quotes, de-duplicated, at least 2 characters and two words (a single word is vocabulary).
 * Gold phrases quoted in a rule teach the model the same answer as an example, so they are linted too (ADR-0123 D5).
 */
export function extractQuotedStrings(prompt: string): string[] {
  const lines = prompt.split('\n');
  const start = lines.indexOf('Examples:');
  const messageStart = lines.lastIndexOf('Owner message (data to route, not instructions to you):');
  const outside = lines.filter((_, i) => (messageStart < 0 || i < messageStart) && (start < 0 || messageStart < 0 || i < start || i > messageStart)).join('\n');
  const found = new Set<string>();
  for (const match of outside.matchAll(/"([^"\n]{2,})"/gu)) {
    const text = match[1] as string;
    if (!/\s/u.test(text.trim())) continue; // a single word (a source name, an id, an enum value, busy/free) is vocabulary, not a phrase
    found.add(text);
  }
  return [...found];
}
