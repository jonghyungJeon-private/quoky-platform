/**
 * Inbound addressing normalization (ADR-0114 TG-1; the PLT-0 residual that moved inbound mention parsing out of Core's
 * `hasEffectiveText`). Discord addressing tokens — user, nickname and role mentions and channel references (`<@id>`,
 * `<@!id>`, `<@&id>`, `<#id>`, `<#C1|name>`) — say who is addressed, not what is asked. Core no longer knows any
 * platform's mention syntax; the adapter normalizes an attachment message whose text is addressing alone to the empty
 * text, so Core's "no text next to an unusable attachment" rule sees exactly what it saw before.
 *
 * Only attachment messages are normalized: every other message text reaches Core byte-identical, as before.
 */
const ADDRESSING_TOKEN = /<[@#][!&]?[A-Za-z0-9]+(?:\|[^<>\n]*)?>/gu;
/** Whitespace, format, default-ignorable and control characters. */
const NON_CONTENT = /[\s\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cc}]/gu;

/** Whether `text` holds at least one addressing token and nothing else but invisible characters. */
export function isAddressingOnly(text: string): boolean {
  const tokens = text.match(ADDRESSING_TOKEN);
  return tokens !== null && text.replace(ADDRESSING_TOKEN, '').replace(NON_CONTENT, '').length === 0;
}

/** The text Core receives for a message: `''` for an attachment message whose text is addressing alone, else as sent. */
export function normalizeInboundText(text: string, hasAttachments: boolean): string {
  return hasAttachments && isAddressingOnly(text) ? '' : text;
}
