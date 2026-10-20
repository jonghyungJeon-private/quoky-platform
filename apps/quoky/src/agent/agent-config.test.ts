import { describe, expect, it } from 'vitest';
import { AgentConfigError, parseAgentConfig } from './agent-config';
import { QuokyConfigErrorCode } from '../config';

// ADR-0121 D7 (stage S2 P1): QUOKY_AGENT_MODE — exact values, default off, `active` refused at startup (the code-level
// release gate), `shadow` only on top of live Phase A selection.

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AgentConfigError ? error.code : 'OTHER';
  }
}

describe('parseAgentConfig', () => {
  it('defaults to off; off is accepted with any selection mode', () => {
    expect(parseAgentConfig({})).toEqual({ mode: 'off' });
    expect(parseAgentConfig({ QUOKY_AGENT_MODE: 'off' })).toEqual({ mode: 'off' });
    expect(parseAgentConfig({ QUOKY_AGENT_MODE: 'off', QUOKY_NL_INTENT_MODE: 'shadow' })).toEqual({ mode: 'off' });
  });

  it('shadow needs QUOKY_NL_INTENT_MODE=active', () => {
    expect(parseAgentConfig({ QUOKY_AGENT_MODE: 'shadow', QUOKY_NL_INTENT_MODE: 'active' })).toEqual({ mode: 'shadow' });
    for (const nl of [undefined, 'off', 'shadow']) {
      expect(codeOf(() => parseAgentConfig({ QUOKY_AGENT_MODE: 'shadow', ...(nl !== undefined ? { QUOKY_NL_INTENT_MODE: nl } : {}) })), String(nl)).toBe('AGENT_MODE_REQUIRES_NL_ACTIVE');
    }
  });

  it('active fails startup until the D11 gates pass (AGENT_MODE_ACTIVE_NOT_RELEASED)', () => {
    expect(codeOf(() => parseAgentConfig({ QUOKY_AGENT_MODE: 'active', QUOKY_NL_INTENT_MODE: 'active' }))).toBe('AGENT_MODE_ACTIVE_NOT_RELEASED');
  });

  it.each(['', 'Shadow', 'SHADOW', ' shadow', 'on', 'true', 'shadow,active'])('refuses %j exactly (AGENT_MODE_INVALID), never echoing the value', (value) => {
    let message = '';
    try {
      parseAgentConfig({ QUOKY_AGENT_MODE: value, QUOKY_NL_INTENT_MODE: 'active' });
    } catch (error) {
      message = (error as Error).message;
      expect((error as AgentConfigError).code).toBe('AGENT_MODE_INVALID');
    }
    expect(message).toBe('AGENT_MODE_INVALID');
  });

  it('its codes are QuokyConfig error codes (the preflight has a hint for each)', () => {
    expect(QuokyConfigErrorCode.AGENT_MODE_INVALID).toBe('AGENT_MODE_INVALID');
    expect(QuokyConfigErrorCode.AGENT_MODE_ACTIVE_NOT_RELEASED).toBe('AGENT_MODE_ACTIVE_NOT_RELEASED');
    expect(QuokyConfigErrorCode.AGENT_MODE_REQUIRES_NL_ACTIVE).toBe('AGENT_MODE_REQUIRES_NL_ACTIVE');
  });
});
