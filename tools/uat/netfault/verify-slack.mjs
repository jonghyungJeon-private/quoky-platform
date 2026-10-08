// UNC-1 read-only verifier, run on the HOST (no proxy): lists the UNC-1 test posts in the allowlisted channel with
// `conversations.history` and the bot token. Prints only ts, the run marker and counts; never the token or channel id.
//
// Usage: node tools/uat/netfault/verify-slack.mjs <env-file> <oldest-unix-seconds> [marker-substring]
import { readFileSync } from 'node:fs';

const [envFile, oldest, filter = 'Quoky UNC-1 test'] = process.argv.slice(2);
if (!envFile || !oldest) {
  process.stderr.write('usage: verify-slack.mjs <env-file> <oldest-unix-seconds> [marker]\n');
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
const token = env.QUOKY_CONNECTOR_WRITE_SLACK_TOKEN ?? '';
const channel = /^quoky-test:([CG][A-Z0-9]{8,20})$/.exec(env.QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS ?? '')?.[1];
if (!token || !channel) {
  process.stderr.write('verify-slack: token or channel missing from the env file\n');
  process.exit(2);
}
for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) delete process.env[key];

const url = new URL('https://slack.com/api/conversations.history');
url.searchParams.set('channel', channel);
url.searchParams.set('oldest', String(oldest));
url.searchParams.set('limit', '200');
const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
const payload = await response.json();
if (!payload.ok) {
  console.log(JSON.stringify({ ok: false, error: payload.error, needed: payload.needed }));
  process.exit(1);
}
const posts = (payload.messages ?? [])
  .filter((m) => typeof m.text === 'string' && m.text.includes(filter))
  .map((m) => ({
    ts: m.ts,
    marker: /Quoky UNC-1 test (case\w+) run (\w+)/.exec(m.text)?.slice(1, 3).join(' run ') ?? null,
    fromBot: Boolean(m.bot_id),
    subtype: m.subtype ?? null,
  }))
  .sort((a, b) => Number(a.ts) - Number(b.ts));
console.log(JSON.stringify({ ok: true, oldest: String(oldest), scanned: payload.messages?.length ?? 0, matching: posts.length, posts }, null, 2));
