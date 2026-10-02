import { describe, expect, it } from 'vitest';
import { describeAiFailure } from './ai-failure';
import { AiProviderError, NoProviderAvailableError } from '../errors';
import { AiFailureKind } from '../domain';

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
});
