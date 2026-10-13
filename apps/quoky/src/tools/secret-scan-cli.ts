/**
 * `pnpm security:secret-scan [--no-history] [--no-tree] [--json]`: scans the repository (cwd) for credential-shaped
 * values (ADR-0121 S0). Prints file, commit and line with the value masked; exit 0 = no hits, 1 = hits, 2 = usage.
 */
import { formatHit, scanHistory, scanWorkingTree, type SecretScanHit } from './secret-scan';

async function main(argv: readonly string[]): Promise<number> {
  const known = new Set(['--no-history', '--no-tree', '--json']);
  if (argv.some((a) => !known.has(a))) {
    process.stderr.write('usage: secret-scan [--no-history] [--no-tree] [--json]\n');
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
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ hits, files, commits, skipped, hitCount: hits.length })}\n`);
  } else {
    for (const hit of hits) process.stdout.write(`${formatHit(hit)}\n`);
    process.stdout.write(`secret-scan: ${hits.length} hit(s); ${files} tracked file(s), ${commits} commit(s), ${skipped} skipped\n`);
  }
  return hits.length > 0 ? 1 : 0;
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
