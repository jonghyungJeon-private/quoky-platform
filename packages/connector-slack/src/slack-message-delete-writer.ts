import {
  connectorWriteNotSent,
  connectorWriteSent,
  connectorWriteUncertain,
  type ChannelMessageDeleteRequest,
  type ChannelMessageDeleteWriter,
  type ConnectorWriteNotSentReason,
  type ConnectorWriteOutcome,
  type ConnectorWriteTransportGuard,
} from '@quoky/core';
import {
  SLACK_API_ORIGIN,
  SLACK_CHANNEL_ID,
  SLACK_MESSAGE_TS,
  discardBody,
  isRecord,
  slackWriteSettings,
  type SlackChannelWriterConfig,
} from './slack-channel-writer';

/**
 * Slack message delete adapter (ADR-0112 amendment 1 S1, ratified 2026-10-15; reachable under amendment 3 O1): ONE
 * `POST /api/chat.delete` with `{ channel, ts }` on the same host as the post (`https://slack.com`), with the same bot token
 * (`chat:write`, posting as the app) and the same channel allowlist as `SlackChannelWriter` (one shared validation). Never
 * `as_user`. A separate class: the post port is not widened. Slack lets a bot token delete only that bot's own messages.
 *
 * No read happens first: the token has no history scope (owner decision S-4), so the adapter cannot see whether the message
 * was edited or has replies. One request with a timeout and redirects refused; no retry. A thrown request is classified by
 * the injected `transportGuard` (UNC-1). Nothing is logged, and no outcome carries the token, the message or a response body.
 */

/** ADR-0112 amendment 1 S6: Slack API errors that certainly mean the message was not deleted. Anything unknown is UNCERTAIN. */
const NOT_SENT_ERRORS: Readonly<Record<string, ConnectorWriteNotSentReason>> = {
  // Already gone (deleted by hand in Slack, or never there): nothing left to undo.
  message_not_found: 'NOT_FOUND',
  channel_not_found: 'NOT_FOUND',
  invalid_channel_id: 'NOT_FOUND',
  // Slack refuses to delete it (another app's message, a workspace policy or a retention / export rule).
  cant_delete_message: 'FORBIDDEN',
  compliance_exports_prevent_deletion: 'FORBIDDEN',
  not_in_channel: 'FORBIDDEN',
  restricted_action: 'FORBIDDEN',
  ekm_access_denied: 'FORBIDDEN',
  team_access_not_granted: 'FORBIDDEN',
  no_permission: 'FORBIDDEN',
  access_denied: 'FORBIDDEN',
  is_archived: 'REJECTED',
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

/** Errors Slack documents as "the request may have been partly processed": UNCERTAIN, never retried. */
const SERVER_ERRORS: ReadonlySet<string> = new Set(['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable']);

export class SlackMessageDeleteWriter implements ChannelMessageDeleteWriter {
  readonly source = 'slack';

  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly transportGuard: ConnectorWriteTransportGuard;
  private readonly ids: ReadonlySet<string>;

  /** The same configuration as `SlackChannelWriter` (`QUOKY_CONNECTOR_WRITE_SLACK_*`): bound exactly when the post writer is. */
  constructor(config: SlackChannelWriterConfig) {
    const settings = slackWriteSettings(config);
    this.token = settings.token;
    this.fetchImpl = settings.fetchImpl;
    this.timeoutMs = settings.timeoutMs;
    this.transportGuard = settings.transportGuard;
    this.ids = settings.ids;
  }

  allowsChannelId(channelId: string): boolean {
    return typeof channelId === 'string' && SLACK_CHANNEL_ID.test(channelId) && this.ids.has(channelId);
  }

  async deleteMessage(request: ChannelMessageDeleteRequest): Promise<ConnectorWriteOutcome> {
    const channelId = request?.channelId;
    const ts = request?.ts;
    if (typeof channelId !== 'string' || !this.allowsChannelId(channelId)) return connectorWriteNotSent('TARGET_NOT_ALLOWED');
    if (typeof ts !== 'string' || !SLACK_MESSAGE_TS.test(ts)) return connectorWriteNotSent('INVALID_REQUEST');

    let response: Response;
    const deleteUrl = new URL('/api/chat.delete', SLACK_API_ORIGIN);
    const attempt = this.transportGuard.begin(deleteUrl);
    try {
      response = await this.fetchImpl(deleteUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        // Exactly the two values from the post receipt; never `as_user`.
        body: JSON.stringify({ channel: channelId, ts }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // NOT_SENT only when no request bytes reached Slack on any connection of this attempt (UNC-1); else UNCERTAIN.
      return attempt.classifyFailure(error);
    } finally {
      attempt.end();
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
    if (!payload.ok) return failedDelete(payload.error);
    // A success must name the very message that was asked for; anything else is unreadable (UNCERTAIN, never retried).
    if (payload.channel !== channelId || payload.ts !== ts) return connectorWriteUncertain('INVALID_RESPONSE');
    return connectorWriteSent(`${channelId}:${ts}`);
  }
}

function failedDelete(error: unknown): ConnectorWriteOutcome {
  if (typeof error !== 'string') return connectorWriteUncertain('UNKNOWN');
  if (Object.prototype.hasOwnProperty.call(NOT_SENT_ERRORS, error)) {
    return connectorWriteNotSent(NOT_SENT_ERRORS[error] as ConnectorWriteNotSentReason);
  }
  if (SERVER_ERRORS.has(error)) return connectorWriteUncertain('SERVER_ERROR');
  return connectorWriteUncertain('UNKNOWN');
}
