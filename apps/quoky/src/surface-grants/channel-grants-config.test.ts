import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../bootstrap-preflight';
import { loadConfig } from '../config';
import { ChannelGrantsConfigError, parseChannelGrantsConfig } from './channel-grants-config';

// ADR-0122 D6: QUOKY_CHANNEL_GRANTS (P1 default `off`) and QUOKY_CHANNEL_GRANTS_SEED, validated at startup with typed,
// value-free errors.

const GUILD = '1520835639103324181';
const QA = '1520835639904309350';
const DISCORD = { guildId: GUILD, channelIds: [QA, '1520835639904309351'] };
const SEED = `discord:${GUILD}:${QA}=jira-mine,jira-project,github,slack-search,confluence,calendar,todo,reminder,memory,code`;

const parse = (env: Record<string, string>, discord: { guildId?: string; channelIds: readonly string[] } = DISCORD) => parseChannelGrantsConfig(env, discord);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelGrantsConfigError);
    // The message is the code only: no configured value is ever echoed.
    expect((error as Error).message).not.toMatch(/[0-9]{6,}|jira|calendar|discord:/);
    return (error as ChannelGrantsConfigError).code;
  }
};

describe('QUOKY_CHANNEL_GRANTS', () => {
  it('defaults to `off` in P1 (the owner sets `enforce` on the live host)', () => {
    expect(parse({})).toEqual({ mode: 'off', explicit: false });
    expect(parse({ QUOKY_CHANNEL_GRANTS: 'enforce' })).toEqual({ mode: 'enforce', explicit: true });
    expect(parse({ QUOKY_CHANNEL_GRANTS: 'off' })).toEqual({ mode: 'off', explicit: true });
  });

  it.each(['ENFORCE', 'on', 'true', 'shadow', 'enforce '])('%j is a startup error', (value) => {
    if (value.trim() === 'enforce') {
      expect(parse({ QUOKY_CHANNEL_GRANTS: value }).mode).toBe('enforce');
      return;
    }
    expect(codeOf(() => parse({ QUOKY_CHANNEL_GRANTS: value }))).toBe('CHANNEL_GRANTS_INVALID');
  });
});

describe('QUOKY_CHANNEL_GRANTS_SEED', () => {
  it('parses the QA seed into one channel key with the groups', () => {
    expect(parse({ QUOKY_CHANNEL_GRANTS: 'enforce', QUOKY_CHANNEL_GRANTS_SEED: SEED }).seed).toEqual({
      channels: [{ key: `discord:${GUILD}:${QA}`, groups: ['jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code'] }],
    });
    expect(parse({ QUOKY_CHANNEL_GRANTS_SEED: `${SEED}; discord:${GUILD}:1520835639904309351=todo` }).seed?.channels).toHaveLength(2);
  });

  it.each([
    [`discord:${GUILD}:${QA}=mail`, 'CHANNEL_GRANTS_SEED_GROUP_INVALID'],
    [`discord:${GUILD}:${QA}=chat`, 'CHANNEL_GRANTS_SEED_GROUP_INVALID'],
    [`discord:${GUILD}:${QA}=todo,bogus`, 'CHANNEL_GRANTS_SEED_GROUP_INVALID'],
    [`discord:${GUILD}:999999999=todo`, 'CHANNEL_GRANTS_SEED_CHANNEL_NOT_ALLOWED'],
    [`discord:111111111:${QA}=todo`, 'CHANNEL_GRANTS_SEED_GUILD_MISMATCH'],
    [`telegram:${GUILD}:${QA}=todo`, 'CHANNEL_GRANTS_SEED_INVALID'],
    [`discord:${GUILD}:${QA}`, 'CHANNEL_GRANTS_SEED_INVALID'],
    [`discord:${GUILD}:${QA}=todo;discord:${GUILD}:${QA}=github`, 'CHANNEL_GRANTS_SEED_INVALID'],
    [';', 'CHANNEL_GRANTS_SEED_INVALID'],
  ])('%s → %s (value never echoed)', (value, code) => {
    expect(codeOf(() => parse({ QUOKY_CHANNEL_GRANTS_SEED: value }))).toBe(code);
  });

  it('needs DISCORD_GUILD_ID', () => {
    expect(codeOf(() => parse({ QUOKY_CHANNEL_GRANTS_SEED: SEED }, { channelIds: [QA] }))).toBe('CHANNEL_GRANTS_SEED_GUILD_MISMATCH');
  });

  it('more than 16 channels is refused', () => {
    const many = Array.from({ length: 17 }, (_, i) => `discord:${GUILD}:${QA}${i}=todo`).join(';');
    expect(codeOf(() => parse({ QUOKY_CHANNEL_GRANTS_SEED: many }))).toBe('CHANNEL_GRANTS_SEED_TOO_MANY_CHANNELS');
  });

  it('loadConfig folds it in and the startup report names the variable with a hint, never the value', () => {
    const base = { QUOKY_DISCORD_OWNER_IDS: '222222222222222222', DISCORD_GUILD_ID: GUILD, QUOKY_DISCORD_CHANNEL_IDS: QA };
    expect(loadConfig({ ...base }).channelGrants).toEqual({ mode: 'off', explicit: false });
    expect(loadConfig({ ...base, QUOKY_CHANNEL_GRANTS: 'enforce', QUOKY_CHANNEL_GRANTS_SEED: SEED }).channelGrants.seed?.channels).toHaveLength(1);
    let failure: unknown;
    try {
      loadConfig({ ...base, QUOKY_CHANNEL_GRANTS_SEED: `discord:${GUILD}:${QA}=mail` });
    } catch (error) {
      failure = error;
    }
    const report = describeStartupFailure(failure);
    expect(report.message).toBe('CHANNEL_GRANTS_SEED_GROUP_INVALID');
    expect(report.hint).toContain('QUOKY_CHANNEL_GRANTS_SEED');
    expect(JSON.stringify(report)).not.toContain(QA);
  });
});
