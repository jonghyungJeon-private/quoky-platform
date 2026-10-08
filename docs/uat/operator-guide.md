# Quoky Platform — Limited Internal UAT Operator Guide

> Operator-facing guide for running **limited internal UAT** of Quoky Platform (**v1 RC ACCEPTED**) safely against a
> **throwaway sandbox** GitHub repository. Authored in Sprint 3m (docs-only). Canonical behavior references:
> `docs/lifecycle-state-machine.md`, `docs/capabilities/git.md`, `docs/capabilities/repository-hosting.md`,
> `DECISIONS.md`. You do **not** need to read the architecture history to run UAT — this guide is self-contained.

> ⚠️ **This guide describes how to run UAT. Running it is a separate, CA-approved step — do not execute it until CA
> schedules the UAT run.** UAT is **not** a release / deploy / tag / package / version bump / production rollout.

---

## 0. Personal v2/v3 operator setup (read first)

Added by DOC-B (v2 wave 8); Personal v3 additions by DOC-C (v3 wave 6) are in 0.2, 0.5, 0.6 and 0.7. Sections 1-11 below are the older v1 RC lifecycle UAT script (sandbox repo, one scenario per
lifecycle gate); this part is the operator reference for running Personal v2 features against the dev bot. Every
variable below was checked against `apps/quoky/src/config.ts` and `.env.example`. Running any live step is a separate
exact-scope Product Owner approval. Never print or paste secret values; list variable **names** only.

### 0.1 Launch and the shell-variable collision

A shell variable with the same name beats `.env.local`. Check names only, then launch without the colliding ones:

```sh
env | grep DISCORD | cut -d= -f1                 # names only, never values
env -u DISCORD_BOT_TOKEN -u DISCORD_GUILD_ID pnpm dev
```

`pnpm dev` builds and starts the bot (log banner `started (Quoky Personal v1)`; the banner text was not changed in v2).
Settings changes need a restart. A runtime started for QA must follow the AGENTS.md temporary-environment rules and use a
copy of the dev database, never the production database.

### 0.2 Environment flags

All boolean flags accept exactly `true` or `false`; an empty value (`NAME=`) is a startup error, so delete or comment the
line to use the default.

| Variable | Default | Operator notes |
|---|---|---|
| `QUOKY_DISCORD_OWNER_IDS` | none (required) | Missing or malformed fails startup. Only these users are served |
| `QUOKY_DISCORD_CHANNEL_IDS` | empty = owner DMs only | Owner messages in these channels (and their threads) are turns |
| `QUOKY_CHAT_PROVIDER` | unset (derived) | `claude` \| `codex` \| `ollama` (exact; else `CHAT_PROVIDER_INVALID`). Picks the chat-tier provider registered next to Claude (ADR-0092 amendment, see 0.4a). Unset derives from `QUOKY_OLLAMA_ENABLED` (`true` → `ollama`, `false` → `claude`). A contradicting pair: the selector wins and startup logs `CHAT_PROVIDER_OVERRIDES_OLLAMA_ENABLED` |
| `QUOKY_CODEX_MODEL` | unset (CLI default) | Passed to `codex exec` as `-m` when `codex` is selected; same token rule as `QUOKY_CLAUDE_MODEL` (`CODEX_MODEL_INVALID`) |
| `QUOKY_OLLAMA_ENABLED` | `true` | Registers local Ollama (chat, summaries, read-only work) when `QUOKY_CHAT_PROVIDER` is unset. `false` forces Claude for everything. The owner's service has it `false` (Claude Sonnet chat) |
| `OLLAMA_MODEL` | `llama3.1` | Must match an installed tag exactly (`ollama list`), e.g. `llama3.1:8b`. The owner's service was set to `granite3.3:8b` on 2026-10-07 (see 0.5); its chat has run on Claude since the owner decision of the same day |
| `QUOKY_CLAUDE_MODEL` | `sonnet` | Passed to the Claude CLI as `--model` |
| `QUOKY_GIT_REMOTE_ENABLED` | `false` | Enables the push to PR chain and remote reads. Needs the GitHub App (0.3) |
| `QUOKY_GITHUB_REPOS` | unset | Code-work repository allowlist (ADR-0109): comma-separated `owner/repo`, at most 10. Malformed / duplicate / too many → `GITHUB_REPOS_INVALID` / `GITHUB_REPOS_DUPLICATE` / `GITHUB_REPOS_TOO_MANY`. The legacy `QUOKY_GITHUB_OWNER`/`QUOKY_GITHUB_REPO` pair is an allowlist of one; setting both forms → `GITHUB_REPOS_WITH_LEGACY_PAIR`. See 0.3 |
| `QUOKY_GIT_MERGE_ENABLED` | `false` | Needs the remote flag, else startup error `GIT_MERGE_REQUIRES_REMOTE`. Keep `false`; merge enablement is a separate Strict decision and was never live-tested |
| `QUOKY_REMINDERS_ENABLED` | `true` | Release default `true` since the SUB-1 always-on runtime is live (ADR-0102 D9, owner decision 8). `false` turns reminders off: a reminder phrase gets a fixed "off" reply and no tick runs |
| `QUOKY_REMINDERS_CHANNEL_DELIVERY` | `false` | `true` posts reminders in the originating channel, so every channel member can read the text. Live PASS 2026-10-06 in the owner's `#reminder` channel (v2 QA record PC-3). The daily brief is DM-only regardless |
| `QUOKY_TIMEZONE` | `Asia/Seoul` | IANA zone; invalid is a startup error |
| `QUOKY_WORK_SUMMARY_ENABLED` | `true` | With Ollama not ready, connector summaries fall back to Claude, so corporate connector text can leave the host through the owner's Claude subscription (owner decision, ADR-0100 #2). Set `false` where policy forbids it; lookups then return the deterministic list |
| `QUOKY_EMBEDDING_ENABLED` | `false` | Local embedding recall. Run `ollama pull nomic-embed-text` first; falls back to lexical recall on any failure |
| `QUOKY_EMBEDDING_MODEL` | `nomic-embed-text` | A name or tag containing `cloud` is refused |
| `QUOKY_EMBEDDING_TIMEOUT_MS` | `3000` | 100-30000 |
| `QUOKY_CONTEXT_MAX_TOKENS` | `6000` | Keep below the Ollama server context window (see 0.5) |
| `QUOKY_MEMORY_ARCHIVE_DAYS` | `7` | Whole days 0-365 a forgotten memory stays restorable in the archive (`보관함`, `기억 복원 N`, `기억 완전 삭제 N`) before the daily maintenance (and each start) deletes it for good, independent of backups. `0` = no archive (forget deletes at once). Anything else, including an empty value, fails startup with `MEMORY_ARCHIVE_DAYS_INVALID`. Credential-like text is never archived. Archived text stays on disk (and in backups) until then |
| `QUOKY_ACTOR_IDENTITY_MAPPINGS` | unset | Non-secret JSON linking the Discord actor to Jira assignee / GitHub login. Without it the work view reports that the account identity is not set |
| `QUOKY_LEARNING_EXAMPLES_ENABLED` | `false` | v3 (ADR-0107). Curated examples go only into GENERAL_CHAT prompts of providers that declare `LOCAL` execution (Ollama), at most 2. The learning commands work regardless and store text only per item, `LOCAL_ONLY`, 365 days |
| `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` | unset | v3 (ADR-0111 amendments, 2026-10-07 / 2026-10-08). `ollama`, `claude`, `codex` or `off`, exact. Unset = `ollama` when `QUOKY_OLLAMA_VISION_MODEL` is set, else `off` (unchanged behaviour). `claude` sends image bytes to Anthropic and `codex` to OpenAI (owner's explicit cloud opt-in). Any other value fails startup (`IMAGE_UNDERSTANDING_PROVIDER_INVALID`). See 0.7 "Image understanding" |
| `QUOKY_IMAGE_UNDERSTANDING_MODEL` | unset | Read only for `claude`: the image model, else `QUOKY_CLAUDE_MODEL`, else `sonnet`. Malformed fails startup (`IMAGE_UNDERSTANDING_MODEL_INVALID`) |
| `QUOKY_OLLAMA_VISION_MODEL` | unset | v3 (ADR-0111). Local Ollama vision model for image attachments; pull it yourself. With the selector unset, an invalid or cloud-served (`*cloud*`) value disables only image understanding (log code `OLLAMA_VISION_MODEL_INVALID` / `OLLAMA_VISION_MODEL_NOT_LOCAL`) and startup continues. With `QUOKY_IMAGE_UNDERSTANDING_PROVIDER=ollama` it is required, and missing, malformed or cloud-served fails startup (`IMAGE_UNDERSTANDING_OLLAMA_MODEL_*`) |
| `QUOKY_DISCORD_EXPECTED_BOT_ID` | unset | v3 (ADR-0102 D5). Required under the launchd launcher; startup compares bot, guild and channels and exits 78 on a mismatch |
| `QUOKY_BACKUP_ENABLED`, `QUOKY_BACKUP_DIR` | on under launchd, else off; `<db dir>/backups` | v3 (ADR-0102 D6). Daily verified backup (DB copy + vector snapshot) at 04:00 `QUOKY_TIMEZONE`; absolute directory only. `false` stops scheduled copies only; `quokyctl.sh backup --apply` still runs |

Personal v3 connector writes, calendar and operations UI flags are in 0.7.

Connector credentials (all optional; a connector is registered only when its full set is present; legacy `CHUNSIK_*`
aliases are accepted, `QUOKY_*` wins):

| Connector | Variables | Notes |
|---|---|---|
| Jira | `QUOKY_JIRA_BASE_URL`, `QUOKY_JIRA_EMAIL`, `QUOKY_JIRA_TOKEN` | Read-only lookups. Basic auth `email:token`. `BASE_URL` is the site origin only (`https://<site>.atlassian.net`). Ran live on the real tenant 2026-10-06 (see below) |
| Slack | `QUOKY_SLACK_TOKEN` | Must be a Slack **user** token (`xoxp-`): `search.messages` refuses bot tokens. Scopes: `search:read` (search), `channels:read` (channel list, public channels only), `channels:history` (public channel messages and threads); add `groups:history` only to read a private channel by id. `groups:read` is not needed (the list does not request private channels). Read lookups ran live on 2026-10-08 with a user token (v3 QA record, sessions 3 B7 and 4 D3/D15); DMs and group DMs are left out of search results and results are labelled `#channel-name` (#148). Slack **writes** use a separate bot token (0.7) |
| Confluence | `QUOKY_CONFLUENCE_BASE_URL`, `QUOKY_CONFLUENCE_TOKEN`, optional `QUOKY_CONFLUENCE_EMAIL` | `BASE_URL` may be the site root or end in `/wiki` (requests go to `/wiki/...` exactly once). With an email the connector sends Basic `email:token` (Atlassian Cloud API token); without one it sends `Bearer` (Data Center PAT only; Cloud rejects Bearer for API tokens). If `QUOKY_CONFLUENCE_EMAIL` is unset and the Jira base URL has the same host, the Jira email is reused; set it to an empty value to force Bearer. Ran live on the real tenant 2026-10-06 with Basic auth (see below) |

On Atlassian Cloud, Jira and Confluence on one site share **one** Atlassian API token: create it for your account at
<https://id.atlassian.com/manage-profile/security/api-tokens> and put the same value in `QUOKY_JIRA_TOKEN` and
`QUOKY_CONFLUENCE_TOKEN`. With `QUOKY_JIRA_EMAIL` set and both base URLs on the same host, no Confluence email is
needed. The email and tokens are never logged.
| GitHub (work lookups) | the GitHub App below | Read token requests Issues: Read and Pull requests: Read |

Connector lookups on the real Jira, Confluence and GitHub tenants ran live on 2026-10-06 (`docs/uat/personal-v2-qa-record.md`
PC-4..PC-8; Confluence was fixed to Basic auth). Slack read lookups ran live on 2026-10-08 (v3 QA record, live QA
sessions 3 and 4). Treat a first run
against a new tenant as a read-only probe, one request per connector, under its own approval.

### 0.3 GitHub App (push to PR chain and GitHub lookups)

Variables: `QUOKY_GITHUB_REPOS` (the repository allowlist, comma-separated `owner/repo`, at most 10) **or** the legacy
pair `QUOKY_GITHUB_OWNER` + `QUOKY_GITHUB_REPO` (an allowlist of one; never both), `QUOKY_GITHUB_APP_ID`, and the
private key via `QUOKY_GITHUB_APP_PRIVATE_KEY_PATH` (preferred, a PEM outside Git) or `QUOKY_GITHUB_APP_PRIVATE_KEY`;
optional `QUOKY_GITHUB_APP_INSTALLATION_ID` (used for every allowlisted repository; unset = looked up per repository).
Never commit the key.

**Installation access (ADR-0109 D4, owner decision 12).** In the App installation settings choose
**"Only select repositories"** and select **exactly** the repositories in the allowlist — no more (a throwaway sandbox
for UAT). "All repositories" is not a supported setting: tokens stay down-scoped per repository either way, but the
installation itself must not reach repositories Quoky is not allowed to work on. When you add or remove an allowlist
entry, change the installation's repository selection in the same step, then restart.

**Which repository a project uses (ADR-0109 D2).** Nothing is configured per project. On every remote step (push,
PR approval and creation, PR status, merge, main sync, local and remote branch cleanup) Quoky reads the registered
project's `origin` fetch and push URLs (credential-free `git remote get-url --all origin` and `--push --all origin`,
under the same sanitized git environment as the App-token push) and derives `owner/repo`. The step runs only when every
URL is a plain `https://github.com/<owner>/<repo>[.git]` and all name the **same** allowlisted repository. Otherwise it
is refused before any git remote call, hosting call or token mint, with a fixed reply that says nothing ran and no
token was issued: not allowlisted; fetch and push naming two repositories (for example a `pushurl` or `pushInsteadOf`
to another repository); or a remote that is SSH, another host, embeds credentials, is unreadable or is rewritten
(`insteadOf`) to such a URL. Two projects on the same repository are fine. A PR approved for one repository cannot be
created, merged or cleaned up after the project's origin changed to another one (the anchored identity must match).

Required App permissions:

| Permission | Level | Why |
|---|---|---|
| Contents | Read and write | push of the work branch (the installation token is minted down-scoped to the single repository with `contents: write`) |
| Pull requests | Read and write | PR creation and status (`pull_requests: write`) |
| Metadata | Read | granted to every App; required by the API |
| Checks | Read | PR status preview reads the head commit's check runs. **Without it the status reply is partial**: PR state, branch, commit, GitHub-reported mergeability and reviews are shown, and the checks line says "체크 결과는 권한이 없어 확인하지 못했어요"; push and PR creation are unaffected |
| Issues | Read | GitHub work lookups (the read token requests `issues: read` and `pull_requests: read`) |

Token scopes: push and PR creation use an installation token down-scoped (`tokenForRepository`, one numeric
`repository_ids` entry) to the one repository the operation resolved, with `contents: write` and
`pull_requests: write`; a token never covers a second repository, and a non-allowlisted identity is refused before
any installation lookup or mint. The PR status preview uses its own read-only token for the same repository
with `pull_requests: read`, `checks: read` and `contents: read`. If the App has not been granted Checks, GitHub refuses
that mint (422); Quoky then mints without `checks` and replies with the partial status above. A 403 on the check-runs
read gives the same partial reply. Merge preflight does not read checks; it relies on GitHub's mergeability, and
"unavailable" checks are never treated as passing. Verified live on the sandbox repo on 2026-10-06 (v2 QA record PC-1,
PC-2) after the installation accepted the new permissions.

App-auth git path (live finding QA-V2-W7-01, fixed):

- Only **HTTPS `github.com`** remotes are supported for App-token operations. SSH (scp-like or `ssh://`), other hosts and
  URLs with embedded credentials are refused before any token is minted. Every fetch and push URL is checked for the
  operation's direction, so a `pushurl` or `insteadOf` rewrite cannot route around the check.
- Ambient credential helpers are reset for App-token operations. The git child gets `GIT_CONFIG_COUNT=1` with
  `credential.helper` set to empty, drops inherited `GIT_CONFIG_*` / `GIT_CONFIG_PARAMETERS`, and authenticates through a
  one-shot `GIT_ASKPASS`. Before the fix, macOS `osxkeychain` (system gitconfig) answered first with another identity's
  credential ("Repository not found"), and on success would have stored the App token in the keychain. If a push fails
  with "Repository not found", check that the remote is HTTPS `github.com/<owner>/<repo>` and that the App is installed
  on that repository.
- Safety rules unchanged: no force push; the first push of a new branch is `HEAD:refs/heads/<branch>` with no upstream
  set; an upstream push that targets `main` or `master` is refused; merge, deploy and release are not performed.

### 0.4 Claude CLI

Quoky calls the locally installed, logged-in `claude` CLI (subscription; no API key is passed to the child). Isolation
flags on every run: `--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, plus `--tools ""` for
workspace-less requests. This keeps the owner's claude.ai connectors (for example Google Calendar), user/project settings
and session history out of Quoky runs (QA-V2-002). Needs a CLI version that supports these flags (the quickstart records
2.1.287). Policy-sensitive chat turns always use Claude, so they count against the subscription.

### 0.4a Codex CLI (`QUOKY_CHAT_PROVIDER=codex`)

ADR-0092 amendment (2026-10-07). With `codex` selected, Quoky registers `CodexCliProvider` next to Claude. Codex serves
`GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS` and `READONLY_LOOKUP` (priority 100 > Claude); code implementation,
code review, planning and policy-sensitive chat stay on Claude, which is also the fallback whenever Codex is not ready.
**All chat-tier content (including connector summaries and text attachments) then goes to OpenAI** through the owner's
ChatGPT login; the owner accepted this on the same basis as Claude.

- Readiness: `codex login status` must exit 0 with a "Logged in" line (10 s bound, cached about 30 s; no model call).
  Under launchd, set `CODEX_CLI_BIN` to an absolute path if `codex` is not on the service PATH; the CLI is a Node script,
  so `node` must be on that PATH too.
- Invocation: `codex exec --json --color never --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
  --sandbox read-only -c approval_policy="never" -c project_doc_max_bytes=0 -c skills.include_instructions=false
  -c web_search="disabled" -c mcp_servers={} -c history.persistence="none" -c model_reasoning_effort=… --disable <shell
  and agent features> [-m QUOKY_CODEX_MODEL] -`, prompt on stdin, fresh empty temp cwd removed afterwards. Only the last
  `agent_message` is used; a stream that shows a command, file change, MCP call or web search is refused whole.
- Not isolated: auth and Codex's built-in agent prompt come from `~/.codex` and the CLI; there is no "no tools" switch,
  so the read-only sandbox in an empty directory plus the disabled tools are the containment. The CLI reports one
  non-fatal "Code Mode is unavailable" item per run because `code_mode_host` is disabled (counted as
  `warningItemCount` in the audit).
- Failures map to `TIMEOUT`, `UNAVAILABLE` (CLI missing, not logged in, usage limit), `EXECUTION_FAILED` or
  `EMPTY_OUTPUT`; no raw CLI text is stored. `task_runs.providerId` shows `codex-cli` for Codex turns.
- Live check 2026-10-07 (codex-cli 0.160.0, default model, two calls): about 7.5-8 s per short Korean recommendation
  turn, about 8.2k input tokens (6.9k cached), session and history files unchanged. On the service, a Codex chat turn
  answered in about 9.5 s, and an operations-UI switch to `codex` was answered by `codex-cli` (v3 QA record OD3, session 3
  A2).
- Switching back: set `QUOKY_CHAT_PROVIDER=claude` (or `ollama`) and restart, or switch at runtime without a restart
  (operations UI `/providers` or `모델 변경: …`, see 0.7 "Runtime model switch").

### 0.5 Ollama

Run Ollama **natively** on the host (`ollama serve`); Quoky shells out to the `ollama` CLI. On macOS, Docker would add
isolation only, and Quoky does not use it. Use a model tag that exists locally. The Ollama server defaults to a 4096 token
window, below Quoky's 6000 token context budget: start the server with `OLLAMA_CONTEXT_LENGTH=8192` or lower
`QUOKY_CONTEXT_MAX_TOKENS`. Known local-model quality limits (not policy bugs): stray non-Korean characters, over-cautious
or vague answers, appended "(Translated from …)" lines (QA-V2-003, QA-V2-008, QA-V2-W7-06). v3 LLM-1 strips the trailing
translation marker and stray Han characters glued between Hangul syllables. For embeddings, pull the embedding model
yourself; Quoky never pulls models.

**Model choice (v3 LLM-2, ADR-0105 D1).** Changing `OLLAMA_MODEL` is an operator change; running the answer-quality
harness (`pnpm eval:answers -- --mode run …`) is Strict per run and needs a fresh `--approved-plan-digest`. The first
comparison (policy checks only) picked `gemma3:4b`, which gave non-answers live and was reverted. The re-run with the
helpfulness checks (`answer-quality-checkers-v2`) picked `granite3.3:8b` (relevant tokens 9/10, hedges uncheckable 3/4, no
invented specifics 4/4, language match 96.9%). On the owner's M3 Pro (18 GB) it uses about 5.7 GB at 100% GPU, 15-17
tok/s idle and about 15 tok/s under heavy CPU load, with a cold load of about 16 s; the Ollama default keep-alive (5
minutes) is kept. The service ran it from 2026-10-07 until the owner moved chat to Claude the same day
(`QUOKY_CHAT_PROVIDER=claude`) after the Korean daily-chat set (QA record W6-L05: about 5 of 20 replies usable as is);
Ollama stays selectable and serves embeddings. The first check ran while unrelated builds held the host load
near 20, the 5 s readiness probe failed at startup and the Claude CLI answered 3 of 4 prompts. The re-test after the
load cleared (QA record W6-M5) was a partial pass: 3 of 4 replies came from granite (21-38 s generation), one fell back
to Claude when a parallel test run raised the load again, and invented specifics (song titles) remain. Under heavy host
load the readiness probe can fail and chat falls back to the Claude CLI; check `task_runs.providerId` when latency looks
wrong. Ollama runs with `--nowordwrap` (PR #133) so replies are not hard-wrapped mid-word. Keep the previous model tag
available for rollback.

### 0.6 Live status and what still needs a session

Done for v2 (owner-attended, dev bot, see `docs/uat/personal-v2-qa-record.md`): migrations to v13 on DB copies, chat
policy and routing, the override flow, reminders on DM delivery including restart catch-up, feedback reactions and
summary, to-dos, the push to PR chain on the private sandbox repo with merge off, and (2026-10-06) Jira, Confluence and
GitHub lookups on real tenants, reminders channel delivery, PR status with checks and embedding recall.

Done for v3 (see `docs/uat/personal-v3-qa-record.md`): the launchd install on the owner's Mac with a `kill -9` restart and
a reminder across the restart; migrations v13 to v14 and v14 to v15 on the service DB with verified pre-migration
backups; memory commands and the archive; the code chain to a PR with the v3 title/body; calendar reads and
create/move/delete on the owner's calendar; Jira comment and transition and a Slack post on allowlisted test targets;
operations UI sign-in. Since then (sessions 2-4 and the host reboot, 2026-10-07/08): the 04:00 daily backup, a restore
drill on a copy, a real host reboot (the service started itself at login), `quokyctl.sh backup --apply` with the vector
snapshot; operations UI panels, approve/reject, the chat/UI race, reminder cancel, memory forget, foreign-Origin
refusal and token rotation across a restart; attachments (text, oversize, credential-like, images, unsupported type,
non-allowlisted channel, injection caption); the W5-L01..L04 re-run; a 44-phrasing DET sweep; Slack read lookups;
Codex chat, runtime model switching and the Codex image option.

Still pending, each its own exact-scope Strict session:

1. A mid-send write failure (`UNCERTAIN`).
2. Any merge-flag enablement (`QUOKY_GIT_MERGE_ENABLED=true`, CODE-9, deferred).
3. The live check of D13 (attachment "not read" reasons; blocked by the Discord web client freezing on a corrupt
   image).
4. The Stage 2A provider-path re-validation and a CODE-8 live check (CODE-8 is being implemented on another branch).

Open defects from live QA session 4, being fixed: D5-R (the own-memory similarity floor does not separate unrelated
Korean questions, so the deterministic "기억에 없어요" does not fire) and D16 (the embedding provider went not-ready for
about 5 minutes without a log line; recall fell back to lexical). Known operator follow-up from live QA session 2: a
local-model runaway generation is stopped only by the 120 s provider timeout. (Resolved since: `vectors/` is now
snapshotted with every backup and restored with its DB copy, and `quokyctl.sh backup --apply` takes an on-demand backup
while the service runs; see 0.7.)

### 0.7 Personal v3 operator additions

Every variable here was checked against `apps/quoky/src/config.ts`, `apps/quoky/src/ops-ui/ops-ui-config.ts`,
`apps/quoky/src/image-understanding-provider.ts` and `.env.example`. Enabling any of these on the owner host is a Strict
`.env.local` edit, and each new external target needs its own live confirmation. List variable names only.

**Always-on service (ADR-0102).** Install, status, restart and uninstall go through `ops/launchd/quokyctl.sh`
(`--dry-run` first, `--apply` is Strict). The service uses `~/Library/Application Support/Quoky/` for the DB, vectors,
backups and the operations UI token, and `~/Library/Logs/Quoky/quoky.log`. Details and the restore runbook are in
`docs/user/quickstart.md` section 7. Do not run `pnpm dev` with the same bot token while the service runs.

**Backup set and on-demand backup.** Every backup (daily, weekly, pre-migration, manual) is a verified DB copy
`quoky-<UTC>-<kind>.db` plus a verified vector-store snapshot `quoky-<UTC>-<kind>.vectors/` (dir 700, files 600; the
collection JSON files and a `.snapshot.json` manifest with sizes, SHA-256 and record counts). The DB copy is
authoritative: a failed snapshot is recorded as `vectors.outcome: FAILED` in `backups/backup-status.json` and
`backup.vectors.failed` in the log, keeps the DB copy, sends no notice and never blocks a start.

| Command | Effect |
|---|---|
| `quokyctl.sh backup` (or `--dry-run`) | Read-only: the copy name, vector record counts and what retention would prune |
| `quokyctl.sh backup --apply` | A `manual` copy + snapshot now, while the service runs (no restart); the 5 newest manual copies are kept |
| `quokyctl.sh backup --verify <copy>.db` | Read-only restore drill: `integrity_check`/`user_version` of the copy and its snapshot, or the rebuild guidance when it has none |

The on-demand copy is a separate short-lived process (`apps/quoky/dist/tools/backup-now.js`): `VACUUM INTO` from a
read-only connection. In WAL mode the service's ordinary commits keep going during the copy, but checkpoints may be
delayed (the WAL can grow) until it ends, and the copy's connection waits up to 5 s on a lock. Every backup run
(scheduled, pre-migration, manual) holds `backups/.backup-lock.db`, an OS-held SQLite exclusive lock the kernel releases
when the holder dies (no pid, age or takeover rule): a manual run that finds it held exits 3, the daily copy retries at
the next 15-minute poll without a notice, and the pre-migration copy polls every second for up to 10 minutes (600
tries) and then refuses the start with exit 78 (`BACKUP_PRE_MIGRATION_FAILED`; launchd stops relaunching after 3
consecutive configuration exits). A second acquire inside a process that already holds the lock returns
`BACKUP_IN_PROGRESS` at once without opening the file (closing any descriptor of it would drop the holder's fcntl
lock); only SQLite opens the lock file. The lock is created inside the backup directory, which must be a real
directory, mode 700 and owned by the owner (lstat + realpath). These checks are not TOCTOU-free: under the owner-only
threat model a same-user process that can write inside the 700 backup directory is out of scope (it could already
tamper with the backups themselves).

Neither `quokyctl.sh backup` nor the tool reads `.env.local`. The running service publishes its effective, non-secret
backup configuration at start to `<data dir>/ops/backup-config.json` (backup directory, enabled, time zone, DB and
vector paths; private-file writer: real 700 dir, `O_CREAT | O_EXCL | O_NOFOLLOW` 600 temp, fsync, rename). The tool
reads it with the private-file checks; when it is missing (the service has not started with this build), invalid,
refused (symlink) or for another database, the tool uses the defaults (`<db dir>/backups`, the default time zone) and
prints a `note:` line. After changing `QUOKY_BACKUP_DIR` or `QUOKY_TIMEZONE`, restart the service before a manual backup.
`--verify` works with no live DB (disaster-recovery drill) and refuses symlinked copies, snapshot directories and backup
directories. Exit codes: 0 ok, 1 DB copy or verify failed, 3 blocked (incl. another run holding the lock), 4 DB copy kept but its
snapshot failed. `backup-status.json` is best-effort, advisory telemetry (written through the private-file writer);
concurrent merges of the service and the manual process can lose a field until the next write.

Restore = DB copy and the same-named snapshot together (quickstart section 7). A copy without a snapshot (older
backups, or a failed one): restore the DB alone and leave `vectors/` moved aside; semantic recall rebuilds lazily (at
most 4 embeddings per turn, lexical ranking until then) and never serves a vector whose memory id and content hash do
not match.

**Calendar (ADR-0110 and its amendment).**

| Variable | Default | Notes |
|---|---|---|
| `QUOKY_CALENDAR_GOOGLE_CLIENT_ID`, `QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET` | unset | OAuth "Desktop app" client from the owner's Google Cloud project with the Calendar API enabled |
| `QUOKY_CALENDAR_GOOGLE_TOKEN_FILE` | unset | Refresh-token file written by the consent helper (mode 600, no symlink). Alternatively `QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN`; setting both leaves the calendar unregistered |
| `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` | `primary` | Calendars to read, comma-separated, at most 10 |
| `QUOKY_CALENDAR_WRITE_ENABLED` | `false` | Create, move and delete on the primary calendar only, independent of the connector-write switch; needs a token with `calendar.events` |

The calendar is registered only when the client id, secret and one token source are all set; otherwise schedule
questions keep the v2 routing. Consent helper (Strict; prints the consent URL, never a token; writes a new file only):
`node apps/quoky/dist/tools/calendar-auth.js --out <new file>` for read-only, add `--with-events` for writes. A grant
broader than `calendar.readonly` plus `calendar.events` is refused. Writes never set attendees and always send
`sendUpdates=none`; recurring series are not edited; update and delete are bound to the previewed event version.

**Connector writes (ADR-0112).**

| Variable | Default | Notes |
|---|---|---|
| `QUOKY_CONNECTOR_WRITES_ENABLED` | `false` | Master switch for Jira and Slack writes |
| `QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS` | empty | Comma-separated distinct project keys (at most 50). Jira writes reuse the `QUOKY_JIRA_*` credentials; this allowlist is the gate |
| `QUOKY_CONNECTOR_WRITE_SLACK_TOKEN` | unset | A Slack **bot** token with `chat:write`, different from `QUOKY_SLACK_TOKEN` (else `CONNECTOR_WRITE_SLACK_TOKEN_NOT_SEPARATE`). Invite the app to each allowlisted channel |
| `QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS` | empty | `name:CHANNELID` or `CHANNELID` entries (at most 50); the name is what the owner types after `#`. Slack writes need both the token and the list |

All values are validated at startup even while writes are off; a malformed value stops startup with its
`CONNECTOR_WRITE_*` / `CALENDAR_WRITE_ENABLED_INVALID` code. A target outside the allowlist is refused before any
network call. Each write is an exact-payload preview, a one-time CRITICAL approval bound to the payload hash, and an
exact execution phrase; a receipt (schema v15, no payload text) records SENT, NOT_SENT or UNCERTAIN, and UNCERTAIN is
never retried. Confluence and GitHub-issue writes do not exist.

**Operations UI (ADR-0113).**

| Variable | Default | Notes |
|---|---|---|
| `QUOKY_OPS_UI_ENABLED` | `false` | Exact `true`/`false`; any other value disables only the UI (`OPS_UI_ENABLED_INVALID`), never startup |
| `QUOKY_OPS_UI_PORT` | `47613` | 1024-65535; out of range or a taken port disables only the UI |

The listener binds `127.0.0.1` only; there is no bind-address setting. Each start writes a new 256-bit token to
`ops-ui.token` (mode 600) in the database directory: on the service `~/Library/Application Support/Quoky/ops-ui.token`,
under `pnpm dev` `./data/ops-ui.token`. A stale file is replaced at start and the file is removed on a clean stop, so
sign in again after every restart. Never paste the token into chat, logs or a URL. The UI shows status, cancels
reminders, forgets memories (with the typed-back code) and rejects or approves pending approvals; approving needs the
6-character confirmation code that chat adds to the approval preview while the UI is on, records the grant only, and
sends the result to the owner DM (`OPS_DECISION_RESULT`). Code-change plan and credential-override approvals can only be
approved in chat. Remote access (tunnels, LAN) is out of v3.

**Image understanding (ADR-0111 and its 2026-10-07 / 2026-10-08 amendments).** The selector is the configured image choice (since the
runtime-switching amendment every configured option is registered and the effective choice decides, see "Runtime model
switch" below):

| `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` | Provider | Locality | Ready when |
|---|---|---|---|
| unset | `ollama` if `QUOKY_OLLAMA_VISION_MODEL` is set, else `off` | as below | as below |
| `ollama` | `OllamaCliVisionProvider` (`ollama-vision-cli`), model `QUOKY_OLLAMA_VISION_MODEL` | `LOCAL` | daemon up, model installed, `ollama show` lists `vision` |
| `claude` | `ClaudeCliVisionProvider` (`claude-vision-cli`), model `QUOKY_IMAGE_UNDERSTANDING_MODEL` / `QUOKY_CLAUDE_MODEL` / `sonnet` | `REMOTE` | `claude auth status --json` exits 0 with `loggedIn: true` (CLI present and logged in) |
| `codex` | `CodexCliVisionProvider` (`codex-vision-cli`), model `QUOKY_CODEX_MODEL` or the CLI default | `REMOTE` | `codex login status` exits 0 with a "Logged in" line (10 s bound, no model call) |
| `off` | none | - | never; image turns get the fixed "not analysed, not sent anywhere" reply |

Core sends image bytes only to a provider whose declared locality is in the image policy: `LOCAL` only by default,
`LOCAL` and `REMOTE` only while the EFFECTIVE image choice (session override → operations-UI default → selector) is
`claude` or `codex`. The policy is resolved on every image turn from that choice, never from a provider id, so switching to
`ollama` or `off` stops cloud egress on the next image turn. The Claude vision provider runs `claude -p` with the same isolation flags as chat
(`--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, neutral cwd) plus
`--input-format stream-json --output-format stream-json --verbose --tools ""`: the image goes on stdin as a base64
image content block, no tool is enabled, and the temp-file path and bytes never appear in argv, logs or errors (failure
messages are fixed reasons and codes, never CLI output). This is specific to the Claude adapter: the local Ollama
vision adapter passes the temp-file paths as `ollama run` arguments (redacted to `<image>` in its audit). The Codex
vision provider runs `codex exec` with exactly the Codex chat isolation (`--ignore-user-config --ignore-rules
--ephemeral --sandbox read-only`, approvals `never`, no project docs, skills, MCP, web search, shell or other agent tools,
no history) and the same fail-closed event-stream check; it re-reads each canonical intake file (no symlink, size and
signature on the open descriptor), writes a private copy (0600) into a fresh empty temp cwd (0700), passes only that copy
as `--image <path>` (each before the next flag), sends the prompt on stdin, and removes the cwd afterwards. Its audit
replaces each image path by `<image>`; failure messages are fixed reasons and codes. Limits:
PNG, JPEG or WebP (content signature checked), 8 MiB per image, 3 images per turn, 120 s per call. `task_runs` audit
metadata carries the model, the image count, total bytes and SHA-256 hashes only. The startup log line
`image understanding uses a cloud provider` and the operations UI providers panel field "이미지 이해 공급자 (설정)" show
the selection; readiness is the panel's `IMAGE_UNDERSTANDING` row. Changing the selector on the owner host is a Strict
`.env.local` edit plus a restart.

Residuals with `claude` or `codex` selected: a secret visible inside an image (a password or token in a screenshot) cannot be
detected before it is sent, because image content is not inspected. The caption and any attached text files pass the
credential guard before egress (a credential-shaped caption is withheld from the prompt), and the reply of every image
turn passes the attachment-turn credential check: a credential-shaped reply is replaced by a fixed notice and is neither
shown nor stored. The hosted API may refuse an image it considers too large even under the 8 MiB bound; that turn fails
with the normal error reply and nothing is stored.

**Runtime model switch (ADR-0092 and ADR-0111 amendments, runtime switching).** Without a restart, the owner can change
the chat tier (chat, summaries, document analysis, read-only lookups) and image understanding:

- **Precedence**, per tier: session override (chat command, that conversation only) → operations-UI default (persisted
  in `<db dir>/ops/provider-selection.json`, mode 600, exclusive no-follow temp file + fsync + rename, survives restarts;
  a symlinked or non-0700 `ops/` directory, or a symlinked file, is refused on write and on read — the configuration then
  applies and the log shows `SELECTION_FILE_REFUSED`) → `QUOKY_CHAT_PROVIDER` /
  `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` → derived default. A choice this host cannot run is skipped; a corrupt or
  unreadable file is ignored with a value-free warning (`SELECTION_FILE_*`) and the configuration applies.
- **Registration.** Claude always; Codex when the `codex` CLI is on `PATH` (or it is configured/persisted); Ollama chat
  when `OLLAMA_MODEL` is set and the `ollama` CLI is present (or it is configured/persisted); Claude vision always (when
  its model is valid), Codex vision when the `codex` CLI is on `PATH` (or `codex` is the configured/persisted image
  choice), and Ollama vision when `QUOKY_OLLAMA_VISION_MODEL` is set. A Claude alias (`opus`, `haiku`) or an
  Ollama model other than the configured one adds one chat-tier-only instance on first use (ids `claude-cli:<alias>`,
  `ollama-cli:<model>`, at most 12 per process). Readiness probes run only for eligible providers; nothing loads a model.
- **Routing.** The router asks the `ProviderSelectionPolicy` (Core port) for the eligible provider keys and their order:
  chat tier = the effective choice, then Claude (selection-time fallback); images = the effective image provider only
  (none for `off`), re-checked immediately before the image is sent (a synchronous check of the live selection is the
  last step, so `off` set during selection always wins); code, review, planning, project analysis, tests and
  policy-sensitive chat are independent of every runtime selection: Claude, plus the configured Ollama chat model as the
  CAP-009 local code fallback only when `.env.local` itself selects Ollama (unchanged from before).
- **Chat command** (owner only, provider-free): `모델 상태`, `모델 목록` (numbers valid 30 min in that conversation),
  `모델 변경: codex` / `모델 변경: 2` / `/model claude:opus` / `/model ollama:<model>`, `이미지 모델 변경: claude|codex|ollama|off`,
  `모델 기본값으로` / `/model reset`. The override is keyed by (Session, Actor): a field-scoped write of the session's
  `metadata` (`quoky.providerSelection.byActor[<actorId>]`) under the shared session write lock, so owners sharing a
  channel never read or change each other's; `새 대화` opens a new Session, which has none.
- **Operations UI**: providers panel → `모델 기본값 바꾸기` (`/providers`): one same-origin form per option with the
  session CSRF token and a one-time nonce whose subject is the option; `설정 기본값으로 되돌리기` resets to the
  configuration. A change sends one owner DM (`OPS_DECISION_RESULT`). The cloud image options show the egress warning
  (Anthropic for `claude`, OpenAI for `codex`).
- **Audit.** Every change logs `provider.selection.changed` with `surface` (`chat`/`ops-ui`), `actor`, `scope`
  (`session`/`default`), `tier`, `selection` and the session id for overrides; `task_runs.providerId` still records the
  provider that answered (e.g. `claude-cli:opus`).

**Chat providers you can switch today.** Claude, any model via `QUOKY_CLAUDE_MODEL` (the owner's service runs chat on
Claude with `QUOKY_OLLAMA_ENABLED=false` since 2026-10-07, an accepted cloud egress); local Ollama, any local model via
`QUOKY_OLLAMA_ENABLED=true` + `OLLAMA_MODEL`; and Codex (OpenAI) via `QUOKY_CHAT_PROVIDER=codex` for the chat tier only
(chat, summaries, document analysis, read-only lookups; see 0.4a). `QUOKY_CHAT_PROVIDER` (`claude` | `codex` | `ollama`)
is the selector; unset derives from `QUOKY_OLLAMA_ENABLED`. Code, review and policy-sensitive chat always stay on Claude.
Images are selected separately (`QUOKY_IMAGE_UNDERSTANDING_PROVIDER`: `claude` | `codex` | `ollama` | `off`; `codex` uses
the chat tier's `QUOKY_CODEX_MODEL`). Other cloud vendors (OpenAI API, Gemini) need a new provider adapter package.

**Not implemented in v3 (do not configure):** `QUOKY_PR_DESCRIPTION_MODEL_ENABLED` (ADR-0108 D4), an MLX provider
(ADR-0105 D2-D4) and continuation activation (ADR-0103). `QUOKY_GITHUB_REPOS` is implemented (CODE-8, ADR-0109, see
0.3); per owner decision 12 of the ADR-0102..0112 ratification record the App installation must be switched to "Only
select repositories" with exactly the allowlisted repositories before CODE-8 merges (a Strict owner action).

---

## 1. UAT purpose and scope

**Purpose:** confirm that a trusted internal operator can drive Quoky Platform through the real conversation lifecycle
against a sandbox repo, verifying at every gate that the bot (a) requires the correct approval, (b) transitions to the
correct state, (c) never over-claims, and (d) never leaks a token. Every remote effect is confirmed **manually in
GitHub**.

**In scope:** one internal operator · one dedicated **sandbox** GitHub repo (throwaway, non-production) · one **small,
low-risk** change (e.g. a one-line edit to a dummy file) · a **test/work branch only** (never `main` as the work
branch) · the lifecycle `ELIGIBLE → … → REMOTE_BRANCH_CLEANED`, gate by gate · manual GitHub verification of every
push/PR/merge/branch-delete · a Node 22 local run of the bot against the sandbox checkout.

**Out of scope (hard):** any production/shared repo · deploy / release / tag / package publish / version bump /
production rollout · unrestricted or multi-user access · large/complex/security-sensitive changes · production secrets
or a broadly-scoped token · a PR/merge-triggered deploy or release workflow in the sandbox · any change to bot
source/tests/behavior during UAT.

---

## 2. Sandbox repository requirements

Use a **dedicated, disposable** GitHub repo. Never point the bot at anything you care about.

```text
- private, throwaway sandbox repo; non-production codebase
- default branch = main; main protected OR trivially recoverable
  (the bot never deletes/force-pushes main — protection is defense-in-depth. Strict protection that requires
   reviews/checks will make merge report BLOCKED, which is a valid Scenario-E test, not a bug.)
- test/work branch naming convention, e.g. uat/<topic> or feature/<topic>  (never "main")
- a small dummy target file to edit, e.g. docs/uat-sandbox-note.md (or a trivial code file)
- a GitHub token, ADAPTER-LOCAL only, with MINIMUM scope for the sandbox repo ONLY:
    contents: read/write   (push, refs, branch delete)
    pull requests: read/write   (create / merge / status)
  Prefer a fine-grained PAT limited to the single sandbox repo; a classic PAT `repo` scope is acceptable for a
  private throwaway. NO org-admin, NO workflow, NO packages, NO other repositories.
- NO production secrets anywhere in the repo or environment
- NO deploy/release/publish workflow triggered by push/PR/merge (check .github/workflows/*)
- the bot's configured repository identity (provider=github, owner, repo) points ONLY at the sandbox
- a clear rollback path: the sandbox is disposable (delete test branches / revert the dummy commit / recreate)
```

---

## 3. Pre-UAT checklist (tick before every session)

```text
[ ] Node 22 active;  pnpm typecheck → exit 0;  pnpm test → green (baseline sanity)
[ ] local checkout of the SANDBOX repo is on a clean working tree at a known commit
[ ] bot repository identity == the sandbox repo (owner/repo)
[ ] GitHub token is minimal-scope + sandbox-only (see §2)  — never paste it into the chat
[ ] default branch is main; note its protection state
[ ] .github/workflows/* contains NO deploy/release/publish on push/pull_request/merge
[ ] a fresh test/work branch name chosen (uat/<topic>), not "main"
[ ] a small dummy target file identified
[ ] you can screenshot/record the transcript WITHOUT capturing the token
```

If any item fails → **do not start**; fix the environment first (this is a safe, non-blocking setup step).

---

## 4. Operator prompt script (representative phrasing)

The classifiers accept several natural phrasings; the phrases below are **representative** — the authoritative intents
and states are in `docs/lifecycle-state-machine.md`. Approvals are decided with **"승인"** (approve) / **"거절"** (deny)
/ **"취소"** (cancel). Type one instruction per turn and read the reply before continuing.

| Gate | Representative operator prompt | Leads to |
|---|---|---|
| Ask for a change | "`<dummy file>`의 한 줄 바꿔줘" (a fix/change request) | diff preview → `ELIGIBLE` |
| Apply the preview | "적용해줘" | `AWAITING_APPROVAL` → (승인) → `APPROVED` → `PATCH_READY` → `WORKSPACE_APPLIED` |
| (validation) | "테스트 돌려줘" / "타입체크 해줘" (optional; point-in-time) | stays `WORKSPACE_APPLIED` |
| Commit approval | "커밋 승인해줘" | `COMMIT_APPROVAL_PENDING` → (승인) → `COMMIT_APPROVED` |
| Commit execute | "커밋해줘" | `GIT_COMMITTED` |
| Push approval | "푸시 승인해줘" | `PUSH_APPROVAL_PENDING` → (승인) → `PUSH_APPROVED` |
| Push execute | "푸시해줘" | `GIT_PUSHED` |
| PR approval | "PR 만들 수 있게 승인해줘" | `PR_APPROVAL_PENDING` → (승인) → `PR_APPROVED` |
| PR create execute | "PR 만들어줘" | `PR_CREATED` |
| Merge approval | "머지 승인해줘" | `MERGE_APPROVAL_PENDING` → (승인) → `MERGE_APPROVED` |
| Merge execute | "머지해줘" | `PR_MERGED` |
| Local main sync | "main 동기화해줘" | `MAIN_SYNCED` |
| Local branch cleanup | "로컬 브랜치 정리해줘" | `BRANCH_CLEANED` |
| Remote cleanup approval | "원격 브랜치 삭제해줘" | `REMOTE_BRANCH_CLEANUP_PENDING` → (승인) → `REMOTE_BRANCH_CLEANUP_APPROVED` |
| Remote cleanup execute | "원격 브랜치 삭제 실행해줘" | `REMOTE_BRANCH_CLEANED` |

Note: a **CRITICAL** approval prompt appears before push, PR creation, merge, and remote branch cleanup; a **HIGH**
approval prompt appears before commit. Approving records permission only — the mutation runs on the following explicit
execute turn.

---

## 5. Scenario A–H test procedures

Every scenario uses the **sandbox** repo and a **test branch**. Fields per scenario: purpose · preconditions ·
operator prompts · expected state transitions · expected artifacts · manual checks · stop conditions · cleanup.

### Scenario A — happy path through `PR_CREATED`
- **Purpose:** diff → apply approval → apply → (validation) → commit approval/exec → push approval/exec → PR
  approval/exec.
- **Preconditions:** §3 checklist passed; clean checkout on a fresh test branch.
- **Operator prompts:** "바꿔줘" (change request) → "적용해줘" → "승인" → "커밋 승인해줘" → "승인" → "커밋해줘" →
  "푸시 승인해줘" → "승인" → "푸시해줘" → "PR 만들 수 있게 승인해줘" → "승인" → "PR 만들어줘".
- **Expected transitions:** `ELIGIBLE → AWAITING_APPROVAL → APPROVED → PATCH_READY → WORKSPACE_APPLIED →
  COMMIT_APPROVAL_PENDING → COMMIT_APPROVED → GIT_COMMITTED → PUSH_APPROVAL_PENDING → PUSH_APPROVED → GIT_PUSHED →
  PR_APPROVAL_PENDING → PR_APPROVED → PR_CREATED`.
- **Expected artifacts:** modified dummy file; a local commit hash; a pushed test branch; a PR number + canonical URL.
- **Manual checks (GitHub):** branch + commit exist; PR exists with expected head/base/commit; **no** deploy/release/
  tag; token appears nowhere in replies.
- **Stop conditions:** any §6 hard stop; PR opened against the wrong base or a non-test head → hard stop.
- **Cleanup:** close the PR + delete the test branch, OR continue into B/C.

### Scenario B — happy path through `PR_MERGED`
- **Purpose:** merge approval + merge execution.
- **Preconditions:** A reached `PR_CREATED`; the PR is mergeable in the sandbox (else this becomes a valid Scenario-E
  Blocked test).
- **Operator prompts:** "머지 승인해줘" → "승인" → "머지해줘".
- **Expected transitions:** `PR_CREATED → MERGE_APPROVAL_PENDING → MERGE_APPROVED → PR_MERGED`.
- **Expected artifacts:** a merge commit hash; PR shows merged.
- **Manual checks:** PR merged on GitHub at the approved head SHA; reply says merged but **not** deployed/released.
- **Stop conditions:** merge reported success while GitHub shows not merged → expect **Unverified**, not "merged"
  (if it claims a definite outcome that contradicts GitHub → hard stop); any §6 hard stop.
- **Cleanup:** continue to C, or delete the test branch.

### Scenario C — full lifecycle through `REMOTE_BRANCH_CLEANED`
- **Purpose:** local main sync → local branch cleanup → remote cleanup approval → execution.
- **Preconditions:** B reached `PR_MERGED`.
- **Operator prompts:** "main 동기화해줘" → "로컬 브랜치 정리해줘" → "원격 브랜치 삭제해줘" → "승인" →
  "원격 브랜치 삭제 실행해줘".
- **Expected transitions:** `PR_MERGED → MAIN_SYNCED → BRANCH_CLEANED → REMOTE_BRANCH_CLEANUP_PENDING →
  REMOTE_BRANCH_CLEANUP_APPROVED → REMOTE_BRANCH_CLEANED`.
- **Expected artifacts:** local main fast-forwarded; local feature ref gone; remote feature branch deleted.
- **Manual checks:** on GitHub the feature branch is gone and **main is untouched**; local `main` == remote main;
  replies say local branch/main/deploy/release/tag were NOT touched.
- **Stop conditions:** **any deletion of main/default or a non-anchored branch → hard stop**; any §6 hard stop.
- **Cleanup:** sandbox is now clean; reset for the next run if needed.

### Scenario D — approval deny/cancel path
- **Purpose:** deny/cancel never mutates and returns to the prior durable state, clearing only that approval's fields.
- **Preconditions:** reach any approval-pending state (e.g. `COMMIT_APPROVAL_PENDING` or `MERGE_APPROVAL_PENDING`).
- **Operator prompts:** at a pending gate, "거절" (one run) and, separately, "취소".
- **Expected transitions:** pending → back to the prior durable state (e.g. `WORKSPACE_APPLIED` / `PR_CREATED`); no
  mutation.
- **Expected artifacts:** none from the denied/cancelled step.
- **Manual checks:** no new commit/branch/PR/merge/delete on GitHub for the denied action.
- **Stop conditions:** any mutation despite deny/cancel → hard stop.
- **Cleanup:** none (nothing mutated).

### Scenario E — blocked preflight path
- **Purpose:** a known pre-mutation failure is reported **Blocked** ("did not happen") and is safe.
- **Preconditions:** induce a safe pre-mutation failure — e.g. "머지해줘" on a non-mergeable PR (branch protection /
  failing required check), or an execute phrase in the wrong state.
- **Operator prompts:** the relevant execute phrase.
- **Expected transitions:** state unchanged; reply is Blocked wording ("…하지 않았어요" + safe reason).
- **Expected artifacts:** none.
- **Manual checks:** GitHub shows no mutation happened.
- **Stop conditions:** a Blocked path that actually mutated → hard stop.
- **Cleanup:** none.

### Scenario F — unverified/ambiguous remote result handling (only if safely simulatable)
- **Purpose:** at/after-mutation ambiguity is reported **Unverified** — never "did not happen".
- **Preconditions:** ambiguity is hard to force safely against live GitHub — **do not fabricate failures on a real
  remote you cannot fully recover.** Prefer to rely on the automated coverage (manager/adapter tests already exercise
  Blocked vs Unverified) and treat a live run as **OPTIONAL**, only via a controlled, fully-recoverable network
  interruption.
- **Operator prompts:** N/A (observation-only, or a controlled-interruption run).
- **Expected transitions:** state stays at the pre-mutation approved state; reply is Unverified wording ("결과를
  확인하지 못했어요 … 확인해 주세요").
- **Manual checks:** verify the true remote state in GitHub.
- **Stop conditions:** an ambiguous result reported as **definitely not performed** → hard stop (safety invariant).
- **Cleanup:** reconcile the sandbox to a known state after manual verification.

### Scenario G — wording / no-overclaim verification
- **Purpose:** no reply implies deployed / released / tagged / production-ready / CI-permanently-verified /
  all-branches-cleaned / repository-fully-cleaned / safe-forever.
- **Preconditions:** any run from A–C.
- **Operator prompts:** normal lifecycle prompts; read every success/terminal reply.
- **Expected:** each mutation reply states what it did **and** what it did NOT do; previews are point-in-time.
- **Manual checks:** scan transcripts for the forbidden claims (see §11).
- **Stop conditions:** a claim of deployed/released/production-ready → hard stop; softer over-claim → DOC finding.
- **Cleanup:** none.

### Scenario H — token/secret non-exposure verification
- **Purpose:** the GitHub token never appears in any reply, anchor, or log.
- **Preconditions:** token configured (adapter-local).
- **Operator prompts:** any remote step (push/PR/merge/remote-delete).
- **Expected:** no reply/log/anchor contains the token or a `ghp_` / `github_pat_` pattern.
- **Manual checks:** grep the transcript + any local logs for the token / `ghp_` / `github_pat_` / "token".
- **Stop conditions:** any token/secret appearing anywhere → hard stop (safety invariant); **rotate the token
  immediately**.
- **Cleanup:** if a token ever leaked, rotate it and stop UAT.

---

## 6. Hard stop / manual verification / safe retry / non-blocking

**HARD STOP — halt UAT immediately, record, report to CA:**

```text
token or secret shown in any response / log / anchor
runtime claims deployed / released / production-ready / tagged
an ambiguous remote result reported as DEFINITELY not performed (Unverified rule violated)
any deploy / release / tag / package attempt
default/main branch deletion attempt, or force / reset --hard behavior
an unexpected remote mutation, or a mutation targeting a non-anchored / user-supplied branch
an unexpected file mutation outside the approved change
working tree not recoverable
```

**MANUAL VERIFICATION REQUIRED — pause, confirm in GitHub before continuing:**

```text
any Unverified reply (push/PR/merge/remote-delete) — verify the true state on GitHub
a Blocked reply where you expected success — confirm nothing mutated, then decide
merge / branch-cleanup behavior under sandbox branch protection
```

**SAFE RETRY ALLOWED — recoverable; retry after checking:**

```text
a not-configured "unavailable" reply (missing token/identity) — fix config, retry
a Blocked pre-mutation reply (dirty tree, wrong state) — remediate the precondition, retry
nothing-to-push / already-merged / already-cleaned idempotent replies
```

**NON-BLOCKING OBSERVATION — note it, keep going:**

```text
wording polish suggestions (non-over-claiming)
a point-in-time status preview that changes shortly after (expected)
cosmetic / UX notes
```

---

## 7. Blocked vs Unverified interpretation (read carefully)

```text
BLOCKED     → a known pre-mutation failure. The operation did NOT happen. Safe to say "not performed".
              Wording pattern: "…하지 않았어요" + a safe reason.
UNVERIFIED  → the mutation was ATTEMPTED but the outcome could not be confirmed. It MAY have happened.
              NEVER read this as "did not happen". You MUST verify the true state manually in GitHub.
              Wording pattern: "결과를 확인하지 못했어요 … 확인해 주세요".
IDEMPOTENT  → already in the desired state (already merged / branch already absent / nothing to push).
              A safe no-op success with an "already …" wording.
UNAVAILABLE → not configured (missing token/identity). No state change. Fix config and retry.
```

GitHub's ref-delete has no atomic conditional delete, so a remote branch delete uses read-immediately-before-delete +
SHA verify; if the DELETE outcome is ambiguous it is **Unverified**, and you confirm on GitHub.

---

## 8. Known limitations (do not misunderstand)

```text
v1 RC is NOT a production release.
UAT is NOT a deploy.
PR_MERGED means merged on the hosting provider only — NOT deployed / released.
MAIN_SYNCED is a LOCAL main fast-forward only.
BRANCH_CLEANED is a LOCAL merged-branch delete only.
REMOTE_BRANCH_CLEANED is deletion of the approved remote PR head branch only — NOT "all branches cleaned",
  NOT "repository fully cleaned".
CI status / merge preview is POINT-IN-TIME only (can change immediately after).
Post-apply validation (pnpm test/typecheck) is POINT-IN-TIME only — there is no durable "validated" state.
Remote ambiguity (Unverified) must be verified MANUALLY in GitHub — Unverified never means "did not happen".
Optional hardening H3/H4/A5 and the ARCHITECTURE lifecycle cross-ref are NOT implemented.
The bot never deploys/releases/tags/publishes, never deletes main/default, never force-pushes, never bulk-deletes.
```

---

## 9. Evidence collection template (NO secrets)

Fill one per session. **Never** record a token / secret / raw credential / private log. If a screenshot would show a
token, redact it.

```text
Session date / operator:
Sandbox repo (owner/repo):
Bot version / commit under test:
Scenarios run: A [ ] B [ ] C [ ] D [ ] E [ ] F [ ] G [ ] H [ ]
Final state reached:
Created commit hash:
Pushed branch name:
PR number + URL:
Merge commit hash (if merged):
Local main sync evidence (main SHA before → after):
Local branch cleanup evidence (ref gone? y/n):
Remote branch cleanup evidence (branch absent on GitHub? main untouched? y/n):
typecheck / test result (if run):
Manual GitHub verification notes per remote step:
Blocked / Unverified wording observed + manual-verification outcome:
Per-scenario result: A __ B __ C __ D __ E __ F __ G __ H __  (pass / fail / n-a)
Known-issue notes:
Token/secret exposure observed? (must be NO):
```

---

## 10. Post-UAT result classification (for CA)

Classify the session as exactly one primary result (plus any secondary findings):

```text
PASS                 — UAT confirms RC usability across tested scenarios; no safety issue.
BUGFIX REQUIRED      — a specific functional defect to fix before broader testing (not a safety violation).
DOC UPDATE REQUIRED  — a guide/scenario/wording issue only (no code change).
OPTIONAL HARDENING   — an improvement surfaced (e.g. H3/H4/A5) but NOT blocking.
STOP RELEASE TRACK   — a safety invariant violation (token leak, deploy/release over-claim, Unverified-as-
                        not-performed, main/default deletion, force/reset, unexpected remote mutation) → HARD BLOCKER.
```

Rule: **do not inflate optional polish into a blocker; any safety invariant violation is a hard blocker.**

---

## 11. Cleanup procedure (after every session)

```text
1. Stop the bot session.
2. On the SANDBOX GitHub repo: delete any leftover test branches; if a PR was left open, close it.
3. If the dummy change should not persist, revert the dummy commit on main (or leave the sandbox to be recreated).
4. Confirm main is untouched/at its expected commit; confirm no unexpected branches/PRs remain.
5. Locally: return the checkout to a clean working tree at a known commit.
6. Since the sandbox is disposable, the simplest reset is to recreate it for the next run.
7. Do NOT commit any UAT artifacts, tokens, or transcripts into the product repository.
```

Forbidden claim reference (for §5 Scenario G / §6): a reply must never imply **deployed · released · tagged ·
production-ready · CI permanently verified · all branches cleaned · repository fully cleaned · safe forever**.

---

*This guide is documentation only. It changes no product behavior. Running UAT is a separate, CA-approved step.*
