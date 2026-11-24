import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LocalClientPlatformAdapter } from '@quoky/adapter-local-client';
import { outboundMessage } from '@quoky/core';
import type { ConversationContext, InboundMessage, Logger, OutboundMessage, OwnerNotification, PlatformAdapter } from '@quoky/core';

import { applyInboundGate } from '../ops/startup-identity-check';
import { loadConfig } from '../config';
import { parseLocalClientConfig } from '../local-client/local-client-config';
import { CompositePlatformAdapter } from './composite-platform-adapter';
import { composePlatformAdapter, localClientOwnerIdentityLinks, localClientStatusOf } from './platform-composition';
import type { LocalClientComposition } from './platform-composition';

const OWNER = '111111111111111111';
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakeDiscord implements PlatformAdapter {
  readonly platform = 'discord';
  readonly notifications: OwnerNotification[] = [];
  gate?: Promise<boolean>;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(): void {}
  onApprovalDecision(): void {}
  async sendMessage(_message: OutboundMessage): Promise<void> {}
  async sendTyping(): Promise<void> {}
  async requestApproval(): Promise<void> {}
  gateInbound(gate: Promise<boolean>): void {
    this.gate = gate;
  }
  async deliver(notification: OwnerNotification) {
    this.notifications.push(notification);
    return { status: 'SENT' as const, via: 'DM' as const };
  }
}

const dirs: string[] = [];
const adapters: PlatformAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function localClient(overrides: Partial<LocalClientComposition> = {}): LocalClientComposition {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lcc-'));
  dirs.push(dir);
  return {
    config: { ownerActor: OWNER },
    dataDir: dir,
    instanceLockHeld: true,
    fileBackedDb: true,
    discordOwnerIds: [OWNER],
    verifyOwner: async () => true,
    ...overrides,
  };
}
const deps = (lc?: LocalClientComposition) => ({ logger: () => silent, dbPath: '/nonexistent/quoky.db', ...(lc === undefined ? {} : { localClient: lc }) });

describe('flag off: composition is exactly what it was (ADR-0125 D1)', () => {
  it('is the Discord adapter itself and creates no socket or token file', () => {
    const discord = new FakeDiscord();
    const composed = composePlatformAdapter(discord, undefined, deps());
    expect(composed).toBe(discord);
  });

  it('parses to undefined for unset or false, and loadConfig has no localClient key', () => {
    expect(parseLocalClientConfig({})).toBeUndefined();
    expect(parseLocalClientConfig({ QUOKY_LOCAL_CLIENT_ENABLED: 'false', QUOKY_LOCAL_CLIENT_OWNER_ACTOR: OWNER })).toBeUndefined();
    const config = loadConfig({ QUOKY_DISCORD_OWNER_IDS: OWNER } as NodeJS.ProcessEnv);
    expect('localClient' in config).toBe(false);
    expect(localClientOwnerIdentityLinks(config.localClient, config.discord.ownerIds)).toEqual([]);
  });

  it('a mistyped flag is a startup error (code only), "true" reads the owner', () => {
    expect(() => parseLocalClientConfig({ QUOKY_LOCAL_CLIENT_ENABLED: 'yes' })).toThrow('LOCAL_CLIENT_ENABLED_INVALID');
    expect(() => parseLocalClientConfig({ QUOKY_LOCAL_CLIENT_ENABLED: 'TRUE' })).toThrow('LOCAL_CLIENT_ENABLED_INVALID');
    expect(parseLocalClientConfig({ QUOKY_LOCAL_CLIENT_ENABLED: 'true', QUOKY_LOCAL_CLIENT_OWNER_ACTOR: ` ${OWNER} ` })).toEqual({ ownerActor: OWNER });
    expect(parseLocalClientConfig({ QUOKY_LOCAL_CLIENT_ENABLED: 'true' })).toEqual({});
  });

  it('with only Telegram configured nothing local-client is joined (a Telegram-only composite is unchanged)', () => {
    const composed = composePlatformAdapter(new FakeDiscord(), undefined, deps());
    expect(composed instanceof CompositePlatformAdapter).toBe(false);
    expect(localClientStatusOf(composed)).toBeUndefined();
  });
});

describe('flag on (ADR-0125 D1, D2 step 0, D5, D8)', () => {
  it('joins the composite behind Discord, takes the inbound gate and serves a turn through one path', async () => {
    const discord = new FakeDiscord();
    const lc = localClient();
    const composed = composePlatformAdapter(discord, undefined, deps(lc));
    adapters.push(composed);
    expect(composed instanceof CompositePlatformAdapter && composed.platforms).toEqual(['discord', 'local-client']);
    const received: InboundMessage[] = [];
    composed.onMessage(async (message) => void received.push(message));
    let open: (v: boolean) => void = () => undefined;
    expect(applyInboundGate(composed, new Promise<boolean>((resolve) => (open = resolve)))).toBe(true);
    expect(discord.gate).toBeDefined();
    await composed.start();
    expect(localClientStatusOf(composed)).toMatchObject({ enabled: true, listening: true });
    expect(existsSync(path.join(lc.dataDir, 'local-client.sock'))).toBe(true);
    open(true);
    await new Promise((r) => setTimeout(r, 20));
    const token = (await import('node:fs')).readFileSync(path.join(lc.dataDir, 'local-client.token'), 'utf8').trim();
    const status = await new Promise<number>((resolve) => {
      http.get({ socketPath: path.join(lc.dataDir, 'local-client.sock'), path: '/client/v1/status', headers: { Host: 'localhost', Authorization: `Bearer ${token}` }, setHost: false }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(200);
    const ctx: ConversationContext = { platform: 'local-client', channelId: 'local-client-dm', userId: OWNER, direct: true };
    const receipt = await composed.sendMessage(outboundMessage(ctx, 'hi') as OutboundMessage);
    expect(receipt).toMatchObject({ platformMessageIds: [expect.stringMatching(/^[0-9a-f]{16}-1$/)] });
    await composed.stop();
    expect(existsSync(path.join(lc.dataDir, 'local-client.sock'))).toBe(false);
    expect(existsSync(path.join(lc.dataDir, 'local-client.token'))).toBe(false);
  });

  it.each([
    ['no instance lock', { instanceLockHeld: false }],
    ['an in-memory database', { fileBackedDb: false }],
  ])('is not joined with %s (the rest of Quoky is unchanged)', (_name, override) => {
    const discord = new FakeDiscord();
    const lc = localClient(override);
    expect(composePlatformAdapter(discord, undefined, deps(lc))).toBe(discord);
    expect(existsSync(path.join(lc.dataDir, 'local-client.sock'))).toBe(false);
  });

  it.each([
    ['no owner configured', { config: {} }],
    ['an owner outside QUOKY_DISCORD_OWNER_IDS', { discordOwnerIds: ['999999999999999999'] }],
    ['an owner that maps to no single Actor', { verifyOwner: async () => false }],
  ])('fails closed at start with %s; Discord keeps starting', async (_name, override) => {
    const discord = new FakeDiscord();
    const lc = localClient(override);
    const composed = composePlatformAdapter(discord, undefined, deps(lc));
    adapters.push(composed);
    await expect(composed.start()).resolves.toBeUndefined();
    expect(localClientStatusOf(composed)).toMatchObject({ enabled: false, listening: false });
    expect(existsSync(path.join(lc.dataDir, 'local-client.sock'))).toBe(false);
  });

  it('links the local-client owner to the configured Discord owner Actor, and only a configured owner', () => {
    expect(localClientOwnerIdentityLinks({ ownerActor: OWNER }, [OWNER])).toEqual([
      { identity: { platform: 'local-client', externalId: OWNER }, owner: { platform: 'discord', externalId: OWNER } },
    ]);
    expect(localClientOwnerIdentityLinks({ ownerActor: OWNER }, ['2'])).toEqual([]);
    expect(localClientOwnerIdentityLinks({}, [OWNER])).toEqual([]);
  });

  it('routes a local-client reminder to the owner Discord DM (D8, LC-1b..LC-3); OPS_DECISION_RESULT stays on Discord', async () => {
    const discord = new FakeDiscord();
    const composed = composePlatformAdapter(discord, undefined, deps(localClient()));
    const target: ConversationContext = { platform: 'local-client', channelId: 'local-client-dm', userId: OWNER, direct: true, threadId: 'th-1' };
    const recheck = { sendIfAllowed: async <T,>(send: () => Promise<T>) => ({ sent: true as const, value: await send() }), dm: { text: 'dm' } };
    const outcome = await (composed as CompositePlatformAdapter).deliver({ correlationId: 'c1', target, kind: 'TEXT', text: '약 먹을 시간', channelRecheck: recheck });
    expect(outcome).toEqual({ status: 'SENT', via: 'DM' });
    expect(discord.notifications).toHaveLength(1);
    const delivered = discord.notifications[0] as OwnerNotification;
    expect(delivered.text).toBe('약 먹을 시간');
    expect(delivered.target).toMatchObject({ platform: 'discord', userId: OWNER });
    expect(delivered.target.spaceId).toBeUndefined();
    expect(delivered.channelRecheck).toBeUndefined();
    await (composed as CompositePlatformAdapter).deliver({ correlationId: 'c2', target, kind: 'BRIEF', text: 'brief' });
    expect(discord.notifications).toHaveLength(2);
  });

  it('a local-client notification with no configured owner is NOT_SENT TARGET_NOT_ADMITTED and reaches nothing', async () => {
    const discord = new FakeDiscord();
    const composed = composePlatformAdapter(discord, undefined, deps(localClient({ config: {} })));
    const target: ConversationContext = { platform: 'local-client', channelId: 'local-client-dm', userId: OWNER, direct: true };
    expect(await (composed as CompositePlatformAdapter).deliver({ correlationId: 'c3', target, kind: 'TEXT', text: 'x' })).toEqual({
      status: 'NOT_SENT',
      reason: 'TARGET_NOT_ADMITTED',
      retryable: false,
    });
    expect(discord.notifications).toHaveLength(0);
  });

  it('the composed adapter is the real LocalClientPlatformAdapter (Core sees only the PlatformAdapter contract)', () => {
    const composed = composePlatformAdapter(new FakeDiscord(), undefined, deps(localClient())) as CompositePlatformAdapter;
    expect(composed.adapterFor('local-client')).toBeInstanceOf(LocalClientPlatformAdapter);
  });
});
