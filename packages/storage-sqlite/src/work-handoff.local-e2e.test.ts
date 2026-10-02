import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentProfileRegistry,
  ArtifactKind,
  ArtifactManager,
  ExecutionKind,
  ExecutionReceiptOutcome,
  ProactiveDelegationDisposition,
  ProactiveDelegationService,
  ResourceRef,
  TriggerSourceKind,
  WorkHandoffManager,
  WorkHandoffConsumptionService,
  WorkItemStatus,
  WorkManager,
  agentProfileId,
} from '@quoky/core';
import type { AgentProfile, ExecutionReceipt } from '@quoky/core';
import { SqliteStorageProvider } from './index';
import { LATEST_SCHEMA_VERSION } from './migrations';
import Database from 'better-sqlite3';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function profile(id: string): AgentProfile {
  return {
    id: agentProfileId(id),
    displayName: id,
    role: 'bounded role',
    purpose: 'bounded purpose',
    instructions: 'bounded instructions',
  };
}

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'quoky-work-handoff-e2e-'));
  directories.push(directory);
  return join(directory, 'ephemeral.db');
}

describe('CAP-014 Local E2E — real Core/Application/SQLite v10, no external boundary', () => {
  it('evaluates and durably records proactive delegation across the real composition chain', async () => {
    const path = databasePath();
    const storage = new SqliteStorageProvider({ dbPath: path });
    await storage.init();
    const workItem = await new WorkManager(storage).create({
      actorId: 'actor-1',
      origin: 'conversation',
    });
    const artifact = await new ArtifactManager(storage).create({
      kind: ArtifactKind.CODE_DIFF,
      title: 'Bounded diff',
    });
    const receipt: ExecutionReceipt = {
      id: 'receipt-1',
      executionKind: ExecutionKind.COMMAND,
      sourceId: 'command-1',
      executionPlanId: 'plan-1',
      authorization: { kind: 'NOT_REQUIRED' },
      outcome: ExecutionReceiptOutcome.SUCCEEDED,
      recordedAt: '2026-09-02T00:00:00.000Z',
    };
    await storage.executionReceipts.insert(receipt);
    const registry = new AgentProfileRegistry([profile('builder'), profile('reviewer')]);
    const handoffManager = new WorkHandoffManager(storage, registry);
    const service = new ProactiveDelegationService(storage, registry, handoffManager);
    const request = {
      trigger: {
        kind: TriggerSourceKind.INTERNAL_CONTINUATION,
        provenanceId: 'work-1:continuation-1',
        observedAt: '2026-09-04T00:00:00.000Z',
      },
      workItemId: workItem.id,
      fromAgentProfileId: agentProfileId('builder'),
      toAgentProfileId: agentProfileId('reviewer'),
      objective: 'Review the durable handoff.',
      handoffId: 'handoff-m3e-2',
      createdAt: '2026-09-04T00:00:01.000Z',
      resourceRefs: [new ResourceRef({ source: 'jira', externalId: 'CAP-014' })],
      artifactIds: [artifact.id],
      executionReceiptIds: [receipt.id],
    } as const;
    await expect(service.evaluate(request)).resolves.toMatchObject({
      disposition: ProactiveDelegationDisposition.DELEGATE,
    });
    await expect(storage.workHandoffs.get(request.handoffId)).resolves.toBeNull();
    const handoff = await service.record(request);
    await storage.close();

    const reopened = new SqliteStorageProvider({ dbPath: path });
    await reopened.init();
    await expect(reopened.workHandoffs.get(handoff.id)).resolves.toEqual(handoff);
    await expect(reopened.workHandoffs.listByWorkItem(workItem.id)).resolves.toEqual([handoff]);
    await expect(reopened.workHandoffs.listByFromAgent(agentProfileId('builder'))).resolves.toEqual([handoff]);
    await expect(reopened.workHandoffs.listByToAgent(agentProfileId('reviewer'))).resolves.toEqual([handoff]);
    const consumer = new WorkHandoffConsumptionService(reopened, registry);
    const before = await reopened.workItems.get(workItem.id);
    const decision = await consumer.evaluate(handoff.id);
    expect(decision).toMatchObject({ handoffId: handoff.id, disposition: 'CONTINUE', reason: 'ACTIVE_WORK_ITEM' });
    expect(Object.isFrozen(decision)).toBe(true);
    await expect(reopened.workItems.get(workItem.id)).resolves.toEqual(before);
    await new WorkManager(reopened).transition(workItem.id, WorkItemStatus.COMPLETED);
    await expect(consumer.evaluate(handoff.id)).resolves.toMatchObject({
      disposition: 'NO_ACTION', reason: 'WORK_ITEM_COMPLETED',
    });
    await expect(reopened.workHandoffs.listByWorkItem(workItem.id)).resolves.toEqual([handoff]);
    await reopened.close();
    const db = new Database(path, { readonly: true });
    try { expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION); } finally { db.close(); }
  });
});
