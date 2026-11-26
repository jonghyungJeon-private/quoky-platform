/**
 * ADR-0121 amendment A8.4 (OQ1-1): the fixed recipient line that ends a reply carrying a model summary of a live item that went
 * to a REMOTE recipient: "· {label}로 요약" / "· summarised by {label}". The label is the recipient's display name from the
 * composition root's closed label table (never a model output or owner text); Core checks only its shape ({@link isRenderableRecipientLabel}, one short printable
 * line) and renders `''` for anything else, so no content or id can ride on the line. Not wired anywhere yet (OQ1-2).
 */
import { isRenderableRecipientLabel } from './recipient-label';

const PREFIX = {
  ko: '· ',
  en: '· summarised by ',
} as const;
const SUFFIX = {
  ko: '로 요약',
  en: '',
} as const;

export function renderItemSummaryRecipientLine(label: string, language: 'ko' | 'en'): string {
  try {
    if (language !== 'ko' && language !== 'en') return '';
    if (!isRenderableRecipientLabel(label)) return '';
    return `${PREFIX[language]}${label}${SUFFIX[language]}`;
  } catch {
    return '';
  }
}
