import {
  WORK_ITEM_MAX_RESOURCE_REFS,
  WORK_ITEM_MAX_TITLE_LENGTH,
  WorkItemCorrelationError,
  WorkItemStatus,
  WorkItemTitleError,
  normalizeWorkItemTitle,
} from '../../domain';
import type { Actor, ResourceRef, WorkItem } from '../../domain';
import {
  CONNECTOR_QUERY_MAX_LIMIT,
  ConnectorQueryName,
  isConnectorQueryError,
} from '../../ports';
import type { ConnectorProvider, ConnectorQuery, PersonalWorkFilter } from '../../ports';
import { containsCredentialMaterial } from '../credential-guard';
import type { WorkManager } from '../work-manager';
import type { WorkSurface } from '../work-surface-query';
import {
  buildExternalWorkReadout,
  renderExternalWorkFooter,
} from './external-work-readout';
import type { ExternalWorkReadout } from './external-work-readout';
import {
  WORK_CHAT_SEARCH_TEXT_MAX_LENGTH,
  WORK_CHAT_SOURCE_QUERIES,
} from './work-chat-command';
import type {
  WorkChatCommand,
  WorkChatLookupQuery,
  WorkChatSource,
  WorkChatTarget,
} from './work-chat-command';
import {
  renderExternalWorkList,
  renderExternalWriteRefusal,
  renderLookupFailure,
  renderLookupUnsupported,
  renderMyWork,
  renderSearchCredentialRefused,
  renderTodoAdded,
  renderTodoAmbiguous,
  renderTodoCanceled,
  renderTodoCompleted,
  renderTodoCredentialRefused,
  renderTodoEmptyTitle,
  renderTodoFailure,
  renderTodoLinked,
  renderTodoNotActive,
  renderTodoNotFound,
  renderTodoTitleTooLong,
  renderTodoTooManyRefs,
  renderWorkChatUsage,
} from './work-chat-renderer';
import type { WorkChatLookupFailure } from './work-chat-renderer';

/** What the runtime presents for one work-chat command (ADR-0100 D8/D10). */
export type WorkChatOutcome =
  | { readonly kind: 'reply'; readonly text: string }
  | {
      readonly kind: 'summarize';
      readonly readout: ExternalWorkReadout;
      /** The deterministic list, used whenever summarization does not produce a reply. */
      readonly fallbackText: string;
      /** Deterministic source links and the disclosure line, appended to a successful summary. */
      readonly footer: string;
    };

/**
 * The work desk the runtime talks to (ADR-0100 D10). `forActor` is the read-only Jira/GitHub surface (kept for the
 * legacy `personal-work-surface` path); `handle` executes one detected command for the resolved owner Actor.
 */
export interface WorkDesk {
  forActor(actor: Actor): Promise<WorkSurface>;
  handle(command: WorkChatCommand, actor: Actor): Promise<WorkChatOutcome>;
}

export interface WorkChatServiceDeps {
  readonly workSurface: { forActor(actor: Actor): Promise<WorkSurface> };
  readonly connectors: { list(): readonly ConnectorProvider[] };
  /** The only to-do state owner; to-do commands never touch storage directly. */
  readonly work: Pick<WorkManager, 'create' | 'listActiveByActor' | 'transition' | 'correlate'>;
}

export interface WorkChatServiceOptions {
  /** `QUOKY_WORK_SUMMARY_ENABLED`: false means a lookup never returns `summarize`. */
  readonly summaryEnabled: boolean;
  /** One deadline for availability check plus query. Defaults to 15 seconds. */
  readonly lookupDeadlineMs?: number;
}

export const WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS = 15_000;

const PERSONAL_WORK_FILTER: Readonly<Record<'my-items' | 'due-this-week' | 'review-requests', PersonalWorkFilter>> = {
  'my-items': 'all',
  'due-this-week': 'due-this-week',
  'review-requests': 'review-requested',
};

class LookupTimeoutError extends Error {
  constructor() {
    super('work-chat lookup timed out');
    this.name = 'LookupTimeoutError';
  }
}

async function withDeadline<T>(run: () => Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LookupTimeoutError()), deadlineMs);
  });
  const task = run();
  // A late rejection after the deadline must not surface as an unhandled rejection.
  task.catch(() => undefined);
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fold(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compareTodos(left: WorkItem, right: WorkItem): number {
  return (
    (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

type Resolution =
  | { readonly kind: 'found'; readonly no: number; readonly item: WorkItem }
  | { readonly kind: 'ambiguous'; readonly candidates: ReadonlyArray<{ no: number; item: WorkItem }> }
  | { readonly kind: 'none' };

/** The owner's ACTIVE to-dos, `createdAt` ascending: the same order the combined view numbers them in. */
function resolveTarget(todos: readonly WorkItem[], target: WorkChatTarget): Resolution {
  if ('index' in target) {
    const item = todos[target.index - 1];
    return item ? { kind: 'found', no: target.index, item } : { kind: 'none' };
  }
  const wanted = fold(target.text);
  if (wanted.length === 0) return { kind: 'none' };
  const numbered = todos.map((item, index) => ({ no: index + 1, item }));
  const exact = numbered.filter(({ item }) => item.title !== undefined && fold(item.title) === wanted);
  const matches = exact.length > 0 ? exact : numbered.filter(({ item }) => item.title !== undefined && fold(item.title).includes(wanted));
  if (matches.length === 1) return { kind: 'found', ...(matches[0] as { no: number; item: WorkItem }) };
  return matches.length === 0 ? { kind: 'none' } : { kind: 'ambiguous', candidates: matches };
}

/**
 * CAP-011 chat entry point (ADR-0100 D10): executes work-chat commands. To-do commands run immediately through
 * `WorkManager` for the resolved owner Actor (LOW-risk local actions, no approval); lookups call only the connector
 * port's named read-only queries. It never calls a provider, never writes externally, and catches its own errors.
 */
export class WorkChatService implements WorkDesk {
  private readonly summaryEnabled: boolean;
  private readonly lookupDeadlineMs: number;

  constructor(
    private readonly deps: WorkChatServiceDeps,
    options: WorkChatServiceOptions,
  ) {
    this.summaryEnabled = options.summaryEnabled;
    this.lookupDeadlineMs = options.lookupDeadlineMs ?? WORK_CHAT_DEFAULT_LOOKUP_DEADLINE_MS;
  }

  forActor(actor: Actor): Promise<WorkSurface> {
    return this.deps.workSurface.forActor(actor);
  }

  async handle(command: WorkChatCommand, actor: Actor): Promise<WorkChatOutcome> {
    try {
      switch (command.kind) {
        case 'todo.add':
          return reply(await this.addTodo(command.title, command.refs, actor));
        case 'todo.list':
          return reply(await this.listWork(actor));
        case 'todo.complete':
          return reply(await this.transitionTodo(command.target, WorkItemStatus.COMPLETED, actor));
        case 'todo.cancel':
          return reply(await this.transitionTodo(command.target, WorkItemStatus.CANCELED, actor));
        case 'todo.link':
          return reply(await this.linkTodo(command.target, command.refs, actor));
        case 'lookup':
          return await this.lookup(command.source, command.query, command.text, actor);
        case 'external-write-unsupported':
          return reply(renderExternalWriteRefusal(command.source));
        case 'usage':
          return reply(renderWorkChatUsage(command.topic));
      }
    } catch (error) {
      return reply(isTodoCommand(command) ? this.todoFailureText(error) : renderLookupFailure(lookupSource(command), 'UNAVAILABLE'));
    }
  }

  // -- to-do commands (WorkManager only) --------------------------------------------------------------------------------

  private async activeTodos(actor: Actor): Promise<WorkItem[]> {
    return [...(await this.deps.work.listActiveByActor(actor.id))].sort(compareTodos);
  }

  private async addTodo(rawTitle: string, refs: readonly ResourceRef[], actor: Actor): Promise<string> {
    if (rawTitle.trim().length === 0) return renderTodoEmptyTitle();
    // A credential-bearing title is refused before anything is stored (ADR-0100 D5; the guard is unchanged, ADR-0097).
    if (containsCredentialMaterial(rawTitle)) return renderTodoCredentialRefused();
    let title: string;
    try {
      title = normalizeWorkItemTitle(rawTitle);
    } catch (error) {
      if (error instanceof WorkItemTitleError) {
        return error.code === 'EMPTY' ? renderTodoEmptyTitle() : renderTodoTitleTooLong(WORK_ITEM_MAX_TITLE_LENGTH);
      }
      throw error;
    }
    if (containsCredentialMaterial(title)) return renderTodoCredentialRefused();
    try {
      const item = await this.deps.work.create({
        actorId: actor.id,
        title,
        resourceRefs: refs,
        origin: 'conversation',
      });
      return renderTodoAdded(item);
    } catch (error) {
      if (error instanceof WorkItemCorrelationError && error.code === 'TOO_MANY_REFS') {
        return renderTodoTooManyRefs(WORK_ITEM_MAX_RESOURCE_REFS);
      }
      throw error;
    }
  }

  private async transitionTodo(target: WorkChatTarget, status: WorkItemStatus, actor: Actor): Promise<string> {
    const todos = await this.activeTodos(actor);
    const action = status === WorkItemStatus.COMPLETED ? 'complete' : 'cancel';
    const resolution = resolveTarget(todos, target);
    if (resolution.kind === 'none') return renderTodoNotFound(target, todos.length);
    if (resolution.kind === 'ambiguous') return renderTodoAmbiguous(action, resolution.candidates);
    const updated = await this.deps.work.transition(resolution.item.id, status);
    return status === WorkItemStatus.COMPLETED ? renderTodoCompleted(updated) : renderTodoCanceled(updated);
  }

  private async linkTodo(target: WorkChatTarget, refs: readonly ResourceRef[], actor: Actor): Promise<string> {
    if (refs.length === 0) return renderWorkChatUsage('todo-link');
    const todos = await this.activeTodos(actor);
    const resolution = resolveTarget(todos, target);
    if (resolution.kind === 'none') return renderTodoNotFound(target, todos.length);
    if (resolution.kind === 'ambiguous') return renderTodoAmbiguous('link', resolution.candidates);
    const known = new Set(resolution.item.resourceRefs.map((ref) => ref.identity));
    const added = refs.filter((ref, index) => !known.has(ref.identity) && refs.findIndex((r) => r.identity === ref.identity) === index);
    if (known.size + added.length > WORK_ITEM_MAX_RESOURCE_REFS) return renderTodoTooManyRefs(WORK_ITEM_MAX_RESOURCE_REFS);
    // No connector call at link time (ADR-0100 D6).
    const updated = await this.deps.work.correlate(resolution.item.id, refs);
    return renderTodoLinked(updated, added);
  }

  private todoFailureText(error: unknown): string {
    if (error instanceof WorkItemCorrelationError) {
      return error.code === 'NOT_ACTIVE' ? renderTodoNotActive() : renderTodoTooManyRefs(WORK_ITEM_MAX_RESOURCE_REFS);
    }
    return renderTodoFailure();
  }

  // -- combined view ------------------------------------------------------------------------------------------------

  private async listWork(actor: Actor): Promise<string> {
    const todos = await this.activeTodos(actor);
    let surface: WorkSurface | null = null;
    try {
      surface = await this.deps.workSurface.forActor(actor);
    } catch {
      surface = null;
    }
    return renderMyWork(todos, surface);
  }

  // -- connector lookups (named read-only queries only) --------------------------------------------------------------

  private async lookup(
    source: WorkChatSource,
    query: WorkChatLookupQuery,
    rawText: string | undefined,
    actor: Actor,
  ): Promise<WorkChatOutcome> {
    const supported = WORK_CHAT_SOURCE_QUERIES[source];
    if (!supported.includes(query)) return reply(renderLookupUnsupported(source, query, supported));

    let searchText: string | undefined;
    if (query === 'search') {
      // eslint-disable-next-line no-control-regex
      searchText = (rawText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (searchText.length === 0) return reply(renderWorkChatUsage('search'));
      if (Array.from(searchText).length > WORK_CHAT_SEARCH_TEXT_MAX_LENGTH) return reply(renderWorkChatUsage('search-too-long'));
      // Search text leaves the machine: a credential-bearing query is never sent.
      if (containsCredentialMaterial(searchText)) return reply(renderSearchCredentialRefused());
    }

    const connector = this.deps.connectors.list().find((candidate) => candidate.source === source);
    if (!connector) return reply(renderLookupFailure(source, 'NOT_CONFIGURED'));

    let namedQuery: ConnectorQuery;
    if (query === 'search') {
      namedQuery = { query: ConnectorQueryName.SEARCH, params: { text: searchText as string, limit: CONNECTOR_QUERY_MAX_LIMIT } };
    } else {
      const identity = actor.identities
        .filter((candidate) => candidate.platform === source)
        .map((candidate) => candidate.externalId.trim())
        .filter(Boolean)
        .sort()[0];
      if (!identity) return reply(renderLookupFailure(source, 'IDENTITY_MISSING'));
      namedQuery = {
        query: ConnectorQueryName.PERSONAL_WORK,
        params: { actorExternalId: identity, filter: PERSONAL_WORK_FILTER[query], limit: CONNECTOR_QUERY_MAX_LIMIT },
      };
    }

    let result: Awaited<ReturnType<ConnectorProvider['query']>> | 'UNAVAILABLE';
    try {
      result = await withDeadline(async () => {
        if (!(await connector.isAvailable())) return 'UNAVAILABLE' as const;
        return connector.query(namedQuery);
      }, this.lookupDeadlineMs);
    } catch (error) {
      return reply(renderLookupFailure(source, failureReason(error)));
    }
    if (result === 'UNAVAILABLE') return reply(renderLookupFailure(source, 'UNAVAILABLE'));

    const readout = buildExternalWorkReadout({
      source,
      query,
      ...(searchText !== undefined ? { text: searchText } : {}),
      items: Array.isArray(result.items) ? result.items : [],
    });
    const fallbackText = renderExternalWorkList(readout);
    if (this.summaryEnabled && readout.items.length > 0) {
      return { kind: 'summarize', readout, fallbackText, footer: renderExternalWorkFooter(readout) };
    }
    return reply(fallbackText);
  }
}

function reply(text: string): WorkChatOutcome {
  return { kind: 'reply', text };
}

function failureReason(error: unknown): WorkChatLookupFailure {
  if (error instanceof LookupTimeoutError) return 'TIMEOUT';
  if (isConnectorQueryError(error)) return error.reason;
  return 'UNAVAILABLE';
}

function isTodoCommand(command: WorkChatCommand): boolean {
  return command.kind.startsWith('todo.');
}

function lookupSource(command: WorkChatCommand): WorkChatSource {
  return command.kind === 'lookup' || command.kind === 'external-write-unsupported' ? command.source : 'jira';
}
