import { Capability } from '@quoky/core';

/**
 * The owner's runtime model switch (ADR-0092 amendment, runtime switching) — the bounded choice vocabulary.
 *
 * This is composition-root data: the concrete provider names live here and in the catalog, never in Core. Core sees
 * only the policy's opaque keys (`ProviderSelectionPolicy`).
 *
 * - **Chat tier** (`GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS`, `READONLY_LOOKUP`): `claude` (optionally one of
 *   the {@link CLAUDE_MODEL_ALIASES}), `codex` (the configured `QUOKY_CODEX_MODEL` or the CLI default; no per-choice
 *   model), or `ollama` (optionally a model from the local `ollama list`).
 * - **Image understanding**: `claude` (cloud, Anthropic), `codex` (cloud, OpenAI), `ollama` (the configured local vision
 *   model) or `off`.
 * - **Never switched** ({@link CLAUDE_PINNED_CAPABILITIES}): code, review, planning, project analysis, tests and
 *   policy-sensitive chat stay on Claude exactly as the ADR-0092 amendment says.
 */

export const CHAT_TIER_CAPABILITIES: readonly Capability[] = Object.freeze([
  Capability.GENERAL_CHAT,
  Capability.SUMMARIZATION,
  Capability.DOCUMENT_ANALYSIS,
  Capability.READONLY_LOOKUP,
]);

export const CLAUDE_PINNED_CAPABILITIES: readonly Capability[] = Object.freeze([
  Capability.CODE_IMPLEMENTATION,
  Capability.CODE_REVIEW,
  Capability.ARCHITECTURE_PLANNING,
  Capability.PROJECT_ANALYSIS,
  Capability.TEST_EXECUTION,
  Capability.POLICY_SENSITIVE_CHAT,
]);

/** The Claude models a choice may name (the alias style `QUOKY_CLAUDE_MODEL` accepts). */
export const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku'] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

export const CHAT_PROVIDER_NAMES = ['claude', 'codex', 'ollama'] as const;
export type ChatProviderName = (typeof CHAT_PROVIDER_NAMES)[number];

export const IMAGE_CHOICES = ['claude', 'codex', 'ollama', 'off'] as const;
export type ImageChoice = (typeof IMAGE_CHOICES)[number];

/**
 * A chat-tier choice. An absent `model` means the configured default of that provider (`QUOKY_CLAUDE_MODEL`,
 * `OLLAMA_MODEL`); Codex always uses `QUOKY_CODEX_MODEL` or the CLI default.
 */
export type ChatChoice =
  | { readonly provider: 'claude'; readonly model?: string }
  | { readonly provider: 'codex' }
  | { readonly provider: 'ollama'; readonly model?: string };

/** Where an effective selection came from, highest precedence first. */
export const SELECTION_SOURCES = ['session', 'persisted', 'env', 'default'] as const;
export type SelectionSource = (typeof SELECTION_SOURCES)[number];

export type ChatChoiceParse =
  | { readonly ok: true; readonly choice: ChatChoice }
  | { readonly ok: false; readonly reason: 'UNKNOWN_PROVIDER' | 'CLAUDE_MODEL_NOT_ALLOWED' | 'CODEX_MODEL_NOT_ALLOWED' | 'MODEL_INVALID' };

/** A bounded Ollama model name (a safe fixed argv element); validated against `ollama list` at selection time. */
const OLLAMA_MODEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

/**
 * `claude`, `claude:<alias>`, `codex`, `ollama`, `ollama:<model>` (provider names case-insensitive; an Ollama model
 * name is kept as typed). Anything else is refused with a reason code; nothing here touches the host.
 */
export function parseChatChoiceToken(raw: string): ChatChoiceParse {
  const token = raw.trim();
  const colon = token.indexOf(':');
  const provider = (colon < 0 ? token : token.slice(0, colon)).toLowerCase();
  const model = colon < 0 ? undefined : token.slice(colon + 1);
  if (provider === 'claude') {
    if (model === undefined) return { ok: true, choice: { provider: 'claude' } };
    const alias = model.toLowerCase();
    return (CLAUDE_MODEL_ALIASES as readonly string[]).includes(alias)
      ? { ok: true, choice: { provider: 'claude', model: alias } }
      : { ok: false, reason: 'CLAUDE_MODEL_NOT_ALLOWED' };
  }
  if (provider === 'codex') {
    return model === undefined ? { ok: true, choice: { provider: 'codex' } } : { ok: false, reason: 'CODEX_MODEL_NOT_ALLOWED' };
  }
  if (provider === 'ollama') {
    if (model === undefined) return { ok: true, choice: { provider: 'ollama' } };
    if (!OLLAMA_MODEL_SHAPE.test(model) || /cloud/i.test(model)) return { ok: false, reason: 'MODEL_INVALID' };
    return { ok: true, choice: { provider: 'ollama', model } };
  }
  return { ok: false, reason: 'UNKNOWN_PROVIDER' };
}

export function parseImageChoiceToken(raw: string): ImageChoice | null {
  const token = raw.trim().toLowerCase();
  return (IMAGE_CHOICES as readonly string[]).includes(token) ? (token as ImageChoice) : null;
}

/** Validate a stored chat choice (persisted file or session metadata); anything malformed is `null`. */
export function chatChoiceFromData(value: unknown): ChatChoice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { provider, model } = value as { provider?: unknown; model?: unknown };
  if (typeof provider !== 'string') return null;
  if (model !== undefined && typeof model !== 'string') return null;
  const parsed = parseChatChoiceToken(model === undefined ? provider : `${provider}:${model}`);
  return parsed.ok && parsed.choice.provider === provider ? parsed.choice : null;
}

export function imageChoiceFromData(value: unknown): ImageChoice | null {
  return typeof value === 'string' && (IMAGE_CHOICES as readonly string[]).includes(value) ? (value as ImageChoice) : null;
}

/** The plain-data form stored in the persisted file and in session metadata. */
export function chatChoiceToData(choice: ChatChoice): { provider: ChatProviderName; model?: string } {
  return 'model' in choice && choice.model !== undefined
    ? { provider: choice.provider, model: choice.model }
    : { provider: choice.provider };
}

export const IMAGE_CHOICE_LOCALITY: Readonly<Record<ImageChoice, 'LOCAL' | 'REMOTE' | 'NONE'>> = {
  claude: 'REMOTE',
  codex: 'REMOTE',
  ollama: 'LOCAL',
  off: 'NONE',
};

/** Where image bytes go under each choice (the egress note in replies and the operations UI). */
export const IMAGE_CHOICE_EGRESS: Readonly<Record<ImageChoice, 'LOCAL' | 'ANTHROPIC' | 'OPENAI' | 'NONE'>> = {
  claude: 'ANTHROPIC',
  codex: 'OPENAI',
  ollama: 'LOCAL',
  off: 'NONE',
};

/** Whether the image choice sends image bytes off this host (the locality policy allows `REMOTE` only then). */
export function imageChoiceIsCloud(choice: ImageChoice): boolean {
  return IMAGE_CHOICE_LOCALITY[choice] === 'REMOTE';
}

/** Whether the choice sends content off this host (the egress note in replies and the operations UI). */
export function chatChoiceIsCloud(choice: ChatChoice): boolean {
  return choice.provider !== 'ollama';
}
