/**
 * `pnpm security:secret-scan [--no-history] [--no-tree] [--json]`: scans the repository (cwd) for credential-shaped
 * values (ADR-0121 S0). Prints file, commit, line and the span's fingerprint with the value masked; exit 0 = no gating
 * hit, 1 = at least one (a non-test hit, or an issued-key candidate in any path, whose fingerprint is not reviewed),
 * 2 = usage or git failure. Every span is reported: there is no hit cap and no size cap.
 */
import {
  applyReviewed,
  formatHit,
  gatingHits,
  historyByCommit,
  loadReviewed,
  scanHistory,
  scanWorkingTree,
  summarize,
  type SecretScanHit,
} from './secret-scan';

async function main(argv: readonly string[]): Promise<number> {
  const known = new Set(['--no-history', '--no-tree', '--json', '--summary']);
  if (argv.some((a) => !known.has(a))) {
    process.stderr.write('usage: secret-scan [--no-history] [--no-tree] [--json] [--summary]\n');
    return 2;
  }
  const cwd = process.cwd();
  const allHits: SecretScanHit[] = [];
  let files = 0;
  let commits = 0;
  let unreadable: string[] = [];
  if (!argv.includes('--no-tree')) {
    const tree = await scanWorkingTree(cwd);
    for (const hit of tree.hits) allHits.push(hit);
    files = tree.files;
    unreadable = tree.unreadable;
  }
  if (!argv.includes('--no-history')) {
    const history = await scanHistory(cwd);
    for (const hit of history.hits) allHits.push(hit);
    commits = history.commits;
  }
  const hits = applyReviewed(allHits, loadReviewed(cwd));
  const gating = gatingHits(hits);
  const rotate = hits.filter((h) => h.issuedCandidate && !h.reviewed);
  const reviewedCount = hits.filter((h) => h.reviewed).length;
  const placeholderCount = hits.filter((h) => h.classification === 'placeholder').length;
  const totals = `${hits.length} hit(s), ${gating.length} gating (non-test or issued-key candidate), ${reviewedCount} reviewed, ${placeholderCount} placeholder`;
  const tail = `${files} file(s), ${commits} commit(s), ${unreadable.length} unreadable tracked path(s)`;
  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ hits, summary: summarize(hits), files, commits, unreadable, hitCount: hits.length, gatingCount: gating.length })}\n`,
    );
  } else if (argv.includes('--summary')) {
    process.stdout.write('rule x where x category: count\n');
    for (const r of summarize(hits)) process.stdout.write(`  ${r.rule} x ${r.where} x ${r.category}: ${r.count}\n`);
    const perCommit = historyByCommit(hits, 'secret-token');
    if (perCommit.length > 0) process.stdout.write(`history secret-token per commit: ${perCommit.join(', ')}\n`);
    process.stdout.write(`rotation candidates (known provider prefix, plausible length, random-looking, any path): ${rotate.length} hit(s) in ${new Set(rotate.map((h) => h.commit)).size} commit(s)\n`);
    for (const hit of gating) process.stdout.write(`gating: ${formatHit(hit)}\n`);
    for (const name of unreadable) process.stdout.write(`unreadable: ${name}\n`);
    process.stdout.write(`secret-scan: ${totals}; ${tail}\n`);
  } else {
    for (const hit of hits) process.stdout.write(`${formatHit(hit)}\n`);
    for (const name of unreadable) process.stdout.write(`unreadable: ${name}\n`);
    process.stdout.write(`secret-scan: ${totals}; ${tail}\n`);
  }
  return gating.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write('secret-scan: failed\n');
    process.exitCode = 2;
  },
);
