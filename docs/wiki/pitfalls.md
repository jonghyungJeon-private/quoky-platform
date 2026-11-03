# Pitfalls: recurring bugs and gotchas

Each item is symptom, then cause, then what to do. Verify against the cited source before relying on an item; these change slowly but they do change.

## Test and build environment

1. **Hundreds of fake test failures, or "NODE_MODULE_VERSION mismatch".** Cause: the shell default `node` is not the repo's Node (the repo pins it in `.nvmrc`), so native modules such as `better-sqlite3` are built for another ABI. Do: prefix every pnpm/node command with the PATH line from quoky-ship section 2 (`export PATH=$HOME/.nvm/versions/node/v<.nvmrc>/bin:$PATH`); if the worktree's `better-sqlite3` is still built for another ABI, copy the prebuilt Node 22 binary kept under `~/Library/Application Support/Quoky/rollback-node18/` to `build/Release/better_sqlite3.node` (local node-gyp compile fails on the current macOS SDK). `pnpm test` refuses to run (exit 78) when the running Node major differs from `.nvmrc`. Source: `.claude/skills/quoky-ship/SKILL.md` section 2, `AGENTS.md` (Engineering Rules).
2. **PC freezes or swaps during tests.** Cause: each vitest worker is about 3.5 GB; a timed-out parent leaves orphan workers. Do: run only one full `pnpm test` at a time across all agents (a machine-wide lock under `~/Library/Application Support/Quoky/locks/full-suite` enforces it; `QUOKY_TEST_NO_WAIT=1` exits 75 instead of waiting); agents run `pnpm vitest run <files>` only; after a timeout kill orphans (`ps -axo pid,ppid,rss,command | grep vitest`, PPID 1). Source: SKILL.md section 2, `AGENTS.md`.
3. **`pnpm test <filter>` takes the full-suite lock.** Cause: only existing regular test files as arguments count as a targeted run; filters, directories and option values count as a full run. Do: pass real file paths, or use `pnpm vitest run <file>`. Source: `AGENTS.md`.
4. **A time-dependent test fails on a clock edge.** Do not hide it; fix it in a separate PR. Source: SKILL.md section 2.
5. **Eval exit 5 read as a regression.** Cause: exit 5 is `INVALID` (provider unavailable), not PASSED/FAILED. Do: rerun after the provider recovers; but an already-observed hard failure (wrong capture, wrong target, red-team success) stays FAILED even during an outage. Source: `AGENTS.md`, SKILL.md section 2.5.
6. **Prompt change merged without the gates.** A PR that changes a prompt version merges and deploys only from a head where the relevant `run-gates.sh` modes are all PASSED; if the prompt changes again, rerun. Source: SKILL.md sections 2.5 and 3.5.

## Git and docs merging

7. **Duplicate or doubled lines in `DECISIONS.md` / `CHANGELOG.md` after rebase.** Cause: `.gitattributes` sets `merge=union`; union never shows conflicts, so two edits of the same existing line both survive and identical added lines can appear twice. Do: after every rebase run `grep '^## ' DECISIONS.md | sort | uniq -d` (must print nothing; note some ADR headings repeat legitimately for amendments, so compare against the pre-rebase output) and `git diff ORIG_HEAD -- DECISIONS.md CHANGELOG.md`. Source: SKILL.md section 4.
8. **`CURRENT_STATE.md` conflicts.** It is excluded from union because status sections are edited in place. Do: keep both sides (`python3 .claude/skills/quoky-ship/scripts/resolve_changelog.py <file>`), only for `CHANGELOG.md`, `CURRENT_STATE.md`, `DECISIONS.md`. Never run that script on `.ts` or other docs (it concatenates both sides and broke a build once); stop and hand code conflicts to an implementer. Source: SKILL.md section 4.
9. **Wrong results from a rebase.** Never rebase from a stale base: fetch first, rebase onto `origin/main`, check the exit code is 0 and `git status` shows no `rebase in progress` or `UU/AA/DU` entries, and only then run the full test. Do not run the full suite on a mid-rebase tree. Source: SKILL.md sections 3.5 and 4.
10. **GitHub reports conflicts the local union merge hid.** GitHub ignores the union setting, so rebase locally before opening the PR. Source: SKILL.md section 4.
11. **Ref lock error or old code built after a parallel fetch.** Cause: another worktree fetched at the same time. Do: retry, and rebuild if the build may have run on old code. Source: SKILL.md section 6.
12. **Untracked-file clash when pulling the skill.** `.claude/skills/quoky-ship/SKILL.md` used to be untracked in the main checkout; move it aside before pulling. `scripts/chat/`, `scripts/qa/`, `scripts/space_id` stay untracked local-only. Source: `AGENTS.md`, SKILL.md header note.
13. **Commit attribution.** Project work uses conventional commits with no `Co-Authored-By` trailer; check with `git log origin/main..HEAD --format=%B | grep -ci co-authored` (must be 0). Source: SKILL.md sections 1 and 2.
14. **Wrong GitHub account.** Run `gh` for this repo with the token of the private account (`GH_TOKEN=$(gh auth token --user <private account>)`); never `gh auth switch`. After a reboot `gh` may be missing from PATH (`/opt/homebrew/bin`). Source: SKILL.md section 5.

## Tools and shells

15. **`codex exec` hangs waiting on stdin.** Cause: it reads stdin when it is not a TTY. Do: redirect `< /dev/null` and run it in the background. Source: `.claude/skills/quoky-ship/SKILL.md` section 1.5 (command shape); the stdin behavior is a tool characteristic.
16. **`timeout` command not found on macOS.** Cause: no GNU coreutils by default. Do: use the tool's own timeout parameter or a small wrapper, not `timeout 30 ...`. Source: general macOS behavior; not documented in the repo.
17. **zsh loop over conflict list fails.** Do: `echo "$c" | while read f; do ...; done` rather than word-splitting a variable. Source: SKILL.md section 4.
18. **Codex review prompt.** `codex review --base` cannot be combined with a prompt; usage-limited runs are not a PASS; very long output lands in a file (read the end for the verdict). Source: SKILL.md section 3.

## Runtime and environment

19. **Service starts with the wrong Discord bot or guild.** Cause: the dotenv loader uses `override: false`, so variables already in the process environment beat `.env.local`. Do: compare declared names with the process environment before start, remove duplicates with `env -u NAME` (especially the Discord token and guild variables), never source `.env`, and verify the bot identity and target before declaring readiness. Source: `AGENTS.md` (Temporary Local/UAT Runtime Environment), `apps/quoky/src/env-loader.ts`.
20. **`.env.local` value silently truncated.** Cause: dotenv treats an unquoted `#` as the start of a comment. Do: quote any value containing `#`. Source: dotenv behavior used by `apps/quoky/src/env-loader.ts`; not documented in the repo.
21. **CRASH_LOOP DM after restarts.** Cause: three or more recent starts under launchd trigger the notice; a bad `.env.local` or a Node mismatch causes repeated exits. Do: check the log, fix the config, do not keep restarting. Source: `apps/quoky/src/ops/ops-notice.ts` (`CRASH_LOOP_RECENT_STARTS`).
22. **Service Node differs from the plist.** `quokyctl restart` uses the Node baked into the launchd plist; if `.nvmrc` moved to another version the deploy step must stop (changing the plist path is a Strict owner action). Source: SKILL.md section 6.
23. **Fake secrets in tests/docs.** Do not write token-shaped literals; build fake keys from concatenated pieces. Source: SKILL.md section 1.

## Design traps (see ADRs)

24. **Fixing an NL routing miss by adding phrases.** Phrase lists grow without bound and still miss. Do: change the catalog or selector design (ADR-0120) and measure with the gates; after two heuristic review rounds on the same family, switch to a structural rule. Source: SKILL.md section 3.5, ADR-0120.
25. **Core grows provider or platform branches.** Core stays provider-neutral; put differences in adapters or composition-root registration. Source: `AGENTS.md`, `ARCHITECTURE.md`, ADR-0092.
26. **Settled-ADR conflict.** If a request conflicts with `ARCHITECTURE.md` or a settled ADR, stop and report; do not invent an exception. Source: `CLAUDE.md`, SKILL.md section 3.
27. **Stale `docs/ai/SESSION_STATE.md`.** It is a dated snapshot from an earlier repo name, not live state. Re-check branch, HEAD and PR state with git. Source: `docs/ai/SESSION_STATE.md`.

Sources: `.claude/skills/quoky-ship/SKILL.md`, `AGENTS.md`, `CLAUDE.md`, `docs/ai/SESSION_STATE.md`, `docs/ai/REVIEW_CHECKLIST.md`, `apps/quoky/src/env-loader.ts`, `apps/quoky/src/ops/ops-notice.ts`.
