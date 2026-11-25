import { describe, expect, it } from 'vitest';
import { WriteProposalsConfigError, parseWriteProposalsConfig } from './write-proposals-config';
import { QuokyConfigErrorCode, loadConfig } from '../config';
import { describeStartupFailure } from '../bootstrap-preflight';

// ADR-0121 amendment A7, slice A7-S2: QUOKY_AGENT_WRITE_PROPOSALS=off|shadow|active, exact, default off; active refused.

function failureOf(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('parseWriteProposalsConfig', () => {
  it('defaults to off; exactly off is accepted', () => {
    expect(parseWriteProposalsConfig({})).toEqual({ mode: 'off' });
    expect(parseWriteProposalsConfig({ QUOKY_AGENT_WRITE_PROPOSALS: 'off' })).toEqual({ mode: 'off' });
  });

  it('shadow needs the agent mode shadow (fail closed)', () => {
    expect(parseWriteProposalsConfig({ QUOKY_AGENT_WRITE_PROPOSALS: 'shadow', QUOKY_AGENT_MODE: 'shadow' })).toEqual({ mode: 'shadow' });
    for (const mode of [undefined, 'off']) {
      const error = failureOf(() => parseWriteProposalsConfig({ QUOKY_AGENT_WRITE_PROPOSALS: 'shadow', ...(mode !== undefined ? { QUOKY_AGENT_MODE: mode } : {}) }));
      expect((error as WriteProposalsConfigError).code).toBe('AGENT_WRITE_PROPOSALS_REQUIRES_AGENT_MODE');
    }
  });

  it('active fails startup with the release-gate code and a value-free hint', () => {
    const error = failureOf(() => parseWriteProposalsConfig({ QUOKY_AGENT_WRITE_PROPOSALS: 'active', QUOKY_AGENT_MODE: 'shadow' }));
    expect(error).toBeInstanceOf(WriteProposalsConfigError);
    expect((error as WriteProposalsConfigError).code).toBe('AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED');
    const failure = describeStartupFailure(error);
    expect(failure.message).toBe('AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED');
    expect(failure.hint).toContain('QUOKY_AGENT_WRITE_PROPOSALS');
  });

  it.each(['', 'ON', 'Off', ' off', 'Shadow', 'true', 'on', 'shadow,active'])('refuses %j exactly, never echoing the value', (value) => {
    const error = failureOf(() => parseWriteProposalsConfig({ QUOKY_AGENT_WRITE_PROPOSALS: value, QUOKY_AGENT_MODE: 'shadow' }));
    expect((error as WriteProposalsConfigError).code).toBe('AGENT_WRITE_PROPOSALS_INVALID');
    expect((error as Error).message).toBe('AGENT_WRITE_PROPOSALS_INVALID');
    expect(describeStartupFailure(error).hint).toBe('QUOKY_AGENT_WRITE_PROPOSALS must be unset (off), "off" or "shadow" (exactly, lowercase).');
  });

  it('its codes are QuokyConfig error codes, and loadConfig folds it in (default off)', () => {
    expect(QuokyConfigErrorCode.AGENT_WRITE_PROPOSALS_INVALID).toBe('AGENT_WRITE_PROPOSALS_INVALID');
    expect(QuokyConfigErrorCode.AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED).toBe('AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED');
    const owner = { QUOKY_DISCORD_OWNER_IDS: '111111111111111111' };
    expect(loadConfig(owner).writeProposals).toEqual({ mode: 'off' });
    expect(() => loadConfig({ ...owner, QUOKY_AGENT_WRITE_PROPOSALS: 'active' })).toThrow('AGENT_WRITE_PROPOSALS_ACTIVE_NOT_RELEASED');
    expect(() => loadConfig({ ...owner, QUOKY_AGENT_WRITE_PROPOSALS: 'yes' })).toThrow('AGENT_WRITE_PROPOSALS_INVALID');
  });
});
