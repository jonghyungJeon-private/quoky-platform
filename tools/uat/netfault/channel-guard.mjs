// UNC-1 target guard, run by harness.mjs as a SEPARATE short-lived process (so no keep-alive connection or proxy
// tunnel it opens can ever carry a later write): Slack `conversations.info` (bot token, read-only) for the approved
// channel id. Prints one JSON line with the verdict and the non-secret facts; never the token. Exit 0 = verified.
//
// Usage: node channel-guard.mjs <approved-channel-id>   (token: QUOKY_CONNECTOR_WRITE_SLACK_TOKEN)
const [approved] = process.argv.slice(2);
const token = process.env.QUOKY_CONNECTOR_WRITE_SLACK_TOKEN ?? '';
const EXPECTED_NAME = 'quoky-test';

function finish(verdict) {
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  process.exit(verdict.verified === true ? 0 : 1);
}

if (!/^[CG][A-Z0-9]{8,20}$/.test(approved ?? '') || token === '') finish({ verified: false, error: 'usage' });
try {
  const url = new URL('https://slack.com/api/conversations.info');
  url.searchParams.set('channel', approved);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || payload.ok !== true) {
    finish({ verified: false, error: typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}` });
  }
  const ch = payload.channel ?? {};
  const facts = { idMatches: ch.id === approved, name: typeof ch.name === 'string' ? ch.name : null, isIm: ch.is_im === true, isMpim: ch.is_mpim === true };
  if (!facts.idMatches) finish({ verified: false, error: 'another channel id', ...facts });
  if (facts.name !== EXPECTED_NAME) finish({ verified: false, error: 'not quoky-test', ...facts });
  if (facts.isIm || facts.isMpim) finish({ verified: false, error: 'dm or group dm', ...facts });
  finish({ verified: true, ...facts, isPrivate: ch.is_private === true });
} catch (error) {
  finish({ verified: false, error: `transport ${error?.cause?.code ?? error?.name ?? 'error'}` });
}
