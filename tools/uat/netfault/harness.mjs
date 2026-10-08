// UNC-1 harness: the PRODUCTION connector-write path end to end, with no Discord.
//
// Boots the real `AppModule` (Nest application context, the composition `main.ts` uses minus the Discord adapter)
// over a fresh temp SQLite file migrated to v15 by the real `@quoky/storage-sqlite`, with Slack connector writes on
// through the real `SlackChannelWriter` (the platform `fetch`) and the real v15 receipts repository. It drives
// `ConversationRuntime.handle` with the owner's chat text: the post request (preview), "승인", "Slack 게시 실행".
//
// Only edges are replaced: every `AiProvider` instance's `isAvailable` / `execute` is a counting stub (no model call
// can be made; none is expected on these deterministic turns), and the Slack writer's `post` is wrapped (not replaced)
// to count calls. The network goes through the fault proxy (`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`).
//
// Usage: node tools/uat/netfault/harness.mjs <case1|case1b|case2|case3> <runId>
// Required env: QUOKY_CONNECTOR_WRITE_SLACK_TOKEN, QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS (`quoky-test:<id>`),
// UNC1_PROXY_CONTROL (e.g. http://unc1-proxy:8081). Output: one JSON document on stdout, secrets redacted.

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const appRequire = createRequire(join(ROOT, 'apps/quoky/package.json'));
const storageRequire = createRequire(join(ROOT, 'packages/storage-sqlite/package.json'));

const CASE = process.argv[2];
const RUN_ID = process.argv[3] ?? String(Date.now());
const CASES = new Set(['case1', 'case1b', 'case2', 'case3']);
if (!CASES.has(CASE)) {
  process.stderr.write('usage: harness.mjs <case1|case1b|case2|case3> <runId>\n');
  process.exit(2);
}

const OWNER_ID = '111111111111111111';
const CHANNEL_NAME = 'quoky-test';
const CONTROL = process.env.UNC1_PROXY_CONTROL ?? 'http://unc1-proxy:8081';

const channelsValue = process.env.QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS ?? '';
const channelId = /^quoky-test:([CG][A-Z0-9]{8,20})$/.exec(channelsValue)?.[1];
if (channelId === undefined) {
  process.stderr.write('UNC-1: QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS must be exactly quoky-test:<id>\n');
  process.exit(2);
}
const token = process.env.QUOKY_CONNECTOR_WRITE_SLACK_TOKEN ?? '';

/** Redacts the bot token, any Slack-token-shaped string and the channel id from everything this harness prints. */
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (token.length > 8) text = text.split(token).join('<redacted-token>');
  text = text.replace(/xox[a-z]-[A-Za-z0-9-]+/g, '<redacted-token>');
  return text.split(channelId).join('<channel-id>');
}

/** Proxy control over plain node:http (never through the proxy). */
function control(method, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONTROL);
    const req = http.request(url, { method, agent: false, timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const setMode = (mode) => control('POST', `/mode?m=${encodeURIComponent(mode)}`);
const slackTunnels = async () => (await control('GET', '/log')).events.filter((e) => e.event === 'connect' && e.host === 'slack.com');

const tempDir = mkdtempSync(join(tmpdir(), 'quoky-unc1-'));
const dbPath = join(tempDir, 'quoky.db');
for (const key of Object.keys(process.env)) {
  if (/^(?:QUOKY_|CHUNSIK_|DISCORD_)/.test(key) && !key.startsWith('QUOKY_CONNECTOR_WRITE_SLACK_')) delete process.env[key];
}
Object.assign(process.env, {
  QUOKY_DISCORD_OWNER_IDS: OWNER_ID,
  QUOKY_DB_PATH: dbPath,
  QUOKY_VECTOR_PATH: join(tempDir, 'vectors'),
  QUOKY_WORKSPACE_ROOT: join(tempDir, 'workspaces'),
  QUOKY_OLLAMA_ENABLED: 'false',
  CODEX_CLI_BIN: join(tempDir, 'codex-not-installed'),
  QUOKY_TIMEZONE: 'Asia/Seoul',
  QUOKY_CONNECTOR_WRITES_ENABLED: 'true',
});

// Every console line of the app goes to stderr, redacted; stdout carries only the result document.
for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
  console[method] = (...args) => process.stderr.write(`[app ${method}] ${redact(args.map(String).join(' '))}\n`);
}

const steps = [];
const writerCalls = [];
let providerCalls = 0;

async function main() {
  appRequire('reflect-metadata');
  const { NestFactory } = appRequire('@nestjs/core');
  const core = appRequire('@quoky/core');
  const { AppModule } = appRequire('./dist/app.module.js');
  const { CONNECTOR_WRITE_FLOW } = appRequire('./dist/features/connector-writes.providers.js');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const storage = app.get(core.STORAGE_PROVIDER);
  await storage.init();
  await app.get(core.VECTOR_PROVIDER).init();
  for (const provider of app.get(core.AI_PROVIDERS)) {
    Object.assign(provider, {
      async isAvailable() {
        providerCalls += 1;
        return false;
      },
      async execute() {
        providerCalls += 1;
        throw new Error('UNC-1: no model calls');
      },
    });
  }

  const writer = app.get(core.CHANNEL_MESSAGE_WRITER);
  const flow = app.get(CONNECTOR_WRITE_FLOW);
  const flowWriter = flow?.deps?.writers?.channelMessages;
  const writerFacts = {
    className: writer?.constructor?.name,
    flowHoldsSameInstance: flowWriter === writer,
    timeoutMs: writer?.timeoutMs,
    fetchIsGlobal: writer?.fetchImpl === globalThis.fetch,
  };
  const originalPost = writer.post.bind(writer);
  writer.post = async (request) => {
    const started = Date.now();
    const call = { at: new Date(started).toISOString(), channelMatches: request.channel === channelId };
    writerCalls.push(call);
    const outcome = await originalPost(request);
    call.ms = Date.now() - started;
    call.outcome = { status: outcome.status, reason: outcome.reason, hasExternalRef: Boolean(outcome.externalRef) };
    return outcome;
  };

  const Database = storageRequire('better-sqlite3');
  const raw = new Database(dbPath, { readonly: true });
  const schemaVersion = Number(raw.pragma('user_version', { simple: true }));
  const receipts = () =>
    raw
      .prepare('SELECT status, connector, operation, created_at, updated_at, data FROM connector_write_receipts ORDER BY created_at')
      .all()
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));

  const runtime = app.get(core.ConversationRuntime);
  const context = { platform: 'discord', channelId: `9${RUN_ID.replace(/\D/g, '').slice(-17).padStart(17, '0')}`, userId: OWNER_ID };
  let seq = 0;
  async function turn(label, text) {
    seq += 1;
    const tunnelsBefore = (await slackTunnels()).length;
    const callsBefore = writerCalls.length;
    const result = await runtime.handle({ id: `unc1-${RUN_ID}-${seq}`, context, text, receivedAt: new Date().toISOString() });
    const step = {
      label,
      sent: text,
      reply: result.reply.text,
      writerCalls: writerCalls.length - callsBefore,
      slackTunnels: (await slackTunnels()).length - tunnelsBefore,
      receipts: receipts().map((r) => ({ status: r.status, reason: r.data?.reason, operation: r.operation })),
    };
    steps.push(step);
    return step;
  }

  const caseLabel = { case1: 'case 1 before-send reset', case1b: 'case 1b proxy refused', case2: 'case 2 response lost', case3: 'case 3 slow response' }[CASE];
  const marker = `Quoky UNC-1 test ${CASE} run ${RUN_ID}`;
  const postText = `${marker}: 네트워크 장애 테스트 메시지예요 (${caseLabel}). 무시해 주세요.`;
  const faultMode = { case1: 'refuse', case1b: 'pass', case2: 'cut-after-request', case3: 'stall-after-request' }[CASE];

  await control('POST', '/reset-log');
  await setMode('pass');
  await turn('preview', `#${CHANNEL_NAME}에 게시: ${postText}`);
  await turn('approve', '승인');
  await setMode(faultMode);
  const executed = await turn('execute', 'Slack 게시 실행');
  // Any later attempt is refused at the proxy (and still logged), so a duplicate can be detected without posting.
  await setMode('refuse');
  const afterExecute = receipts();
  await turn('repeat-phrase', 'Slack 게시 실행');
  // Retry: a NEW request for the same text, approved and executed (the proxy still refuses: an attempt is visible in
  // the tunnel log, but nothing can be posted).
  await turn('retry-preview', `#${CHANNEL_NAME}에 게시: ${postText}`);
  const retryApproval = await turn('retry-approve', '승인');
  let retryExecute = null;
  if (retryApproval.reply.includes('실행')) retryExecute = await turn('retry-execute', 'Slack 게시 실행');

  const result = {
    case: CASE,
    runId: RUN_ID,
    marker,
    node: process.version,
    nodeUseEnvProxy: process.env.NODE_USE_ENV_PROXY,
    httpsProxy: process.env.HTTPS_PROXY,
    schemaVersion,
    writerFacts,
    faultMode,
    executeReply: executed.reply,
    receiptAfterExecute: afterExecute.map((r) => ({ status: r.status, reason: r.data?.reason, data: r.data, connector: r.connector })),
    receiptsAtEnd: receipts().map((r) => ({ status: r.status, reason: r.data?.reason, data: r.data })),
    retryExecuted: retryExecute !== null,
    writerCalls,
    providerCalls,
    steps,
    proxyLog: (await control('GET', '/log')).events,
  };
  raw.close();
  await storage.close?.().catch?.(() => undefined);
  await app.close();
  return result;
}

const watchdog = setTimeout(() => {
  process.stderr.write('UNC-1: harness watchdog fired\n');
  process.exit(3);
}, 120_000);

main()
  .then((result) => {
    process.stdout.write(`===UNC1-RESULT-BEGIN===\n${redact(JSON.stringify(result, null, 2))}\n===UNC1-RESULT-END===\n`);
    clearTimeout(watchdog);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${redact(String(error?.stack ?? error))}\n`);
    process.stdout.write(`${redact(JSON.stringify({ case: CASE, error: String(error?.message ?? error), steps, writerCalls }, null, 2))}\n`);
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  });
