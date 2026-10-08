// UNC-1 case-specific result acceptance (run by run.sh after every harness run). Exit 0 only when the result JSON
// exists, carries every expected field, and shows exactly the expected outcome and tunnel pattern for its case:
//
//   all     schema v15; target guard verified (or the offline placeholder, case1/case1b only); one writer call on the
//           execute step; the repeated phrase makes no writer call and opens no tunnel; NO pass-mode tunnel in the run
//           (the guard runs in its own process before the log is reset, and the proxy closes every tunnel on each mode
//           change, so nothing opened in pass mode can carry the write).
//   case1   NOT_SENT/UNAVAILABLE; the execute step opened exactly one tunnel, in `refuse` mode, and it was reset;
//           no tunnel ever connected upstream.
//   case1b  NOT_SENT/UNAVAILABLE; the execute step opened no tunnel; no tunnel ever connected upstream.
//   case2/3 UNCERTAIN/TRANSPORT; exactly one tunnel in the whole run carried the POST (`request-forwarded`), it was
//           opened by the execute step in the case's fault mode (`cut-after-request` / `stall-after-request`); case2
//           also shows the client cut on that tunnel.
//
// Usage: node validate-result.mjs <result.json> <case>
import { readFileSync } from 'node:fs';

const [file, expectedCase] = process.argv.slice(2);
const problems = [];
let d;
try {
  d = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  console.error('result JSON missing or unreadable');
  process.exit(1);
}
const need = (ok, what) => {
  if (!ok) problems.push(what);
};
const FAULT_MODE = { case1: 'refuse', case2: 'cut-after-request', case3: 'stall-after-request' };

need(['case1', 'case1b', 'case2', 'case3'].includes(expectedCase), 'known case');
need(d.case === expectedCase, 'case');
need(d.schemaVersion === 15, 'schemaVersion 15');
need(typeof d.executeReply === 'string' && d.executeReply.length > 0, 'executeReply');
for (const key of ['receiptAfterExecute', 'receiptsAtEnd', 'writerCalls', 'steps', 'proxyLog']) need(Array.isArray(d[key]), key);
const guardOk =
  d.targetGuard?.verified === true ||
  (d.targetGuard?.offlinePlaceholder === true && (expectedCase === 'case1' || expectedCase === 'case1b'));
need(guardOk, 'targetGuard');

const steps = Array.isArray(d.steps) ? d.steps : [];
const step = (label) => steps.find((s) => s.label === label);
const execute = step('execute');
const repeat = step('repeat-phrase');
need(execute !== undefined && Array.isArray(execute.tunnels), 'execute step with tunnels');
need(repeat !== undefined && Array.isArray(repeat.tunnels), 'repeat-phrase step with tunnels');
need(execute?.writerCalls === 1, 'execute: exactly one writer call');
need(repeat?.writerCalls === 0 && repeat?.tunnels?.length === 0, 'repeat-phrase: no writer call, no tunnel');

const receipt = Array.isArray(d.receiptAfterExecute) && d.receiptAfterExecute.length === 1 ? d.receiptAfterExecute[0] : undefined;
need(receipt !== undefined, 'exactly one receipt after execute');

const log = Array.isArray(d.proxyLog) ? d.proxyLog : [];
const connects = log.filter((e) => e.event === 'connect');
const eventsOf = (name) => log.filter((e) => e.event === name);
need(connects.every((e) => e.mode !== 'pass'), 'no pass-mode tunnel in the run');
const executeTunnels = execute?.tunnels ?? [];

if (expectedCase === 'case1' || expectedCase === 'case1b') {
  need(receipt?.status === 'NOT_SENT' && receipt?.reason === 'UNAVAILABLE', 'receipt NOT_SENT/UNAVAILABLE');
  need(eventsOf('upstream-connected').length === 0, 'no tunnel connected upstream');
  need(eventsOf('request-forwarded').length === 0, 'no request bytes forwarded');
  if (expectedCase === 'case1') {
    need(executeTunnels.length === 1 && executeTunnels[0]?.mode === FAULT_MODE.case1, 'execute: one refuse-mode tunnel');
    const id = executeTunnels[0]?.tunnel;
    need(eventsOf('refused-reset').some((e) => e.tunnel === id), 'execute tunnel was reset');
  } else {
    need(executeTunnels.length === 0, 'execute: no tunnel (proxy port refused)');
  }
} else if (expectedCase === 'case2' || expectedCase === 'case3') {
  need(receipt?.status === 'UNCERTAIN' && receipt?.reason === 'TRANSPORT', 'receipt UNCERTAIN/TRANSPORT');
  const carriers = eventsOf('request-forwarded').map((e) => e.tunnel);
  need(carriers.length === 1, 'exactly one tunnel carried the POST');
  const carrier = executeTunnels.find((t) => t.tunnel === carriers[0]);
  need(carrier !== undefined && carrier.mode === FAULT_MODE[expectedCase], 'the POST tunnel was opened by execute in the fault mode');
  if (expectedCase === 'case2') need(eventsOf('client-cut-reset').some((e) => e.tunnel === carriers[0]), 'client cut on the POST tunnel');
}

if (problems.length > 0) {
  console.error(`result rejected (${expectedCase}): ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`result accepted (${expectedCase})`);
