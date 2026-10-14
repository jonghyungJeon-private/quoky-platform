import type { Id, Metadata } from './common';

/**
 * ADR-0120 amendment A6-D3 (the kill switch is atomic with the write): a store write made by a natural-language action
 * carries this condition, and the store evaluates it INSIDE the same critical section as the write (the SQLite adapter:
 * in the write's IMMEDIATE transaction, reading the actor row), right before the row is written. While the actor's
 * persisted switch is stopped, nothing is written. One mechanism for every A6 mutation (to-do create, complete, cancel,
 * reopen; reminder create, cancel, reactivate). Anchored Class A commands carry no condition.
 */
export interface ActionWriteCondition {
  /** The actor whose `Actor.metadata['quoky.actionSwitch']` must be running. */
  readonly actionSwitchOf: Id;
}

/** `Actor.metadata` key of the persisted switch (`{ state: 'running' | 'stopped', at }`). */
export const ACTION_SWITCH_METADATA_KEY = 'quoky.actionSwitch';

/** Whether actor metadata leaves natural-language actions running (missing or malformed = running). Pure. */
export function isActionSwitchRunning(metadata: Metadata | undefined): boolean {
  const raw = metadata?.[ACTION_SWITCH_METADATA_KEY];
  return !(typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as Record<string, unknown>).state === 'stopped');
}

/** A write refused by its {@link ActionWriteCondition}: the switch was stopped when the store was about to write. */
export class ActionWriteStoppedError extends Error {
  constructor() {
    super('natural-language actions are stopped');
    this.name = 'ActionWriteStoppedError';
  }
}
