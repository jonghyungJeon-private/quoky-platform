/**
 * `pnpm security:secret-scan [--no-history] [--no-tree] [--json]`: scans the repository (cwd) for credential-shaped
 * values (ADR-0121 S0). Prints file, commit and line with the value masked; exit 0 = no non-test hits and no issued-key candidate, 1 = otherwise, 2 = usage or git failure.
 * A credential-assignment counts only for a credential-shaped string literal (not identifiers, env names, placeholders).
 */
import {
  formatHit,
  gatingHits,
  historyByCommit,
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
  const hits: SecretScanHit[] = [];
  let files = 0;
  let commits = 0;
  let skipped = 0;
  if (!argv.includes('--no-tree')) {
    const tree = await scanWorkingTree(cwd);
    hits.push(...tree.hits);
    files = tree.files;
    skipped += tree.skipped;
  }
  if (!argv.includes('--no-history')) {
    const history = await scanHistory(cwd);
    hits.push(...history.hits);
    commits = history.commits;
    skipped += history.skipped;
  }
  const gating = gatingHits(hits);
  const rotate = hits.filter((h) => h.issuedCandidate);
  const totals = `${hits.length} hit(s), ${gating.length} gating (non-test or issued-key candidate)`;
  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ hits, summary: summarize(hits), files, commits, skipped, hitCount: hits.length, gatingCount: gating.length })}\n`,
    );
  } else if (argv.includes('--summary')) {
    process.stdout.write('rule x where x category: count\n');
    for (const r of summarize(hits)) process.stdout.write(`  ${r.rule} x ${r.where} x ${r.category}: ${r.count}\n`);
    const perCommit = historyByCommit(hits, 'secret-token');
    if (perCommit.length > 0) process.stdout.write(`history secret-token per commit: ${perCommit.join(', ')}\n`);
    process.stdout.write(`rotation candidates (known provider prefix, plausible length, random-looking, any path): ${rotate.length} hit(s) in ${new Set(rotate.map((h) => h.commit)).size} commit(s)\n`);
    process.stdout.write(`secret-scan: ${totals}; ${files} file(s), ${commits} commit(s), ${skipped} skipped\n`);
  } else {
    for (const hit of hits) process.stdout.write(`${formatHit(hit)}\n`);
    process.stdout.write(`secret-scan: ${totals}; ${files} tracked file(s), ${commits} commit(s), ${skipped} skipped\n`);
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
