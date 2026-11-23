import type { NlWave1EntryId } from '../nl-routing/catalog';
import { neutralizeLinks } from '../link-neutralizer';
import { normalizeUntrustedText } from '../untrusted-document-readout';
import { pseudonymLabel, pseudonymiseParticipants, type WorkItemParticipant } from '../participant-pseudonyms';

/**
 * ADR-0121 amendment A5.2 (slice A5-S1): the field projection of the five work sources' summary readout, taken from the
 * listing read's OWN response and nothing else. Pure, total and offline.
 *
 * - **A closed field table per entry** ({@link WORK_SUMMARY_FIELDS}, the SR-1 field names). A member of a listed item that is
 *   not in the table is never read: comments, threads, attachments, links, names and any other field cannot reach a prompt,
 *   whatever the read port hands over. A field the listing response does not carry is omitted, never fetched: this module
 *   makes no request and takes no port.
 * - **Bounds.** A title is at most {@link WORK_SUMMARY_TITLE_MAX_CHARS} and every other text field at most
 *   {@link WORK_SUMMARY_FIELD_MAX_CHARS} code points, one line, normalised and link-neutralised (the ADR-0100 D8 bounds);
 *   `buildUntrustedDocumentReadout` later runs the credential guard on the result and withholds a credential-shaped item whole.
 * - **People are pseudonyms.** A person field of a listed item (`author`, `assignee`, `reporter`, `organizer`, `people`,
 *   `attendees`) is read ONLY to name the participants: the Slack author is sent as "참여자 A, B, ..." (order of first
 *   appearance in the listing, A6 R2 D5) and a participant's handle inside a sent text is replaced by the same pseudonym
 *   (the A3a record, answer 5, for GitHub). No other person field is sent.
 * - The item id is structural: it is the document's `id` (the executor checks it against the projector's slot) and is never
 *   in the prompt. Dates are Core facts and are not sent (`date` is empty).
 */

/** One projected item, structurally an `AgentSourceDocument` (this module does not import the summariser). */
export interface ProjectedWorkDocument {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly author: string;
  readonly date: string;
  readonly body: string;
}

export const WORK_SUMMARY_TITLE_MAX_CHARS = 200;
export const WORK_SUMMARY_FIELD_MAX_CHARS = 300;

interface TextField {
  readonly field: string;
  /** A fixed label written by Core in front of the field's text (never content). */
  readonly label?: string;
}

interface FieldSpec {
  /** The member sent as the title. */
  readonly title?: string;
  /** The members sent as the body, in order. */
  readonly text: readonly TextField[];
  /** The member whose handle is sent as a pseudonym (Slack's author). */
  readonly author?: string;
}

/** The A5.2 table: what is sent to M2 per source entry (SR-1 field names). */
export const WORK_SUMMARY_FIELDS: Readonly<Partial<Record<NlWave1EntryId, FieldSpec>>> = Object.freeze({
  'calendar.events': Object.freeze({ title: 'title', text: Object.freeze([{ field: 'location', label: 'Location' }, { field: 'description', label: 'Description' }]) }),
  'jira.issues': Object.freeze({ title: 'summary', text: Object.freeze([{ field: 'description' }]) }),
  // A release-items listing carries no description: `summary` only.
  'jira.release': Object.freeze({ title: 'summary', text: Object.freeze([]) }),
  'slack.search': Object.freeze({ text: Object.freeze([{ field: 'text' }]), author: 'author' }),
  'confluence.search': Object.freeze({ title: 'title', text: Object.freeze([{ field: 'body' }]) }),
  'github.items': Object.freeze({ title: 'title', text: Object.freeze([{ field: 'body' }]) }),
});

/** The members read host-side to name the participants (never sent, except the pseudonym of the Slack author). */
const PERSON_FIELDS: readonly string[] = Object.freeze(['author', 'assignee', 'reporter', 'organizer', 'people', 'attendees']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handlesOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => (typeof entry === 'string' && entry.trim().length >= 2 ? [entry.trim()] : []));
}

/** The participants of one listing, in order of first appearance (a pseudonym per distinct handle). */
function participantsOf(items: readonly unknown[]): WorkItemParticipant[] {
  const handles: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    for (const field of PERSON_FIELDS) {
      for (const handle of handlesOf(item[field])) if (!handles.includes(handle)) handles.push(handle);
    }
  }
  return handles.map((handle, index) => ({ handle, label: pseudonymLabel(index) }));
}

function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

/** One field as one bounded line: normalised, link-neutralised, handles pseudonymised, whitespace collapsed, clipped. */
function oneLine(value: unknown, max: number, participants: readonly WorkItemParticipant[]): string {
  if (typeof value !== 'string') return '';
  const line = neutralizeLinks(normalizeUntrustedText(value), 'display').replace(/\s+/g, ' ').trim();
  return clip(pseudonymiseParticipants(line, participants), max);
}

/**
 * The documents a summarize step reads from one listing response: one per listed item, at its 1-based listing position,
 * with the item's own id. A row that is not a plain object or has no string id is skipped (its position stays empty, as the
 * projector's slots do). An entry with no table yields none. Total: never throws.
 */
export function projectWorkSummaryDocuments(entryId: NlWave1EntryId, items: unknown): readonly ProjectedWorkDocument[] {
  const spec = WORK_SUMMARY_FIELDS[entryId];
  if (spec === undefined || !Array.isArray(items)) return [];
  const documents: ProjectedWorkDocument[] = [];
  try {
    const participants = participantsOf(items);
    const labelOf = new Map(participants.map((participant) => [participant.handle, participant.label]));
    items.forEach((item: unknown, index) => {
      try {
        if (!isRecord(item) || typeof item.id !== 'string') return;
        const title = spec.title === undefined ? '' : oneLine(item[spec.title], WORK_SUMMARY_TITLE_MAX_CHARS, participants);
        const lines = spec.text.flatMap((entry) => {
          const text = oneLine(item[entry.field], WORK_SUMMARY_FIELD_MAX_CHARS, participants);
          return text.length === 0 ? [] : [entry.label === undefined ? text : `${entry.label}: ${text}`];
        });
        // An item with only a title (a release item, an event without a description) is summarised from the title.
        const body = lines.length > 0 ? lines.join('\n') : title;
        const handle = spec.author === undefined ? undefined : handlesOf(item[spec.author])[0];
        const author = handle === undefined ? '' : (labelOf.get(handle) ?? '');
        documents.push({ id: item.id, position: index + 1, title, author, date: '', body });
      } catch {
        // A malformed row is skipped; the executor counts the gap as omitted.
      }
    });
  } catch {
    return [];
  }
  return documents;
}
