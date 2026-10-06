import type { Logger } from '@quoky/core';
import { BootstrapPreflightError } from '../bootstrap-preflight';
import type { QuokyConfig } from '../config';

/**
 * ADR-0102 D5 startup identity check. After the platform connects and before the reminder tick starts, the
 * composition root compares the identity the bot actually connected as with the configuration it was given:
 * - the connected bot user id equals `QUOKY_DISCORD_EXPECTED_BOT_ID`;
 * - when `DISCORD_GUILD_ID` is set, the bot is a member of that guild;
 * - every `QUOKY_DISCORD_CHANNEL_IDS` entry can be fetched and lives in that guild (or, with no guild configured,
 *   in a guild the bot is a member of).
 * A mismatch is a configuration error (the process stops and exits with the configuration code); an identity that
 * cannot be read at all is reported as unverifiable (the process stops; the launcher may retry). Logs carry field
 * names and counts only, never an id.
 */
export const StartupIdentityErrorCode = {
  DISCORD_IDENTITY_MISMATCH: 'DISCORD_IDENTITY_MISMATCH',
  DISCORD_IDENTITY_UNVERIFIABLE: 'DISCORD_IDENTITY_UNVERIFIABLE',
} as const;

export interface StartupIdentityExpectation {
  readonly botUserId: string;
  readonly guildId?: string;
  readonly channelIds: readonly string[];
}

/** Facts reported by the platform (the Discord adapter's `readConnectedIdentity` returns this shape). */
export interface ConnectedIdentityFacts {
  readonly botUserId: string;
  readonly guildIds: readonly string[];
  readonly channels: ReadonlyArray<{ readonly id: string; readonly guildId: string | null }>;
  readonly unreachableChannelIds: readonly string[];
}

/** Adapter-local capability (not part of `PlatformAdapter`): a platform that can report its connected identity. */
export interface ConnectedIdentityReader {
  readConnectedIdentity(
    channelIds: readonly string[],
    options?: { readonly readyTimeoutMs?: number },
  ): Promise<ConnectedIdentityFacts>;
}

export type IdentityMismatchField = 'bot' | 'guild' | 'channel';

/** `undefined` when no expected bot id is configured (the check is off outside the launcher). */
export function startupIdentityExpectation(config: Pick<QuokyConfig, 'discord'>): StartupIdentityExpectation | undefined {
  const { expectedBotId, guildId, channelIds } = config.discord;
  if (expectedBotId === undefined) return undefined;
  const trimmedGuild = guildId?.trim();
  return {
    botUserId: expectedBotId,
    ...(trimmedGuild ? { guildId: trimmedGuild } : {}),
    channelIds,
  };
}

/** Pure comparison; returns the mismatching fields in a fixed order (empty = match). */
export function compareStartupIdentity(
  expected: StartupIdentityExpectation,
  facts: ConnectedIdentityFacts,
): IdentityMismatchField[] {
  const mismatches: IdentityMismatchField[] = [];
  if (facts.botUserId !== expected.botUserId) mismatches.push('bot');
  if (expected.guildId !== undefined && !facts.guildIds.includes(expected.guildId)) mismatches.push('guild');
  const channelsOk = expected.channelIds.every((id) => {
    if (facts.unreachableChannelIds.includes(id)) return false;
    const channel = facts.channels.find((entry) => entry.id === id);
    if (!channel || channel.guildId === null) return false;
    return expected.guildId !== undefined ? channel.guildId === expected.guildId : facts.guildIds.includes(channel.guildId);
  });
  if (!channelsOk) mismatches.push('channel');
  return mismatches;
}

export function isConnectedIdentityReader(value: unknown): value is ConnectedIdentityReader {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<ConnectedIdentityReader>).readConnectedIdentity === 'function'
  );
}

/**
 * Adapter-local capability (not part of `PlatformAdapter`): a platform that holds adapter-side inbound effects (the
 * Discord adapter's attachment download, temp file and refusal note) until the startup identity gate opens.
 */
export interface InboundGateTarget {
  gateInbound(gate: Promise<boolean>): void;
}

export function isInboundGateTarget(value: unknown): value is InboundGateTarget {
  return (
    typeof value === 'object' && value !== null && typeof (value as Partial<InboundGateTarget>).gateInbound === 'function'
  );
}

/**
 * ADR-0102 D5: hands the composition root's inbound gate to the platform, so its adapter-side inbound effects wait
 * for the same verification as the turn itself. Returns whether the platform took it. Call before `platform.start()`.
 */
export function applyInboundGate(platform: unknown, gate: Promise<boolean>): boolean {
  if (!isInboundGateTarget(platform)) return false;
  platform.gateInbound(gate);
  return true;
}

/** Reads the connected identity from `platform` and throws a typed error unless it matches `expected`. */
export async function verifyStartupIdentity(
  platform: unknown,
  expected: StartupIdentityExpectation,
  log: Logger,
  options: { readonly readyTimeoutMs?: number } = {},
): Promise<void> {
  if (!isConnectedIdentityReader(platform)) throw unverifiable();
  let facts: ConnectedIdentityFacts;
  try {
    facts = await platform.readConnectedIdentity(expected.channelIds, options);
  } catch {
    throw unverifiable();
  }
  const mismatches = compareStartupIdentity(expected, facts);
  if (mismatches.length > 0) {
    log.error('startup identity mismatch', { fields: mismatches.join(',') });
    throw new BootstrapPreflightError(
      StartupIdentityErrorCode.DISCORD_IDENTITY_MISMATCH,
      `The connected Discord ${mismatches.join('/')} does not match .env.local (QUOKY_DISCORD_EXPECTED_BOT_ID, DISCORD_GUILD_ID, QUOKY_DISCORD_CHANNEL_IDS). Check that DISCORD_BOT_TOKEN belongs to the expected bot and that the bot can see every allowlisted channel, then restart.`,
    );
  }
  log.info('startup identity verified', {
    bot: 'match',
    guild: expected.guildId !== undefined ? 'match' : 'not configured',
    channels: expected.channelIds.length,
  });
}

function unverifiable(): BootstrapPreflightError {
  return new BootstrapPreflightError(
    StartupIdentityErrorCode.DISCORD_IDENTITY_UNVERIFIABLE,
    'The connected Discord identity could not be read (gateway not ready or the platform cannot report it). The process stopped without serving; it is retried on the next start.',
  );
}
