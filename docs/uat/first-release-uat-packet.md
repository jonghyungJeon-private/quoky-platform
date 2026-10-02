# Quoky Personal v1 — First-Release Attended Live UAT Packet (AC12)

> **This packet describes how to run the attended Live UAT. Executing it requires separate Strict Product Owner
> approval** (`docs/governance/DEVELOPMENT-MODE.md`). Authoring or merging this document grants no runtime, Discord,
> provider, network, or secret authority. Nothing here may be run until that approval is recorded.

Status: **NOT EXECUTED.** Offline acceptance (`apps/quoky/src/first-release-acceptance.test.ts`) is the
prerequisite; this packet covers only what offline fakes cannot prove (a real Discord gateway, real providers).

## 1. Scope

| In scope | Out of scope (hard) |
|---|---|
| One owner · one Discord bot · one DM and one designated channel · local Claude CLI (and Ollama if enabled) | Any other user acting as owner, any shared/production server |
| Part 1: conversation (owner gate, context, memory, help/reset) | Part 1 and 2 never touch a production repository |
| Part 2: local code flow on a **disposable pnpm sandbox repo** | Git push, PR, merge, remote branch cleanup (`QUOKY_GIT_REMOTE_ENABLED` stays `false`) |
| Verification of every claim by direct observation | Deploy, release, tag, publish, version bump |

## 2. Preconditions

1. Strict Product Owner approval for this UAT run is recorded (reference it in the result record).
2. The integration commit under test is checked out; record `git rev-parse HEAD`; `git status --short` is clean.
3. `pnpm typecheck` and `pnpm test` are green on that commit.
4. A Discord application and bot exist with **MESSAGE CONTENT INTENT** enabled and an invite per
   [`docs/user/quickstart.md`](../user/quickstart.md). The owner's user ID and one channel ID are known.
5. `claude --version` works (Claude Code CLI with `--model`/`--effort`/`--tools`; tested with 2.1.287) and
   `ANTHROPIC_API_KEY` is **unset** in the launching shell. Ollama (optional): server running with `OLLAMA_MODEL`
   pulled. Record which providers are expected to be ready.
6. Sandbox repo for Part 2 (see section 5) exists on a **non-main branch**.
7. A second Discord account (not an owner) is available to send the non-owner message.

## 3. Pre-start environment collision check (mandatory)

Rule source: `AGENTS.md` -> "Temporary Local/UAT Runtime Environment". `.env.local` is the configuration source and
the loader uses `override: false`, so an inherited process variable silently beats `.env.local`.

1. Prepare `.env.local` from `.env.example` (`cp -n .env.example .env.local`) and set `DISCORD_BOT_TOKEN`,
   `QUOKY_DISCORD_OWNER_IDS`, `QUOKY_DISCORD_CHANNEL_IDS`. Do not print values. Do not source `.env`. Do not rely
   on a login-shell Discord configuration.
2. Compare variable **names** only:

   ```sh
   # names declared in .env.local (values never printed)
   grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.local | cut -d= -f1 | sort -u > /tmp/uat-envlocal-names
   # names present in the current process environment
   env | cut -d= -f1 | sort -u > /tmp/uat-process-names
   comm -12 /tmp/uat-envlocal-names /tmp/uat-process-names
   ```

3. Any name printed by `comm` is a collision. Do **not** start as-is. Remove duplicates for the launch command with
   `env -u NAME` (always for `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID` unless their absence from the process
   environment was verified):

   ```sh
   env -u DISCORD_BOT_TOKEN -u DISCORD_GUILD_ID pnpm dev
   ```

4. After start, **before declaring readiness**, verify read-only that the connected bot identity, guild, and channel
   match the intended `.env.local` targets. If they differ or cannot be verified, stop the runtime, perform no
   Discord action, and report a blocker.
5. Record in the result: collision check performed (yes/no), colliding **names** removed (no values).

Startup is expected to log `database` (absolute path), `provider ready` / `provider not ready` lines, and finally
`started (Quoky Personal v1)`.

## 4. Part 1 — Conversation

Use the owner account. Record the observed reply gist (never secrets) and PASS/FAIL per step.

| # | Action | Expected result |
|---|---|---|
| 1.1 | In the **DM**, send `안녕` | A reply arrives (no @mention needed) |
| 1.2 | In the **designated channel**, send `안녕` | A reply arrives in that channel |
| 1.3 | In the same place, send a follow-up that depends on the previous answer (e.g. `방금 답을 이어서 설명해줘`) | The reply continues the topic (context kept) |
| 1.4 | Send `도움말` | Fixed help text ("Quoky로 할 수 있는 일이에요.") listing `기억해:`, the code flow phrases, `도움말`, `새 대화`; arrives immediately (no model latency) |
| 1.5 | Send `기억해: 내 UAT 암호는 파랑 고래야` (use a harmless fact, never a real secret) | Acknowledged as remembered |
| 1.6 | Ask `내 UAT 암호가 뭐였지?` | The answer contains the remembered fact |
| 1.7 | Send `새 대화` | Reply "새 대화를 시작할게요..." and says applied changes/commits are not rolled back and remembered content stays |
| 1.8 | Repeat 1.6 | Fact is recalled after the reset |
| 1.9 | From the **other** surface (DM if 1.5 was in the channel, or vice versa) repeat 1.6 | Fact is recalled across DM/channel |
| 1.10 | Stop the runtime, start it again (repeat section 3), repeat 1.6 | Fact is recalled after restart |
| 1.11 | From the **non-owner** account, DM the bot and message the designated channel | **No reply at all** from the bot. No error message. (Confirm nothing posted in either place) |
| 1.12 | Run **after Part 2 step 2.2** (an active project is registered), then ask `현재 연결 상태 알려줘` | The reply makes **no false connection claim**: it must not assert verified live connections (Jira, GitHub, Slack, etc.) that Quoky did not check. Record the exact claim wording if any is questionable |

Optional provider observation (record only): which provider answered ordinary chat (Ollama if ready, otherwise
Claude), per the startup `provider ready` lines. If Ollama was stopped for a trial, chat must still answer via
Claude without a restart.

## 5. Part 2 — Disposable sandbox local code flow

### 5.1 Sandbox

Create a throwaway pnpm repo **outside** the Quoky checkout, on a feature branch, with an existing file to change:

```sh
mkdir -p ~/quoky-uat-sandbox && cd ~/quoky-uat-sandbox
git init -b main && git checkout -b uat/sandbox
mkdir src
cat > package.json <<'EOF'
{ "name": "uat-sandbox", "private": true, "scripts": { "test": "node test.js" } }
EOF
printf "module.exports = { greet: () => 'hello' };\n" > src/greet.js
printf "const assert = require('node:assert');\nassert.strictEqual(require('./src/greet').greet(), 'hello');\nconsole.log('ok');\n" > test.js
git add -A && git -c user.name=uat -c user.email=uat@example.invalid commit -m "init sandbox"
```

(The sandbox needs no dependencies; `pnpm test` just runs `node test.js`.) No remote is configured.

**The target file must live in a subdirectory.** Target-path recognition requires a relative path with at least one directory segment (e.g. `src/greet.js`). A bare root-level filename (`index.js`, `README.md`) or a path starting with `./` or `/` is not recognized as a target, and Quoky would answer with a "which file?" clarification instead of the approval request, which would make every later step fail.

### 5.2 Steps

Send each phrase as its own message in the owner's DM or designated channel.

| # | Send | Expected |
|---|---|---|
| 2.1 | `새 대화` | Clean session (project binding cleared) |
| 2.2 | `이 프로젝트 등록해줘: <absolute path of ~/quoky-uat-sandbox>` | Project registered and active |
| 2.3 | `src/greet.js 파일을 수정해줘: 파일 맨 위에 한 줄 주석을 추가해줘` (or `/preview src/greet.js ...`) | A code-change **approval request** (risk HIGH). File unchanged |
| 2.4 | `진행하지 마` (negated approval) | **Refused**: treated as a denial, not an approval. The request is not applied; file unchanged (`git status` in sandbox clean). Then send the request in 2.3 again |
| 2.5 | `승인` | A read-only **diff preview** of `src/greet.js` is delivered. File unchanged |
| 2.6 | `적용해줘` | A second approval request for applying. File still unchanged |
| 2.7 | `승인` | "적용 승인만 기록했어요..." and the next phrase `패치 만들어줘`. File still unchanged |
| 2.8 | `패치 만들어줘` | Patch preview starting with "패치 미리보기를 만들었어요. 아직 실제 파일에는 적용하지 않았어요. 파일은 수정되지 않았어요." and ending with a footer that names `"패치 적용해줘"`. File unchanged |
| 2.9 | `패치 적용해줘` | `파일을 수정했어요: src/greet.js`; states git commands, commit/push, and tests were **not** run. `git diff` in the sandbox now shows exactly the previewed change (state WORKSPACE_APPLIED) |
| 2.10 | `테스트 실행해줘` | Quoky runs `pnpm test` in the sandbox and reports the result. **No separate approval is requested** — this is the documented behavior; the sandbox must therefore be disposable. The comment-only change keeps the sandbox test passing; record the reported result. |
| 2.11 | `테스트 실행하지 마` | **No** test run starts; the message is not treated as a test request |
| 2.12 | Optional: `도움말` while a request is pending, and an unrelated message while an approval is pending | `도움말` returns help; the unrelated message gets the pending-approval reminder (with remaining minutes), not chat |

Remote git exclusion: do **not** request push, PR, merge, or branch cleanup. If curious, confirm instead that a
remote request is refused: send `푸시해줘` after 2.9 and verify no push is performed and no git change is claimed
(no remote exists and `QUOKY_GIT_REMOTE_ENABLED` is `false`). Local commit (`커밋해줘` -> `승인` -> `커밋 실행`) is
optional and must be on `uat/sandbox`; a commit while on `main` must be refused.

## 6. Pass criteria

AC12 PASSES only when **every** Part 1 and Part 2 step above is PASS, no secret appears in any bot reply, log
excerpt, or the result record, the non-owner got no reply, no file changed before the step that applies it, the negated
approval did not approve, and no remote git effect occurred. Any FAIL is reported with the step number; do not
patch source during the UAT.

## 7. Cleanup

Stop the runtime (Ctrl+C). Remove the sandbox (`rm -rf ~/quoky-uat-sandbox`), the temporary name lists from
section 3 (`rm -f /tmp/uat-envlocal-names /tmp/uat-process-names`), and consider rotating the bot token if it was
exposed anywhere. `.env.local` stays uncommitted.

## 8. Result recording template (secret-free)

Copy into a new result record. Never include tokens, key material, environment **values**, or private message
content beyond the harmless test fact.

```markdown
# Quoky Personal v1 — Live UAT result (AC12)

- Approval reference (Strict Product Owner): <link/id>
- Date / operator: <YYYY-MM-DD> / <name>
- Commit under test: <git rev-parse HEAD>
- Offline gate: pnpm typecheck <PASS/FAIL>; pnpm test <PASS/FAIL>
- Node / pnpm / claude / ollama versions: <...>
- Providers ready at startup (from `provider ready` lines): <names>
- Env collision check: performed <yes/no>; colliding names removed: <NAMES ONLY or none>
- Bot/guild/channel identity verified against .env.local targets: <yes/no>

## Part 1 — Conversation
| Step | PASS/FAIL | Observation (no secrets) |
|---|---|---|
| 1.1 .. 1.12 | | |

## Part 2 — Sandbox local code flow
| Step | PASS/FAIL | Observation (no secrets) |
|---|---|---|
| 2.1 .. 2.12 | | |

- Sandbox `git status`/`git diff` matched expectations at 2.4, 2.8, 2.9: <yes/no>
- Remote git effects observed: <none>
- Secrets observed in replies/logs: <none>
- Blockers / deviations: <...>
- Cleanup done: <yes/no>
- Overall AC12: <PASS / FAIL / BLOCKED>
```
