import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AgentProfileRegistry, agentProfileId } from '@quoky/core';
import type { AgentProfile } from '@quoky/core';
import { loadConfig } from './config';
import { createAgentProfileRegistryProvider } from './agent-profile-registry-provider';

const profile = {
  id: agentProfileId('receiver'), displayName: 'Receiver', role: 'implementer',
  purpose: 'continue delegated work', instructions: 'Follow the handoff objective.',
};

async function registryFrom(profiles: readonly AgentProfile[]): Promise<AgentProfileRegistry> {
  @Module({ providers: [createAgentProfileRegistryProvider(profiles)] })
  class AgentProfileCompositionModule {}
  const application = await NestFactory.createApplicationContext(AgentProfileCompositionModule, { logger: false });
  try {
    return application.get(AgentProfileRegistry);
  } finally {
    await application.close();
  }
}

// Personal edition requires an owner id (ADR-0091); unrelated to the profile settings under test.
const OWNER_ID = '111111111111111111';

describe('AgentProfileRegistry composition (M3E-6H, ADR-0089)', () => {
  it('resolves an empty composition-time registry with no configuration and no fallback agent', async () => {
    const registry = await registryFrom(loadConfig({ QUOKY_DISCORD_OWNER_IDS: OWNER_ID } as NodeJS.ProcessEnv).agentProfiles);
    expect(registry.list()).toEqual([]);
    // Unknown lookup stays fail-closed exactly as before, so continuation cannot proceed.
    expect(() => registry.get(agentProfileId('receiver'))).toThrow(/Unknown AgentProfile id/);
  });

  it('resolves an empty registry for an explicit empty array without activating anything', async () => {
    const registry = await registryFrom(
      loadConfig({ QUOKY_DISCORD_OWNER_IDS: OWNER_ID, QUOKY_AGENT_PROFILES: '[]' } as NodeJS.ProcessEnv).agentProfiles,
    );
    expect(registry.list()).toEqual([]);
    expect(() => registry.get(agentProfileId('receiver'))).toThrow(/Unknown AgentProfile id/);
  });

  it('carries configured profiles through the composition root to the existing lookup path', async () => {
    const configured = loadConfig({
      QUOKY_DISCORD_OWNER_IDS: OWNER_ID,
      QUOKY_AGENT_PROFILES: JSON.stringify([profile, { ...profile, id: 'source', displayName: 'Source' }]),
    } as NodeJS.ProcessEnv).agentProfiles;
    const registry = await registryFrom(configured);
    // The same registry lookup used to resolve WorkHandoff.toAgentProfileId; no alias, no fuzzy matching.
    expect(registry.get(agentProfileId('receiver'))).toEqual(profile);
    expect(registry.list().map((entry) => entry.id)).toEqual(['receiver', 'source']);
    expect(() => registry.get(agentProfileId('Receiver'))).toThrow(/Unknown AgentProfile id/);
    expect(() => registry.get(agentProfileId('unconfigured'))).toThrow(/Unknown AgentProfile id/);
  });

  it('is one immutable startup snapshot: later input or source mutation cannot change it', async () => {
    const source: AgentProfile[] = [{ ...profile }];
    const registry = await registryFrom(source);
    source.push({ ...profile, id: agentProfileId('injected') });
    source[0] = { ...profile, displayName: 'Rewritten' };
    expect(registry.list().map((entry) => entry.id)).toEqual(['receiver']);
    expect(registry.get(agentProfileId('receiver')).displayName).toBe('Receiver');
    expect(() => registry.get(agentProfileId('injected'))).toThrow(/Unknown AgentProfile id/);
  });

  it('exposes frozen profiles and no register/replace/remove/reload API', async () => {
    const registry = await registryFrom([{ ...profile }]);
    const resolved = registry.get(agentProfileId('receiver'));
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(registry)).toBe(true);
    for (const mutator of ['register', 'replace', 'remove', 'reload', 'add', 'set', 'clear']) {
      expect((registry as unknown as Record<string, unknown>)[mutator]).toBeUndefined();
    }
  });

  it('grants no Provider, capability, Tool or approval authority through configuration', async () => {
    const registry = await registryFrom([{ ...profile }]);
    const resolved = registry.get(agentProfileId('receiver')) as unknown as Record<string, unknown>;
    // Structural proof: the resolved value carries exactly the five non-authoritative persona fields.
    expect(Object.keys(resolved).sort())
      .toEqual(['displayName', 'id', 'instructions', 'purpose', 'role']);
    for (const authority of ['providerId', 'provider', 'apiKey', 'credential', 'secret', 'tools',
      'toolAllowlist', 'capabilities', 'capability', 'approved', 'approvalId', 'executablePath',
      'command', 'permissions', 'network']) {
      expect(resolved[authority]).toBeUndefined();
    }
  });
});
