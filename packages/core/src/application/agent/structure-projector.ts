import { flowLabel, type FlowLabel } from '../../domain/flow-label';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { AGENT_READ_SOURCES, readOutputLabel } from './flow-policy';

/**
 * ADR-0121 D2/D4 (stage S2 P3-3a): the deterministic StructureProjector.
 *
 * It takes what a read port returned and keeps ONLY structure: closed-format ids (per projected field), a count and the
 * source binding. Every id is accepted only when the whole string matches that field's closed pattern; anything else is
 * dropped and counted, never repaired, never echoed. No title, subject, name, body or other free text is ever read, so none
 * can cross into control flow (a later step's arguments); the only values a reference can carry are these ids.
 *
 * The projection's label is `STRUCTURE`: the projector is the one place that declassifies trust (D4). Egress and scope stay
 * those of the source ({@link readOutputLabel}): a calendar event id is still `OWNER_DM_ONLY`.
 */

/** Closed id shapes by projected field (the fields of `AGENT_READ_SOURCES[…].refField`). */
const FIELD_PATTERNS: Readonly<Record<string, RegExp>> = Object.freeze({
  // Mirrors `CONNECTOR_ITEM_KEY` (ports/connector-query.ts); pinned equal by test (Core's agent boundary forbids that import).
  issueKeys: /^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,9}$/,
  messageIds: /^[A-Za-z0-9._:-]{1,128}$/,
  eventIds: /^[A-Za-z0-9_-]{1,256}$/,
  fileIds: /^[A-Za-z0-9_-]{6,128}$/,
  pageIds: /^[0-9]{1,20}$/,
  itemIds: /^[A-Za-z0-9._/#:-]{1,200}$/,
});

/** The projected id fields. */
export const AGENT_PROJECTED_FIELDS: readonly string[] = Object.freeze(Object.keys(FIELD_PATTERNS));

/** Whether `value` is a closed-format id of `field`. */
export function isProjectedId(field: string, value: unknown): value is string {
  const pattern = FIELD_PATTERNS[field];
  return pattern !== undefined && typeof value === 'string' && pattern.test(value);
}

/** What a read port hands over per listed item: its id (any other member is ignored, never read). */
export interface AgentRawItem {
  readonly id?: unknown;
}

export interface StructureProjection {
  readonly entryId: NlWave1EntryId;
  readonly source: string;
  readonly origin: string;
  /** The projected field, absent for a source with no id field (local stores, the brief). */
  readonly field?: string;
  /** Closed-format ids in the order the source listed them (de-duplicated). */
  readonly ids: readonly string[];
  /** Items the port returned. */
  readonly itemCount: number;
  /** Items whose id was missing, malformed or a duplicate. */
  readonly dropped: number;
  readonly label: FlowLabel;
}

/** Project a read's items into structure. Pure and total; never throws on any input. */
export function projectStructure(entryId: NlWave1EntryId, items: readonly AgentRawItem[]): StructureProjection {
  const meta = AGENT_READ_SOURCES[entryId];
  const output = readOutputLabel(entryId);
  const label = flowLabel('STRUCTURE', output.egress, output.scope, output.sources);
  const list = Array.isArray(items) ? items : [];
  const base = { entryId, source: meta.source, origin: meta.origin, itemCount: list.length, label };
  const field = meta.refField;
  if (field === undefined) return { ...base, ids: [], dropped: 0 };
  const seen = new Set<string>();
  const ids: string[] = [];
  let dropped = 0;
  for (const item of list) {
    const id = typeof item === 'object' && item !== null ? (item as AgentRawItem).id : undefined;
    if (!isProjectedId(field, id) || seen.has(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return { ...base, field, ids, dropped };
}
