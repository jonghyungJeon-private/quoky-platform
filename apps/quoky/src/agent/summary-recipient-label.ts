import type { AiProvider } from '@quoky/core';

/**
 * ADR-0121 rule ① (CS-1a): the recipient's display name of a `REMOTE` summary provider, the question's `{remote}`. A closed
 * table over the provider family (`family`, else `id`), owned here because only the composition root may know provider
 * families; Core never branches on an id. A provider the table does not know has no name: `undefined`, so Core excludes it
 * from a remote summary (fail closed) and no question can name it. The name is the product name the owner knows
 * (precedent: the owner's own example, "Claude").
 */
const RECIPIENT_BY_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  'claude-cli': 'Claude',
  'codex-cli': 'Codex',
  'openai-api': 'OpenAI',
  'gemini-api': 'Gemini',
});

export function summaryRecipientLabel(provider: Pick<AiProvider, 'id' | 'family'>): string | undefined {
  try {
    const key = provider.family ?? provider.id;
    return typeof key === 'string' && Object.hasOwn(RECIPIENT_BY_FAMILY, key) ? RECIPIENT_BY_FAMILY[key] : undefined;
  } catch {
    return undefined;
  }
}
