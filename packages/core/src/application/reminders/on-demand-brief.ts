import type { Id, IsoTimestamp, MessageBody, WorkItem } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import type { ReminderRepository } from '../../ports/reminder-repository.port';
import type { DailyBriefSources } from './daily-brief-sources';
import type { ReminderReplyComposer } from './reminder-reply-composer';

/**
 * The on-demand `brief.today` (ADR-0120 D1, the ADR-0117 D3/D4 amendment): the same model-free composition as the
 * scheduled daily brief, read now for the asking owner — their active reminders, their local WorkItems and the configured
 * read-only brief sources (today's calendar, the opt-in assigned work). A failed local read degrades the brief exactly as
 * the scheduled one does ("could not read"), never an empty day. No provider, no write; DM-only is enforced by the
 * handler. Brief content never reaches the selector: only the choice of this entry is model-assisted.
 */
export interface OnDemandBriefDeps {
  readonly repository: Pick<ReminderRepository, 'listActiveByActor'>;
  readonly workItems: { listByActor(actorId: Id): Promise<readonly WorkItem[]> };
  readonly briefSources?: Pick<DailyBriefSources, 'read'>;
  readonly composer: Pick<ReminderReplyComposer, 'brief'>;
  /** `QUOKY_TIMEZONE`. */
  readonly timeZone: string;
  readonly logger?: Logger;
}

export class OnDemandBrief {
  constructor(private readonly deps: OnDemandBriefDeps) {}

  async compose(actorId: Id, now: IsoTimestamp): Promise<MessageBody> {
    const [reminders, workItems, sources] = await Promise.all([
      this.readOrNull(() => this.deps.repository.listActiveByActor(actorId)),
      this.readOrNull(() => this.deps.workItems.listByActor(actorId)),
      this.deps.briefSources?.read({ actorId, now, timeZone: this.deps.timeZone }),
    ]);
    return this.deps.composer.brief({ now, timeZone: this.deps.timeZone, reminders, workItems, ...(sources ?? {}) });
  }

  private async readOrNull<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      try {
        this.deps.logger?.warn('reminder.brief.on_demand_read_failed', { errorName: error instanceof Error ? error.name : 'unknown' });
      } catch {
        // best-effort
      }
      return null;
    }
  }
}
