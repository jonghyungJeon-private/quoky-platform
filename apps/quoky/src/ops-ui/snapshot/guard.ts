import { learningTextHasCredential } from '@quoky/core';

import type { OpsLink, OpsPanelView, OpsTable, OpsViewModel } from '../http/view-model';

/**
 * ADR-0113 D5: every string that enters the view model passes the ADR-0097 strict credential guard (the chat-text
 * detector plus the file-content detector, as ADR-0107 D1 runs it) here, in `snapshot/*`. A match becomes the fixed
 * {@link OPS_HIDDEN} marker — never a redacted copy. Strings are also bounded so no field can carry a long body.
 */

export const OPS_HIDDEN = '[hidden]';
/** Upper bound on any one displayed string, in code points. */
export const OPS_MAX_STRING_CHARS = 160;

export function guardText(value: string): string {
  if (learningTextHasCredential(value)) return OPS_HIDDEN;
  const chars = Array.from(value);
  return chars.length <= OPS_MAX_STRING_CHARS ? value : `${chars.slice(0, OPS_MAX_STRING_CHARS - 1).join('')}…`;
}

function guardLink(link: OpsLink): OpsLink {
  return { label: guardText(link.label), href: guardText(link.href) };
}

function guardTable(table: OpsTable): OpsTable {
  return {
    columns: table.columns.map(guardText),
    rows: table.rows.map((row) => row.map(guardText)),
    emptyText: guardText(table.emptyText),
    ...(table.rowLinks !== undefined ? { rowLinks: table.rowLinks.map((link) => (link === null ? null : guardLink(link))) } : {}),
  };
}

function guardPanel(panel: OpsPanelView): OpsPanelView {
  return {
    id: guardText(panel.id),
    title: guardText(panel.title),
    state: panel.state,
    ...(panel.errorCode !== undefined ? { errorCode: guardText(panel.errorCode) } : {}),
    fields: panel.fields.map((field) => ({ label: guardText(field.label), value: guardText(field.value) })),
    ...(panel.table !== undefined ? { table: guardTable(panel.table) } : {}),
    notes: panel.notes.map(guardText),
    ...(panel.links !== undefined ? { links: panel.links.map(guardLink) } : {}),
  };
}

/** The final pass over the whole view model: no string reaches `http/*` without the guard. */
export function guardViewModel(view: OpsViewModel): OpsViewModel {
  return { generatedAt: guardText(view.generatedAt), panels: view.panels.map(guardPanel) };
}
