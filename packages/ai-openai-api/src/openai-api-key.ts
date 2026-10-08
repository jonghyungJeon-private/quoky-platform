import { inspect } from 'node:util';
import { isWellFormedOpenAiApiKey } from './openai-api-config';

const REDACTED = '[REDACTED]';

/**
 * The OpenAI API key as a secret holder (ADR-0115 D6). The value lives in a true private field: it is not an own
 * enumerable property, so `JSON.stringify`, `util.inspect`, object spread and `Object.values` of the holder — or of any
 * configuration object that carries it — show only `[REDACTED]`. Only the adapter calls {@link reveal}, to build the
 * `Authorization` header.
 */
export class OpenAiApiKey {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /** A holder for a well-formed key, or `null` (the value is never echoed). */
  static from(raw: unknown): OpenAiApiKey | null {
    return isWellFormedOpenAiApiKey(raw) ? new OpenAiApiKey(raw) : null;
  }

  /** The key itself. For the adapter's request header only. */
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
    return `OpenAiApiKey(${REDACTED})`;
  }
}
