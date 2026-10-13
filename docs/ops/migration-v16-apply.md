# Migration v16 apply and rollback runbook

Scope: applying schema v16 (ADR-0119, plan track STO-1) to the always-on service database, and rolling it back. v16 adds
the `sessions.platform` column (backfilled from each session's own `context.platform`), the index
`idx_sessions_platform_context`, and the partial expression index `idx_task_runs_usage_finished`. It is additive and
idempotent and runs in one transaction; no row is deleted or rewritten except the new column.

**Everything below is Strict (AGENTS.md, ADR-0119 "Strict gates").** The owner confirms the apply before step 1 and is
told the rollback data-loss window (step 6) before the restart. Nothing here prints an env value or a secret.

Paths used below (the live service; check them with `ops/launchd/quokyctl.sh status`):

```bash
export PATH=$HOME/.nvm/versions/node/v22.22.1/bin:$PATH   # the service runs Node 22 (plist --node)
D=/Users/seongsujeonjonghyeong/demo_Project/.worktrees/quoky-platform/quoky-service   # the service checkout
DATA="$HOME/Library/Application Support/Quoky"           # quoky.db, vectors/, backups/
B="$DATA/backups"
```

## 1. Record the running (pre-v16) build

```bash
PREV=$(git -C "$D" rev-parse HEAD); echo "$PREV"   # keep this: the rollback deploys exactly this commit
```

## 2. Pre-apply backup, then verify it

The service keeps running; the copy is a `VACUUM INTO` from a read-only connection (ADR-0102 D6).

```bash
cd "$D"
bash ops/launchd/quokyctl.sh backup --apply
#   -> "backup:  verified quoky-<UTC>-manual.db (user_version 15) in ..."   (must say user_version 15)
N=quoky-<UTC>-manual                                       # the name printed above, without .db
bash ops/launchd/quokyctl.sh backup --verify "$N.db" || exit 1
#   -> "database: ... ok (integrity_check ok, user_version 15)" and the vector snapshot line
```

Stop here if either command fails. Do not continue on an unverified copy.

## 3. Build the v16 code (the service keeps running the old build)

```bash
cd "$D" && git fetch -q origin && git checkout -q --detach origin/main \
  && pnpm install --frozen-lockfile && pnpm build
```

## 4. Rehearse on a scratch copy of the verified backup

This step runs the real v16 migration from the new build on a copy of the backup, never on the service DB. The counts
and the usage totals must match exactly. Sessions only gain the new column.

```bash
S="$(mktemp -d)/v16-rehearsal.db"
cp -P "$B/$N.db" "$S"
Q="SELECT 'sessions', COUNT(*) FROM sessions;
SELECT 'sessions_active', COUNT(*) FROM sessions WHERE status = 'ACTIVE';
SELECT 'task_runs', COUNT(*) FROM task_runs;
SELECT 'usage', json_extract(data, '\$.usage.label'), COUNT(*), TOTAL(json_extract(data, '\$.usage.inputTokens')),
  TOTAL(json_extract(data, '\$.usage.outputTokens')), TOTAL(json_extract(data, '\$.usage.totalTokens'))
  FROM task_runs WHERE json_extract(data, '\$.usage') IS NOT NULL GROUP BY 2 ORDER BY 2;"
sqlite3 "$S" 'PRAGMA user_version;'                 # -> 15
sqlite3 "$S" "$Q" > "${S%.db}.before.txt"
node -e 'const { SqliteStorageProvider } = require("./packages/storage-sqlite/dist/index.js");
const log = (m, f) => console.log(m, JSON.stringify(f ?? {}));
const s = new SqliteStorageProvider({ dbPath: process.argv[1], logger: { info: log, warn: log, error: log } });
s.init().then(() => s.close()).catch((e) => { console.error(e.message); process.exit(1); });' "$S"
#   -> storage.migration.applied {"version":16,...,"sessionsWithoutPlatform":<n>}
sqlite3 "$S" "$Q" > "${S%.db}.after.txt"
diff "${S%.db}.before.txt" "${S%.db}.after.txt" && echo IDENTICAL   # must print IDENTICAL
sqlite3 "$S" "PRAGMA user_version; PRAGMA integrity_check;
  SELECT 'platform', IFNULL(platform, '(none)'), COUNT(*) FROM sessions GROUP BY 2 ORDER BY 2;"
#   -> 16, ok, and the per-platform session counts (discord / telegram; "(none)" = sessionsWithoutPlatform)
rm -rf "$(dirname "$S")"
```

Run `node -e` from `$D` (it loads the freshly built `packages/storage-sqlite/dist`). `sessionsWithoutPlatform` counts
sessions whose stored JSON has no platform. They are never matched again, so each such conversation starts a new
session (ADR-0119 D1: nothing is guessed). Expect 0 on a database written by any v1+ build. A non-zero count is not an
error, but tell the owner. Stop if the diff is not identical, the version is not 16, or `integrity_check` is not `ok`.

## 5. Apply: the deploy restart migrates at startup

```bash
cd "$D" && bash ops/launchd/quokyctl.sh restart --apply --repo "$D"
```

At start the service takes its own verified `pre-migration` copy first (ADR-0102 D6, `quoky-<UTC>-pre-migration.db`,
user_version 15). If that copy fails, the start is refused with `BACKUP_PRE_MIGRATION_FAILED` (exit 78) and nothing is
migrated. Then `storage.init()` applies v16 in one transaction.

## 6. Verify

```bash
grep -E 'storage.migration.applied|failed to start|started' ~/Library/Logs/Quoky/quoky.log | tail -5
#   -> storage.migration.applied ... version=16 ... sessionsWithoutPlatform=<same n as step 4>, then "started"
bash ops/launchd/quokyctl.sh status                    # running, no configuration exits
bash ops/launchd/quokyctl.sh backup --apply            # -> "(user_version 16)": the live DB is at v16
```

Live QA (ADR-0119 / plan STO-1): one turn in the owner's Discord DM and one in the Telegram private chat each continue
their existing conversation (the reply uses the earlier context, not a fresh session). The ops-UI usage panel loads and
shows the same current and previous month totals as before the restart.

Data window: anything written between the step-2 backup (or the step-5 `pre-migration` copy) and a rollback is lost on
rollback. Tell the owner before step 5.

## 7. Rollback (restore the verified backup, redeploy the pre-v16 build)

Migrations are forward-only; there is no down migration. A v15 build refuses a v16 database with
`SCHEMA_VERSION_AHEAD` and touches nothing, so the database and the code are rolled back together. **Restore before
starting the old build.** The pre-v16 build (`$PREV`) exits 1 on that refusal, so launchd keeps relaunching it and a
crash-loop `OPS_NOTICE` follows. Only builds from STO-1 on map it to the configuration exit 78 with a restore hint, and
the launcher stops after three of those.

```bash
# a. Stop the service.
launchctl bootout gui/$(id -u)/com.quoky.personal
# b. Pick the restore copy: the newest verified user_version-15 copy. Prefer the step-5 pre-migration copy (smallest
#    loss window); otherwise the step-2 manual copy ($N). Verify it first.
R=quoky-<UTC>-pre-migration                                       # or R=$N
bash "$D/ops/launchd/quokyctl.sh" backup --verify "$R.db" || exit 1   # must say user_version 15
# c. Restore it with its vector snapshot: docs/user/quickstart.md "복구 절차", steps 4-6 (move quoky.db, -wal, -shm and
#    vectors/ aside into before-restore/, copy "$B/$R.db" to quoky.db with mode 600, copy "$B/$R.vectors").
# d. Deploy the pre-v16 build recorded in step 1.
cd "$D" && git checkout -q --detach "$PREV" && pnpm install --frozen-lockfile && pnpm build
# e. Start it with the live service's exact install command (paths from `quokyctl.sh status`).
bash ops/launchd/quokyctl.sh install --apply --repo "$D" --node "$(command -v node)" --env-file "$D/.env.local"
```

Verify the rollback with `quokyctl.sh status`, `grep started ~/Library/Logs/Quoky/quoky.log | tail -1`, and
`quokyctl.sh backup --apply` printing `user_version 15`. Keep `before-restore/` until the owner confirms. It holds the
v16 database.

Rolling forward again later is steps 1-6 on the restored v15 database, which is the same idempotent path.
