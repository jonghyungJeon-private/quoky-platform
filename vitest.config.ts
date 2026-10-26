import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Minimal test config (Sprint 1b-2). Tests import package sources directly; the
// aliases let cross-package imports resolve to package sources without a build.
// Incident (2026-10-16): when a parent test command was cut off by a timeout, eight vitest worker
// processes (~3.5 GB each, ~28 GB total on an 18 GB machine) were left orphaned, filled swap and froze
// the PC. Worker count is therefore capped (default 2, override with QUOKY_TEST_MAX_WORKERS), the
// forks pool is pinned explicitly, and teardown is bounded so stuck workers are killed promptly.
const DEFAULT_MAX_WORKERS = 2;
const parsedMaxWorkers = Number(process.env.QUOKY_TEST_MAX_WORKERS);
const maxWorkers =
  /^\d+$/.test(process.env.QUOKY_TEST_MAX_WORKERS ?? '') && parsedMaxWorkers > 0
    ? parsedMaxWorkers
    : DEFAULT_MAX_WORKERS;

export default defineConfig({
  resolve: {
    alias: {
      '@quoky/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@quoky/tool-mcp': fileURLToPath(new URL('./packages/tool-mcp/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // apps/** added (Sprint 3d-A, ADR-0051) so the single env-reading path `apps/quoky/src/config.ts`
    // can be tested directly (CA change 8) — the narrowest enabling change, no broad refactor.
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'tools/provider-routing/egress-allowlist-runner/**/*.test.ts', 'tools/test-lock/**/*.test.ts', 'tools/g6/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    maxWorkers,
    minWorkers: Math.min(1, maxWorkers),
    teardownTimeout: 10_000,
  },
});
