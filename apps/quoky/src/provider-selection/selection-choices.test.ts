import { describe, expect, it } from 'vitest';
import { Capability } from '@quoky/core';
import {
  CHAT_TIER_CAPABILITIES,
  CLAUDE_PINNED_CAPABILITIES,
  IMAGE_CHOICES,
  IMAGE_CHOICE_EGRESS,
  IMAGE_CHOICE_LOCALITY,
  chatChoiceFromData,
  chatChoiceIsCloud,
  imageChoiceIsCloud,
  imageChoiceFromData,
  parseChatChoiceToken,
  parseImageChoiceToken,
} from './selection-choices';

describe('selection choices (ADR-0092 amendment, runtime switching)', () => {
  it('the switch covers the chat tier only; code, review, planning, tests and policy-sensitive chat stay pinned', () => {
    expect([...CHAT_TIER_CAPABILITIES].sort()).toEqual(
      [Capability.GENERAL_CHAT, Capability.SUMMARIZATION, Capability.DOCUMENT_ANALYSIS, Capability.READONLY_LOOKUP].sort(),
    );
    for (const capability of [Capability.CODE_IMPLEMENTATION, Capability.CODE_REVIEW, Capability.ARCHITECTURE_PLANNING, Capability.POLICY_SENSITIVE_CHAT]) {
      expect(CLAUDE_PINNED_CAPABILITIES).toContain(capability);
      expect(CHAT_TIER_CAPABILITIES).not.toContain(capability);
    }
  });

  it('parses the bounded token vocabulary', () => {
    expect(parseChatChoiceToken('claude')).toEqual({ ok: true, choice: { provider: 'claude' } });
    expect(parseChatChoiceToken('Claude:OPUS')).toEqual({ ok: true, choice: { provider: 'claude', model: 'opus' } });
    expect(parseChatChoiceToken('claude:gpt')).toEqual({ ok: false, reason: 'CLAUDE_MODEL_NOT_ALLOWED' });
    expect(parseChatChoiceToken('codex')).toEqual({ ok: true, choice: { provider: 'codex' } });
    expect(parseChatChoiceToken('codex:o3')).toEqual({ ok: false, reason: 'CODEX_MODEL_NOT_ALLOWED' });
    expect(parseChatChoiceToken('ollama:Granite3.3:8b')).toEqual({ ok: true, choice: { provider: 'ollama', model: 'Granite3.3:8b' } });
    expect(parseChatChoiceToken('ollama:x;rm')).toEqual({ ok: false, reason: 'MODEL_INVALID' });
    expect(parseChatChoiceToken('ollama:kimi-cloud')).toEqual({ ok: false, reason: 'MODEL_INVALID' });
    expect(parseChatChoiceToken('bard')).toEqual({ ok: false, reason: 'UNKNOWN_PROVIDER' });
    expect(parseImageChoiceToken(' Off ')).toBe('off');
    expect(parseImageChoiceToken('Codex')).toBe('codex');
    expect(parseImageChoiceToken('codex:gpt-5')).toBeNull();
    expect(parseImageChoiceToken('gemini:gemini-3.5-flash')).toBeNull();
  });

  it('validates stored data strictly', () => {
    expect(chatChoiceFromData({ provider: 'claude', model: 'haiku' })).toEqual({ provider: 'claude', model: 'haiku' });
    expect(chatChoiceFromData({ provider: 'claude:opus' })).toBeNull();
    expect(chatChoiceFromData({ provider: 'codex', model: 'o3' })).toBeNull();
    expect(chatChoiceFromData({ provider: 'ollama', model: 3 })).toBeNull();
    expect(chatChoiceFromData('codex')).toBeNull();
    expect(imageChoiceFromData('claude')).toBe('claude');
    expect(imageChoiceFromData('Claude')).toBeNull();
    expect(imageChoiceFromData('codex')).toBe('codex');
  });

  it('image choices: Claude, Codex and the OpenAI and Gemini APIs are cloud (REMOTE, Anthropic / OpenAI / Google), Ollama is local, off sends nothing', () => {
    expect(IMAGE_CHOICES).toEqual(['claude', 'codex', 'ollama', 'openai', 'gemini', 'off']);
    expect(IMAGE_CHOICE_LOCALITY).toEqual({ claude: 'REMOTE', codex: 'REMOTE', ollama: 'LOCAL', openai: 'REMOTE', gemini: 'REMOTE', off: 'NONE' });
    expect(IMAGE_CHOICE_EGRESS).toEqual({ claude: 'ANTHROPIC', codex: 'OPENAI', ollama: 'LOCAL', openai: 'OPENAI', gemini: 'GOOGLE', off: 'NONE' });
    expect(IMAGE_CHOICES.filter(imageChoiceIsCloud)).toEqual(['claude', 'codex', 'openai', 'gemini']);
  });

  it('openai chat tokens (ADR-0115 D3): the provider alone or an allow-listed model, compared lowercase', () => {
    expect(parseChatChoiceToken('openai')).toEqual({ ok: true, choice: { provider: 'openai' } });
    expect(parseChatChoiceToken('OpenAI:GPT-4.1-mini')).toEqual({ ok: true, choice: { provider: 'openai', model: 'gpt-4.1-mini' } });
    for (const bad of ['openai:gpt-9-preview', 'openai:o3', 'openai:', 'openai:gpt-4.1-mini:x']) {
      expect(parseChatChoiceToken(bad)).toEqual({ ok: false, reason: 'OPENAI_MODEL_NOT_ALLOWED' });
    }
    expect(chatChoiceFromData({ provider: 'openai', model: 'gpt-4o' })).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(chatChoiceFromData({ provider: 'openai', model: 'gpt-secret' })).toBeNull();
    expect(chatChoiceIsCloud({ provider: 'openai' })).toBe(true);
    expect(imageChoiceFromData('openai')).toBe('openai');
  });

  it('gemini chat tokens (ADR-0115 D3/D4): the provider alone or an allow-listed model, compared lowercase', () => {
    expect(parseChatChoiceToken('gemini')).toEqual({ ok: true, choice: { provider: 'gemini' } });
    expect(parseChatChoiceToken('Gemini:GEMINI-3.5-Flash')).toEqual({ ok: true, choice: { provider: 'gemini', model: 'gemini-3.5-flash' } });
    for (const bad of ['gemini:gemini-2.0-flash', 'gemini:gpt-4o', 'gemini:', 'gemini:gemini-3.5-flash:x', 'gemini:models/gemini-3.5-flash']) {
      expect(parseChatChoiceToken(bad)).toEqual({ ok: false, reason: 'GEMINI_MODEL_NOT_ALLOWED' });
    }
    expect(chatChoiceFromData({ provider: 'gemini', model: 'gemini-3.8-flash' })).toEqual({ provider: 'gemini', model: 'gemini-3.8-flash' });
    expect(chatChoiceFromData({ provider: 'gemini', model: 'gemini-secret' })).toBeNull();
    expect(chatChoiceIsCloud({ provider: 'gemini' })).toBe(true);
    expect(parseImageChoiceToken('Gemini')).toBe('gemini');
    expect(imageChoiceFromData('gemini')).toBe('gemini');
  });
});
