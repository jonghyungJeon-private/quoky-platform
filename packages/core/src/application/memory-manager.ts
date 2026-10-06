import { newId } from '../util/id';
import { now } from '../util/clock';
import { MemoryType } from '../domain';
import type {
  ContextFile,
  ConversationContext,
  Id,
  InboundMessage,
  MemoryRecord,
  MemoryScope,
  Task,
} from '../domain';

export type ConversationRole = 'user' | 'assistant';

/** Max SHORT_TERM memories kept per session; older ones are pruned (ADR-0017). */
export const MAX_SESSION_SHORT_TERM = 30;
import type { StorageProvider, VectorProvider } from '../ports';

/**
 * Owns Quoky Memory — the source of truth. The AI CLIs are stateless; the
 * ONLY way memory reaches them is the context files this manager materializes.
 *
 * v1: storage + a deterministic renderer are implemented (plumbing). Semantic
 * retrieval ranking via the VectorProvider is left as a TODO so we don't bake
 * in a recall strategy prematurely.
 */
export class MemoryManager {
  constructor(
    private readonly storage: StorageProvider,
    private readonly vector: VectorProvider,
  ) {}

  /** Persist the latest USER message as short-term session memory (ADR-0017). */
  async recordShortTerm(message: InboundMessage, sessionId?: Id): Promise<MemoryRecord> {
    return this.saveShortTerm('user', message.text, message.context, sessionId);
  }

  /** Persist the assistant's response as short-term session memory (ADR-0017). */
  async recordAssistant(
    text: string,
    context: ConversationContext,
    sessionId?: Id,
  ): Promise<MemoryRecord> {
    return this.saveShortTerm('assistant', text, context, sessionId);
  }

  /** No provider id is ever stored in memory; role lives in metadata. */
  private async saveShortTerm(
    role: ConversationRole,
    content: string,
    context: ConversationContext,
    sessionId?: Id,
  ): Promise<MemoryRecord> {
    const persistenceScope: MemoryScope = sessionId
      ? { sessionId }
      : {
          channelId: context.channelId,
          ...(context.threadId ? { threadId: context.threadId } : {}),
        };
    const existing = await this.storage.memories.findByScope(
      persistenceScope,
      MemoryType.SHORT_TERM,
    );
    const ts = MemoryManager.nextPersistenceTimestamp(existing);
    const record: MemoryRecord = {
      id: newId(),
      type: MemoryType.SHORT_TERM,
      scope: {
        userId: context.userId,
        channelId: context.channelId,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
      content,
      metadata: { role },
      createdAt: ts,
      updatedAt: ts,
    };
    const saved = await this.storage.memories.save(record);
    if (sessionId) await this.pruneSession(sessionId);
    return saved;
  }

  /**
   * ADR-0106 D5 (W2-L01): replace the text of one recorded SHORT_TERM turn — a memory-command turn whose verbatim
   * text would keep memory content in the conversation history. The turn keeps its place (createdAt) and role; an
   * absent or non-SHORT_TERM record is left alone.
   */
  async redactShortTerm(id: Id, content: string): Promise<void> {
    const record = await this.storage.memories.get(id);
    if (record === null || record.type !== MemoryType.SHORT_TERM) return;
    await this.storage.memories.save({ ...record, content, updatedAt: now() });
  }

  /** Keep only the newest MAX_SESSION_SHORT_TERM SHORT_TERM memories per session. */
  private async pruneSession(sessionId: Id): Promise<void> {
    const all = await this.storage.memories.findByScope({ sessionId }, MemoryType.SHORT_TERM);
    if (all.length <= MAX_SESSION_SHORT_TERM) return;
    const sorted = all.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const excess = sorted.slice(0, all.length - MAX_SESSION_SHORT_TERM);
    for (const r of excess) await this.storage.memories.delete(r.id);
  }

  /** Persist a PROJECT-type memory summary (ADR-0018). */
  async recordProjectMemory(
    content: string,
    scope: { projectId: Id; sessionId?: Id },
  ): Promise<MemoryRecord> {
    const ts = now();
    const record: MemoryRecord = {
      id: newId(),
      type: MemoryType.PROJECT,
      scope: {
        projectId: scope.projectId,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      },
      content,
      metadata: { kind: 'project' },
      createdAt: ts,
      updatedAt: ts,
    };
    return this.storage.memories.save(record);
  }

  /** Persist a TOOL-type memory (e.g. a project analysis result) (ADR-0019). */
  async recordToolMemory(
    content: string,
    scope: { projectId?: Id; sessionId?: Id },
  ): Promise<MemoryRecord> {
    const ts = now();
    const record: MemoryRecord = {
      id: newId(),
      type: MemoryType.TOOL,
      scope: {
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      },
      content,
      metadata: { kind: 'analysis' },
      createdAt: ts,
      updatedAt: ts,
    };
    return this.storage.memories.save(record);
  }

  /** The latest PROJECT memory summary for a project, if any. */
  async projectMemory(projectId: Id): Promise<MemoryRecord | undefined> {
    const records = await this.storage.memories.findByScope({ projectId }, MemoryType.PROJECT);
    return records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  }

  /** Most recent short-term memories for a scope, oldest → newest. */
  async recentShortTerm(scope: MemoryScope, limit = 10): Promise<MemoryRecord[]> {
    const records = await this.storage.memories.findByScope(scope, MemoryType.SHORT_TERM);
    return records
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit);
  }

  /** Exact durable-memory lookup used by application-owned lifecycle policy. */
  async durableMemory(id: Id): Promise<MemoryRecord | null> {
    return this.storage.memories.get(id);
  }

  /** Scope-bound durable-memory lookup; unbounded repository list is intentionally absent. */
  async durableMemories(scope: MemoryScope): Promise<MemoryRecord[]> {
    return this.storage.memories.findByScope(scope, MemoryType.LONG_TERM);
  }

  /** Persist an application-approved durable record through the existing source of truth. */
  async saveDurable(record: MemoryRecord): Promise<MemoryRecord> {
    if (record.type !== MemoryType.LONG_TERM) {
      throw new Error('saveDurable accepts LONG_TERM memory only');
    }
    return this.storage.memories.save(record);
  }

  /** Apply an application-approved exact forget through the existing repository. */
  async forgetDurable(id: Id): Promise<void> {
    await this.storage.memories.delete(id);
  }

  /**
   * Preserve persistence order even when multiple turns arrive within the same
   * clock millisecond. Context retrieval can then select the newest records by
   * creation time without depending on repository row order.
   */
  private static nextPersistenceTimestamp(existing: MemoryRecord[]): string {
    const wallClock = Date.parse(now());
    const latestPersisted = existing.reduce((latest, record) => {
      const parsed = Date.parse(record.createdAt);
      return Number.isNaN(parsed) ? latest : Math.max(latest, parsed);
    }, Number.NEGATIVE_INFINITY);
    return new Date(Math.max(wallClock, latestPersisted + 1)).toISOString();
  }

  /**
   * Build the context files injected into a CLI run for a task. Renders the
   * relevant memory into the file layout the spec calls for:
   *   - .chunsik/context.md  (project + long-term + connector memory)
   *   - .chunsik/task.md      (working memory: the current task & plan state)
   * CLAUDE.md / AGENTS.md are added by provider-specific shaping later.
   */
  async buildContextFiles(task: Task): Promise<ContextFile[]> {
    const scope: MemoryScope = {
      userId: task.context.userId,
      channelId: task.context.channelId,
      ...(task.context.threadId ? { threadId: task.context.threadId } : {}),
      taskId: task.id,
      ...(task.projectId ? { projectId: task.projectId } : {}),
    };
    const records = await this.storage.memories.findByScope(scope);
    return [
      { path: '.chunsik/context.md', content: this.renderContext(records) },
      { path: '.chunsik/task.md', content: this.renderTask(task) },
    ];
  }

  private renderContext(records: MemoryRecord[]): string {
    const byType = (t: MemoryType) =>
      records
        .filter((r) => r.type === t)
        .map((r) => `- ${r.content}`)
        .join('\n');
    return [
      '# Quoky Context',
      '',
      '## Project memory',
      byType(MemoryType.PROJECT) || '_none_',
      '',
      '## Long-term memory',
      byType(MemoryType.LONG_TERM) || '_none_',
      '',
      '## Recent conversation',
      byType(MemoryType.SHORT_TERM) || '_none_',
      '',
    ].join('\n');
  }

  private renderTask(task: Task): string {
    return [
      '# Current Task',
      '',
      `- **Title:** ${task.title}`,
      `- **Status:** ${task.status}`,
      `- **Risk:** ${task.riskLevel}`,
      `- **Intent:** ${task.intent.summary}`,
      '',
    ].join('\n');
  }
}
