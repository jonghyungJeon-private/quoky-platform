import type { Actor, Id, IsoTimestamp, Metadata } from '../../domain';
import type { Logger } from '../../ports/logger.port';
import { ActorMetadataStore } from '../actor-metadata-store';

/**
 * The persisted kill switch of natural-language actions (ADR-0120 amendment A6-D3, owner decision 8): stored in
 * `Actor.metadata['quoky.actionSwitch'] = { state: 'running' | 'stopped', at }` through the existing `ActorRepository`,
 * with the same re-read-and-merge write as the ADR-0120 D7 preferences: no file flag, no new port, no migration.
 *
 * - The owner flips it with the Class A control phrases `에이전트 중지` / `에이전트 재개` (owner DM). ADR-0114 maps
 *   every platform to one owner Actor, so one stop covers all of them.
 * - While it is `stopped`, every A6 entry is withdrawn from the catalog (the selector never sees them) and the anchored
 *   grammars keep working. A missing or malformed record means `running`.
 * - ADR-0121 S2 may reuse this switch by its own note (ADR-0121 D7 names a data-directory flag).
 */

export { ACTION_SWITCH_METADATA_KEY } from '../../domain/action-write-condition';
import { ACTION_SWITCH_METADATA_KEY } from '../../domain/action-write-condition';

export type NlActionSwitchState = 'running' | 'stopped';

export interface NlActionSwitchRecord {
  readonly state: NlActionSwitchState;
  readonly at?: IsoTimestamp;
}

/** The switch as stored on this actor (default `running`). Pure. */
export function readActionSwitch(actor: Pick<Actor, 'metadata'>): NlActionSwitchRecord {
  const raw = actor.metadata?.[ACTION_SWITCH_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { state: 'running' };
  const record = raw as Record<string, unknown>;
  const state = record.state === 'stopped' ? 'stopped' : 'running';
  const at = typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) ? (record.at as IsoTimestamp) : undefined;
  return { state, ...(at !== undefined ? { at } : {}) };
}

/** Pure: the actor metadata with only the switch key replaced (every other key kept as it is). */
export function withActionSwitch(metadata: Metadata | undefined, state: NlActionSwitchState, now: IsoTimestamp): Metadata {
  return { ...(metadata ?? {}), [ACTION_SWITCH_METADATA_KEY]: { state, at: now } };
}

/** The owner's control phrase (A6-D3): `에이전트 중지` stops, `에이전트 재개` resumes; anything else `undefined`. */
export function parseActionSwitchPhrase(text: string): NlActionSwitchState | undefined {
  const normalized = text.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/[.!。！]+$/u, '').trim();
  if (/^에이전트 ?중지$/u.test(normalized)) return 'stopped';
  if (/^에이전트 ?재개$/u.test(normalized)) return 'running';
  return undefined;
}

export interface NlActionSwitchDeps {
  /** The live Actor repository (`StorageProvider.actors`). */
  readonly actors: { get(id: Id): Promise<Actor | null>; save(actor: Actor): Promise<Actor> };
  readonly logger: Logger;
}

/**
 * The kill switch over the existing `ActorRepository`: re-read, merge one key, save (A6-D3), through the ONE per-actor
 * metadata lock (ADR-0122 D3), so a racing preference or grant write never loses this key or brings an old one back.
 */
export class NlActionSwitch {
  private readonly metadata: ActorMetadataStore;

  constructor(private readonly deps: NlActionSwitchDeps) {
    this.metadata = new ActorMetadataStore(deps.actors);
  }

  /** The current state of `actor` (the turn's snapshot; a save made earlier in the turn is visible on the next turn). */
  state(actor: Pick<Actor, 'metadata'>): NlActionSwitchState {
    return readActionSwitch(actor).state;
  }

  /** Persist `state` for `actorId`. Returns the saved state, or `undefined` when the write failed (logged, no content). */
  async set(actorId: Id, fallback: Actor, state: NlActionSwitchState, now: IsoTimestamp): Promise<NlActionSwitchState | undefined> {
    try {
      await this.metadata.updateMetadataEntry(
        actorId,
        ACTION_SWITCH_METADATA_KEY,
        () => withActionSwitch(undefined, state, now)[ACTION_SWITCH_METADATA_KEY],
        fallback,
      );
      this.log('info', 'nl_action.switch', { state });
      return state;
    } catch (error) {
      this.log('warn', 'nl_action.switch_write_failed', { errorName: error instanceof Error ? error.name : typeof error });
      return undefined;
    }
  }

  private log(level: 'info' | 'warn', event: string, fields: Record<string, string>): void {
    try {
      this.deps.logger[level](event, fields);
    } catch {
      // best-effort
    }
  }
}

/** The fixed replies of the control phrases (owner DM). */
export function renderActionSwitchReply(state: NlActionSwitchState | undefined, language: 'ko' | 'en' = 'ko'): string {
  if (state === undefined) {
    return language === 'en'
      ? 'I could not save the switch. Natural-language actions keep their previous state; please try again.'
      : '스위치를 저장하지 못했어요. 자연어 실행은 이전 상태 그대로예요. 다시 시도해 주세요.';
  }
  if (state === 'stopped') {
    return language === 'en'
      ? 'Natural-language actions are stopped. Exact commands (for example "할 일 추가: …") still work. Send "에이전트 재개" to resume.'
      : '자연어 실행을 멈췄어요. 정확한 명령(예: "할 일 추가: …")은 그대로 동작해요. 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
  }
  return language === 'en' ? 'Natural-language actions are running again.' : '자연어 실행을 다시 켰어요.';
}
