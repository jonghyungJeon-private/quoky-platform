import { ConsentPendingStore, summaryConsentPending, type BoundConsent } from '../consent-answer/consent-pending';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { AGENT_READ_SOURCES } from './flow-policy';
import { mintSummaryConsentToken, type SummaryConsentToken, type SummaryRunToken } from './quarantined-summary';

/**
 * Test support (never imported by production code): a rule-① consent token obtained the REAL way. A `ConsentPendingStore` opens a
 * `summaryConsentPending`, the step is claimed and bound with a closed yes (the store's own `bind`), and the token is minted by
 * the production {@link mintSummaryConsentToken}. There is no shortcut that skips the bound consent.
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
  const claimed = store.claim(scope, 1);
  if (!claimed.ok) throw new Error('test consent claim failed');
  const bound = store.bind(claimed.claim, 2);
  if (bound === undefined) throw new Error('test consent bind failed');
  return { bound, runRef };
}

/** A real consent token for `run` and `step` over the fixture's reads, exactly the scope its pending step recorded. */
export function consentTokenFor(run: SummaryRunToken, step: number, fixture: ConsentFixture): SummaryConsentToken {
  const { bound, runRef } = boundConsentFor(fixture);
  const token = mintSummaryConsentToken({ bound, runRef, run, step, reads: fixture.reads });
  if (token === undefined) throw new Error('test consent mint refused');
  return token;
}
