import { answerConsentTurn } from '../consent-answer/consent-answer';
import { ConsentPendingStore, summaryConsentPending, type BoundConsent } from '../consent-answer/consent-pending';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { AGENT_READ_SOURCES } from './flow-policy';
import { mintSummaryConsentToken, type SummaryConsentToken, type SummaryRunToken } from './quarantined-summary';

/**
 * Test support (never imported by production code; a pin test enforces it): a rule-① consent token obtained the REAL way. A
 * `ConsentPendingStore` opens a `summaryConsentPending`, and the production `answerConsentTurn` runs a closed yes ("응") over it
 * (claim, bind, record the owner's yes), then the production {@link mintSummaryConsentToken} mints. A bind that the pipeline did
 * not answer yes is never accepted by the mint. The closed-yes path has no await before its bind, so the pipeline has bound
 * (synchronously) when the call returns its promise; the bound consent is read off the store's own `bind`.
 */
export interface ConsentRead {
  readonly entryId: NlWave1EntryId;
  readonly itemIds: readonly string[];
}

export interface ConsentFixture {
  readonly recipient: string;
  readonly runRef?: string;
  readonly reads: readonly ConsentRead[];
}

const SCOPE_NOTE = 'closed yes through answerConsentTurn';

/** Run a closed yes through the real pipeline over `store` and return the bound consent it produced (synchronously bound). */
export function yesBound(store: ConsentPendingStore, scope: { actorId: string; conversationKey: string }, text = '응'): BoundConsent {
  let captured: BoundConsent | undefined;
  const realBind = store.bind.bind(store);
  store.bind = (claim, atMs) => {
    captured = realBind(claim, atMs);
    return captured;
  };
  void answerConsentTurn(store, { scope, ownerDm: true, text, atMs: 1 }, { mode: 'off' }, () => 2);
  if (captured === undefined) throw new Error(`test consent not bound by ${SCOPE_NOTE}`);
  return captured;
}

/** A genuine bound consent for the step a fixture describes, with the `runRef` it was opened under. */
export function boundConsentFor(fixture: ConsentFixture): { readonly bound: BoundConsent; readonly runRef: string } {
  const runRef = fixture.runRef ?? 'run-ref-test';
  const bySource = new Map<string, string[]>();
  for (const read of fixture.reads) {
    const source = AGENT_READ_SOURCES[read.entryId].source;
    const ids = bySource.get(source) ?? [];
    for (const id of read.itemIds) if (!ids.includes(id)) ids.push(id);
    bySource.set(source, ids);
  }
  const scope = { actorId: 'actor-test', conversationKey: 'conversation-test' };
  const store = new ConsentPendingStore();
  store.open(
    summaryConsentPending({
      scope,
      language: 'en',
      createdAtMs: 0,
      recipient: fixture.recipient,
      sources: [...bySource].map(([source, itemIds]) => ({ source: source as 'mail', itemIds })),
      runRef,
    }),
  );
  return { bound: yesBound(store, scope), runRef };
}

/** A real consent token for `run` and `step` over the fixture's reads, exactly the scope its pending step recorded. */
export function consentTokenFor(run: SummaryRunToken, step: number, fixture: ConsentFixture): SummaryConsentToken {
  const { bound, runRef } = boundConsentFor(fixture);
  const token = mintSummaryConsentToken({ bound, runRef, run, step, reads: fixture.reads });
  if (token === undefined) throw new Error('test consent mint refused');
  return token;
}
