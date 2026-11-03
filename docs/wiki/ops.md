# Ops: deploy, restart, smoke (brief)

The authoritative procedure is `.claude/skills/quoky-ship/SKILL.md` section 6 (and section 7 for what always needs the owner). This page only orients; do not copy commands from here.

- **Service shape**: a macOS launchd user agent runs the built app (`node apps/quoky/dist/main.js`) through `ops/launchd/quoky-launch.sh`; control with `ops/launchd/quokyctl.sh` (`status`, `render`, `restart`, `install`, `uninstall`, `backup`, `telegram`). `install`, `uninstall` and `restart` need `--dry-run` or `--apply` and are Strict owner-host actions. Config comes from the repo-root `.env.local` (see pitfalls 19-20). Decision: ADR-0102.
- **Deploy order** (section 6): a dedicated, never-deleted service worktree is detached at `origin/main`; check that the `.nvmrc` Node matches the plist `--node` (stop and ask on mismatch); `pnpm install --frozen-lockfile`, `pnpm build`, `quokyctl.sh restart --apply`; confirm the "started" line in the service log.
- **Smoke**: run through the `quoky-e2e` skill (`.claude/skills/quoky-e2e/SKILL.md`) via the logged-in browser tab for the chat channel; check the changed feature path and the unchanged behavior of unconfigured features. Concrete channel targets are not stored in the repo.
- **Report and cleanup**: owner report goes through the local chat relay scripts (untracked, main checkout only); remove only clean, merged worktrees, never the service worktree.
- **Strict (always ask the owner)**: `.env.local` edits and secrets, DB migrations on the service DB (e.g. `docs/ops/migration-v16-apply.md`), new external targets and real external writes, OAuth scope changes, GitHub App installation changes, merge flags, service reboot.
- **Related runbooks**: `docs/ops/key-rotation.md`, `docs/ops/security-incident-response.md`, `docs/ops/remote-access-inventory.md`.
- **Eval gates** before deploying prompt changes: `.claude/skills/quoky-ship/scripts/run-gates.sh` (SKILL.md section 2.5).

Sources: `.claude/skills/quoky-ship/SKILL.md` sections 2.5, 6, 7; `ops/launchd/quokyctl.sh` (header usage); `docs/ops/*.md`; ADR-0102 in `DECISIONS.md`.
