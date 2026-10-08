import {
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  failSafeConnectorWriteTransportClassifier,
  isValidConnectorWriteText,
  resolveConnectorQueryTimeoutMs,
  type ChannelMessageRequest,
  type ChannelMessageWriter,
  type ConnectorWriteNotSentReason,
  type ConnectorWriteOutcome,
  type ConnectorWriteTransportClassifier,
} from '@quoky/core';

/**
 * Slack post adapter (ADR-0112 D1/D2/D4): `chat.postMessage` to an allowlisted channel with a BOT token (`chat:write`,
 * posting as the app), separate from the read connector's user token. A separate class from the read-only
 * `SlackConnectorProvider`. The text is posted verbatim: `&`, `<` and `>` are escaped and mention, link and markdown
 * expansion is off, so owner text can never become `@channel` or a hidden link. One request with a timeout and
 * redirects refused; no retry. A thrown request is classified by the injected
 * `classifyTransportFailure` (NOT_SENT only with connection-stage evidence; default UNCERTAIN). Nothing is logged, and no outcome carries the
 * token, the payload or a response body.
 */

const SLACK_API_ORIGIN = 'https://slack.com';
/** Built by concatenation so no token-shaped literal appears in the source. */
const SLACK_BOT_TOKEN_PREFIX = 'xox' + 'b-';
const CHANNEL_ID = /^[CG][A-Z0-9]{8,20}$/;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MESSAGE_TS = /^[0-9]{1,12}\.[0-9]{1,8}$/;
const PERMALINK = /^https:\/\/[A-Za-z0-9.-]+\.slack\.com\/[\x21-\x7e]{1,500}$/;

/** One allowlisted channel: its id, and optionally the name the owner types (`#name`). */
export interface SlackWriteChannel {
  readonly id: string;
  readonly name?: string;
}

export interface SlackChannelWriterConfig {
  /** The bot token (`chat:write`). Must be a bot token and must not be the read connector's token. */
  readonly token: string;
  /** Allowlisted channels (`QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS`). Must not be empty. */
  readonly channels: readonly SlackWriteChannel[];
  /** Injectable for deterministic unit tests. Production defaults to the platform fetch implementation. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout in milliseconds (default 10000). */
  readonly timeoutMs?: number;
  /**
   * How a thrown post request is classified (UNC-1; injected by the composition root). Default: fail safe, every
   * thrown request is UNCERTAIN.
   */
  readonly classifyTransportFailure?: ConnectorWriteTransportClassifier;
}

/** Slack API error codes that certainly mean the message was not posted. Anything unknown is UNCERTAIN. */
const NOT_SENT_ERRORS: Readonly<Record<string, ConnectorWriteNotSentReason>> = {
  channel_not_found: 'NOT_FOUND',
  not_in_channel: 'FORBIDDEN',
  is_archived: 'REJECTED',
  msg_too_long: 'INVALID_REQUEST',
  no_text: 'INVALID_REQUEST',
  restricted_action: 'FORBIDDEN',
  restricted_action_read_only_channel: 'FORBIDDEN',
  restricted_action_thread_only_channel: 'FORBIDDEN',
  restricted_action_non_threadable_channel: 'FORBIDDEN',
  ekm_access_denied: 'FORBIDDEN',
  team_access_not_granted: 'FORBIDDEN',
  no_permission: 'FORBIDDEN',
  access_denied: 'FORBIDDEN',
  not_allowed_token_type: 'UNAUTHORIZED',
  invalid_auth: 'UNAUTHORIZED',
  not_authed: 'UNAUTHORIZED',
  account_inactive: 'UNAUTHORIZED',
  token_revoked: 'UNAUTHORIZED',
  token_expired: 'UNAUTHORIZED',
  missing_scope: 'INSUFFICIENT_SCOPE',
  ratelimited: 'RATE_LIMITED',
  rate_limited: 'RATE_LIMITED',
  invalid_arguments: 'REJECTED',
  invalid_arg_name: 'REJECTED',
  invalid_charset: 'REJECTED',
  invalid_form_data: 'REJECTED',
  invalid_post_type: 'REJECTED',
  missing_post_type: 'REJECTED',
  invalid_json: 'REJECTED',
  json_not_object: 'REJECTED',
};

export class SlackChannelWriter implements ChannelMessageWriter {
  readonly source = 'slack';

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly classifyTransportFailure: ConnectorWriteTransportClassifier;
  private readonly ids: ReadonlySet<string>;
  private readonly byName: ReadonlyMap<string, string>;

  constructor(config: SlackChannelWriterConfig) {
    const token = typeof config?.token === 'string' ? config.token.trim() : '';
    if (!token.startsWith(SLACK_BOT_TOKEN_PREFIX) || token.length <= SLACK_BOT_TOKEN_PREFIX.length) {
      throw new Error('slack writer: a bot token is required');
    }
    this.token = token;
    this.classifyTransportFailure = config.classifyTransportFailure ?? failSafeConnectorWriteTransportClassifier;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = resolveConnectorQueryTimeoutMs(config.timeoutMs, 'slack writer');
    const channels = Array.isArray(config.channels) ? config.channels : [];
    if (channels.length === 0) throw new Error('slack writer: a non-empty channel allowlist is required');
    const ids = new Set<string>();
    const byName = new Map<string, string>();
    for (const channel of channels) {
      if (typeof channel?.id !== 'string' || !CHANNEL_ID.test(channel.id)) {
        throw new Error('slack writer: every allowlisted channel needs a valid channel id');
      }
      ids.add(channel.id);
      if (channel.name !== undefined) {
        if (typeof channel.name !== 'string' || !CHANNEL_NAME.test(channel.name)) {
          throw new Error('slack writer: an allowlisted channel name is invalid');
        }
        const known = byName.get(channel.name);
        if (known !== undefined && known !== channel.id) {
          throw new Error('slack writer: an allowlisted channel name maps to two ids');
        }
        byName.set(channel.name, channel.id);
      }
    }
    this.ids = ids;
    this.byName = byName;
  }

  resolveChannel(channel: string): string | undefined {
    if (typeof channel !== 'string') return undefined;
    const trimmed = channel.trim();
    if (this.ids.has(trimmed)) return trimmed;
    const name = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();
    return this.byName.get(name);
  }

  async post(request: ChannelMessageRequest): Promise<ConnectorWriteOutcome> {
    const channelId = this.resolveChannel(request?.channel);
    if (channelId === undefined) return connectorWriteNotSent('TARGET_NOT_ALLOWED');
    if (!isValidConnectorWriteText(request.text)) return connectorWriteNotSent('INVALID_REQUEST');

    let response: Response;
    try {
      response = await this.fetchImpl(new URL('/api/chat.postMessage', SLACK_API_ORIGIN), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          text: escapeSlackText(request.text),
          mrkdwn: false,
          parse: 'none',
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // NOT_SENT only with connection-stage evidence that it never reached Slack (UNC-1); otherwise UNCERTAIN.
      return this.classifyTransportFailure(error);
    }

    if (response.status === 429) {
      await discardBody(response);
      return connectorWriteNotSent('RATE_LIMITED');
    }
    if (!response.ok) {
      await discardBody(response);
      if (response.status >= 500 || response.status < 400) return connectorWriteUncertain('SERVER_ERROR');
      if (response.status === 401) return connectorWriteNotSent('UNAUTHORIZED');
      if (response.status === 403) return connectorWriteNotSent('FORBIDDEN');
      if (response.status === 404) return connectorWriteNotSent('NOT_FOUND');
      return connectorWriteNotSent('REJECTED');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return connectorWriteUncertain('INVALID_RESPONSE');
    }
    if (!isRecord(payload) || typeof payload.ok !== 'boolean') return connectorWriteUncertain('INVALID_RESPONSE');
    if (!payload.ok) return failedPost(payload.error);
    const ts = payload.ts;
    if (typeof ts !== 'string' || !MESSAGE_TS.test(ts)) return connectorWriteUncertain('INVALID_RESPONSE');
    return connectorWriteSent(`${channelId}:${ts}`, await this.permalink(channelId, ts));
  }

  /** Best effort, after the message is already posted: a failure only means no link. Never affects the outcome. */
  private async permalink(channelId: string, ts: string): Promise<string | undefined> {
    try {
      const url = new URL('/api/chat.getPermalink', SLACK_API_ORIGIN);
      url.searchParams.set('channel', channelId);
      url.searchParams.set('message_ts', ts);
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await discardBody(response);
        return undefined;
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.ok !== true || typeof payload.permalink !== 'string') return undefined;
      return PERMALINK.test(payload.permalink) ? payload.permalink : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Slack's three control characters are escaped so the text shows exactly as written. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function failedPost(error: unknown): ConnectorWriteOutcome {
  if (typeof error !== 'string') return connectorWriteUncertain('UNKNOWN');
  if (Object.prototype.hasOwnProperty.call(NOT_SENT_ERRORS, error)) {
    return connectorWriteNotSent(NOT_SENT_ERRORS[error] as ConnectorWriteNotSentReason);
  }
  if (['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable'].includes(error)) {
    return connectorWriteUncertain('SERVER_ERROR');
  }
  return connectorWriteUncertain('UNKNOWN');
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore: the body is never read
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
