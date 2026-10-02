# Quoky Personal v2 — Code-work GitHub Chain Attended Live UAT Packet (ADR-0099 D4/D5)

> **This packet describes how to run the attended code-work push → PR Live UAT. Executing any part of it requires a
> separate, exact-scope Strict Product Owner approval** (`docs/governance/DEVELOPMENT-MODE.md`, ADR-0099 "Strict
> gates"). Authoring or merging this document grants no runtime, Discord, Claude provider, `.env.local`, GitHub App
> key, dev-DB, push or PR authority. The first live push (U6) and the first live PR (U7) are Strict actions in their
> own right, each also behind Quoky's CRITICAL approvals. Sandbox cleanup is a **separate human gate** (section 7).

Status: **NOT EXECUTED.** Offline acceptance is the prerequisite and covers the chain with a real local git
repository whose `origin` is a local bare repository, a fake AI proposal and a fake repository-hosting manager:
`apps/quoky/src/code-v2-remote-acceptance.test.ts`, plus
`packages/core/src/application/code-work/push-target-resolution.test.ts`,
`packages/core/src/application/code-work/git-branch-runtime.integration.test.ts`,
`apps/quoky/src/personal-hosting-guard.test.ts`, `apps/quoky/src/personal-git-guard.test.ts` and the push/PR/merge
sections of `packages/core/src/application/conversation-runtime.test.ts`. This packet covers only what fakes cannot
prove: a real Discord turn sequence, the real Claude provider, the real GitHub App token mint, a real push to
GitHub and a real Pull Request.

## 1. Scope

| In scope | Out of scope (hard) |
|---|---|
| Sandbox repository `jonghyungJeon-private/quoky-uat-sandbox` only, through the GitHub App `quoky-dev` | The product repository, any other repository, any organization repository |
| `QUOKY_GIT_REMOTE_ENABLED=true`, `QUOKY_GIT_MERGE_ENABLED=false`, `QUOKY_RUNTIME_ENV=dev` | **Any `QUOKY_GIT_MERGE_ENABLED=true`** (merge, main sync, post-merge cleanup, remote branch delete) |
| One owner · one bot · one allowlisted channel · the delegated dev DB | Shared/production server or DB; any non-owner participant |
| U1–U10: branch create, a 2-file change set, apply, commit, first push of a new remote branch, PR creation, PR status, negatives, rollback probe | Force push, history rewrite, tag, release, deployment, CI changes |
| Secret-free evidence (section 6) | Closing the PR, deleting the remote branch, resetting the sandbox — section 7, a separate human gate outside Quoky |

## 2. Preconditions

1. Exact-scope Strict approval for this UAT is recorded (reference it in the result record), naming: App key
   secret access, Discord, the Claude provider, workspace apply and commit in the sandbox clone, the first live
   push (U6) and the first live PR (U7). Nothing beyond the approved scope is attempted.
2. The integration commit under test is checked out in the product repository; record `git rev-parse HEAD`;
   `git status --short` is clean; `pnpm typecheck` and `pnpm test` are green on it (including
   `code-v2-remote-acceptance.test.ts`).
3. The sandbox clone registered as the Quoky project is `jonghyungJeon-private/quoky-uat-sandbox`, checked out on
   `main`, clean, and `main == origin/main` (read-only `git status --short`, `git rev-parse main origin/main` after a
   read-only `git fetch` performed by the operator). No `uat/*` branch exists locally or on the remote
   (`git branch --list 'uat/*'`, `git ls-remote --heads origin 'uat/*'` — both empty).
4. The GitHub App `quoky-dev` is installed on the sandbox repository only, with contents and pull requests write.
   The App private key stays where `.env.local` points; it is never printed, copied or attached.
5. `.env.local` (edited only under this approval; values never printed) sets:

   | Variable | Value |
   |---|---|
   | `QUOKY_RUNTIME_ENV` | `dev` |
   | `QUOKY_GIT_REMOTE_ENABLED` | `true` |
   | `QUOKY_GIT_MERGE_ENABLED` | `false` (or unset; `true` is out of scope, and `true` with remote off is a startup error) |
   | `QUOKY_GITHUB_OWNER` / `QUOKY_GITHUB_REPO` | `jonghyungJeon-private` / `quoky-uat-sandbox` |
   | `QUOKY_GITHUB_APP_ID`, `QUOKY_GITHUB_APP_PRIVATE_KEY_PATH` (or `_PRIVATE_KEY`), optional `QUOKY_GITHUB_APP_INSTALLATION_ID` | the `quoky-dev` App (values never printed) |
   | `QUOKY_GITHUB_TOKEN` | **unset** (App-only; no PAT fallback for this UAT) |

## 3. Runtime start (AGENTS.md "Temporary Local/UAT Runtime Environment")

1. Compare variable **names** only between `.env.local` and the process environment (never print values):

   ```sh
   grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.local | cut -d= -f1 | sort -u > /tmp/uat-envlocal-names
   env | cut -d= -f1 | sort -u > /tmp/uat-process-names
   comm -12 /tmp/uat-envlocal-names /tmp/uat-process-names
   ```

2. Any printed name is a collision: remove it for the launch with `env -u NAME`. Always remove (or prove absent)
   `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID`. Never source `.env`.

   ```sh
   env -u DISCORD_BOT_TOKEN -u DISCORD_GUILD_ID pnpm dev
   ```

3. Before declaring readiness, verify read-only that the connected bot identity, guild and channel match the
   `.env.local` targets. On a mismatch or if it cannot be verified: stop the runtime, perform no Discord action,
   report a blocker.

Record: collision check performed (yes/no), colliding **names** removed (no values), product HEAD, sandbox `main`
SHA, flags used.

## 4. Steps U1–U10

Send each message in the allowlisted channel as the owner. Record the reply gist and PASS/FAIL per step. Operator
checks are **read-only** git or GitHub UI reads in the sandbox clone.

| # | Action | Expected result |
|---|---|---|
| U1 | Preflight (sections 2–3) | All preconditions recorded; runtime ready; no `uat/*` branch anywhere |
| U2 | `브랜치 만들어줘 uat/code-v2-<yyyymmdd>` | `새 브랜치를 만들고 전환했어요` with `main → uat/code-v2-<yyyymmdd>`; no approval, no remote change. Operator: `git rev-parse --abbrev-ref HEAD` is the new branch; `main` unchanged |
| U3 | A change request naming one existing file and one new file in a new directory, with explicit create wording (e.g. `README.md에 사용법 한 줄 추가하고 새 파일 docs/uat/hello.md도 만들어줘`) → `승인` → 2-file preview → `적용해줘` → `승인` → `패치 만들어줘` → `패치 적용해줘` | One preview block per file; the apply reply names both files and marks the new file. Operator: `git status --short --untracked-files=all` shows exactly ` M README.md` and `?? docs/uat/hello.md` |
| U4 | `테스트 실행해줘` | The validation reply (pass/fail is informational for the sandbox); no git change |
| U5 | `커밋해줘` → `승인` → `커밋 실행` | One commit on the uat branch containing exactly the 2 files (the new file marked). Operator: `git show --stat HEAD` lists exactly those 2 files; `git status --short` is empty; `main` unchanged |
| U6 | `푸시해줘` | **CRITICAL** push approval naming the commit, `대상: origin/uat/code-v2-<yyyymmdd>` and "원격에 아직 없는 브랜치 — push하면 원격에 새 브랜치로 만들어져요", "강제 push는 하지 않고, 로컬 업스트림(추적 브랜치)도 설정하지 않아요"; nothing pushed yet |
| U6a | `승인` | `push 승인은 기록했어요` + `실제로 push하려면 "푸시 실행"이라고 알려 주세요`; nothing pushed yet |
| U6b | `푸시 실행` | `원격에 새 브랜치로 push했어요: <short> → origin/uat/code-v2-<yyyymmdd>`. Operator: `git ls-remote --heads origin uat/code-v2-<yyyymmdd>` equals the U5 commit; `git rev-parse --abbrev-ref --symbolic-full-name @{u}` still fails (no upstream set); remote `main` unchanged |
| U7 | `PR 만들어줘` | **CRITICAL** PR approval: head `uat/code-v2-<yyyymmdd>` → base `main`, the pushed commit, a deterministic title; no PR yet |
| U7a | `승인` | `PR 생성 승인은 기록했어요` + `실제로 PR을 만들려면 "PR 생성 실행"이라고 알려 주세요`; no PR yet |
| U7b | `PR 생성 실행` | The PR URL. Operator (GitHub UI, read-only): head = the uat branch, base = `main`, head commit = the U5 commit, opened by the App |
| U8 | `PR 상태 봐줘` | Read-only status preview (open/checks as GitHub reports); no state change |
| U9 | Negatives, each with **no remote change** (re-check `git ls-remote --heads origin` after each): | |
| U9a | `병합해줘` (and `머지해줘`) | `병합은 이 설정에서 꺼져 있어요(QUOKY_GIT_MERGE_ENABLED=false)…`; no merge approval is created; the PR stays open |
| U9b | `강제 푸시해줘` | Fixed refusal (push with force/companion wording is not supported); no approval |
| U9c | Operator switches the sandbox clone to `main` (read-only-safe `git switch main`), then `푸시해줘` | Refused before any approval (HEAD is not the committed commit / main is never pushed); switch back afterwards |
| U9d | A change request creating `src/secrets.js` | Refused by the secret-filename policy at the first stage it applies (target, preview or apply); no file created, nothing sent to the provider, no override offered |
| U9e | With an uncommitted local edit in the clone, `uat/other 브랜치로 전환해줘` (operator creates `uat/other` locally first) | Refused with no branch change — from a committed/PR stage the fixed "after commit approval" refusal, otherwise `커밋하지 않은 변경이 있어서 전환하지 않았어요`; the operator then reverts the edit and deletes `uat/other` |
| U10 | Rollback probe on a second 2-file change set (one update + one new file): after `패치 만들어줘`, the operator edits the update target externally, then `패치 적용해줘` | The rolled-back / not-applied wording ("nothing changed"); both files exactly as before the apply and the new file absent (`git status --short --untracked-files=all` shows only the operator's external edit, which the operator then reverts) |

A failed step is recorded and the session stops at that step; no retry with widened scope.

## 5. Stop conditions

Stop the runtime and report a blocker on: a bot/guild/channel identity mismatch; any reply claiming a push, PR,
merge or deletion that the operator's read-only check contradicts; any push or PR outside the sandbox repository;
any secret, token, App JWT, `Authorization` header or private-key material appearing in a reply, log line or
screenshot; any merge or branch deletion attempt reaching GitHub.

## 6. Evidence rules (secret-free)

- Record: product HEAD, sandbox `main` SHA before/after, the uat branch name, the U5 commit SHA, the `ls-remote`
  SHA after U6b, the PR number/URL, the PR head/base, each step's PASS/FAIL and reply gist.
- Never record: tokens, App JWTs, installation tokens, `Authorization` headers, the App private key or its path
  contents, `.env.local` values, or an `env` dump. Screenshots crop out everything but the conversation and the PR
  head/base/commit fields.
- Runtime log scan after the session: no token-shaped string, no file content beyond what the replies show.
- Results go to `docs/uat/code-v2-github-chain-uat-result-<yyyy-mm-dd>.md` (a new file, under its own approval).

## 7. Cleanup — a SEPARATE human-approved gate (performed outside Quoky)

Not part of this UAT's approval. With its own exact-scope approval, the owner (not Quoky) closes the UAT PR without
merging, deletes the remote `uat/code-v2-<yyyymmdd>` branch, deletes the local uat branches, and resets the sandbox
clone to `origin/main`. Quoky's merge, main sync and remote branch cleanup stay disabled
(`QUOKY_GIT_MERGE_ENABLED=false`) throughout; enabling them is out of scope for Personal v2.
