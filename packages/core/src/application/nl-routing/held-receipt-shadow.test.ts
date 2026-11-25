import { describe, expect, it } from 'vitest';
import type { Actor, IsoTimestamp, Session } from '../../domain';
import type { AiProvider, Logger } from '../../ports';
import { LAST_LISTING_METADATA_KEY } from '../last-listing';
import { NlActionSwitch } from './action-switch';
import { NlSelectionService } from './nl-selection-service';

// ADR-0121 A7-S2: the held-receipt shadow hook is log-only (count and closed source), absent by default, and never changes
// what the listing receipt writes.

const NOW = '2026-11-25T10:00:00.000Z' as IsoTimestamp;

async function run(shadow: ((event: { source: string; items: number }) => void) | undefined) {
  let session = { id: 'dm-1', metadata: {} } as unknown as Session;
  const actor = { id: 'owner', metadata: {} } as unknown as Actor;
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const actors = { get: async () => actor, save: async (next: Actor) => next };
  const service = new NlSelectionService({
    mode: 'active',
    router: { select: async () => ({}) as AiProvider },
    sessions: {
      async updateMetadataEntry(_ref, key, update) {
        const metadata: Record<string, unknown> = { ...(session.metadata ?? {}) };
        const next = update(metadata[key]);
        if (next === undefined) delete metadata[key];
        else metadata[key] = next;
        session = { ...session, metadata } as Session;
        return session;
      },
    },
    actors,
    timeZone: 'Asia/Seoul',
    logger,
    actions: { level: 'local', killSwitch: new NlActionSwitch({ actors, logger }) },
    ...(shadow !== undefined ? { heldReceiptShadow: shadow } : {}),
  });
  const message = { id: 'in-1', context: { platform: 'test', channelId: 'dm' } };
  await service.recordActionReceipt({ session, actor, message, now: NOW, listing: { source: 'jira', items: [{ label: 1, id: 'BE-1' }, { label: 2, id: 'BE-2' }] } });
  await service.recordActionReceipt({ session, actor, message: { ...message, id: 'in-2' }, now: NOW, listing: { source: 'slack', items: [] } });
  return session.metadata?.[LAST_LISTING_METADATA_KEY];
}

describe('heldReceiptShadow hook', () => {
  it('reports only the closed source and the count for a non-empty listing', async () => {
    const events: unknown[] = [];
    await run((event) => events.push(event));
    expect(events).toEqual([{ source: 'jira', items: 2 }]);
  });
  it('changes nothing about the stored listing, and a throwing hook never throws', async () => {
    const without = await run(undefined);
    const withHook = await run(() => {
      throw new Error('x');
    });
    expect(withHook).toEqual(without);
  });
});
