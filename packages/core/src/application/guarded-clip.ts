import { containsCredentialMaterial } from './credential-guard';
import { neutralizeLinks } from './link-neutralizer';
import { untrustedText, type MessagePart } from './message-rendering';

/**
 * One shared clip-and-guard for owner-visible untrusted text (listing names, senders, subjects, snippets and the echoed
 * query; ADR-0118, CA review P2-1). Single spaces, cut at `maxChars` with a `…`.
 */
export function clip(text: string, maxChars: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * The placeholder when the full value, the normalized text or the CLIPPED text is credential-shaped; else the text with
 * its links replaced (checked again after the clip: a cut can create `evil.com` from `evil.com1`, or an `AKIA…` key
 * from `AKIA…z`), as an `untrusted` span. A trailing `…` is the clip marker (the normalized text never holds one) and is
 * kept out of the re-check, because NFKC would turn it into `...`.
 */
export function guardedClippedSpan(value: string, maxChars: number, placeholder: string): MessagePart {
  if (value.trim().length > 0 && containsCredentialMaterial(value)) return placeholder;
  const shown = neutralizeLinks(value, 'display');
  if (shown.trim().length > 0 && containsCredentialMaterial(shown)) return placeholder;
  const cut = clip(shown, maxChars);
  const marker = cut.endsWith('…') ? '…' : '';
  const body = neutralizeLinks(marker === '' ? cut : cut.slice(0, -1), 'display');
  if (body.trim().length > 0 && containsCredentialMaterial(body)) return placeholder;
  return untrustedText(`${body}${marker}`);
}
