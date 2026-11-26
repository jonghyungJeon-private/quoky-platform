import { describe, expect, it } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider } from '../../ports/ai-provider.port';
import { RecipientRecheckRefused, SummaryRecipientGuard, renderItemSummaryNotSentLine, type SummaryRecipientGuardInput } from './summary-recipient-guard';

// ADR-0121 amendment A8.3c (OQ1-2): the per-turn egress guard, unit level (the runtime wiring is pinned in
// conversation-runtime-item-summary-consent.test.ts).

const provider = (id: string, executionLocality: 'LOCAL' | 'REMOTE'): AiProvider => ({
  id,
  capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
  executionLocality,
  isAvailable: async () => true,
  execute: async () => ({ text: '' }),
});
const REMOTE = provider('p-remote', 'REMOTE');
const OTHER = provider('p-other', 'REMOTE');
const LOCAL = provider('p-local', 'LOCAL');
const labels: Readonly<Record<string, string>> = { 'p-remote': 'Remote', 'p-other': 'Other' };

function guard(overrides: Partial<SummaryRecipientGuardInput> = {}, state = { expected: 'p-remote' as string | undefined, eligible: true }) {
  return new SummaryRecipientGuard({
    capability: Capability.SUMMARIZATION,
    context: { sessionId: 's', actorId: 'a' },
    snapshot: { kind: 'expected', key: 'p-remote', label: 'Remote' },
    selector: { isStillEligible: () => state.eligible, expectedRecipientKey: () => state.expected },
    recipientLabel: (p) => labels[p.id],
    ...overrides,
  });
}

describe('SummaryRecipientGuard', () => {
  it('admits the call once, then the regeneration once and only after the call', () => {
    const g = guard();
    expect(g.admit(REMOTE, 'regeneration')).toBe(false);
    expect(g.admit(REMOTE, 'call')).toBe(true);
    expect(g.admit(REMOTE, 'call')).toBe(false);
    expect(g.admit(REMOTE, 'regeneration')).toBe(true);
    expect(g.admit(REMOTE, 'regeneration')).toBe(false);
  });

  it('refuses a changed recipient, a changed expected key, a lost eligibility and a missing dispatch-time check', () => {
    expect(guard().admit(OTHER, 'call')).toBe(false);
    expect(guard({}, { expected: undefined, eligible: true }).admit(REMOTE, 'call')).toBe(false);
    expect(guard({}, { expected: 'p-remote', eligible: false }).admit(REMOTE, 'call')).toBe(false);
    expect(guard({ selector: { expectedRecipientKey: () => 'p-remote' } }).admit(REMOTE, 'call')).toBe(false);
    // A changed label alone (same key) is a different recipient.
    expect(guard({ recipientLabel: () => 'Renamed' }).admit(REMOTE, 'call')).toBe(false);
    // An unnamed live recipient is never admitted.
    expect(guard({ recipientLabel: () => undefined }).admit(REMOTE, 'call')).toBe(false);
  });

  it('OQ1-3 review round 2: stillCurrent false (a stop voided consents during the turn) refuses both hooks, LOCAL and expected alike', () => {
    let current = true;
    const g = guard({ stillCurrent: () => current });
    expect(g.admit(REMOTE, 'call')).toBe(true);
    current = false;
    expect(g.admit(REMOTE, 'regeneration')).toBe(false);
    expect(guard({ stillCurrent: () => false }).admit(REMOTE, 'call')).toBe(false);
    expect(guard({ snapshot: { kind: 'local' }, stillCurrent: () => false }).admit(LOCAL, 'call')).toBe(false);
  });

  it('a LOCAL snapshot admits only a LOCAL provider and renders no line', () => {
    const g = guard({ snapshot: { kind: 'local' } });
    expect(g.admit(REMOTE, 'call')).toBe(false);
    expect(g.admit(LOCAL, 'call')).toBe(true);
    expect(g.recipientLine('ko')).toBeUndefined();
  });

  it('an unexpected snapshot needs consentedRemote (the OQ1-3 token); absent it is refused', () => {
    const snapshot = { kind: 'unexpected', key: 'p-remote', label: 'Remote' } as const;
    const state = { expected: 'p-other' as string | undefined, eligible: true };
    expect(guard({ snapshot }, state).admit(REMOTE, 'call')).toBe(false);
    const phases: string[] = [];
    const g = guard({ snapshot, consentedRemote: (_v, phase) => (phases.push(phase), true) }, state);
    expect(g.admit(REMOTE, 'call')).toBe(true);
    expect(phases).toEqual(['call']);
  });

  it('OQ1-3 review round 1: with consentedRemote an EXPECTED recipient also needs the judge at both hooks; LOCAL never asks it', () => {
    const phases: string[] = [];
    let allow = true;
    const g = guard({ consentedRemote: (_v, phase) => (phases.push(phase), allow) });
    expect(g.admit(REMOTE, 'call')).toBe(true);
    allow = false;
    expect(g.admit(REMOTE, 'regeneration')).toBe(false);
    expect(phases).toEqual(['call', 'regeneration']);
    expect(guard({ consentedRemote: () => false }).admit(REMOTE, 'call')).toBe(false);
    const local = guard({ snapshot: { kind: 'local' }, consentedRemote: () => (phases.push('local'), false) });
    expect(local.admit(LOCAL, 'call')).toBe(true);
    expect(phases).not.toContain('local');
  });

  it('a throwing selector is a refusal, never a throw', () => {
    const g = guard({ selector: { isStillEligible: () => { throw new Error('x'); }, expectedRecipientKey: () => 'p-remote' } });
    expect(g.admit(REMOTE, 'call')).toBe(false);
  });

  it('the recipient line appears only after an admitted REMOTE call, KO and EN', () => {
    const g = guard();
    expect(g.recipientLine('ko')).toBeUndefined();
    g.admit(REMOTE, 'call');
    expect(g.recipientLine('ko')).toBe('· Remote로 요약');
    expect(g.recipientLine('en')).toBe('· summarised by Remote');
  });

  it('the refusal error and the fixed not-sent line carry no content', () => {
    const error = new RecipientRecheckRefused('regeneration');
    expect(error.message).toBe('SUMMARY_RECIPIENT_RECHECK_REFUSED');
    expect(error.phase).toBe('regeneration');
    expect(renderItemSummaryNotSentLine('ko')).toBe('받는 쪽을 확인하지 못해 요약을 보내지 않았어요.');
    expect(renderItemSummaryNotSentLine('en')).toBe("I couldn't confirm who would summarise this, so nothing was sent.");
  });
});
