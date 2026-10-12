import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Capability,
  ContextBuilder,
  IntentType,
  MemoryManager,
  MemoryType,
  PromptComposer,
  PromptRenderer,
  RiskLevel,
  TaskRunStatus,
  TaskStatus,
} from '@quoky/core';
import type { MemoryRecord, Task, TaskRun, VectorProvider } from '@quoky/core';
import { SqliteStorageProvider } from './index';

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function freshStore(): Promise<SqliteStorageProvider> {
  const dir = mkdtempSync(join(tmpdir(), 'quoky-taskrun-'));
  dirs.push(dir);
  const store = new SqliteStorageProvider({ dbPath: join(dir, 'chunsik.db') });
  await store.init();
  return store;
}

function runOf(id: string, metadata?: TaskRun['metadata']): TaskRun {
  return {
    id,
    taskId: 'task-1',
    attempt: id === 'legacy-run' ? 1 : 2,
    status: TaskRunStatus.SUCCEEDED,
    capability: Capability.GENERAL_CHAT,
    providerId: 'ollama-cli',
    artifactIds: [],
    startedAt: '2026-07-23T00:00:00.000Z',
    finishedAt: '2026-07-23T00:00:01.000Z',
    durationMs: 1_000,
    ...(metadata ? { metadata } : {}),
  };
}

describe('SqliteTaskRunRepository optional metadata compatibility', () => {
  it('round-trips audit metadata without a schema migration', async () => {
    const store = await freshStore();
    const metadata = {
      model: 'llama3.1',
      sanitizedCommand: ['ollama', 'run', 'llama3.1'],
      promptSha256: 'a'.repeat(64),
      captureMode: 'pipe',
      colorDisabled: true,
      outputSanitized: true,
    };

    await store.taskRuns.save(runOf('audited-run', metadata));
    expect((await store.taskRuns.get('audited-run'))?.metadata).toEqual(metadata);
    await store.close();
  });

  it('PRV-3: forEachUsageFinishedBetween visits TaskRun.usage in [from, to) with no schema change', async () => {
    const store = await freshStore();
    const usage = { label: 'codex', reported: true, totalTokens: 5 };
    const visit = async (from: string, to: string) => {
      const seen: Array<[unknown, string]> = [];
      await store.taskRuns.forEachUsageFinishedBetween(from, to, (u, finishedAt) => seen.push([u, finishedAt]));
      return seen;
    };
    const at = (id: string, finishedAt: string, extra: Partial<TaskRun> = {}): TaskRun => ({ ...runOf(id), taskId: `task-${id}`, finishedAt, ...extra });
    await store.taskRuns.save(at('before', '2026-09-30T14:59:59.999Z', { usage }));
    await store.taskRuns.save(at('first', '2026-09-30T15:00:00.000Z', { usage }));
    await store.taskRuns.save(at('last', '2026-10-31T14:59:59.999Z', { usage }));
    await store.taskRuns.save(at('end', '2026-10-31T15:00:00.000Z', { usage }));
    await store.taskRuns.save(at('none', '2026-10-05T00:00:00.000Z', { metadata: { model: 'm' } }));
    // A provider-owned `metadata.usage` is not the Usage value object and is never read as one.
    await store.taskRuns.save(at('metadata-only', '2026-10-05T00:00:00.000Z', { metadata: { usage } }));
    await store.taskRuns.save(at('bare', '2026-10-05T00:00:00.000Z'));
    const seen = await visit('2026-09-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z');
    // Only the usage value and the timestamp reach the visitor, never the whole run.
    expect(seen.sort((a, b) => a[1].localeCompare(b[1]))).toEqual([
      [usage, '2026-09-30T15:00:00.000Z'],
      [usage, '2026-10-31T14:59:59.999Z'],
    ]);
    expect((await store.taskRuns.get('first'))?.usage).toEqual(usage);
    await store.close();
  });

  it('PRV-3: forEachUsageFinishedBetween streams many runs one at a time and the visitor sees each once', async () => {
    const store = await freshStore();
    const n = 2_000;
    for (let i = 0; i < n; i += 1) {
      const finishedAt = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
      await store.taskRuns.save({ ...runOf(`bulk-${i}`), taskId: `task-bulk-${i}`, finishedAt, usage: { label: i % 2 === 0 ? 'a' : 'b', reported: true, totalTokens: 1 } });
    }
    let count = 0;
    let sum = 0;
    await store.taskRuns.forEachUsageFinishedBetween('2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', (u) => {
      count += 1;
      sum += (u as { totalTokens: number }).totalTokens;
    });
    expect([count, sum]).toEqual([n, n]);
    await store.close();
  });

  it('reads legacy TaskRun JSON with no metadata', async () => {
    const store = await freshStore();
    await store.taskRuns.save(runOf('legacy-run'));

    const legacy = await store.taskRuns.get('legacy-run');
    expect(legacy).not.toHaveProperty('metadata');
    await store.close();
  });

  it('feeds deterministic SQLite history and GENERAL_CHAT instructions into the rendered provider request', async () => {
    const store = await freshStore();
    const sessionId = 'runtime-session';
    const timestamp = '2026-08-18T00:00:00.000Z';
    const records: MemoryRecord[] = Array.from({ length: 12 }, (_, index) => ({
      id: `memory-${index}`,
      type: MemoryType.SHORT_TERM,
      scope: { sessionId, channelId: 'discord-channel', userId: 'discord-user' },
      content: index === 10 ? '파란 하늘이라고 말했어' : `old-topic-${index}`,
      metadata: { role: index % 2 === 0 ? 'user' : 'assistant' },
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
    for (const record of records) await store.memories.save(record);

    const vector = {} as VectorProvider;
    const memory = new MemoryManager(store, vector);
    const task: Task = {
      id: 'runtime-task',
      title: '내가 방금 뭐라고 했지?',
      description: '내가 방금 뭐라고 했지?',
      status: TaskStatus.PENDING,
      intent: {
        type: IntentType.CHAT,
        capability: Capability.GENERAL_CHAT,
        confidence: 1,
        requiresWork: true,
        summary: '내가 방금 뭐라고 했지?',
      },
      riskLevel: RiskLevel.LOW,
      context: {
        platform: 'discord',
        channelId: 'discord-channel',
        userId: 'discord-user',
      },
      sessionId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const bundle = await new ContextBuilder(memory).build(task);
    expect(bundle.conversationTranscript.map((entry) => entry.content)).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `old-topic-${index + 2}`),
      '파란 하늘이라고 말했어',
      'old-topic-11',
    ]);
    expect(
      bundle.conversationTranscript.filter((entry) => entry.provenance === 'USER').at(-1)?.content,
    ).toBe('파란 하늘이라고 말했어');

    const request = new PromptRenderer().render(new PromptComposer().compose(task, bundle), {
      capability: Capability.GENERAL_CHAT,
    });
    expect(request.prompt).toContain(
      '# Developer\nMANDATORY LANGUAGE RULE: Respond in the same language the user used in their current message.',
    );
    expect(request.prompt).toContain(
      'Your entire response must use that language unless the user explicitly requests a different language in their current message.',
    );
    expect(request.prompt).toContain(
      'the final USER entry before the current Task is the immediately previous User message',
    );
    expect(request.prompt).toContain(
      'do not mention, continue, summarize, or inject unrelated topics from prior conversations or background resources',
    );
    expect(request.prompt).toContain('파란 하늘이라고 말했어');
    expect(request.prompt).toContain('내가 방금 뭐라고 했지?');
    await store.close();
  });
});
