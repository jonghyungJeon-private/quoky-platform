import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';

/**
 * The shape of a Telegram bot token (BotFather): the bot's numeric user id, a colon, then the secret part. The id prefix
 * is public (it is the bot's user id); the whole token is a secret.
 */
const BOT_TOKEN = /^([1-9][0-9]{4,15}):[A-Za-z0-9_-]{30,64}$/u;

/** Whether `raw` is a well-formed bot token (the value is never echoed). */
export function isWellFormedTelegramBotToken(raw: unknown): raw is string {
  return typeof raw === 'string' && BOT_TOKEN.test(raw);
}

/**
 * Every token-shaped span (`<id>:<secret>`, also inside a `/bot<token>/` URL path) replaced by `[REDACTED]`. Defence in
 * depth for any text that might leave the adapter (an error message, a log field): the adapter's own failures never
 * carry the URL or the token, and this keeps a foreign error that does from leaking it.
 */
export function redactTelegramToken(text: string): string {
  return text.replace(/(bot)?[0-9]{5,16}:[A-Za-z0-9_-]{30,}/gu, (_match, bot: string | undefined) => `${bot ?? ''}${REDACTED}`);
}

/**
 * The Telegram bot token as a secret holder (ADR-0114 D5; the `OpenAiApiKey` precedent of ADR-0115 D6). The value lives
 * in a true private field: it is not an own enumerable property, so `JSON.stringify`, `util.inspect`, object spread and
 * `Object.values` of the holder, or of any configuration object that carries it, show only `[REDACTED]`. Only the Bot
 * API client calls {@link reveal}, to build the request path to the pinned host.
 */
export class TelegramBotToken {
  readonly #value: string;
  readonly #botId: string;

  private constructor(value: string, botId: string) {
    this.#value = value;
    this.#botId = botId;
  }

  /** A holder for a well-formed token, or `null` (the value is never echoed). */
  static from(raw: unknown): TelegramBotToken | null {
    if (!isWellFormedTelegramBotToken(raw)) return null;
    const botId = BOT_TOKEN.exec(raw)?.[1];
    return botId === undefined ? null : new TelegramBotToken(raw, botId);
  }

  /** The bot user id the token names (its public prefix). */
  get botId(): string {
    return this.#botId;
  }

  /** The token itself. For the Bot API request path only. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `TelegramBotToken(${REDACTED})`;
  }
}
