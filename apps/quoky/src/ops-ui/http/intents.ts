import { newSecret } from './security';
import type { OpsActionOutcome } from './view-model';

/**
 * OPS-2 / OPS-2b one-time action intents (ADR-0113 D7), `node:*` only.
 *
 * A confirmation page carries a random nonce bound to the session, the action kind and its subject (the reminder
 * number, or the issued forget code). The executing `POST` names only the nonce: the subject comes from the
 * server-side intent, never from the form, so a tampered field cannot redirect the action (an approval decision's
 * approval id is its subject). The first submit runs the
 * action; any later or concurrent submit of the same nonce gets the same outcome without running it again
 * (double-submit is idempotent). Intents live in memory, per session, for at most {@link OPS_INTENT_TTL_MS}.
 */

export type OpsIntentKind = 'reminder-cancel' | 'memory-forget' | 'approval-approve' | 'approval-reject';

/** An intent is accepted for this long after its confirmation page was served (the ADR-0106 code window). */
export const OPS_INTENT_TTL_MS = 30 * 60 * 1000;
/** Oldest intents of a session are dropped beyond this many. */
export const OPS_MAX_INTENTS_PER_SESSION = 32;
/** Wrong confirmation codes accepted for one forget intent before it is dropped. */
export const OPS_MAX_CODE_ATTEMPTS = 5;

export interface OpsIntent {
  readonly nonce: string;
  readonly sessionId: string;
  readonly kind: OpsIntentKind;
  readonly subject: string;
  readonly createdAtMs: number;
  attempts: number;
  /** Set by the first submit; later submits await the same outcome. */
  result?: Promise<OpsActionOutcome>;
}

export type OpsIntentRun =
  | { readonly status: 'RAN'; readonly outcome: OpsActionOutcome }
  | { readonly status: 'REPEATED'; readonly outcome: OpsActionOutcome };

export class OpsIntentStore {
  private readonly intents = new Map<string, OpsIntent>();

  constructor(private readonly nowMs: () => number) {}

  issue(sessionId: string, kind: OpsIntentKind, subject: string): string {
    this.sweep();
    const intent: OpsIntent = { nonce: newSecret(), sessionId, kind, subject, createdAtMs: this.nowMs(), attempts: 0 };
    this.intents.set(intent.nonce, intent);
    const own = [...this.intents.values()].filter((entry) => entry.sessionId === sessionId);
    for (const stale of own.slice(0, Math.max(0, own.length - OPS_MAX_INTENTS_PER_SESSION))) this.intents.delete(stale.nonce);
    return intent.nonce;
  }

  /** The live intent for this session, kind and nonce; undefined when unknown, foreign, of another kind or expired. */
  find(sessionId: string, kind: OpsIntentKind, nonce: string | undefined): OpsIntent | undefined {
    if (nonce === undefined || nonce.length === 0) return undefined;
    const intent = this.intents.get(nonce);
    if (intent === undefined || intent.sessionId !== sessionId || intent.kind !== kind) return undefined;
    if (this.nowMs() - intent.createdAtMs >= OPS_INTENT_TTL_MS) {
      this.intents.delete(nonce);
      return undefined;
    }
    return intent;
  }

  /** Run the intent's action at most once. */
  async runOnce(intent: OpsIntent, action: () => Promise<OpsActionOutcome>): Promise<OpsIntentRun> {
    if (intent.result !== undefined) return { status: 'REPEATED', outcome: await intent.result };
    intent.result = action().catch(
      (): OpsActionOutcome => ({ code: 'FAILED', message: '처리하지 못했어요. 잠시 뒤 다시 시도하세요.', ok: false }),
    );
    return { status: 'RAN', outcome: await intent.result };
  }

  drop(nonce: string): void {
    this.intents.delete(nonce);
  }

  endSession(sessionId: string): void {
    for (const [nonce, intent] of this.intents) if (intent.sessionId === sessionId) this.intents.delete(nonce);
  }

  clear(): void {
    this.intents.clear();
  }

  private sweep(): void {
    const now = this.nowMs();
    for (const [nonce, intent] of this.intents) if (now - intent.createdAtMs >= OPS_INTENT_TTL_MS) this.intents.delete(nonce);
  }
}
