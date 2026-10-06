/**
 * ADR-0102 D5: read-only facts about the identity the Discord client actually connected as, for the composition
 * root's startup identity check. Adapter-local: it is not part of `PlatformAdapter` and Core never sees it. Nothing
 * here sends a message or changes Discord state; it only reads the gateway cache and fetches configured channels.
 */

/** What the connected client reports. Ids only; no names, topics or message content. */
export interface DiscordConnectedIdentity {
  /** The connected bot user's id. */
  readonly botUserId: string;
  /** Guilds the bot is a member of (gateway cache after READY). */
  readonly guildIds: readonly string[];
  /** Each requested channel id that could be fetched, with its guild (`null` for a channel outside any guild). */
  readonly channels: ReadonlyArray<{ readonly id: string; readonly guildId: string | null }>;
  /** Requested channel ids that could not be fetched (missing, no access, or a fetch error). */
  readonly unreachableChannelIds: readonly string[];
}

/** Default bound for the gateway READY wait. */
export const DEFAULT_IDENTITY_READY_TIMEOUT_MS = 30_000;

/** The narrow client view the reader needs; the adapter builds it from the live discord.js client. */
export interface IdentityClientView {
  isReady(): boolean;
  /** Registers a one-shot READY listener and returns a function that removes it. */
  onceReady(listener: () => void): () => void;
  botUserId(): string | undefined;
  guildIds(): Iterable<string>;
  /** Resolves the channel's guild id, `null` for a channel outside a guild, `undefined` when it cannot be fetched. */
  channelGuildId(channelId: string): Promise<string | null | undefined>;
}

export class DiscordIdentityUnavailableError extends Error {
  constructor(readonly code: 'DISCORD_NOT_READY' | 'DISCORD_BOT_USER_UNKNOWN') {
    super(code);
    this.name = 'DiscordIdentityUnavailableError';
  }
}

/** Waits for READY (bounded), then reads the bot id, guild ids and the configured channels. */
export async function readConnectedIdentity(
  client: IdentityClientView,
  channelIds: readonly string[],
  options: { readonly readyTimeoutMs?: number } = {},
): Promise<DiscordConnectedIdentity> {
  if (!client.isReady()) {
    await waitForReady(client, options.readyTimeoutMs ?? DEFAULT_IDENTITY_READY_TIMEOUT_MS);
  }
  const botUserId = client.botUserId();
  if (!botUserId) throw new DiscordIdentityUnavailableError('DISCORD_BOT_USER_UNKNOWN');

  const channels: Array<{ id: string; guildId: string | null }> = [];
  const unreachableChannelIds: string[] = [];
  for (const id of channelIds) {
    const guildId = await client.channelGuildId(id).catch(() => undefined);
    if (guildId === undefined) unreachableChannelIds.push(id);
    else channels.push({ id, guildId });
  }
  return { botUserId, guildIds: [...client.guildIds()], channels, unreachableChannelIds };
}

function waitForReady(client: IdentityClientView, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeListener();
      reject(new DiscordIdentityUnavailableError('DISCORD_NOT_READY'));
    }, timeoutMs);
    const removeListener = client.onceReady(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    // READY may have fired between the isReady() check and listener registration.
    if (!settled && client.isReady()) {
      settled = true;
      clearTimeout(timer);
      removeListener();
      resolve();
    }
  });
}
