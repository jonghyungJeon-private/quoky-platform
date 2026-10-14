import type Database from 'better-sqlite3';
import { isActionSwitchRunning, type ActionWriteCondition, type Actor } from '@quoky/core';

/**
 * ADR-0120 amendment A6-D3, the one store-side mechanism: whether a write's {@link ActionWriteCondition} holds, read from
 * the actor row INSIDE the caller's transaction (so it is atomic with the write that follows). A missing or unreadable
 * actor row fails closed. Synchronous: better-sqlite3 transactions are synchronous.
 */
export function actionWriteConditionHolds(db: Database.Database, condition: ActionWriteCondition | undefined): boolean {
  if (condition === undefined) return true;
  const row = db.prepare('SELECT data FROM actors WHERE id = ?').get(condition.actionSwitchOf) as { data: string } | undefined;
  if (row === undefined) return false;
  try {
    return isActionSwitchRunning((JSON.parse(row.data) as Actor).metadata);
  } catch {
    return false;
  }
}
