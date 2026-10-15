import {
  SURFACE_GRANT_MAX_CHANNELS,
  isGrantableSurfaceGroup,
  isSurfaceGroupId,
  surfaceChannelKey,
  type SurfaceGrantSeed,
  type SurfaceGrantsMode,
  type SurfaceGroupId,
} from '@quoky/core';

/**
 * ADR-0122 D6: the channel-grants configuration, parsed and validated only here (composition root). Typed value-free
 * errors: the message is the code only, a configured value is never echoed.
 *
 * - `QUOKY_CHANNEL_GRANTS`: exactly `enforce` or `off`. **P1 deploy default `off`** (byte-identical to the release before
 *   ADR-0122 apart from the shipped P0 DM-only gates) until the owner sets the value on the live host (Strict); the ADR's
 *   ratified default `enforce` takes effect through that value. `off` logs one startup warning.
 * - `QUOKY_CHANNEL_GRANTS_SEED`: `discord:<guildId>:<channelId>=<group>,<group>[;discord:…=…]`. Every channel must be in
 *   `QUOKY_DISCORD_CHANNEL_IDS` and its guild must equal `DISCORD_GUILD_ID`; every group must be grantable (never an
 *   always or a DM-only group); at most 16 channels. Applied once per digest at startup, after the identity provisioner,
 *   only while `enforce`.
 */

export const ChannelGrantsConfigErrorCode = {
  CHANNEL_GRANTS_INVALID: 'CHANNEL_GRANTS_INVALID',
  CHANNEL_GRANTS_SEED_INVALID: 'CHANNEL_GRANTS_SEED_INVALID',
  CHANNEL_GRANTS_SEED_GROUP_INVALID: 'CHANNEL_GRANTS_SEED_GROUP_INVALID',
  CHANNEL_GRANTS_SEED_CHANNEL_NOT_ALLOWED: 'CHANNEL_GRANTS_SEED_CHANNEL_NOT_ALLOWED',
  CHANNEL_GRANTS_SEED_GUILD_MISMATCH: 'CHANNEL_GRANTS_SEED_GUILD_MISMATCH',
  CHANNEL_GRANTS_SEED_TOO_MANY_CHANNELS: 'CHANNEL_GRANTS_SEED_TOO_MANY_CHANNELS',
} as const;
export type ChannelGrantsConfigErrorCode = (typeof ChannelGrantsConfigErrorCode)[keyof typeof ChannelGrantsConfigErrorCode];

export class ChannelGrantsConfigError extends Error {
  constructor(readonly code: ChannelGrantsConfigErrorCode) {
    super(code);
    this.name = 'ChannelGrantsConfigError';
  }
}

/** The P1 code default (see the module note). */
export const DEFAULT_CHANNEL_GRANTS_MODE: SurfaceGrantsMode = 'off';

export interface ChannelGrantsConfig {
  readonly mode: SurfaceGrantsMode;
  /** Whether `QUOKY_CHANNEL_GRANTS` was set explicitly (the startup warning names the default otherwise). */
  readonly explicit: boolean;
  /** The validated seed (channel keys `discord:<guild>:<channel>`), or undefined when unset. */
  readonly seed?: SurfaceGrantSeed;
}

const DISCORD_ID = /^[0-9]{5,25}$/;
/** The only platform with channels today (Telegram admits the owner's private chat only, ADR-0114). */
const SEED_PLATFORM = 'discord';

function fail(code: ChannelGrantsConfigErrorCode): never {
  throw new ChannelGrantsConfigError(code);
}

function present(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim().length === 0 ? undefined : raw.trim();
}

export function parseChannelGrantsConfig(
  env: NodeJS.ProcessEnv,
  discord: { readonly guildId?: string; readonly channelIds: readonly string[] },
): ChannelGrantsConfig {
  const rawMode = present(env.QUOKY_CHANNEL_GRANTS);
  if (rawMode !== undefined && rawMode !== 'enforce' && rawMode !== 'off') fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_INVALID);
  const mode: SurfaceGrantsMode = rawMode ?? DEFAULT_CHANNEL_GRANTS_MODE;
  const rawSeed = present(env.QUOKY_CHANNEL_GRANTS_SEED);
  if (rawSeed === undefined) return { mode, explicit: rawMode !== undefined };
  return { mode, explicit: rawMode !== undefined, seed: parseChannelGrantsSeed(rawSeed, discord) };
}

export function parseChannelGrantsSeed(
  raw: string,
  discord: { readonly guildId?: string; readonly channelIds: readonly string[] },
): SurfaceGrantSeed {
  const entries = raw.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
  if (entries.length === 0) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_INVALID);
  if (entries.length > SURFACE_GRANT_MAX_CHANNELS) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_TOO_MANY_CHANNELS);
  const channels: { key: string; groups: SurfaceGroupId[] }[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = /^([a-z]+):([^:=\s]+):([^:=\s]+)=([^=]+)$/u.exec(entry);
    if (!match) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_INVALID);
    const [, platform, guildId, channelId, list] = match as unknown as [string, string, string, string, string];
    if (platform !== SEED_PLATFORM || !DISCORD_ID.test(guildId) || !DISCORD_ID.test(channelId)) {
      fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_INVALID);
    }
    if (discord.guildId === undefined || discord.guildId !== guildId) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_GUILD_MISMATCH);
    if (!discord.channelIds.includes(channelId)) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_CHANNEL_NOT_ALLOWED);
    const groups: SurfaceGroupId[] = [];
    for (const name of list.split(',').map((part) => part.trim())) {
      if (!isSurfaceGroupId(name) || !isGrantableSurfaceGroup(name)) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_GROUP_INVALID);
      if (!groups.includes(name)) groups.push(name);
    }
    if (groups.length === 0) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_INVALID);
    const key = surfaceChannelKey({ platform, spaceId: guildId, channelId });
    if (seen.has(key)) fail(ChannelGrantsConfigErrorCode.CHANNEL_GRANTS_SEED_INVALID);
    seen.add(key);
    channels.push({ key, groups });
  }
  return { channels };
}
