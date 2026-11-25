import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capability } from '../../domain';
import type { AiProvider, AiRequest } from '../../ports/ai-provider.port';
import type { NlWave1EntryId } from '../nl-routing/catalog';
import { NL_WAVE1_ENTRIES } from '../nl-routing/wave1-entries';
import { setSummaryConsentAllowAllForTest } from './quarantined-summary';

// Rule ① (CS-1a): this suite predates the consent guard and exercises the REMOTE path itself; the rule is tested in summary-consent.cs1a.test.ts.
setSummaryConsentAllowAllForTest(true);

// ADR-0121 remote batch, review round 2 (CA P3): a call refused by the FINAL prompt credential check while another call of the
// step succeeds sets the closed flag `credentialWithheld`, which the executor passes on and the assembler renders as one fixed
// line. The readout guard withholds credential-shaped items before any prompt, so the detector is made to fire only on an
// assembled M2 prompt (it alone holds the span marker) that carries a Drive item.
vi.mock('../credential-guard', async (importActual) => {
  const actual = await importActual<typeof import('../credential-guard')>();
  return {
    ...actual,
    containsCredentialMaterial: (text: string): boolean =>
      (text.includes('<<<UNTRUSTED_SPAN') && text.includes('DRIVE DOCUMENT')) || actual.containsCredentialMaterial(text),
  };
});

import { AgentPlanExecutor, type AgentReadPort, type AgentReadResponse } from './plan-executor';
import type { ValidatedAgentPlan, ValidatedAgentStep } from './plan-validator';
import { setSummaryGrantsForTest, type AgentSourceDocument } from './quarantined-summary';
import { assembleAgentReply } from './reply-assembler';
import type { AgentStepsPlan } from './reply-notes';

type RunPlan = Extract<ValidatedAgentPlan, { steps: readonly ValidatedAgentStep[] }>;
const wide = (entryId: NlWave1EntryId, limit: number): ValidatedAgentStep => ({ kind: 'read', entry: NL_WAVE1_ENTRIES[entryId as keyof typeof NL_WAVE1_ENTRIES], args: { limit }, provenance: {} });
const plan = (steps: ValidatedAgentStep[]): RunPlan => ({ kind: 'run', steps, connectorCalls: steps.filter((step) => step.kind === 'read').length });
const port = (documents: readonly AgentSourceDocument[]): AgentReadPort => ({
  read: async (request): Promise<AgentReadResponse> =>
    request.budget.reserveQuery() && request.budget.reserveHttp() ? { ok: true, items: documents.map((document) => ({ id: document.id })), documents } : { ok: false, code: 'BOUND' },
});
const mailDoc = (position: number): AgentSourceDocument => ({ id: `m${position}`, position, title: 't', author: 'a', date: '', body: `mail body ${position}` });
const driveDoc = (position: number): AgentSourceDocument => ({ id: `f0000${position}`, position, title: 't', author: 'a', date: '', body: `drive body ${position}` });

afterEach(() => setSummaryGrantsForTest());

describe('remote batch: a call refused by the final prompt credential check (review round 2, CA P3)', () => {
  it('mail is summarised, the Drive call is neither reserved nor sent, its items are omitted, and the flag reaches the reply', async () => {
    setSummaryGrantsForTest(() => true);
    const requests: AiRequest[] = [];
    const provider: AiProvider = {
      id: 'p-remote',
      executionLocality: 'REMOTE',
      capabilities: [{ capability: Capability.SUMMARIZATION, priority: 1 }],
      isAvailable: async () => true,
      execute: async (request) => (requests.push(request), { text: '{"items":[{"n":1,"summary":"About the first mail."},{"n":2,"summary":"About the second mail."}]}' }),
    };
    const p = plan([wide('mail.list', 2), wide('drive.files', 2), { kind: 'summarize', from: [1, 2], schema: 'digest.v1' }]);
    const result = await new AgentPlanExecutor({
      readers: { 'mail.list': port([mailDoc(1), mailDoc(2)]), 'drive.files': port([driveDoc(1), driveDoc(2)]) },
      summarizer: { selector: { select: async () => provider, isStillEligible: () => true } },
    }).execute(p);

    // Only the mail call was sent and reserved; the Drive call was refused before its reservation.
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toContain('EMAIL MESSAGE');
    expect(requests[0]?.prompt).not.toContain('DRIVE DOCUMENT');
    expect(result.usage).toMatchObject({ m2Calls: 1, modelCalls: 1 });
    expect(result.usage.inputTokens).toBe(new TextEncoder().encode(requests[0]?.prompt ?? '').length);
    expect(result.breach).toBeUndefined();
    // The step is ok, carries the flag, and the two Drive items are omitted.
    expect(result.steps[2]).toMatchObject({ kind: 'summarize', status: 'ok', omitted: 2, credentialWithheld: true, audits: [{ locality: 'REMOTE' }] });

    const reply = assembleAgentReply({ plan: p as AgentStepsPlan, result, language: 'en', destinationIsOwnerDm: true });
    expect(reply.parts.filter((part) => part.text === 'Items that looked sensitive were left out of the summary.')).toHaveLength(1);
    expect(reply.text).not.toContain('drive body');
  });
});
