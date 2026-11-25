import { describe, expect, it } from 'vitest';
import { GEMINI_CHAT_PROVIDER_ID } from '@quoky/ai-gemini-api';
import { OPENAI_CHAT_PROVIDER_ID } from '@quoky/ai-openai-api';
import { summaryRecipientLabel } from './summary-recipient-label';

// ADR-0121 rule ① (CS-1a): the closed recipient-name map over the provider family. Unknown means no name (REMOTE excluded).

describe('summaryRecipientLabel', () => {
  it('names the known provider families', () => {
    expect(summaryRecipientLabel({ id: 'claude-cli' })).toBe('Claude');
    expect(summaryRecipientLabel({ id: 'codex-cli' })).toBe('Codex');
    expect(summaryRecipientLabel({ id: OPENAI_CHAT_PROVIDER_ID })).toBe('OpenAI');
    expect(summaryRecipientLabel({ id: GEMINI_CHAT_PROVIDER_ID })).toBe('Gemini');
  });

  it('reads the family before the id', () => {
    expect(summaryRecipientLabel({ id: 'claude-cli-summarizer', family: 'claude-cli' })).toBe('Claude');
    expect(summaryRecipientLabel({ id: 'claude-cli', family: 'unknown-family' })).toBeUndefined();
  });

  it('a provider the table does not know, or an inherited property name, has no name', () => {
    for (const id of ['ollama-cli', 'fake', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(summaryRecipientLabel({ id }), id).toBeUndefined();
  });

  it('never throws on a provider whose fields throw', () => {
    const hostile = { get id(): string { throw new Error('x'); } };
    expect(summaryRecipientLabel(hostile as never)).toBeUndefined();
  });
});
