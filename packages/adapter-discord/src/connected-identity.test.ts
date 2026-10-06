import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordIdentityUnavailableError, readConnectedIdentity } from './connected-identity';
import type { IdentityClientView } from './connected-identity';

const BOT = '888888888888888888';
const GUILD = '333333333333333333';
const CHANNEL = '444444444444444444';
const THREAD = '666666666666666666';
const MISSING = '999999999999999999';

function fakeClient(init: { ready?: boolean; botUserId?: string; channels?: Record<string, string | null> } = {}) {
  let ready = init.ready ?? true;
  const listeners = new Set<() => void>();
  const view: IdentityClientView = {
    isReady: () => ready,
    onceReady: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    botUserId: () => ('botUserId' in init ? init.botUserId : BOT),
    guildIds: () => [GUILD],
    channelGuildId: async (id) => {
      const channels = init.channels ?? { [CHANNEL]: GUILD };
      return id in channels ? channels[id] : undefined;
    },
  };
  return {
    view,
    listeners,
    fireReady: () => {
      ready = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readConnectedIdentity (ADR-0102 D5)', () => {
  it('reports the bot id, guild ids and each channel guild without waiting when already ready', async () => {
    const { view } = fakeClient({ channels: { [CHANNEL]: GUILD, [THREAD]: GUILD } });
    await expect(readConnectedIdentity(view, [CHANNEL, THREAD])).resolves.toEqual({
      botUserId: BOT,
      guildIds: [GUILD],
      channels: [
        { id: CHANNEL, guildId: GUILD },
        { id: THREAD, guildId: GUILD },
      ],
      unreachableChannelIds: [],
    });
  });

  it('lists channels that cannot be fetched (or whose fetch throws) as unreachable', async () => {
    const { view } = fakeClient();
    const throwing: IdentityClientView = {
      ...view,
      channelGuildId: async (id) => {
        if (id === THREAD) throw new Error('Missing Access');
        return view.channelGuildId(id);
      },
    };
    const identity = await readConnectedIdentity(throwing, [CHANNEL, MISSING, THREAD]);
    expect(identity.channels).toEqual([{ id: CHANNEL, guildId: GUILD }]);
    expect(identity.unreachableChannelIds).toEqual([MISSING, THREAD]);
  });

  it('waits for READY, then removes its listener', async () => {
    const client = fakeClient({ ready: false });
    const pending = readConnectedIdentity(client.view, []);
    expect(client.listeners.size).toBe(1);
    client.fireReady();
    await expect(pending).resolves.toMatchObject({ botUserId: BOT });
  });

  it('fails with DISCORD_NOT_READY when READY does not arrive within the bound', async () => {
    vi.useFakeTimers();
    const client = fakeClient({ ready: false });
    const pending = readConnectedIdentity(client.view, [], { readyTimeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toEqual(new DiscordIdentityUnavailableError('DISCORD_NOT_READY'));
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(client.listeners.size).toBe(0);
  });

  it('fails with DISCORD_BOT_USER_UNKNOWN when the client has no user', async () => {
    const { view } = fakeClient({ botUserId: undefined });
    await expect(readConnectedIdentity(view, [])).rejects.toMatchObject({ code: 'DISCORD_BOT_USER_UNKNOWN' });
  });
});
