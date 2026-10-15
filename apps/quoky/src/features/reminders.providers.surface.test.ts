import type { FactoryProvider } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ReminderDispatchService, ReminderReplyComposer, type StorageProvider } from '@quoky/core';
import type { ReminderConfig } from '../reminders/reminder-config';
import { createRemindersProviders } from './reminders.providers';
import type { SurfaceGrantsComposition } from './surface-grants.providers';

// ADR-0122 D2.6 (P2): the reminder dispatcher gets the send-time channel check only when a reminder can reach a channel
// at all (QUOKY_REMINDERS_CHANNEL_DELIVERY on) AND the surface gate is enforced (its `deliveryAllowed` exists).

const CONFIG: ReminderConfig = { enabled: true, channelDelivery: false, timeZone: 'Asia/Seoul', briefJiraEnabled: false, briefMailEnabled: false };
const logger = { info() {}, warn() {}, error() {} };

function dispatchFactory(): FactoryProvider['useFactory'] {
  const provider = createRemindersProviders(() => CONFIG, { logger }).find(
    (candidate): candidate is FactoryProvider => typeof candidate === 'object' && 'provide' in candidate && candidate.provide === ReminderDispatchService,
  );
  if (provider === undefined) throw new Error('no dispatch provider');
  return provider.useFactory;
}

function surfaceDeliveryOf(config: ReminderConfig, surfaceGrants: Partial<SurfaceGrantsComposition> | undefined): unknown {
  const service = dispatchFactory()(config, {} as StorageProvider, {}, { deliver: async () => ({ status: 'SENT', via: 'dm' }) }, new ReminderReplyComposer(), undefined, undefined, undefined, surfaceGrants);
  return (service as unknown as { deps: { surfaceDelivery?: unknown } }).deps.surfaceDelivery;
}

describe('reminder dispatch wiring of the channel check', () => {
  const deliveryAllowed = async () => true;
  const deliverIfAllowed = async () => ({ sent: false as const });

  it('wired only with channel delivery on and the gate enforced', () => {
    expect(surfaceDeliveryOf({ ...CONFIG, channelDelivery: true }, { deliveryAllowed, deliverIfAllowed })).toEqual({ allows: deliveryAllowed, sendIfAllowed: deliverIfAllowed });
    expect(surfaceDeliveryOf({ ...CONFIG, channelDelivery: false }, { deliveryAllowed, deliverIfAllowed })).toBeUndefined();
    expect(surfaceDeliveryOf({ ...CONFIG, channelDelivery: true }, {})).toBeUndefined(); // the gate `off`
    expect(surfaceDeliveryOf({ ...CONFIG, channelDelivery: true }, undefined)).toBeUndefined();
  });
});
