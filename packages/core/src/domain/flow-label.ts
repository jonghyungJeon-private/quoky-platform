/**
 * ADR-0121 D4 / ARCHITECTURE.md §8.3: the information-flow label every value of a bounded agent run carries. Pure domain
 * data: no provider id, no platform, no storage type. Labels join to the most restrictive value of each part, and only
 * the deterministic structure projector may declassify (ADR-0121 D4; stage S2 P3).
 *
 * - `trust`: `TRUSTED` (the owner's own non-quoted words, the closed catalog), `STRUCTURE` (counts, closed-format ids,
 *   types and error codes a deterministic projector derived) or `UNTRUSTED` (connector content, quoted or pasted text,
 *   attachments, any model output derived from them).
 * - `egress`: where the value may go: `REMOTE_OK`, `REMOTE_ON_SUMMARY_REQUEST` (mail, Drive: only when the owner's words ask
 *   for a summary), `LOCAL_MODEL_ONLY` (calendar) or `HOST_ONLY` (credential-shaped material).
 * - `scope`: where the value may be shown: `WORK_CHANNEL_OK` or `OWNER_DM_ONLY`.
 * - `sources`: the closed source names the value came from (sorted, unique).
 */

export type FlowTrust = 'TRUSTED' | 'STRUCTURE' | 'UNTRUSTED';
export type FlowEgress = 'REMOTE_OK' | 'REMOTE_ON_SUMMARY_REQUEST' | 'LOCAL_MODEL_ONLY' | 'HOST_ONLY';
export type FlowScope = 'WORK_CHANNEL_OK' | 'OWNER_DM_ONLY';

/** Least to most restrictive. */
export const FLOW_TRUST_ORDER: readonly FlowTrust[] = ['TRUSTED', 'STRUCTURE', 'UNTRUSTED'];
export const FLOW_EGRESS_ORDER: readonly FlowEgress[] = ['REMOTE_OK', 'REMOTE_ON_SUMMARY_REQUEST', 'LOCAL_MODEL_ONLY', 'HOST_ONLY'];
export const FLOW_SCOPE_ORDER: readonly FlowScope[] = ['WORK_CHANNEL_OK', 'OWNER_DM_ONLY'];

export interface FlowLabel {
  readonly trust: FlowTrust;
  readonly egress: FlowEgress;
  readonly scope: FlowScope;
  readonly sources: readonly string[];
}

function stricter<T>(order: readonly T[], a: T, b: T): T {
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** A label with its sources sorted and de-duplicated. Pure. */
export function flowLabel(trust: FlowTrust, egress: FlowEgress, scope: FlowScope, sources: readonly string[]): FlowLabel {
  return { trust, egress, scope, sources: [...new Set(sources)].sort() };
}

/**
 * The join of labels: the most restrictive trust, egress and scope, and the union of the sources. The join of nothing is
 * the most permissive label with no source (the identity of the join). Pure.
 */
export function joinFlowLabels(...labels: readonly FlowLabel[]): FlowLabel {
  let trust: FlowTrust = 'TRUSTED';
  let egress: FlowEgress = 'REMOTE_OK';
  let scope: FlowScope = 'WORK_CHANNEL_OK';
  const sources: string[] = [];
  for (const label of labels) {
    trust = stricter(FLOW_TRUST_ORDER, trust, label.trust);
    egress = stricter(FLOW_EGRESS_ORDER, egress, label.egress);
    scope = stricter(FLOW_SCOPE_ORDER, scope, label.scope);
    sources.push(...label.sources);
  }
  return flowLabel(trust, egress, scope, sources);
}

/** Whether `label` is at least as restrictive as `bound` in every part (sources are not compared). Pure. */
export function flowLabelWithin(label: FlowLabel, bound: Pick<FlowLabel, 'trust' | 'egress' | 'scope'>): boolean {
  return (
    FLOW_TRUST_ORDER.indexOf(label.trust) <= FLOW_TRUST_ORDER.indexOf(bound.trust) &&
    FLOW_EGRESS_ORDER.indexOf(label.egress) <= FLOW_EGRESS_ORDER.indexOf(bound.egress) &&
    FLOW_SCOPE_ORDER.indexOf(label.scope) <= FLOW_SCOPE_ORDER.indexOf(bound.scope)
  );
}

/** The owner's own non-quoted words (ADR-0120 D4 grounding text). */
export const OWNER_TEXT_FLOW_LABEL: FlowLabel = Object.freeze(flowLabel('TRUSTED', 'REMOTE_OK', 'WORK_CHANNEL_OK', ['owner']));
/** The closed catalog and Quoky's own fixed instruction text. */
export const CATALOG_FLOW_LABEL: FlowLabel = Object.freeze(flowLabel('TRUSTED', 'REMOTE_OK', 'WORK_CHANNEL_OK', ['catalog']));
/** The previous selection as structure only (closed entry id and canonical args). */
export const PREVIOUS_SELECTION_FLOW_LABEL: FlowLabel = Object.freeze(flowLabel('STRUCTURE', 'REMOTE_OK', 'WORK_CHANNEL_OK', ['selection']));
/** Quoted, pasted, fenced or attached material in the owner's message (never the owner's own words). */
export const QUOTED_MATERIAL_FLOW_LABEL: FlowLabel = Object.freeze(flowLabel('UNTRUSTED', 'REMOTE_OK', 'WORK_CHANNEL_OK', ['quoted']));
