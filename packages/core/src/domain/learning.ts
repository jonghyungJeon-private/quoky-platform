import type { Id, IsoTimestamp } from './common';
import type { IntentType } from './enums';

/**
 * Owner-curated learning store domain model (ADR-0107 D1/D2/D7, LRN-1; schema v14).
 *
 * The first consented text store besides memory. Text enters it only through an explicit owner command on one
 * item (per-item consent, owner decision 5), passes the strict credential guard at capture and again at every use
 * (a match is refused, never redacted-and-kept), stays on this host (`egress` is `LOCAL_ONLY`, the only value in
 * v3), expires 365 days after creation and is capped per actor. Nothing here changes behaviour automatically: an
 * `EXAMPLE` is used only by LRN-2, behind `QUOKY_LEARNING_EXAMPLES_ENABLED` (default `false`), and only for a
 * provider that declares local execution.
 */

export enum LearningItemKind {
  /** A 👎 turn the owner annotated (`후보 N 메모: …`); exported offline as a golden corpus candidate. */
  GOLDEN_CANDIDATE = 'GOLDEN_CANDIDATE',
  /** A 👍 turn the owner promoted (`후보 N 예시로 저장`); a curated few-shot example for LRN-2. */
  EXAMPLE = 'EXAMPLE',
}

/** ADR-0107 D2: the only egress value in v3. A wider value needs an ADR amendment. */
export const LEARNING_EGRESS_LOCAL_ONLY = 'LOCAL_ONLY' as const;
export type LearningEgress = typeof LEARNING_EGRESS_LOCAL_ONLY;

/** Where a provider executes (ADR-0107 D6). Absent means `REMOTE` (fail closed). */
export type LearningExecutionLocality = 'LOCAL' | 'REMOTE';

/** ADR-0107 D2: each stored text field is bounded to this many characters (code points). */
export const LEARNING_TEXT_MAX_CHARS = 2000;
/** ADR-0107 D2 / owner decision 5: retention from creation. */
export const LEARNING_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/** ADR-0107 D2: hard cap on stored items per actor. A save beyond it is refused, never evicting older items. */
export const LEARNING_MAX_ITEMS_PER_ACTOR = 1000;
/** Upper bound on expired rows deleted by one lazy prune. */
export const LEARNING_PRUNE_MAX_ROWS = 100;
/** The `capability` column value when the source turn recorded no capability. */
export const LEARNING_CAPABILITY_UNKNOWN = 'UNKNOWN' as const;

/** Coarse language tag of the request text: Hangul → `ko`, Latin letters only → `en`, otherwise `und`. */
export type LearningLanguage = 'ko' | 'en' | 'und';

/** The source turn's rating at capture time. */
export type LearningSourceRating = 'POSITIVE' | 'NEGATIVE';

/**
 * The JSON `data` column: an explicit whitelist. Every text field is owner-approved, bounded to
 * {@link LEARNING_TEXT_MAX_CHARS} and passed the credential guard at capture.
 */
export interface LearningItemData {
  /** The owner's request text, from the locally stored Task of the rated turn. */
  requestText: string;
  /** EXAMPLE: the ideal answer (the locally stored reply, or the owner's `예시 N 수정: …` text). */
  idealAnswer?: string;
  /** GOLDEN_CANDIDATE: the owner's note on what was wrong (`후보 N 메모: …`). */
  note?: string;
  /** Expected behaviour, when the owner states one (reserved for the reviewed export; not set by v3 commands). */
  expectedBehavior?: string;
  /** The source turn's rating when the item was captured. */
  sourceRating: LearningSourceRating;
  /** The source turn's routed intent, when recorded (a routing fact, never text). */
  intentType?: IntentType;
}

/** One stored learning item (`learning_items` row, ADR-0107 D2). */
export interface LearningItem {
  id: Id;
  actorId: Id;
  kind: LearningItemKind;
  /** The source turn's capability value, or {@link LEARNING_CAPABILITY_UNKNOWN}. */
  capability: string;
  language: LearningLanguage;
  /** The `conversation_turns` id the item was captured from. */
  sourceTurnId?: Id;
  /** The memory record the item was derived from (ADR-0107 D7 forget cascade); not set by LRN-1 commands. */
  sourceMemoryId?: Id;
  egress: LearningEgress;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  data: LearningItemData;
}

/**
 * ADR-0107 D6 egress rule: a `LOCAL_ONLY` item may reach only a provider that declares `LOCAL` execution. An absent
 * declaration counts as `REMOTE` (fail closed); an unknown egress value is never allowed.
 */
export function isLearningEgressAllowed(egress: string, locality: LearningExecutionLocality | undefined): boolean {
  return egress === LEARNING_EGRESS_LOCAL_ONLY && locality === 'LOCAL';
}

/** Coarse language tag of `text` (see {@link LearningLanguage}). */
export function learningLanguageOf(text: string): LearningLanguage {
  if (/[ᄀ-ᇿ㄰-㆏가-힯]/u.test(text)) return 'ko';
  if (/[A-Za-z]/u.test(text)) return 'en';
  return 'und';
}
