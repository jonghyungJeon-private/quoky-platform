# Quoky Personal v3 — Plan

- **Status:** Approved for execution; ADR-0102..0112 ratified by the Product Owner on 2026-10-06 with all recommended defaults (ratification record in `DECISIONS.md`). Planning only: nothing here ratifies an ADR or authorizes a Strict action. GOV-3
  (2026-10-06) appended the new decisions to `DECISIONS.md` as ADR-0102..0112, each **Ratified 2026-10-06** (previously Proposed); the former `TBD-ADR-n` placeholders below now carry the real numbers.
  GOV-4 (2026-10-06) added **ADR-0113 (local operations UI, track OPS) as Proposed (awaiting owner ratification)** and
  recorded the owner decision that a Telegram platform adapter is a post-v3 extension.
- **Date:** 2026-10-03
- **Base:** `claude/v2-wave8` `eaacca2` (Personal v2 waves 1-7 on `main` at `ba28314`, plus INT-1 and DOC-B; the wave-8
  PR is not merged yet). SQLite schema v13, `ConversationRuntimeDeps` = 34, five registered turn handlers.
- **Inputs:** `CURRENT_STATE.md` (Personal v2 entry), `docs/uat/personal-v2-qa-record.md`, `docs/uat/operator-guide.md`
  Part 0, ADR-0096..0101 and the ADR-0098 amendment, `ROADMAP.md` "Personal v3 candidates".
- **Structure:** mirrors `docs/plans/personal-v2-execution-plan.md`. Where this plan and a ratified ADR disagree, the ADR
  wins and this plan is corrected.

**ADR mapping (GOV-3, 2026-10-06; all Ratified 2026-10-06):**

| Placeholder | ADR | Track | Placeholder | ADR | Track |
|---|---|---|---|---|---|
| TBD-ADR-1 | ADR-0102 runtime substrate | SUB-1/2 | TBD-ADR-7 | ADR-0108 PR title/body, status token | CODE-6/7/9 |
| TBD-ADR-2 | ADR-0103 Personal trust for continuation | SUB-3 | TBD-ADR-8 | ADR-0109 multi-repo allowlist | CODE-8 |
| TBD-ADR-3 | ADR-0104 internal-action guard, help intent | DET-1, LLM-1 | TBD-ADR-9 | ADR-0110 calendar read | CAL-1/2 |
| TBD-ADR-4 | ADR-0105 model choice, MLX provider | LLM-2/3 | TBD-ADR-10 | ADR-0111 files and images | MM-1/2 |
| TBD-ADR-5 | ADR-0106 memory commands | MEM-1 | TBD-ADR-11 | ADR-0112 connector writes (v15) | CWR-1/2 |
| TBD-ADR-6 | ADR-0107 learning store (v14), locality | LRN-1..4 | — | ADR-0113 local operations UI (**Proposed**, GOV-4) | OPS-1/2 |

## 1. Goal and scope

**Where v2 leaves the Personal edition (estimate):** about 65% (`CURRENT_STATE.md`). The owner can chat (Ollama first,
Claude for policy-sensitive turns), keep durable memory, use reminders (opt-in, DM), give 👍/👎 feedback, manage to-dos,
look up work items (not live-verified), and run the code chain up to PR creation on one sandbox repository. Three gaps
keep it from being a service a real user relies on every day:

1. **It only runs while someone runs `pnpm dev`.** Reminders fire only while the process is up. A missed reminder is
   delivered once at the next start, so it can arrive hours late.
2. **When a phrase misses the deterministic handlers, the local model can invent an outcome.** Live QA found
   QA-V2-005, W7-02, W7-03 and W7-05. Each was fixed one at a time; the general class is still open.
3. **What it can see and do is narrow.** It has no calendar, cannot look at images or files, writes nothing to work
   tools, and gives the owner no way to see or correct what it remembers.

**v3 target (estimate, not a measured metric): about 85%.** The bar is the owner's standing rule, "needed for a real
user to use the service?" For a real user, "done" means all of the following:

- Quoky runs unattended on an always-on owner machine, restarts after a crash or reboot, and backs up its database. No
  operator has to launch it.
- Live QA never sees a fabricated action claim. Every action-shaped phrase in a feature's vocabulary either gets a
  deterministic reply or reaches a guard that reports that nothing was done.
- The owner can read today's and tomorrow's calendar, ask about an image or a text file in Discord, and post a Jira
  comment or Slack message through an exact-payload approval.
- The owner can list, edit and forget memories with chat commands.
- Answer quality is measured, and it improves only through owner-approved changes: curated examples, routing rules, or
  a model switch backed by an evaluation.

The remaining ~15% is left out of v3 on purpose: multi-agent runtime, local fine-tuning (pending enough curated data),
merge/deploy automation, more platforms (a Telegram adapter is a post-v3 extension, owner decision 2026-10-06), and
anything for the Team or Hosted editions, including remote access to the operations UI.

**Priority tiers.** P0 is needed for a real user. P1 makes the service clearly more useful. P2 is stretch work or waits
on a decision. P0 and P1 make up the 85% target.

| Tier | Items |
|---|---|
| P0 | v2 carry-over live sessions (section 2), SUB-1/2 always-on runtime, DET deterministic coverage, LLM local-model quality, MEM memory commands, LRN-1/2 measurement and owner-curated loop, CODE-6/7 PR status and PR title/body |
| P1 | CAL-1/2 calendar read, MM-1/2 files and images, CWR-1/2 Jira comment/transition and Slack post, LRN-3 offline mining, OPS-1/2 local operations UI (monitoring, then handling) |
| P2 | SUB-3 continuation activation, CODE-8 multi-repo, CODE-9 merge enablement, LRN-4 local fine-tuning, calendar writes, OPS-2b (approve-path runtime extraction and config fold, if needed) |
| Out | Multi-agent runtime, Team/Hosted tenancy, deploy/release automation, Confluence/GitHub-issue writes, remote access to the operations UI (Tailscale or other tunnels, LAN binding) and a separate mobile/desktop client (Team/Hosted, ADR-0113 D11), **a Telegram platform adapter (post-v3 extension: owner decision 2026-10-06, after all v3 development completes; see `ROADMAP.md` "Post-v3 extensions")** |

## 2. Carry-over from v2 (not yet live, or accepted residuals)

None of these items is done. The QA record and operator guide Part 0.6 list each one as pending.

| # | Item | State | v3 handling |
|---|---|---|---|
| C1 | Connector lookups on real Jira, Slack, Confluence and GitHub tenants | **Jira, Confluence and GitHub ran live 2026-10-06** (PC-4..PC-8; Confluence fixed to Basic auth); Slack NOT RUN (no user token yet). Original note: NOT EXECUTED; waiting for the owner's credentials. Also unverified: the Jira `/search/jql` endpoint, the Confluence auth style, and whether Slack search needs a user token | **W0**, one read-only GET probe per connector, then attended work-chat QA. This must pass before CWR or CAL starts its own live QA. Any fix lands in the connector package only |
| C2 | Reminders channel delivery and the allowlist-removal DM fallback | **Channel delivery PASS 2026-10-06** in the owner's `#reminder` channel (PC-3, after fix af419b7) | **W0** attended UAT with `QUOKY_REMINDERS_CHANNEL_DELIVERY=true` |
| C3 | Release default of `QUOKY_REMINDERS_ENABLED` (still `false`) | Pending a decision | Flip to `true` once the DM path has passed live (it has) and SUB-1 is live. Release default of channel delivery stays `false`; the owner host enables it for `#reminder` (ADR-0102 D9) |
| C4 | Merge-flag enablement | Never live-tested; the merge path was only checked to refuse | P2 as CODE-9. The release default stays `false` (owner decision 7) |
| C5 | GitHub App Checks permission and token scope (QA G11) | **DONE in PR #113 (6a59526), live PC-2 PASS 2026-10-06**; recorded for ratification as ADR-0108 D1. Original note: the repository token is minted with only `contents: write` and `pull_requests: write` (`app.module.ts`), so check-runs return 403 even when the App has the Checks permission | **CODE-6**: mint a separate read token for status with `checks: read` and `pull_requests: read`. The write token stays at its current minimum. If checks are still unavailable, the status reply shows the PR and its reviews and says "checks unavailable" |
| C6 | Embedding recall live probe | NOT EXECUTED | W0 Strict probe (`ollama pull nomic-embed-text` by the owner). It is an input to LRN-2 |
| C7 | Override copy follow-ups (e8e2c91, 43976e1, QA-V2-004) | Unit-tested only | Re-run in the W0 attended session |
| C8 | Answer-quality harness provider runs | None recorded | **LLM-2** runs them (Strict per run and per target) |
| R1 | Storage has no compare-and-set (override consumption is single-flight within one process; small stale-write window) | Accepted in v2 (PRs #107, #108) | **Keep while Quoky runs as one process.** SUB-1 enforces a single instance with a lock file. If SUB-3 or anything else adds a second writer process, add guarded CAS on the affected repositories first (ADR-0102 records this trigger) |
| R2 | Delete/write TOCTOU against a parent-directory symlink swap (Node has no `openat`/`unlinkat`); detected after the write and rolled back | Accepted in v2 (PRs #105, #106) | **Keep.** Exploiting it needs a same-user local process, which could already write outside the workspace, so no privilege boundary is crossed. Revisit only if workspaces ever run under a different OS user |
| R3 | Credential guard is a best-effort regex check, not DLP | Accepted in v1/v2 (ADR-0097) | **Keep the strict guard and widen its reach.** Run it on every new outbound path in v3: connector write payloads, calendar and attachment text, curated examples. Add the corpus cases each track finds. Do not claim DLP |
| R4 | A forced stop past the 65 s bound can close the platform while a send is in flight (at-most-once still holds) | Accepted in v2 (PR #109) | Keep. SUB-1's service stop timeout is set longer than the 65 s drain bound |

## 3. Tracks

Each track lists the problem, the user value, the approach, the ADRs it needs, its risks, acceptance criteria (AC), and
its live QA. Constraints common to all tracks:

- Dependencies point only `apps -> adapters -> core`.
- Core never branches on a provider id. Routing goes through capabilities, priority and `isAvailable()`.
- New ports and their tokens go in `packages/core/src/ports`.
- A new feature arrives as an ADR-0096 turn handler plus an `app/features/*.providers.ts` composition, not as a new
  runtime dependency, so the deps baseline stays at 34 unless a track's ADR says otherwise.
- No AI HTTP API. Providers stay CLI-based.

### SUB — Always-on runtime, deployment substrate, continuation (P0 for SUB-1/2, P2 for SUB-3)

- **Problem.** No runtime contract exists. Quoky runs through `pnpm dev` and the AGENTS.md "Temporary Local/UAT Runtime
  Environment" rules. R3-B3-2C recorded `DEPLOYMENT_SUBSTRATE = UNRESOLVED` and `REAL_TRUST_ROOT =
  NO_FEASIBLE_REAL_TRUST_ROOT_YET`. That is why the R3 production-trust track and continuation activation (receiver
  R2 implemented, `general-chat-v1` mode fails closed at startup) are blocked.
- **User value.** Reminders arrive on time, the bot answers without anyone launching it, and data survives a disk
  failure.
- **Approach.**
  - **SUB-1** picks the Personal substrate: a macOS `launchd` user agent on an always-on owner Mac (or a dedicated Mac
    mini), running the built app (`node apps/quoky/dist/main.js`). Ollama is native and the Claude CLI is logged in on
    the same host, so local-first holds and no new egress appears. The service gets:
    - one fixed environment source (`.env.local`, launched with no inherited shell variables), which closes the
      `DISCORD_*` collision class;
    - a single-instance lock (R1);
    - a startup identity check of bot, guild and channel;
    - a stop timeout longer than the reminder drain bound (R4);
    - log rotation.
  - **SUB-2** adds a scheduled SQLite online backup (`VACUUM INTO` / backup API) with retention, a restore runbook, and
    a local health signal. That signal is an owner-DM notice after a crash loop; no HTTP endpoint is added.
  - When SUB-1 is live, the dedicated runtime launcher exists, so the AGENTS.md temporary section may be retired.
    Removing it needs its own approval.
  - **SUB-3 (decision-gated)** revisits R3 for the Personal edition only. On a single-owner host, the owner's machine
    is the trust root. ADR-0103 would scope the remote-attestation requirement (ADR-0090 R3-B3) to the Team/Hosted
    editions and define a local containment-evidence model for Personal. Only after that is ratified may the
    `general-chat-v1` continuation receiver be activated for one explicit trigger, such as a long-running summary that
    reports back by DM. Multi-agent stays behind the `AgentProfile` seam and out of v3.
- **ADRs.** ADR-0102 (Personal runtime substrate: launchd, single instance, backup, environment source; the R1 CAS
  trigger). ADR-0103 (Personal trust model for continuation; scopes the Proposed ADR-0090 R3-B3 requirement for the Personal
  edition only and keeps every ratified ADR-0089 activation prerequisite;
  P2).
- **Risks.**
  - The Mac sleeping: document `pmset`/power settings, and catch-up stays as it is.
  - Weakening R3 by accident: ADR-0103 changes nothing for Team/Hosted, and continuation stays fail-closed until it
    is ratified.
  - Plaintext `.env.local` secrets on disk: file mode 600, never logged.
- **AC.**
  - The service starts at login or boot, restarts after `kill -9` within 30 s, and refuses a second instance.
  - A reminder due while the service restarts is delivered once.
  - A backup is restorable into a disposable DB, and its `user_version` matches.
  - Offline tests cover the launcher's environment construction (no inherited `DISCORD_*`).
- **Live QA.** Install on the owner host (Strict). Then reboot, crash-restart, a reminder across a restart, and a
  backup/restore drill on a DB copy.

### DET — Deterministic-answer coverage (P0)

- **Problem.** v2 live QA kept finding action-shaped phrases that fell through to GENERAL_CHAT, where the local model
  claimed an outcome: "푸시를 실행할 수 있습니다", a suggested `git push -f`, "성공적으로 완성하였습니다", "완료된 상태로
  보입니다". Each fix covered one phrase family. The ADR-0098 amendment guard covers *external* actions (calendar,
  email, payment) but not *Quoky-internal* ones (commit, push, PR, to-do, reminder, memory).
- **User value.** The bot never claims it did something it did not do.
- **Approach.**
  - **DET-1** writes a per-feature vocabulary inventory: for every handler family and anchor state, the verbs and nouns
    a user might use (`푸시`, `커밋`, `PR`, `머지`, `완료`, `취소`, `알림`, `기억`, `삭제`...).
  - Each handler gets state-aware replies for its vocabulary in every state, extending the v2 pattern of post-push
    states answering push phrases.
  - The provider-neutral action-claim guard is extended to internal actions. A GENERAL_CHAT reply that claims a
    completed Quoky-domain action (`커밋했습니다`, `푸시했어요`, `추가했습니다`, `완료 처리했습니다`) is replaced by a
    fixed notice that nothing was done, plus the exact command to use.
  - A new golden corpus, `action-shaped-fallthrough.v1.json`, records every live-QA miss as a `mustPass` case. The
    owner curates it (ADR-0098 D7). INT ratchets it.
- **ADRs.** ADR-0104: an ADR-0098 amendment for the internal-action claim guard and its lexicon bounds, with
  translation and quotation exemptions mirroring QUAL-6.
- **Risks.** False positives on legitimate explanations ("커밋은 이렇게 해요"). Mitigation: claim shape only (first
  person, completed aspect), the quoted/translated-clause exemptions from wave 4, and negative corpus cases.
- **AC.**
  - Every v2 live-QA miss replays deterministically (zero provider calls).
  - The guard has zero false positives on the existing intent-routing and how-to corpora.
  - The new corpus is in `baseline.v1.json` (or a `baseline.v2.json`) with its `minTotal` raised.
- **Live QA.** An ego-browser edge-case sweep of about 40 phrasings per feature state on the dev bot, including
  negations, questions, typos, mixed Korean and English, and phrases sent in the wrong state.

### LLM — Local model quality (P0)

- **Problem.** These are the open findings:
  - QA-V2-003: a stray "栏" in Korean text.
  - QA-V2-008: an over-cautious answer to "9시에 뭐 먹을까?".
  - QA-V2-W7-06: a vague answer to "완료 처리 어떻게 해?" with an appended "(Translated from …)" line.
  - `llama3.1:8b` is weak in Korean.
  - Quoky-feature how-to questions go to the model instead of to help.
- **Approach.**
  - **LLM-1, deterministic hygiene.** `sanitizeGeneralChatText` drops a trailing standalone `(Translated from …)` /
    `(…에서 번역됨)` marker line when no translation was requested. It strips isolated Han characters inside Hangul
    runs only when the reply language is `ko` and the character has no Hangul neighbour inside a word. The sanitizer
    still never rewrites content. A **help-intent handler** answers how-to questions about Quoky's own commands
    (`완료 처리 어떻게 해?`, `알림 어떻게 지워?`) from the handler-contributed help lines (ADR-0096), with no provider
    call.
  - **LLM-2, model choice by measurement.** Run the existing answer-quality harness, each run Strict and local, on the
    synthetic fixtures plus the v2 QA prompts. Candidates are the current `llama3.1:8b`, `qwen2.5:7b`/`14b`, `gemma3`,
    and `exaone3.5:7.8b` (Korean-strong). Pick a model by pass rate, Korean-script purity and latency on the owner's
    hardware. This is an `OLLAMA_MODEL` operator change; no code change is involved.
  - **LLM-3, MLX evaluation (P1, optional).** On Apple Silicon, benchmark `mlx_lm` against Ollama for the chosen
    model. If it wins clearly (for example ≥1.5× tokens/s at equal harness score), add an MLX
    provider (`MlxCliProvider` inside `packages/ai-cli`, ADR-0105 D2: a separate `packages/ai-mlx` reusing the
    `ai-cli` runner would make one adapter depend on another) that implements the unchanged `AiProvider` through the
    `mlx_lm` **CLI**, contained by the existing `CliRunner` under its own offline `MLX_LOCAL` profile (ADR-0105 D4,
    amending ADR-0098 D8). Routing stays capability/priority-based. Docker
    stays out: on macOS it adds isolation only, with no Metal acceleration.
- **ADRs.** None for LLM-1/2; they are covered by ADR-0096/0098. A help-intent handler is an ADR-0096 registration
  plus an ADR-0093 note, recorded in ADR-0104 D4/D5. LLM-3 needs ADR-0105 (a new provider and its containment).
- **Risks.**
  - Over-stripping legitimate CJK text: limited to the `ko` reply language and covered by tests.
  - Model churn invalidating Stage 2A bindings: re-run the approved bindings.
  - A larger model exceeding RAM or latency budgets: measure first.
- **AC.**
  - QA-V2-003 and W7-06 shapes are fixed in sanitizer tests.
  - How-to questions route to help with zero provider calls.
  - An evaluation table with the recorded model decision is filed in `docs/uat/`.
- **Live QA.** Re-run QA-V2-003/008/W7-06 and a 20-prompt Korean daily-chat set on the chosen model.

### MEM — Memory management commands (P0)

- **Problem.** The owner can add memories (`기억해:`) but cannot see, correct or delete them. `MemoryWriter.forget`
  (exact id, scope-bound, ADR-0073) and superseding promotion exist, but nothing in chat reaches them.
- **User value.** Trust and privacy. The user can see what Quoky knows and take it back.
- **Approach.** **MEM-1** adds a `pre-classify` handler, actor-scoped (owner actor only, durable scope of that actor):
  - `기억 목록` lists numbered, credential-guarded previews, paged at 10.
  - `기억 N 보여줘` shows one memory.
  - `기억 N 잊어줘` asks for exact confirmation, then calls `MemoryWriter.forget`.
  - `기억 N 수정: …` goes through superseding promotion, so the writer policy and the credential guard apply.

  Numbers are bound to the last listing (session-scoped and short-lived, like to-dos). Forget also removes the
  record's vector from `LocalVectorProvider` (rebuildable cache) and any LRN example derived from it. No migration is
  needed. The listing never shows the scope of other actors (single actor today; keeps the Team seam honest).
- **ADRs.** ADR-0106 (the memory command grammar and its precedence against `기억해:` and to-do prefixes; amends
  ADR-0073 for the user-facing forget surface).
- **Risks.** Grammar collisions with to-do and reminder prefixes: fixed stage/order, plus negative corpus cases. Stale
  numbering: bind each number to a listing id and refuse it after 30 minutes or after any change.
- **AC.**
  - List, view, edit and forget work end to end.
  - After forget, recall (lexical and embedding) no longer returns the memory.
  - A credential-shaped edit is refused.
  - Golden routing cases are added.
- **Live QA.** List → forget → recall check → edit → recall check, on a DB copy.

### LRN — Feedback learning (P0 for LRN-1/2, P1 for LRN-3, P2 for LRN-4)

The owner's request: "앞으로 데이터를 학습해야 질문 -> 답변에 대한 정확도가 오를테니, 그것도 고민해줘."

- **Problem.** v2 captures 👍/👎 and implicit signals with **no message or reply text** (ADR-0098 D4). `피드백 요약`
  shows counts, and the golden corpora (`intent-routing`, `turn-handler-routing`, `reminder-todo-precedence`, ...)
  plus `baseline.v1.json` ratchet routing. Nothing turns a signal into better answers: ROADMAP candidate D (feedback
  examples in `PromptComposer`) and E (fine-tuning) are not done. ADR-0098 says that feedback never changes behaviour
  automatically, and that stays true.
- **Principles (binding for every LRN task).**
  1. **The owner approves every change.** No online self-modification. Every learned change is either an
     owner-approved example or a reviewed code change.
  2. **Consent before text.** Turn text enters a learning store only through an explicit owner action on that turn.
  3. **Credential exclusion.** The strict credential guard runs at capture and again at use. A matching item is
     refused, never redacted-and-kept.
  4. **No cloud egress of personal data unless approved.** Learning artifacts are used only on local providers by
     default (decision 5), and Claude-based judging or rewriting of personal turns is off.
  5. **Actor-scoped, forgettable, bounded:** 365-day retention as in v12, MEM forget cascades, and hard count caps.
  6. **Measured.** A change counts only if it moves a metric: 👎 rate per capability over 30 days, golden pass rate,
     and the harness score on fixtures.
- **Approach (ladder; each rung ships only if the previous one shows value).**
  - **LRN-1, measurement and candidates (P0, schema v14).**
    - `피드백 요약` gains a trend line: 👎 rate per capability, this 30 days against the previous 30.
    - New owner commands on a 👎 turn: `피드백 후보` lists recent 👎 turns as candidates, using the Task request text
      that is already stored locally, truncated and guarded. `후보 N 메모: <what was wrong>` attaches an owner note.
    - v14 adds a consent-scoped `learning_items` table: kind `GOLDEN_CANDIDATE | EXAMPLE`, the owner-approved text,
      expected behaviour, capability, language, source turn id, `egress` = `LOCAL_ONLY` by default, and created/expires
      timestamps.
    - An offline tool (`apps/quoky/src/tools/learning-export.ts`, local file output, no network) turns approved
      golden candidates into JSON corpus cases for a reviewed PR. The golden policy stays owner-curated.
  - **LRN-2, curated few-shot examples (P0, closes candidate D).**
    - A 👍 turn can be promoted with `예시로 저장`. The owner may edit the ideal answer (`예시 N 수정: …`).
    - `PromptComposer` injects at most 2 examples for GENERAL_CHAT, chosen by the local embedding scorer when it is
      enabled (`QUOKY_EMBEDDING_ENABLED`) and lexically otherwise, under a fixed token budget, as non-authoritative
      `EXAMPLE` entries. They are never framed as facts.
    - `LOCAL_ONLY` examples are injected only when the routed provider declares local execution. That needs a
      provider **descriptor attribute** (data, not an id branch), which is a Core contract change under ADR-0107.
    - Flag `QUOKY_LEARNING_EXAMPLES_ENABLED`, default `false`.
  - **LRN-3, offline rule mining (P1).**
    - An offline report clusters 👎 and implicit-correction turns by intent, capability, keyword fingerprint and
      request text. It flags action-shaped GENERAL_CHAT misses (DET candidates) and misrouted intents.
    - Output: proposed golden cases and classifier/handler patterns, shipped as an ordinary reviewed PR.
    - It also tunes the embedding recall parameters (weight 0.7, threshold) against an owner-labelled recall set.
      That is a config proposal, not an automatic change.
  - **LRN-4, local fine-tuning (P2, deferred).**
    - Requires ≥300 approved `EXAMPLE` items and LRN-2 showing a measured gain.
    - MLX LoRA on the owner host only, producing a new local model tag. It is adopted only when it beats the base model
      on the harness and on a held-out slice of the examples. The base stays registered for rollback.
    - Training data never leaves the host.
- **ADRs.** ADR-0107: the learning store (v14), consent model, local-only egress attribute, example injection, and
  retention/forget cascade. It amends ADR-0098, whose "no learning loop" consequence becomes "no *automatic* learning
  loop". LRN-4 needs its own ADR later.
- **Risks.**
  - Text capture changes the v12 privacy posture: explicit per-item consent, a separate table, and forget cascades.
  - Examples that mislead the model: at most 2, non-authoritative, measured; one command disables them.
  - Prompt growth against the Ollama window (QA-019): a fixed budget.
  - Stage 2A binding invalidation: re-run the approved bindings.
- **AC.**
  - With learning flags off, the v12 behaviour is unchanged (byte-identical prompts).
  - Consent, credential refusal, forget cascade and `LOCAL_ONLY` enforcement are covered by tests.
  - The export tool produces valid corpus cases.
  - LRN-2 shows a non-negative harness delta and a 30-day 👎-rate report after use.
- **Live QA.** 👎 → `피드백 후보` → note; 👍 → `예시로 저장` → a similar question shows the improved style; forget the
  source memory/example → it is no longer injected; a policy-sensitive (Claude) turn receives no `LOCAL_ONLY` example.

### CODE — Code work v3 (P0 for CODE-6/7, P2 for CODE-8/9)

- **Problem.**
  - The PR title is the raw instruction text (QA G5).
  - PR status fails entirely without check-runs (G11, C5).
  - There is one target repository (`QUOKY_GITHUB_OWNER`/`QUOKY_GITHUB_REPO`).
  - Merge has never been enabled.
- **Approach.**
  - **CODE-6 (largely delivered by PR #113, 6a59526):** partial PR status as described in C5 (PR state, mergeability, reviews; checks shown as unavailable on
    403), with a separate read-only status token `{pull_requests, checks, contents}: read`. Remaining scope: residual
    tests or copy found in review, and ratification of ADR-0108 D1.
  - **CODE-7:** PR title and body.
    - Deterministic first. Title: the head commit subject (Conventional Commits). Body: changed files, commit list, and
      "generated by Quoky; not merged".
    - An optional model-proposed title/body, routed by capability, is shown in the PR preview, credential-guarded and
      length-bounded.
    - The approved PR request binds the exact title and body hash (an ADR-0099 approval-payload extension).
  - **CODE-8 (P2):** a multi-repository allowlist (`QUOKY_GITHUB_REPOS`). Each registered project maps to one allowed
    repository, push-target resolution validates against it, and one App installation covers the allowlisted
    repositories only.
  - **CODE-9 (P2, decision-gated):** merge enablement is a sandbox UAT of the merge scenarios (operator guide
    Scenarios B/C) with `QUOKY_GIT_MERGE_ENABLED=true`. The release default stays `false`.
- **ADRs.** ADR-0108 (an ADR-0099 and ADR-0049 amendment: PR title/body binding and the status token scope). ADR-0109 (the
  multi-repo allowlist; P2).
- **Risks.** The model-generated body leaking diff secrets: credential guard plus the deterministic default. Token
  scope creep: keep separate tokens per direction and test the minted scopes.
- **AC.**
  - The title is never the raw instruction.
  - An approved PR uses exactly the previewed title/body.
  - The status reply works without the Checks permission.
  - Minted-token scope tests pass.
- **Live QA.** On `quoky-uat-sandbox`: branch → commit → push → PR (title/body check) → status with and without the
  Checks permission → close unmerged.

### CAL — Calendar read (P1)

- **Problem.** QUAL-7 routes "내일 9시에 뭐 있어?" to Claude, which truthfully says it cannot see the schedule. That is
  correct but not useful. Calendar is the most frequent personal-data question.
- **Approach.**
  - **CAL-1:** a read-only calendar adapter package. The provider is decision 4: Google Calendar `calendar.readonly`
    is recommended; Microsoft 365 / CalDAV are alternatives. It implements a narrow `CalendarReader` port (list events
    in a time window) or a `ConnectorProvider` resource kind, whichever ADR-0072/0100 fits without a contract change.
    ADR-0110 D1 decides: a narrow `CalendarReader` port. Tokens come from `.env.local` or a local token file; none are logged.
  - **CAL-2:** a `pre-classify` handler (order 150, ADR-0110 D3; ADR-0096 has no `work` stage) answers schedule questions deterministically ("오늘/내일/이번 주 일정") in
    `QUOKY_TIMEZONE`, with an optional summary.
    - Summaries are local-only by default. Unlike `QUOKY_WORK_SUMMARY_ENABLED`, there is no Claude fallback for
      calendar text.
    - When no calendar is configured, QUAL-7 routing is unchanged.
    - Writes (create or move an event) stay refused. They are P2 behind the CWR approval model.
  - **Later:** "회의 10분 전 알림" combines calendar with reminders. P2; it needs its own ADR-0101 amendment.
- **Risks.** OAuth token handling: a read-only scope and a local file at mode 600. Time-zone and all-day edge cases: a
  pure formatter with tests. Calendar text egress: local-only summaries.
- **AC.** Today/tomorrow/week queries return correct, time-zone-correct events from a fixture adapter offline. The
  QUAL-7 fallback still holds with no calendar. Event text never reaches Claude unless decision 4 allows it.
- **Live QA.** Owner-confirmed new external target (Strict). One read-only probe, then about 15 schedule phrasings,
  including empty days, all-day events and a time-zone boundary.

### MM — Files and images in Discord (P1)

- **Problem.** Attachments are ignored. Users paste screenshots and logs.
- **Approach.**
  - **MM-1:** `InboundMessage` gains optional attachment metadata (name, MIME, size). This is an additive
    `PlatformAdapter` change, with no Discord types crossing the port. The adapter downloads only owner messages that
    pass the ADR-0091 gate, within size and type bounds (text ≤256 KiB; images ≤8 MiB; png/jpeg/webp), into a
    runner-owned temporary directory. Text files become a bounded, credential-guarded `Resource` in the context. They
    are never written into the workspace, and `Resource` and `Artifact` stay separate.
  - **MM-2:** images route by a new capability, `IMAGE_UNDERSTANDING`, so Core never branches on a provider id. Only
    providers that advertise it are selected: a local Ollama vision model (for example `qwen2.5vl` or
    `llama3.2-vision`, operator-chosen) by default. The Claude CLI receives images only if decision 9 allows it. With
    no capable provider, the reply truthfully says image analysis is unavailable. Image bytes are never persisted.
- **ADRs.** ADR-0111 (attachment intake, bounds, the new capability, egress policy; amends ADR-0091/0098).
- **Risks.**
  - A second untrusted inbound content type: injection rules apply, and attachment text is untrusted readout.
  - Download abuse: owner-only, size limits checked before download.
  - Egress of images: decision 9.
- **AC.** Bounded intake is tested. A credential-shaped text file is refused. Image turns route only to
  `IMAGE_UNDERSTANDING` providers, and a turn with no provider has a deterministic reply.
- **Live QA.** A text log, a screenshot, an oversize file, an unsupported type, an image in a non-allowlisted channel
  (dropped), and an image plus an injection caption.

### CWR — Connector writes behind exact-payload approvals (P1)

- **Problem.** Work chat is read-only and writes are refused. Commenting on a Jira issue or posting to Slack is the
  natural next step.
- **Approach.**
  - **CWR-1, schema v15:** narrow write ports (ARCHITECTURE §13: "writes use separately approved narrow ports"), not a
    widened `ConnectorProvider`:
    - `IssueCommentWriter` (Jira comment)
    - `IssueTransitionWriter` (Jira transition to a named state)
    - `ChannelMessageWriter` (Slack post to an allowlisted channel)

    v15 adds `connector_write_receipts`: idempotency key, target, payload hash, and the status `PREPARED | SENT |
    NOT_SENT | UNCERTAIN`, mirroring the ADR-0101 delivery contract. It has no payload text column.
  - **CWR-2:** the chat flow is preview → exact payload shown → approval → one execution. ARCHITECTURE §10 sets HIGH as
    the minimum. v3 applies the stricter one-time, hash-bound, single-use pattern of ADR-0097, so these are
    CRITICAL-style approvals:
    - the grant binds target and payload hash and is consumed once;
    - `UNCERTAIN` is never retried;
    - a repeated request on an already sent receipt replies "이미 보냈어요".
  - The credential guard runs on every payload. Confluence and GitHub-issue writes stay out of v3.
- **ADRs.** ADR-0112 (write ports, receipts v15, approval binding, allowlists; amends ADR-0100's "writes refused").
- **Risks.**
  - The first irreversible external writes to corporate systems: off by default (`QUOKY_CONNECTOR_WRITES_ENABLED=false`),
    allowlisted targets, exact preview.
  - Slack token type: settle it in C1 first.
  - Double-post on retries: the receipt state machine and no retry on `UNCERTAIN`.
- **AC.** The approval binds the payload hash. Replays are refused. `UNCERTAIN` has no retry. A non-allowlisted target
  is refused before any network call. Writes are off by default.
- **Live QA.** Owner-confirmed new external targets (a Jira test project issue and a Slack test channel). Comment,
  transition, post, deny, replay, network failure mid-send.

### OPS — Local operations UI (P1; ADR-0113 Proposed)

- **Problem.** Once SUB-1 makes Quoky an unattended service, the owner sees its state only through Discord replies, the
  `OPS_NOTICE` DM and log files. There is no single place to check health, provider readiness, queued reminders,
  waiting approvals, connectors, recent errors, feedback and backups, or to act on them outside chat. Owner direction
  (2026-10-06): a monitoring and handling screen is needed, with no separate client for now.
- **User value.** One local page shows whether the service is healthy and what it is waiting on; later the owner can
  cancel, forget, reject and approve from it under the same gates as chat.
- **Approach.**
  - **OPS-1, Phase 1 read-only monitoring (W3, after SUB-2).** A `node:http` listener inside the Quoky process, bound to
    `127.0.0.1` only, default off (`QUOKY_OPS_UI_ENABLED=false`, `QUOKY_OPS_UI_PORT`), with a random per-start token in
    a `0600` file in the host data directory, a `SameSite=Strict` session cookie, CSRF tokens, Host/Origin checks and a
    strict CSP. Panels: runtime/health, provider readiness, reminder queue, pending approvals (metadata only),
    connector status, recent errors (codes and categories from an in-memory ring buffer), feedback stats, and SUB-2
    backup status. No secrets, tokens, conversation bodies or approval payloads are ever displayed; every string passes
    the credential guard at render time. Code lives in `apps/quoky/src/ops-ui/` (`http/*` and `snapshot/*`) and is
    wired from `main.ts` through Nest container lookups, so `app.module.ts` is not touched. Its flags are parsed in its
    own `app/ops-ui/ops-ui-config.ts`, because `config.ts` belongs to CAL-1 in W3. Core gets no HTTP dependency and no
    port, token or contract change. No npm dependency, workspace package or migration is added.
  - **OPS-2, Phase 2 handling (W4, after MEM-1).** Cancel a reminder, forget a memory (ADR-0106 content-bound code),
    and reject or approve a pending approval. Each action calls the same Core use case as the chat command, with the same
    confirmations and one-time grant consumption, and never writes storage directly. Approving requires the
    confirmation reference that chat shows with the exact preview (ADR-0113 D7, pending owner decision 13). A use case
    that exists only inside `conversation-runtime.ts` is first extracted into a Core application service with the
    runtime's behaviour unchanged.
  - **OPS-2b (W6, only if needed).** The `conversation-runtime.ts` extraction hunk for the approve path (W4 and W5
    belong to MM-2 and CWR-2) and folding the OPS flags into `config.ts`/`.env.example`.
- **ADRs.** ADR-0113 (Proposed): the listener, its security model, the display rule, the phases, the no-bypass rule,
  placement, and a narrow amendment of ADR-0102 D1/D7 ("no HTTP endpoint"). Remote access and a separate client are
  out of v3 (Team/Hosted).
- **Risks.**
  - A local TCP listener: loopback-only bind, Host/Origin checks, a per-start `0600` token, `SameSite=Strict`, CSRF,
    default off.
  - A second approval surface: no-bypass shared use cases, approve-needs-chat-preview, and the existing one-time grants.
  - Provider readiness against ARCHITECTURE.md §12: shown as operator health, with no per-turn selection. If the review
    disagrees, the panel falls back to readiness per capability.
- **AC.** As ADR-0113's acceptance criteria. Notably: no port opens when disabled; a foreign Host or Origin, a missing
  CSRF token or no session is refused; a fixture with credential-shaped strings and message bodies renders none of
  them; Phase 2 actions match the chat effects on one fixture.
- **Live QA.** Enable on the owner host (Strict `.env.local` edit). Sign in, check each panel against chat output, send a
  foreign-Origin request, and restart to confirm the token rotates. For OPS-2: cancel, forget, reject and approve on a
  DB copy.

## 4. Waves

Owned files are exclusive within a wave. `core/` = `packages/core/src/`, `app/` = `apps/quoky/src/`.

| Wave | Task | Track | Owned files (summary) | Deps |
|---|---|---|---|---|
| 0 | LIVE-0 | carry-over | No code. Strict sessions C1, C2, C6, C7, then the C3 decision; fixes go to the owning package | v2 wave-8 PR merged |
| 1 | GOV-3 | GOV | `DECISIONS.md` (ADR-0102..0112 appended; ratified 2026-10-06), this plan | — |
| 1 | GOV-4 | GOV | `DECISIONS.md` (ADR-0113 appended, Proposed), this plan, `ROADMAP.md` (Telegram as post-v3 extension) | GOV-3 merged |
| 1 | SUB-1 | SUB | `app/main.ts`, `app/config.ts`, `.env.example`, new `ops/launchd/*`, launcher script (+tests), `docs/user/quickstart.md` service section | ADR-0102 |
| 1 | DET-1 | DET | `conversation-runtime.ts` (+test), `core/application/chat-policy/*`, `golden/action-shaped-fallthrough.v1.json`, `app/features/turn-handlers.providers.ts` | ADR-0104 |
| 1 | LLM-1 | LLM | `packages/ai-cli/src/output-sanitizer.ts` (+test), `ai-cli/src/index.ts`, new help-intent handler module | — |
| 1 | CODE-6 | CODE | **Largely delivered by PR #113 (6a59526).** Remaining: residual tests/copy from review only; ratification of ADR-0108 D1 | ADR-0108 |
| 2 | MEM-1 | MEM | new `core/application/memory-commands/*` (+tests), `memory-writer.ts`, `packages/vector-local` delete, `app/features/memory.providers.ts`, `app.module.ts`, `turn-handlers.providers.ts` | DET-1, ADR-0106 |
| 2 | LRN-1 | LRN | `migrations.ts` (+test; **v14**), `storage-sqlite` learning repository, `core/application/feedback/*`, `app/tools/learning-export.ts`, `config.ts` | ADR-0107 |
| 2 | CODE-7 | CODE | `conversation-runtime.ts` (+test), `response-composer.ts` (+test), `code-work/pr-description.ts` | CODE-6 |
| 2 | LLM-2 | LLM | `docs/uat/` eval record only (Strict runs; `OLLAMA_MODEL` operator change) | LLM-1 |
| 2 | SUB-2 | SUB | backup/health modules under `app/ops/*` (+tests), `main.ts` | SUB-1 |
| 3 | LRN-2 | LRN | `prompt-composer.ts` (+test), provider descriptor attribute (`core/ports` AI provider file, `ai-cli` providers), `app/context-builder-provider.ts` | LRN-1, ADR-0107 |
| 3 | CAL-1 | CAL | new `packages/connector-calendar-*`, calendar port in `core/ports`, `config.ts`, `.env.example` | C1, ADR-0110 |
| 3 | MM-1 | MM | `platform-adapter.port.ts`, `adapter-discord/src/index.ts` (+test), new `adapter-discord/src/attachments.ts` | ADR-0111 |
| 3 | LLM-3 | LLM | `MlxCliProvider` in `packages/ai-cli` (optional, if the benchmark passes; not a new package, ADR-0105 D2) | LLM-2, ADR-0105 |
| 3 | OPS-1 | OPS | new `app/ops-ui/*` (`http/*`, `snapshot/*`, `ops-ui-config.ts`; +tests), `main.ts` (wiring), `docs/user/quickstart.md` operations-UI section | SUB-2, ADR-0113 ratified |
| 4 | CAL-2 | CAL | calendar turn handler, `chat-policy/*` (QUAL-7 switch), `turn-handlers.providers.ts`, `app/features/calendar.providers.ts`, `app.module.ts` | CAL-1 |
| 4 | MM-2 | MM | `domain/enums.ts` (`IMAGE_UNDERSTANDING`), `conversation-runtime.ts` (+test), `ai-cli/src/index.ts` (image path argument) | MM-1 |
| 4 | CWR-1 | CWR | write ports in `core/ports`, `migrations.ts` (**v15**), receipts repository, `connector-jira`/`connector-slack` writers (+tests), `config.ts` | C1, LRN-1 merged, ADR-0112 |
| 4 | OPS-2 | OPS | `app/ops-ui/*` (+tests), `main.ts`, Core application services extracted for shared use (reminder cancel, memory forget, approval decision; outside `conversation-runtime.ts`) | OPS-1, MEM-1 |
| 5 | CWR-2 | CWR | `conversation-runtime.ts` (+test), `response-composer.ts` (+test), `app.module.ts`, `app/features/connector-writes.providers.ts` | CWR-1 |
| 5 | LRN-3 | LRN | `app/tools/learning-report.ts` (+test), corpus additions via reviewed PR | LRN-1 |
| 5 | CODE-8 | CODE | `push-target-resolution.ts`, `personal-hosting-guard.ts`, `config.ts` (P2) | CODE-7, ADR-0109 |
| 6 | SUB-3 | SUB | continuation activation wiring, `main.ts`, `app.module.ts` (P2) | SUB-2, ADR-0103 ratified |
| 6 | CODE-9 | CODE | No code expected; sandbox merge UAT (P2) | owner decision 7 |
| 6 | OPS-2b | OPS | `conversation-runtime.ts` (+test) approve-path extraction hunk only if OPS-2 needs it; `config.ts`/`.env.example` fold of the OPS flags; `app/ops-ui/*` (P2) | OPS-2, CWR-2 |
| 6 | INT-2 | INT | `app/personal-v3-acceptance.test.ts`, golden routing additions, `baseline` | all merged tracks |
| 6 | DOC-C | DOC | `CURRENT_STATE.md`, `CHANGELOG.md`, `DECISIONS.md` (implementation records), `ROADMAP.md`, quickstart, operator guide | all merged tracks |

Registration notes: LLM-1 ships the help-intent handler module; DET-1 (the W1 `turn-handlers.providers.ts` owner)
registers it. OPS-1/OPS-2 wire the UI from `main.ts` (free in W3 and W4) and do not edit `app.module.ts`,
`config.ts` or `.env.example` in those waves; OPS-2b folds the flags into `config.ts`/`.env.example` in W6 (free). LLM-3 lands in W3 as a new module inside `packages/ai-cli` (ADR-0105 D2) without touching
`ai-cli/src/index.ts` (the W3 LRN-2 hot file); its export line and composition-root wiring are a small W6 hunk coordinated
with SUB-3 (the W6 `app.module.ts` owner).

Parallel and sequential work: inside a wave, the tasks run in parallel in separate worktrees. A track's later task waits
for its earlier one. CAL and CWR wait for the C1 read-only connector QA. P2 tasks (SUB-3, CODE-8, CODE-9, LLM-3, LRN-4)
may be dropped without blocking INT-2.

### Lanes

**Migration lane** (the same rules as ADR-0096 D10: additive, idempotent, numbers fixed, contiguity and
`SCHEMA_VERSION_AHEAD` checks stay, no renumbering after a merge):

| Version | Task | Wave | Content |
|---|---|---|---|
| v14 | LRN-1 | 2 | `learning_items` (consent-scoped owner-approved text, `egress`, expiry) + indexes |
| v15 | CWR-1 | 4 | `connector_write_receipts` (idempotency key, target, payload hash, status; no payload text) |

CWR-1 is blocked until LRN-1 is on `main`. If LRN-1 slips, CWR-1 waits. Only an amendment made before any v14 merge may
swap the order. MEM, CAL, MM, CODE, SUB and DET add no migration. Applying migrations outside the delegated dev DB is
Strict, and that includes the always-on host's DB, which becomes the owner's real data once SUB-1 is live.

**Hot-file lane** (one editor per wave):

| File | W1 | W2 | W3 | W4 | W5 | W6 |
|---|---|---|---|---|---|---|
| `conversation-runtime.ts` (~6,800 lines) | DET-1 | CODE-7 | — | MM-2 | CWR-2 | OPS-2b (if needed) |
| `response-composer.ts` | CODE-6 | CODE-7 | — | — | CWR-2 | — |
| `app.module.ts` | CODE-6 | MEM-1 | LRN-2 | CAL-2 | CWR-2 | SUB-3 |
| `turn-handlers.providers.ts` | DET-1 | MEM-1 | — | CAL-2 | — | — |
| `prompt-composer.ts` | — | — | LRN-2 | — | — | — |
| `ai-cli/src/index.ts` | LLM-1 | — | LRN-2 | MM-2 | — | — |
| `platform-adapter.port.ts`, `adapter-discord/src/index.ts` | — | — | MM-1 | — | — | — |
| `migrations.ts` / `storage-sqlite/src/index.ts` | — | LRN-1 | — | CWR-1 | — | — |
| `config.ts`, `.env.example` | SUB-1 | LRN-1 | CAL-1 | CWR-1 | CODE-8 | OPS-2b |
| `main.ts` | SUB-1 | SUB-2 | OPS-1 | OPS-2 | — | SUB-3 |
| `app/ops-ui/*` | — | — | OPS-1 | OPS-2 | — | OPS-2b |
| `chat-policy/*`, `intent-classifier.ts` | DET-1 | — | — | CAL-2 | — | — |
| `DECISIONS.md` | GOV-3, then GOV-4 | — | — | — | — | DOC-C |

**Deps baseline.** 34 at the base. A track that needs a new `ConversationRuntimeDeps` entry must say so in its ADR.
Moving the baseline is expected only for CWR-2 (the write-approval flow, ADR-0112: 34 → 35) and SUB-3 (ADR-0103
authorizes none; an amendment must state any key). OPS-1/OPS-2 add none (ADR-0113 D8: the UI is not a runtime
dependency, and no npm dependency, workspace package or migration is added). Every task asserts the baseline in
force when it merges.

## 5. Governance and validation

This mirrors the v2 run.

- **ADR gate.** A track's first code merge waits for the Product Owner to ratify its ADR (Proposed → Accepted).
  GOV-3 drafted all eleven (ADR-0102..0112). GOV-4 drafted ADR-0113 (OPS), which is Proposed: OPS-1 waits for its
  ratification. A stalled ADR stalls only its own track.
- **Per wave:**
  1. Implementation in separate worktrees.
  2. Offline validation: `pnpm typecheck` plus focused tests. A task on a hot file runs the full `pnpm test`. INT-2
     adds `pnpm build`. Docs-only tasks run `git diff --check` and check that `grep '^## ADR-' DECISIONS.md` gives
     unique numbers.
  3. An independent review (reviewer ≠ implementer). The independent Chief Architect review is mandatory before
     DET-1, LRN-1, LRN-2, MM-1, CWR-2, SUB-3, OPS-1 and OPS-2 merge.
  4. A sparse Codex review: once per wave on the integration head, plus a delta review after fixes.
  5. Push, PR and merge.
- **Approval boundary.** Push, PR and merge run automatically after steps 1-4 pass, **only under the owner's standing
  exact-scope approval for v3 waves** (decision 1; it renews the v2 approval of 2026-10-02 and is not inherited
  automatically).
- **Fix loops.** At most two fix loops per finding inside the approved scope. After that the orchestrator decides:
  narrow the scope, defer to a follow-up, or stop and report.
- **Live QA.** Owner-attended deep QA via ego-browser on the dev bot (`chunsik-bot`, `#일반`) after each wave that
  changes user-visible behaviour, with edge-case sweeps (negation, wrong state, typos, mixed language, repeats,
  restarts) and findings recorded in a `docs/uat/personal-v3-qa-record.md`. The runtime follows the AGENTS.md
  temporary-environment rules on a DB copy until SUB-1 replaces them.
- **Strict, per target.** Live UAT against any **new external target** needs explicit owner confirmation for that
  target. That covers real connector tenants, a calendar account, Slack/Jira write targets, the always-on host install,
  the merge flag, Claude receiving images, and enabling the operations UI on the owner host. So do harness `run`s, `ollama pull`, `.env.local` edits, and any
  production DB migration.
- **Honesty.** No doc claims a live result before the session that produced it has run. DOC-C keeps Pending items
  Pending.

## 6. Risks

| Risk | Mitigation |
|---|---|
| `conversation-runtime.ts` (~6,800 lines) edited in four waves | One editor per wave; prefer handlers over runtime hunks; rebase on the merged wave head; full `pnpm test` |
| The learning store adds the first consented text column | Per-item consent, a separate table, the credential guard twice, `LOCAL_ONLY` default, forget cascade, flag off by default |
| The first irreversible corporate writes (CWR) | Off by default, allowlists, exact-payload one-time approvals, no retry on `UNCERTAIN`, read-only QA first |
| The always-on host now holds the real data | Backups and a restore drill (SUB-2); migrations there are Strict; single instance |
| R3 weakened by the Personal trust re-scope | ADR-0103 is Personal-only and P2; continuation stays fail-closed until it is ratified |
| Guard false positives (DET) frustrate normal chat | Claim-shape matching, exemptions, negative corpora, live sweep |
| Model switch regressions (LLM-2) | The harness decides; the old tag stays installed for rollback |
| Connector credentials still not provided | CAL/CWR live QA slips; their offline work still merges, flag-gated |
| The operations UI opens a local listener and a second approval surface (OPS) | Loopback-only, per-start `0600` token, CSRF and Host/Origin checks, default off; shared Core use cases with the chat confirmations; approve needs the chat preview reference |
| Scope creep across 10 tracks | Tiers: P2 is droppable; the "needed for a real user?" gate on every new item |

## 7. Open decisions for the owner

Each decision has a recommended default.

**Owner decisions recorded 2026-10-06** (answers to the five decisions asked first):

| # | Decision | Owner answer |
|---|---|---|
| 1 | Standing approval for v3 waves | **Renewed** — auto Push/PR/Merge per wave after offline validation, independent review and Codex review pass; Live UAT of new external targets still confirmed per target |
| 2 | Deployment substrate | **macOS first** — launchd user agent on the owner's Mac (a dedicated Mac mini later is compatible); no cloud VM |
| 4 | Calendar | **As recommended** — Google Calendar read-only (`calendar.readonly`), local-only summaries, no Claude fallback for calendar text |
| 5 | Learning consent | **Consented as recommended** — per-item consent, 365-day retention, `LOCAL_ONLY` by default, `QUOKY_LEARNING_EXAMPLES_ENABLED=false` until LRN-2 is measured |
| 7 | Merge enablement | **As recommended** — release default stays `QUOKY_GIT_MERGE_ENABLED=false` |
| 8 (partial) | Reminders channel | Owner asked for channel delivery in a dedicated `#reminder` text channel on the owner's own Discord server (created 2026-10-06, allowlisted); DM stays the default elsewhere. The C2 UAT runs there |

All remaining decisions (3, 6, 9-12) were ratified with their recommended defaults on 2026-10-06 ("우선은 모두 권장 값으로 ratify").

**Recorded 2026-10-06 after GOV-3:** the owner asked for a monitoring and handling screen with no separate client for
now (track OPS, ADR-0113 Proposed, decision 13 below), and decided that a Telegram platform adapter is a post-v3
extension, taken up only after all v3 development completes (`ROADMAP.md` "Post-v3 extensions").

1. **Standing approval for v3 waves.** Renew the v2 auto Push/PR/Merge approval for v3 waves, which applies after
   offline validation, independent review and Codex review pass. Live UAT of new external targets still needs
   confirmation per target. *Recommended: renew.*
2. **Deployment substrate.** Use a launchd user agent on an always-on owner Mac (or a dedicated Mac mini); no cloud VM.
   *Recommended: yes.* State which machine.
3. **Continuation and the R3 re-scope (SUB-3).** *Recommended:* keep it P2. ADR-0103 (Personal-only local trust) is
   drafted as Proposed; ratify it only after SUB-1/2 are live. Multi-agent stays out of v3.
4. **Calendar provider and egress.** *Recommended:* Google Calendar read-only (`calendar.readonly`), local-only
   summaries, no Claude fallback for calendar text. Alternatives are Microsoft 365 or CalDAV, if the work calendar
   lives there.
5. **Learning consent and egress.** Allow owner-approved text in `learning_items` (v14). *Recommended:* yes, per-item
   consent, 365-day retention, `LOCAL_ONLY` by default (examples never go to Claude), and
   `QUOKY_LEARNING_EXAMPLES_ENABLED=false` until LRN-2 is measured.
6. **Connector write scope.** *Recommended:* Jira comment and transition, plus Slack post to allowlisted channels, with
   one-time hash-bound approvals. Confluence and GitHub-issue writes are deferred.
7. **Merge enablement.** *Recommended:* the release default stays `QUOKY_GIT_MERGE_ENABLED=false`. Run the sandbox
   merge UAT (CODE-9) only if you want merge from chat.
8. **Reminders default.** *Recommended:* flip `QUOKY_REMINDERS_ENABLED` to `true` once SUB-1 is live, and keep
   `QUOKY_REMINDERS_CHANNEL_DELIVERY=false` (DM-only) after the C2 UAT.
9. **Images and Claude.** *Recommended:* local vision model only in v3. Claude receives no image bytes unless you
   approve that egress.
10. **Local model.** *Recommended:* choose by LLM-2 measurement among `llama3.1:8b`, `qwen2.5`, `gemma3` and
    `exaone3.5`. MLX is evaluated, and an adapter is added only if it clearly wins. Docker stays unused on macOS.
11. **Fine-tuning (LRN-4).** *Recommended:* defer until ≥300 approved examples exist and LRN-2 shows a gain.
12. **Accepted residuals R1-R4.** *Recommended:* keep all four as documented. Address R1 (storage CAS) only if a second
    writer process is introduced.
13. **Operations UI (ADR-0113, open).** *Recommended:* ratify ADR-0113 as written: a loopback-only, token-gated UI that
    is off by default. Phase 1 is read-only (OPS-1, W3). Phase 2 (OPS-2, W4) handles actions through the chat use cases,
    and approving from the UI needs the confirmation reference that chat shows with the exact preview. Remote access
    and a separate client stay out of v3.
