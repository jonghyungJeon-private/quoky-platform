import type { NlWave1EntryId } from '../nl-routing/catalog';
import { neutralizeLinks } from '../link-neutralizer';
import { isUntrustedTextCredentialShaped, normalizeUntrustedText } from '../untrusted-document-readout';
import { pseudonymLabel, pseudonymiseParticipants, type WorkItemParticipant } from '../participant-pseudonyms';

/**
 * ADR-0121 amendment A5.2 (slice A5-S1): the field projection of the five work sources' summary readout, taken from the
 * listing read's OWN response and nothing else. Pure, total and offline.
 *
 * - **A typed raw item per entry** ({@link AgentCalendarSummaryItem}, {@link AgentExcerptSummaryItem},
 *   {@link AgentSlackSummaryItem}), pinned at compile time, and a closed field table
 *   ({@link WORK_SUMMARY_FIELDS}). The read port maps its `ConnectorItem` explicitly: `ConnectorItem.title` is `title`,
 *   `ConnectorItem.summary` (the listing's excerpt, NOT the title) is `excerpt`, every person is a handle in `people`. A member
 *   of a listed item that is not in the type is never read: comments, threads, attachments, links, names and any other
 *   field cannot reach a prompt, whatever the read port hands over.
 * - **Credentials first.** The strict credential guard runs on every COMPLETE, untransformed field (and on the joined text)
 *   before any normalising, pseudonymising or clipping; a match withholds the whole item (never redacted, never clipped
 *   to a prefix) and it is counted in `withheld`. A field the listing response does not carry is omitted, never fetched: this module
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

/** The calendar event of `calendar.events` read with the agent-summary mask (maps `CalendarEventSummaryFields`). */
export interface AgentCalendarSummaryItem {
  readonly id: string;
  readonly title?: string;
  readonly location?: string;
  readonly description?: string;
  /** Organizer and attendees as handles: read only to pseudonymise, never sent. */
  readonly people?: readonly string[];
}

/** A Jira, Confluence or GitHub listing item (maps `ConnectorItem`: `title` is the title, `summary` is the `excerpt`). */
export interface AgentExcerptSummaryItem {
  readonly id: string;
  readonly title?: string;
  readonly excerpt?: string;
  /** Assignee, reporter, author, reviewers as handles: read only to pseudonymise, never sent. */
  readonly people?: readonly string[];
}

/** A Slack search hit: the matched message text and its author handle (sent only as a pseudonym). */
export interface AgentSlackSummaryItem {
  readonly id: string;
  readonly text?: string;
  readonly author?: string;
  readonly people?: readonly string[];
}

export type AgentWorkSummaryRawItem = AgentCalendarSummaryItem | AgentExcerptSummaryItem | AgentSlackSummaryItem;

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
  /** Slack: the author member, sent as a pseudonym. */
  readonly author?: boolean;
}

/** A field spec whose member names are keys of the typed item `T`: renaming a member of the interface breaks the compile. */
function specOf<T>(spec: { readonly title?: keyof T & string; readonly text: readonly { readonly field: keyof T & string; readonly label?: string }[]; readonly author?: boolean }): FieldSpec {
  return Object.freeze({ ...spec, text: Object.freeze([...spec.text]) });
}

/** The A5.2 table: what is sent to M2 per source entry, by the typed member names above. */
export const WORK_SUMMARY_FIELDS: Readonly<Partial<Record<NlWave1EntryId, FieldSpec>>> = Object.freeze({
  'calendar.events': specOf<AgentCalendarSummaryItem>({ title: 'title', text: [{ field: 'location', label: 'Location' }, { field: 'description', label: 'Description' }] }),
  'jira.issues': specOf<AgentExcerptSummaryItem>({ title: 'title', text: [{ field: 'excerpt' }] }),
  // A release-items listing carries no description: the summary (title) only.
  'jira.release': specOf<AgentExcerptSummaryItem>({ title: 'title', text: [] }),
  'slack.search': specOf<AgentSlackSummaryItem>({ text: [{ field: 'text' }], author: true }),
  'confluence.search': specOf<AgentExcerptSummaryItem>({ title: 'title', text: [{ field: 'excerpt' }] }),
  'github.items': specOf<AgentExcerptSummaryItem>({ title: 'title', text: [{ field: 'excerpt' }] }),
});

/** The members read host-side to name the participants. */
const PERSON_FIELDS: readonly string[] = Object.freeze(['author', 'people']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A handle is normalised exactly as the text it is looked for in (NFKC, invisible characters removed): a fullwidth handle matches. */
function handlesOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => {
    const handle = typeof entry === 'string' ? normalizeUntrustedText(entry).trim() : '';
    return handle.length >= 2 ? [handle] : [];
  });
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

/**
 * ADR-0121 A7 (A7-S4a, a7-08): the host-only map of one listing's pseudonyms back to the names the listing itself carried, for the
 * drafter's remap. The same participants (same handles, same order, same labels) the documents were pseudonymised with. Never in a
 * prompt, a log or an audit record. Total.
 */
export function workSummaryParticipants(items: unknown): readonly { readonly label: string; readonly name: string }[] {
  try {
    return Array.isArray(items) ? participantsOf(items).map((participant) => ({ label: participant.label, name: participant.handle })) : [];
  } catch {
    return [];
  }
}

function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

/** One field as one bounded line: normalised, link-neutralised, handles pseudonymised, whitespace collapsed, clipped. */
function oneLine(value: string, max: number, participants: readonly WorkItemParticipant[]): string {
  const line = neutralizeLinks(normalizeUntrustedText(value), 'display').replace(/\s+/g, ' ').trim();
  return clip(pseudonymiseParticipants(line, participants), max);
}

export interface WorkSummaryProjection {
  readonly documents: readonly ProjectedWorkDocument[];
  /** Items withheld whole because a complete field was credential-shaped. */
  readonly withheld: number;
}

/**
 * The documents a summarize step reads from one listing response: one per listed item, at its 1-based listing position,
 * with the item's own id. A row that is not a plain object or has no string id is skipped (its position stays empty, as the
 * projector's slots do). An entry with no table yields none. Total: never throws.
 */
export function projectWorkSummaryDocuments(entryId: NlWave1EntryId, items: unknown): WorkSummaryProjection {
  const spec = WORK_SUMMARY_FIELDS[entryId];
  if (spec === undefined || !Array.isArray(items)) return { documents: [], withheld: 0 };
  const documents: ProjectedWorkDocument[] = [];
  let withheld = 0;
  try {
    const participants = participantsOf(items);
    const labelOf = new Map(participants.map((participant) => [participant.handle, participant.label]));
    items.forEach((item: unknown, index) => {
      try {
        if (!isRecord(item) || typeof item.id !== 'string') return;
        const raw = (name: string | undefined): string => (name !== undefined && typeof item[name] === 'string' ? (item[name] as string) : '');
        const rawTitle = raw(spec.title);
        const rawParts = spec.text.map((entry) => raw(entry.field));
        // The strict guard on every COMPLETE original field and on their joins (with a newline and with no separator, so a token split across two fields is still seen), before anything is normalised or clipped.
        if ([rawTitle, ...rawParts, [rawTitle, ...rawParts].join('\n'), [rawTitle, ...rawParts].join('')].some((field) => isUntrustedTextCredentialShaped(field))) {
          withheld += 1;
          return;
        }
        const title = oneLine(rawTitle, WORK_SUMMARY_TITLE_MAX_CHARS, participants);
        const lines = spec.text.flatMap((entry, at) => {
          const text = oneLine(rawParts[at] as string, WORK_SUMMARY_FIELD_MAX_CHARS, participants);
          return text.length === 0 ? [] : [entry.label === undefined ? text : `${entry.label}: ${text}`];
        });
        // An item with only a title (a release item, an event without a description) is summarised from the title.
        const body = lines.length > 0 ? lines.join('\n') : title;
        const handle = spec.author === true ? handlesOf(item.author)[0] : undefined;
        const author = handle === undefined ? '' : (labelOf.get(handle) ?? '');
        documents.push({ id: item.id, position: index + 1, title, author, date: '', body });
      } catch {
        // A malformed row is skipped; the executor counts the gap as omitted.
      }
    });
  } catch {
    return { documents: [], withheld: 0 };
  }
  return { documents, withheld };
}
