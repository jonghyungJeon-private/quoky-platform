import { describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, InboundMessage, NotificationSink, OwnerNotification, StorageProvider } from '@quoky/core';
import { createSurfaceGrantsComposition } from './surface-grants.providers';

// ADR-0122 D6 (CA P3): the seed's owner DM lines — new groups get the plain line; only groups the owner had revoked get
// the explicit "해제하셨던 … 다시 허용" line.

const OWNER_ID = '222222222222222222';
const GUILD = '1520835639103324181';
const QA = '1520835639904309350';
const KEY = `discord:${GUILD}:${QA}`;

function world() {
  let actor: Actor = { id: 'owner', displayName: 'o', identities: [{ platform: 'discord', externalId: OWNER_ID }], createdAt: '2026-10-15T00:00:00.000Z' };
  const delivered: OwnerNotification[] = [];
  const storage = {
    actors: {
      async get(id: string) {
        return id === actor.id ? structuredClone(actor) : null;
      },
      async save(next: Actor) {
        actor = structuredClone(next);
        return next;
      },
      async findByExternalIdentity(platform: string, externalId: string) {
        return actor.identities.some((identity) => identity.platform === platform && identity.externalId === externalId) ? structuredClone(actor) : null;
      },
    },
  } as unknown as StorageProvider;
  const sink: NotificationSink = {
    async deliver(notification) {
      delivered.push(notification);
      return { status: 'SENT', via: 'DM' } as never;
    },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const composition = (groups: readonly string[], mode: 'enforce' | 'off' = 'enforce') =>
    createSurfaceGrantsComposition(
      { channelGrants: { mode, explicit: true, seed: { channels: [{ key: KEY, groups: groups as never }] } }, discordOwnerIds: [OWNER_ID], telegramOwnerIds: [] },
      storage,
      sink,
      logger,
    );
  return { composition, delivered, actor: () => actor };
}

describe('seed DM lines (D6)', () => {
  it('a changed value: new groups get the plain line, revoked ones the explicit re-added line', async () => {
    const w = world();
    const first = w.composition(['calendar', 'todo']);
    await first.applySeed('2026-10-15T00:00:00.000Z');
    await first.deliverSeedReceipts();
    expect(w.delivered.map((n) => n.text)).toEqual([`배포 시 사전 허용: ${QA}에 캘린더 조회, 할 일. 해제: 그 채널에서 "이 채널 권한 모두 해제".`]);
    const channel: ConversationContext = { platform: 'discord', spaceId: GUILD, channelId: QA, userId: OWNER_ID, direct: false };
    const message: InboundMessage = { id: 'm', context: channel, text: '이 채널에 캘린더 허용 해제', receivedAt: '2026-10-15T00:00:00.000Z' };
    expect(await first.service.handlePhrase(message, w.actor(), '2026-10-15T00:00:00.000Z')).toBe('이 채널에서 해제했어요: 캘린더 조회.');
    w.delivered.length = 0;
    const changed = w.composition(['calendar', 'todo', 'github']);
    await changed.applySeed('2026-10-16T00:00:00.000Z');
    await changed.deliverSeedReceipts();
    expect(w.delivered.map((n) => [n.kind, n.text])).toEqual([
      ['SURFACE_GRANT', `배포 시 사전 허용: ${QA}에 GitHub 조회. 해제: 그 채널에서 "이 채널 권한 모두 해제".`],
      ['SURFACE_GRANT', `배포 설정이 바뀌어 해제하셨던 캘린더 조회을(를) ${QA}에 다시 허용했어요. 원치 않으면 그 채널에서 '… 허용 해제'라고 보내 주세요.`],
    ]);
  });
});

describe('the reminder delivery check (D2.6, P2)', () => {
  const channel: ConversationContext = { platform: 'discord', spaceId: GUILD, channelId: QA, userId: OWNER_ID, direct: false };

  it('exists only while `enforce`; it reads the live owner grants and fails closed', async () => {
    const w = world();
    expect(w.composition([], 'off').deliveryAllowed).toBeUndefined();
    const enforced = w.composition(['reminder']);
    expect(await enforced.deliveryAllowed!(channel, 'owner', ['reminder'])).toBe(false); // nothing seeded yet
    await enforced.applySeed('2026-10-15T00:00:00.000Z');
    expect(await enforced.deliveryAllowed!(channel, 'owner', ['reminder'])).toBe(true);
    expect(await enforced.deliveryAllowed!(channel, 'owner', ['reminder', 'calendar'])).toBe(false);
    expect(await enforced.deliveryAllowed!(channel, 'nobody', ['reminder'])).toBe(false);
    const message: InboundMessage = { id: 'm', context: channel, text: '이 채널 권한 모두 해제', receivedAt: '2026-10-15T00:00:00.000Z' };
    await enforced.service.handlePhrase(message, w.actor(), '2026-10-15T00:00:00.000Z');
    expect(await enforced.deliveryAllowed!(channel, 'owner', ['reminder'])).toBe(false);
  });
});

describe('the last-moment reminder channel send under the per-actor lock (D2.6, Codex P1 final round)', () => {
  const channel: ConversationContext = { platform: 'discord', spaceId: GUILD, channelId: QA, userId: OWNER_ID, direct: false };
  const revokeMessage: InboundMessage = { id: 'r', context: channel, text: '이 채널 권한 모두 해제', receivedAt: '2026-10-15T00:00:00.000Z' };

  it('a revoke issued while the check and the send run waits for the send; the next send is refused', async () => {
    const w = world();
    const composition = w.composition(['reminder']);
    expect(w.composition([], 'off').deliverIfAllowed).toBeUndefined();
    await composition.applySeed('2026-10-15T00:00:00.000Z');
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    const events: string[] = [];
    const sending = composition.deliverIfAllowed!(channel, 'owner', ['reminder'], async () => {
      events.push('send-start');
      await inFlight;
      events.push('send-end');
      return 'sent';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revoking = composition.service.handlePhrase(revokeMessage, w.actor(), '2026-10-15T00:00:00.000Z').then((reply) => {
      events.push('revoked');
      return reply;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['send-start']); // the revoke is waiting for the lock
    release();
    expect(await sending).toEqual({ sent: true, value: 'sent' });
    expect(await revoking).toBe('이 채널의 권한을 모두 해제했어요.');
    expect(events).toEqual(['send-start', 'send-end', 'revoked']);
    let sent = false;
    expect(await composition.deliverIfAllowed!(channel, 'owner', ['reminder'], async () => (sent = true))).toEqual({ sent: false });
    expect(sent).toBe(false);
  });

  it('a revoke that committed first: the check refuses and the send never runs; a missing actor refuses', async () => {
    const w = world();
    const composition = w.composition(['reminder']);
    await composition.applySeed('2026-10-15T00:00:00.000Z');
    const revoking = composition.service.handlePhrase(revokeMessage, w.actor(), '2026-10-15T00:00:00.000Z');
    let sent = false;
    const sending = composition.deliverIfAllowed!(channel, 'owner', ['reminder'], async () => (sent = true));
    await revoking;
    expect(await sending).toEqual({ sent: false });
    expect(sent).toBe(false);
    expect(await composition.deliverIfAllowed!(channel, 'nobody', ['reminder'], async () => (sent = true))).toEqual({ sent: false });
  });
});
