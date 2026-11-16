import { describe, expect, it } from 'vitest';
import { AgentConfigError, parseAgentConfig } from './agent-config';
import { QuokyConfigErrorCode } from '../config';
import { describeStartupFailure } from '../bootstrap-preflight';

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

  it('active fails startup until the D11 gates pass (AGENT_MODE_ACTIVE_NOT_RELEASED), even with the egress guard in enforce', () => {
    expect(codeOf(() => parseAgentConfig({ QUOKY_AGENT_MODE: 'active', QUOKY_NL_INTENT_MODE: 'active', QUOKY_EGRESS_GUARD: 'enforce' }))).toBe('AGENT_MODE_ACTIVE_NOT_RELEASED');
  });

  it('S2 wiring slice: active without QUOKY_EGRESS_GUARD=enforce is refused first (AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE; owner decision 5 of 2026-11-02)', () => {
    for (const guard of [undefined, 'observe', 'off', 'ENFORCE', ' enforce']) {
      const env = { QUOKY_AGENT_MODE: 'active', QUOKY_NL_INTENT_MODE: 'active', ...(guard !== undefined ? { QUOKY_EGRESS_GUARD: guard } : {}) };
      expect(codeOf(() => parseAgentConfig(env)), String(guard)).toBe('AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE');
    }
    // off and shadow never look at the guard.
    expect(parseAgentConfig({ QUOKY_AGENT_MODE: 'shadow', QUOKY_NL_INTENT_MODE: 'active', QUOKY_EGRESS_GUARD: 'observe' })).toEqual({ mode: 'shadow' });
    expect(parseAgentConfig({ QUOKY_EGRESS_GUARD: 'off' })).toEqual({ mode: 'off' });
  });

  it('the egress refusal reaches the startup report as a value-free hint', () => {
    let caught: unknown;
    try {
      parseAgentConfig({ QUOKY_AGENT_MODE: 'active', QUOKY_EGRESS_GUARD: 'observe' });
    } catch (error) {
      caught = error;
    }
    const failure = describeStartupFailure(caught);
    expect(failure.message).toBe('AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE');
    expect(failure.hint).toContain('QUOKY_EGRESS_GUARD=enforce');
    expect(failure.hint).not.toContain('observe');
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
    expect(QuokyConfigErrorCode.AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE).toBe('AGENT_MODE_ACTIVE_REQUIRES_EGRESS_ENFORCE');
  });
});
