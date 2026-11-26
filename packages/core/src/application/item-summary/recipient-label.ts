/**
 * ADR-0121 amendment A8.4 (OQ1-1): the ONE shape check for a recipient display label, shared by `recipientVerdict` (a label that
 * fails it is `unnamed`) and the recipient-line renderer, so an `expected` verdict always renders a line. One short printable line:
 * no outer blanks, at most 40 code points, no control, format, separator (other than the plain space) or combining characters.
 * Pure; imports nothing (the item-summary/ invariants test).
 */
export const RECIPIENT_LABEL_MAX_CODE_POINTS = 40;

export function isRenderableRecipientLabel(label: unknown): label is string {
  try {
    if (typeof label !== 'string' || label.length === 0 || label !== label.trim()) return false;
    if ([...label].length > RECIPIENT_LABEL_MAX_CODE_POINTS) return false;
    return !/[\p{C}\p{Z}\p{M}]/u.test(label.replace(/ /gu, ''));
  } catch {
    return false;
  }
}
