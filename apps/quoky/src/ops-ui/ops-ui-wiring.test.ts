import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AiProviderManager,
  ApprovalStatus,
  CONNECTOR_PROVIDERS,
  Capability,
  FeedbackRecorder,
  MemoryCommandService,
  PLATFORM_ADAPTER,
  REMINDER_REPOSITORY,
  ReminderConversationService,
  ReminderStatus,
  RiskLevel,
  STORAGE_PROVIDER,
} from '@quoky/core';
import type { AiProvider, DurableMemoryQuery, Logger, LogFields, MemoryRecord, Reminder } from '@quoky/core';

import type { BackupStatus } from '../ops/backup-job';
import { ReminderTickDriver } from '../reminders/reminder-tick-driver';
import { cookieFrom, send } from './test-support/http-client';
import { OpsErrorRing } from './snapshot/error-ring';
import { opsSnapshotSources, opsUiErrorRing, recordOpsUiErrors, startOpsUi } from './ops-ui-wiring';
import type { OpsUiContainer, OpsUiHandle, OpsUiWiringInput } from './ops-ui-wiring';

const GITHUB_TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

let dir: string;
const handles: OpsUiHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ops-ui-wiring-'));
  mkdirSync(path.join(dir, 'data'));
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  rmSync(dir, { recursive: true, force: true });
});

function fakeProvider(id: string, capabilities: Capability[], available: boolean): AiProvider {
  return {
    id,
    capabilities: capabilities.map((capability) => ({ capability, priority: 1 })),
    isAvailable: async () => available,
    execute: async () => {
      throw new Error('execute must never be called by the operations UI');
    },
  } as unknown as AiProvider;
}

interface Fakes {
  readonly lookups: unknown[];
  readonly memoryQueries: DurableMemoryQuery[];
  readonly container: OpsUiContainer;
}

function fakes(options: { owners?: Record<string, string>; extra?: ReadonlyArray<[unknown, unknown]> } = {}): Fakes {
  const lookups: unknown[] = [];
  const memoryQueries: DurableMemoryQuery[] = [];
  const owners = options.owners ?? { 'owner-discord-id': 'actor-1' };
  const reminder: Reminder = {
    id: 'r1',
    actorId: 'actor-1',
    displayNo: 1,
    status: ReminderStatus.SCHEDULED,
    kind: 'TEXT',
    body: '회의 준비',
    schedule: { type: 'ONCE', at: '2026-10-07T00:00:00.000Z' },
    timeZone: 'Asia/Seoul',
    origin: { platform: 'discord', channelId: 'dm', userId: 'owner-discord-id' },
    nextFireAt: '2026-10-07T00:00:00.000Z',
    occurrenceAt: '2026-10-07T00:00:00.000Z',
    attempt: 0,
    createdAt: '2026-10-06T00:00:00.000Z',
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
  const memory = (id: string, archived: boolean): MemoryRecord =>
    ({
      id,
      type: 'LONG_TERM',
      scope: { userId: 'actor-1' },
      content: `MEMORY_CONTENT_BODY_MARKER ${GITHUB_TOKEN}`,
      metadata: archived ? { archivedAt: '2026-10-05T00:00:00.000Z' } : {},
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    }) as unknown as MemoryRecord;
  const values = new Map<unknown, unknown>([
    [
      STORAGE_PROVIDER,
      {
        actors: {
          findByExternalIdentity: async (platform: string, externalId: string) =>
            platform === 'discord' && owners[externalId] ? { id: owners[externalId] } : null,
        },
        approvals: {
          list: async () => [
            {
              id: 'approval-1234',
              executionPlanRef: { id: 'plan', goal: `APPROVAL_GOAL_BODY_MARKER ${GITHUB_TOKEN}` },
              status: ApprovalStatus.PENDING,
              riskLevel: RiskLevel.HIGH,
              reason: 'APPROVAL_REASON_BODY_MARKER',
              requestedBy: 'x',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
        memories: {
          findDurableCandidates: async (query: DurableMemoryQuery) => {
            memoryQueries.push(query);
            return [memory('m1', true), memory('m2', false), memory('m3', true)];
          },
        },
      },
    ],
    [
      AiProviderManager,
      new AiProviderManager(
        [
          fakeProvider('provider-id-marker-claude', [Capability.GENERAL_CHAT], true),
          fakeProvider('provider-id-marker-ollama', [Capability.GENERAL_CHAT], false),
        ],
        { availabilityTtlMs: 0 },
      ),
    ],
    [
      REMINDER_REPOSITORY,
      {
        listActiveByActor: async () => [reminder],
        getByDisplayNo: async (actorId: string, displayNo: number) => (actorId === 'actor-1' && displayNo === 1 ? reminder : null),
      },
    ],
    [ReminderTickDriver, { state: 'RUNNING' }],
    [PLATFORM_ADAPTER, { readConnectedIdentity: async () => ({ botUserId: 'BOT_ID_MARKER', guildIds: [], channels: [], unreachableChannelIds: [] }) }],
    [CONNECTOR_PROVIDERS, [{ source: 'jira', readOnly: true, isAvailable: async () => true }]],
    [
      FeedbackRecorder,
      {
        summarize: async () => ({ since: '', turnCount: 3, signals: [], byCapability: [], byIntent: [], recentNegative: [] }),
        trend: async () => null,
      },
    ],
    ...(options.extra ?? []),
  ]);
  const container: OpsUiContainer = {
    get<T>(token: unknown): T {
      lookups.push(token);
      if (!values.has(token)) throw new Error('not bound');
      return values.get(token) as T;
    },
  };
  return { lookups, memoryQueries, container };
}

const BACKUP: BackupStatus = {
  schema: 'quoky.backup-status/1',
  updatedAt: '2026-10-06T00:00:00.000Z',
  enabled: false,
  state: 'DISABLED',
  lastRun: null,
  lastVerified: null,
  retainedCount: 0,
  retained: [],
  nextScheduledAt: null,
};

function captureLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (message: string, fields?: LogFields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

function input(container: OpsUiContainer, env: NodeJS.ProcessEnv, extra: Partial<OpsUiWiringInput> = {}): OpsUiWiringInput {
  return {
    app: container,
    config: {
      storage: { dbPath: ':memory:' } as OpsUiWiringInput['config']['storage'],
      reminders: { enabled: true, channelDelivery: false, timeZone: 'Asia/Seoul' },
      host: { recentStarts: 0 },
      discord: { ownerIds: ['owner-discord-id'] },
    },
    ops: { backupStatus: () => BACKUP },
    instanceLockHeld: false,
    identityVerified: false,
    env,
    cwd: dir,
    errorRing: new OpsErrorRing(),
    ...extra,
  };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function connectable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

describe('OPS-1 wiring (ADR-0113 D1/D8)', () => {
  it('opens no port and looks nothing up when QUOKY_OPS_UI_ENABLED is unset or false', async () => {
    const port = await freePort();
    for (const env of [{ QUOKY_OPS_UI_PORT: String(port) }, { QUOKY_OPS_UI_ENABLED: 'false', QUOKY_OPS_UI_PORT: String(port) }]) {
      const f = fakes();
      const handle = await startOpsUi(input(f.container, env));
      handles.push(handle);
      expect(handle.port).toBeUndefined();
      expect(f.lookups).toEqual([]);
      expect(await connectable(port)).toBe(false);
      expect(existsSync(path.join(dir, 'data', 'ops-ui.token'))).toBe(false);
    }
  });

  it('disables only the UI on an invalid flag, logging the code and never the value', async () => {
    const logger = captureLogger();
    const handle = await startOpsUi(input(fakes().container, { QUOKY_OPS_UI_ENABLED: 'yes-please' }, { logger }));
    expect(handle.port).toBeUndefined();
    expect(logger.lines).toEqual(['warn ops-ui.disabled {"reason":"OPS_UI_ENABLED_INVALID"}']);
  });

  it('disables only the UI when the port is taken', async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      const logger = captureLogger();
      const handle = await startOpsUi(input(fakes().container, { QUOKY_OPS_UI_ENABLED: 'true', QUOKY_OPS_UI_PORT: String(port) }, { logger }));
      expect(handle.port).toBeUndefined();
      expect(logger.lines.join('\n')).toContain('ops-ui.unavailable {"reason":"PORT_IN_USE"}');
      expect(existsSync(path.join(dir, 'data', 'ops-ui.token'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('disables only the UI when a container binding is missing', async () => {
    const logger = captureLogger();
    const empty: OpsUiContainer = {
      get() {
        throw new Error('not bound');
      },
    };
    const handle = await startOpsUi(input(empty, { QUOKY_OPS_UI_ENABLED: 'true' }, { portOverride: 0, logger }));
    expect(handle.port).toBeUndefined();
    expect(logger.lines).toEqual(['warn ops-ui.unavailable {"reason":"WIRING_FAILED"}']);
  });

  it('fails closed with the typed bind error for a non-loopback host', async () => {
    await expect(
      startOpsUi(input(fakes().container, { QUOKY_OPS_UI_ENABLED: 'true' }, { portOverride: 0, host: '0.0.0.0' })),
    ).rejects.toMatchObject({ code: 'OPS_UI_BIND_NOT_LOOPBACK' });
    expect(existsSync(path.join(dir, 'data', 'ops-ui.token'))).toBe(false);
  });

  it('serves the read-only dashboard from the container when enabled, and removes the token on stop', async () => {
    const f = fakes();
    const logger = captureLogger();
    const handle = await startOpsUi(input(f.container, { QUOKY_OPS_UI_ENABLED: 'true' }, { portOverride: 0, logger }));
    handles.push(handle);
    const port = handle.port ?? 0;
    expect(port).toBeGreaterThan(0);
    const tokenFile = path.join(dir, 'data', 'ops-ui.token');
    const token = readFileSync(tokenFile, 'utf8').trim();

    const signIn = await send({ port, method: 'POST', path: '/session', origin: `http://127.0.0.1:${port}`, form: { token } });
    const page = await send({ port, path: '/', cookie: cookieFrom(signIn) });
    expect(page.status).toBe(200);
    expect(page.body).toContain('회의 준비');
    expect(page.body).toContain('approval');
    expect(page.body).toContain('GENERAL_CHAT');
    expect(page.body).toContain('일부 불가 (degraded)');
    expect(page.body).toContain('연결됨');
    for (const hidden of ['provider-id-marker', 'APPROVAL_GOAL_BODY_MARKER', 'APPROVAL_REASON_BODY_MARKER', 'MEMORY_CONTENT_BODY_MARKER', GITHUB_TOKEN, 'BOT_ID_MARKER', token]) {
      expect(page.body).not.toContain(hidden);
    }
    expect(logger.lines.join('\n')).not.toContain(token);

    await handle.stop();
    expect(existsSync(tokenFile)).toBe(false);
    expect(await connectable(port)).toBe(false);
  });

  it('counts archived memories by their flag, asking the store for the archive', async () => {
    const f = fakes();
    const sources = opsSnapshotSources(input(f.container, {}), new OpsErrorRing());
    expect(await sources.archivedMemoryCount?.('actor-1')).toEqual({ count: 2, capped: false });
    expect(f.memoryQueries[0]).toMatchObject({ scope: { userId: 'actor-1' }, archived: 'only', excludeSuperseded: true });
  });

  it('resolves the owner Actor read-only: one Actor, none, or several', async () => {
    const one = opsSnapshotSources(input(fakes().container, {}), new OpsErrorRing());
    expect(await one.owner()).toEqual({ status: 'RESOLVED', actorId: 'actor-1' });
    const none = opsSnapshotSources(input(fakes({ owners: {} }).container, {}), new OpsErrorRing());
    expect(await none.owner()).toEqual({ status: 'NONE' });
    const several = opsSnapshotSources(
      input(fakes({ owners: { a: 'actor-1', b: 'actor-2' } }).container, {}, {
        config: { ...input(fakes().container, {}).config, discord: { ownerIds: ['a', 'b'] } },
      }),
      new OpsErrorRing(),
    );
    expect(await several.owner()).toEqual({ status: 'AMBIGUOUS' });
  });

  it('feeds composition-root errors into the process-wide ring', () => {
    const inner = captureLogger();
    const before = opsUiErrorRing.size;
    recordOpsUiErrors(inner, 'quoky').error('inbound handling failed', { stage: 'inbound', errorName: 'TypeError' });
    expect(opsUiErrorRing.size).toBe(Math.min(before + 1, 100));
    expect(opsUiErrorRing.recent(1)[0]).toMatchObject({ component: 'quoky', category: 'inbound', code: 'TypeError' });
    expect(inner.lines).toHaveLength(1);
  });

  it('wires OPS-2 handling to the container chat services, acting as the owner Actor', async () => {
    const cancels: unknown[] = [];
    const forgetRequests: unknown[] = [];
    const reminderService = {
      cancelByDisplayNo: async (request: unknown) => {
        cancels.push(request);
        return { status: 'CANCELED', displayNo: 1, reply: 'CHAT_REPLY_BODY_MARKER' };
      },
    };
    const memoryService = {
      archiveDays: 7,
      listable: async () => [],
      requestForgetConfirmation: async (request: unknown, number: number) => {
        forgetRequests.push([request, number]);
        return { status: 'NOT_FOUND', number, total: 0 };
      },
      confirmForget: async () => ({ outcome: 'confirm-unknown', text: '', status: 'RESPONDED' }),
    };
    const f = fakes({ extra: [[ReminderConversationService, reminderService], [MemoryCommandService, memoryService]] });
    const handle = await startOpsUi(input(f.container, { QUOKY_OPS_UI_ENABLED: 'true' }, { portOverride: 0 }));
    handles.push(handle);
    const port = handle.port ?? 0;
    const token = readFileSync(path.join(dir, 'data', 'ops-ui.token'), 'utf8').trim();
    const cookie = cookieFrom(await send({ port, method: 'POST', path: '/session', origin: `http://127.0.0.1:${port}`, form: { token } }));
    const dashboard = (await send({ port, path: '/', cookie })).body;
    expect(dashboard).toContain('href="/actions/reminders/cancel?no=1"');
    expect(dashboard).toContain('href="/memories"');

    const confirmPage = (await send({ port, path: '/actions/reminders/cancel?no=1', cookie })).body;
    const csrf = /name="csrf" value="([^"]+)"/.exec(confirmPage)?.[1] ?? '';
    const nonce = /name="nonce" value="([^"]+)"/.exec(confirmPage)?.[1] ?? '';
    const done = await send({ port, method: 'POST', path: '/actions/reminders/cancel', origin: `http://127.0.0.1:${port}`, cookie, form: { csrf, nonce } });
    expect(done.body).toContain('CANCELED');
    expect(done.body).not.toContain('CHAT_REPLY_BODY_MARKER');
    expect(cancels).toEqual([{ actorId: 'actor-1', displayNo: 1, now: expect.any(String) }]);

    await send({ port, method: 'POST', path: '/actions/memories/forget/request', origin: `http://127.0.0.1:${port}`, cookie, form: { csrf, number: '2' } });
    expect(forgetRequests).toEqual([[{ actorId: 'actor-1', now: expect.any(String) }, 2]]);
  });

  it('serves no handling link or route when the chat services are not bound (Phase 1 only)', async () => {
    const handle = await startOpsUi(input(fakes().container, { QUOKY_OPS_UI_ENABLED: 'true' }, { portOverride: 0 }));
    handles.push(handle);
    const port = handle.port ?? 0;
    const token = readFileSync(path.join(dir, 'data', 'ops-ui.token'), 'utf8').trim();
    const cookie = cookieFrom(await send({ port, method: 'POST', path: '/session', origin: `http://127.0.0.1:${port}`, form: { token } }));
    const dashboard = (await send({ port, path: '/', cookie })).body;
    expect(dashboard).not.toContain('/actions/');
    expect(dashboard).not.toContain('href="/memories"');
    expect((await send({ port, path: '/memories', cookie })).status).toBe(404);
  });

  it('disables handling links when the owner ids map to several Actors', async () => {
    const f = fakes({
      owners: { a: 'actor-1', b: 'actor-2' },
      extra: [[ReminderConversationService, { cancelByDisplayNo: async () => ({ status: 'CANCELED' }) }]],
    });
    const base = input(f.container, { QUOKY_OPS_UI_ENABLED: 'true' }, { portOverride: 0 });
    const handle = await startOpsUi({ ...base, config: { ...base.config, discord: { ownerIds: ['a', 'b'] } } });
    handles.push(handle);
    const port = handle.port ?? 0;
    const token = readFileSync(path.join(dir, 'data', 'ops-ui.token'), 'utf8').trim();
    const cookie = cookieFrom(await send({ port, method: 'POST', path: '/session', origin: `http://127.0.0.1:${port}`, form: { token } }));
    expect((await send({ port, path: '/', cookie })).body).not.toContain('/actions/reminders/cancel');
    const refused = await send({ port, path: '/actions/reminders/cancel?no=1', cookie });
    expect(refused.body).toContain('ACTIONS_DISABLED');
    expect(refused.body).not.toContain('name="nonce"');
  });
});
