import { describe, expect, it } from 'vitest';
import { POLICY_SENSITIVE_CHAT_UNAVAILABLE_MESSAGE, describeAiFailure } from './ai-failure';
import { AiProviderError, NoProviderAvailableError } from '../errors';
import { AiFailureKind, Capability } from '../domain';

describe('describeAiFailure', () => {
  it('maps an AiProviderError kind to a friendly message + technical summary', () => {
    const d = describeAiFailure(
      new AiProviderError(AiFailureKind.TIMEOUT, 'claude CLI timed out after 120000ms'),
    );
    expect(d.kind).toBe(AiFailureKind.TIMEOUT);
    expect(d.userMessage).toMatch(/오래|멈|지연|시간/);
    expect(d.errorSummary).toContain('TIMEOUT');
  });

  it('treats NoProviderAvailableError as UNAVAILABLE', () => {
    const d = describeAiFailure(new NoProviderAvailableError('GENERAL_CHAT'));
    expect(d.kind).toBe(AiFailureKind.UNAVAILABLE);
    expect(d.userMessage).toBeTruthy();
    expect(d.errorSummary).toContain('GENERAL_CHAT');
  });

  it('gives NoProviderAvailableError its own "AI not configured" copy, distinct from "try again later"', () => {
    const notConfigured = describeAiFailure(new NoProviderAvailableError('GENERAL_CHAT'));
    const transient = describeAiFailure(new AiProviderError(AiFailureKind.UNAVAILABLE, 'claude CLI could not run'));
    expect(notConfigured.userMessage).toMatch(/설정/);
    expect(notConfigured.userMessage).not.toMatch(/잠시 후 다시/);
    expect(transient.userMessage).toMatch(/잠시 후 다시/);
    expect(notConfigured.userMessage).not.toBe(transient.userMessage);
    // Setup guidance only: no capability name or other technical detail reaches the user.
    expect(notConfigured.userMessage).not.toContain('GENERAL_CHAT');
  });

  it('treats unknown errors as EXECUTION_FAILED and never leaks raw detail into userMessage', () => {
    const d = describeAiFailure(new Error('secret-internal-detail'));
    expect(d.kind).toBe(AiFailureKind.EXECUTION_FAILED);
    expect(d.userMessage).not.toContain('secret-internal-detail');
    expect(d.errorSummary).toContain('secret-internal-detail');
  });

  it('caps the error summary length', () => {
    const d = describeAiFailure(new Error('x'.repeat(1000)));
    expect(d.errorSummary.length).toBeLessThanOrEqual(500);
  });

  it('gives a missing POLICY_SENSITIVE_CHAT provider a truthful deterministic reply, not "AI not configured" (ADR-0098 amendment)', () => {
    const d = describeAiFailure(new NoProviderAvailableError(Capability.POLICY_SENSITIVE_CHAT));
    const generic = describeAiFailure(new NoProviderAvailableError(Capability.GENERAL_CHAT));
    expect(d.kind).toBe(AiFailureKind.UNAVAILABLE);
    expect(d.userMessage).toBe(POLICY_SENSITIVE_CHAT_UNAVAILABLE_MESSAGE);
    expect(d.userMessage).not.toBe(generic.userMessage);
    expect(d.userMessage).toMatch(/아무 작업도 실행하지 않았어요/);
    expect(d.userMessage).toMatch(/nothing was done/i);
    expect(d.userMessage).not.toMatch(/추가했|보냈|예약했|드릴게요/);
    expect(d.userMessage).not.toContain('POLICY_SENSITIVE_CHAT');
    expect(d.errorSummary).toContain('POLICY_SENSITIVE_CHAT');
    // Other capabilities keep the setup copy.
    expect(describeAiFailure(new NoProviderAvailableError(Capability.SUMMARIZATION)).userMessage).toBe(generic.userMessage);
  });
});
