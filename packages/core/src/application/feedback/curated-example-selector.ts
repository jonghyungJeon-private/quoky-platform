import { Capability, LEARNING_EGRESS_LOCAL_ONLY, LearningItemKind } from '../../domain';
import type { CuratedExampleEntry, Id, IsoTimestamp, LearningItem, Task } from '../../domain';
import { NoProviderAvailableError } from '../../errors';
import { executionLocalityOf } from '../../ports';
import type { LearningRepository, Logger, ProviderSelector } from '../../ports';
import { now } from '../../util/clock';
import type { SemanticRecallScoring } from '../recall/semantic-recall-scorer';
import { scoreSemanticRelevance } from '../semantic-relevance';
import { learningItemUsable } from './learning-service';

/**
 * Curated few-shot example selection for GENERAL_CHAT (ADR-0107 D5, LRN-2). Read-only and deterministic apart from
 * the optional local embedding scorer.
 *
 * Only the acting owner's unexpired `EXAMPLE` items qualify, and only when they are `LOCAL_ONLY`, came from a 👍
 * GENERAL_CHAT turn, carry an owner-approved ideal answer and still pass the strict credential guard and the
 * 2,000-character bound at use (ADR-0107 D1 "again at use"). At most {@link CURATED_EXAMPLE_MAX_PER_TURN} relevant
 * examples are chosen under a fixed {@link CURATED_EXAMPLE_BUDGET_CHARS} budget; an example that does not fit is
 * skipped, never truncated. Selection is not consent to egress: `PromptComposer` layers the result only for a
 * provider that declares `LOCAL` execution (ADR-0107 D6). Every failure degrades to "no examples".
 */

/** ADR-0107 D5: at most this many examples per turn. */
export const CURATED_EXAMPLE_MAX_PER_TURN = 2;
/** ADR-0107 D5: fixed budget for all selected examples (request + ideal answer, in code points). */
export const CURATED_EXAMPLE_BUDGET_CHARS = 2400;
/** The newest unexpired examples considered per turn (the per-actor cap is 1,000). */
export const CURATED_EXAMPLE_CANDIDATE_LIMIT = 200;
/** Share of relevance given to the semantic score when the local scorer returned one (ADR-0098 D8 default). */
export const CURATED_EXAMPLE_SEMANTIC_WEIGHT = 0.7;
/**
 * Relevance floors: an example qualifies only when at least this share of the query keywords appears in its request
 * (lexical) or its request embedding is at least this similar (semantic). Proposals to tune them belong to LRN-3.
 */
export const CURATED_EXAMPLE_MIN_LEXICAL_SCORE = 0.25;
export const CURATED_EXAMPLE_MIN_SEMANTIC_SCORE = 0.6;
/** Vector-cache collection for example request embeddings (vector ids are learning item ids; no text is stored). */
export const LEARNING_EXAMPLE_VECTOR_COLLECTION = 'learning-example-v1';

/** The seam `ContextBuilder` calls for a GENERAL_CHAT turn (ADR-0107 D5). */
export interface CuratedExampleSource {
  select(task: Task): Promise<CuratedExampleEntry[]>;
}

export interface CuratedExampleSelectorDeps {
  learning: Pick<LearningRepository, 'list'>;
  /** Optional local semantic scorer (composed only when `QUOKY_EMBEDDING_ENABLED=true`); lexical otherwise. */
  semanticScorer?: SemanticRecallScoring;
  logger?: Logger;
  clock?: () => IsoTimestamp;
}

/** Size of an example against the budget: request plus ideal answer, in code points. */
export function curatedExampleChars(example: Pick<CuratedExampleEntry, 'requestText' | 'idealAnswer'>): number {
  return [...example.requestText].length + [...example.idealAnswer].length;
}

/**
 * Wrap a provider selector so it yields only providers that declare `LOCAL` execution (ADR-0107 D6). Used for the
 * example embedding scorer: example text is `LOCAL_ONLY`, so a non-local embedding provider is treated as absent and
 * the scorer falls back to lexical ranking.
 */
export function localOnlyProviderSelector(selector: ProviderSelector): ProviderSelector {
  return {
    async select(capability) {
      const provider = await selector.select(capability);
      if (executionLocalityOf(provider) !== 'LOCAL') throw new NoProviderAvailableError(capability);
      return provider;
    },
  };
}

interface ScoredExample {
  item: LearningItem;
  entry: CuratedExampleEntry;
  score: number;
}

const NO_OP_LOGGER: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

export class CuratedExampleSelector implements CuratedExampleSource {
  private readonly logger: Logger;
  private readonly clock: () => IsoTimestamp;

  constructor(private readonly deps: CuratedExampleSelectorDeps) {
    this.logger = deps.logger ?? NO_OP_LOGGER;
    this.clock = deps.clock ?? now;
  }

  async select(task: Task): Promise<CuratedExampleEntry[]> {
    if (task.intent.capability !== Capability.GENERAL_CHAT || !task.actorId) return [];
    const actorId = task.actorId;
    const at = this.clock();
    let items: LearningItem[];
    try {
      items = await this.deps.learning.list({
        actorId,
        kind: LearningItemKind.EXAMPLE,
        now: at,
        limit: CURATED_EXAMPLE_CANDIDATE_LIMIT,
      });
    } catch {
      this.logger.warn('curated examples unavailable; none used', { reason: 'LIST_FAILED' });
      return [];
    }
    if (!Array.isArray(items)) return [];

    const eligible = items.flatMap((item) => {
      const entry = CuratedExampleSelector.entryOf(item, actorId, at);
      return entry === null ? [] : [{ item, entry }];
    });
    if (eligible.length === 0) return [];

    const query = task.description;
    const semantic = await this.semanticScores(query, eligible);
    const scored: ScoredExample[] = eligible.flatMap(({ item, entry }) => {
      const lexical = scoreSemanticRelevance(query, entry.requestText);
      const rawSemantic = semantic?.get(item.id);
      const semanticScore =
        rawSemantic !== undefined && Number.isFinite(rawSemantic) ? Math.max(0, Math.min(1, rawSemantic)) : undefined;
      const relevant =
        lexical >= CURATED_EXAMPLE_MIN_LEXICAL_SCORE ||
        (semanticScore !== undefined && semanticScore >= CURATED_EXAMPLE_MIN_SEMANTIC_SCORE);
      if (!relevant) return [];
      const score =
        semanticScore === undefined
          ? lexical
          : CURATED_EXAMPLE_SEMANTIC_WEIGHT * semanticScore + (1 - CURATED_EXAMPLE_SEMANTIC_WEIGHT) * lexical;
      return [{ item, entry, score }];
    });
    scored.sort(
      (a, b) =>
        b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt) || a.item.id.localeCompare(b.item.id),
    );

    const selected: CuratedExampleEntry[] = [];
    let remaining = CURATED_EXAMPLE_BUDGET_CHARS;
    const seenRequests = new Set<string>();
    for (const { entry } of scored) {
      if (selected.length >= CURATED_EXAMPLE_MAX_PER_TURN) break;
      if (seenRequests.has(entry.requestText)) continue;
      const size = curatedExampleChars(entry);
      if (size > remaining) continue;
      selected.push(entry);
      seenRequests.add(entry.requestText);
      remaining -= size;
    }
    // Counts only: never text or ids.
    this.logger.info('curated examples selected', {
      candidates: items.length,
      eligible: eligible.length,
      relevant: scored.length,
      selected: selected.length,
      scorer: semantic === null ? 'lexical' : 'semantic',
    });
    return selected;
  }

  private async semanticScores(
    query: string,
    eligible: ReadonlyArray<{ item: LearningItem; entry: CuratedExampleEntry }>,
  ): Promise<ReadonlyMap<Id, number> | null> {
    if (this.deps.semanticScorer === undefined) return null;
    // Newest first, so a just-saved example is embedded within the scorer's per-turn bound.
    const candidates = [...eligible]
      .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt) || a.item.id.localeCompare(b.item.id))
      .map(({ item, entry }) => ({ id: item.id, content: entry.requestText }));
    try {
      return await this.deps.semanticScorer.score(query, candidates);
    } catch {
      return null;
    }
  }

  /** The prompt entry for `item`, or null when it may not be used for this actor now (ADR-0107 D1/D2/D5). */
  private static entryOf(item: LearningItem, actorId: Id, at: IsoTimestamp): CuratedExampleEntry | null {
    if (typeof item !== 'object' || item === null) return null;
    if (item.kind !== LearningItemKind.EXAMPLE || item.actorId !== actorId) return null;
    if (item.egress !== LEARNING_EGRESS_LOCAL_ONLY) return null;
    if (!(Date.parse(item.expiresAt) > Date.parse(at))) return null;
    if (item.capability !== Capability.GENERAL_CHAT) return null;
    const data = item.data;
    if (typeof data !== 'object' || data === null || data.sourceRating !== 'POSITIVE') return null;
    if (typeof data.requestText !== 'string' || typeof data.idealAnswer !== 'string') return null;
    // The strict credential guard and the bound run again at use; a match drops the item, never redacts it.
    if (!learningItemUsable(data)) return null;
    const entry: CuratedExampleEntry = {
      requestText: data.requestText,
      idealAnswer: data.idealAnswer,
      egress: LEARNING_EGRESS_LOCAL_ONLY,
      provenance: 'OWNER_CURATED_EXAMPLE',
      epistemicStatus: 'NON_AUTHORITATIVE_EXAMPLE',
      learningItemId: item.id,
    };
    return curatedExampleChars(entry) <= CURATED_EXAMPLE_BUDGET_CHARS ? entry : null;
  }
}
