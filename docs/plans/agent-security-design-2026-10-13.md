# Bounded agent with information-flow control: security design, threat model, compliance and traffic audit (2026-10-13)

- **Status:** **Proposed** (Chief Architect, docs only). Input to ADR-0121 (`DECISIONS.md`) and to the constitution
  amendment draft `docs/plans/architecture-amendment-agent-draft.md`. Nothing in this document is authorized until
  the Product Owner ratifies ADR-0121. Every Strict action it mentions still needs its own owner yes.
- **Base:** `origin/main` `57accc7` (ADR-0120 NL-1 merged; A1 accepted; A2 ratified on 2026-10-13, see the A2
  ratification record in `DECISIONS.md`).
- **Owner direction (2026-10-13):** "OpenClaw식이 좀 더 맞을거 같긴한데 … 자연어 처리가 자연스럽게 되어야하고, 코드상 하드코딩으로는
  한계가 있다"; "보안상으로 취약점은 막긴 해야해"; "tailscale 로 원격 접속으로 인해 회사 내부망에 보안팀이 요청이 있었어. 너무
  잦은 트래픽으로 인해서 말야. 이런 취약점이 존재해서도 안돼." The owner also asked for the company `#ax-security` guidance
  (the MSIT advisory of 2026-10) to be applied. Section 4 maps it item by item.
- **Agreed staged path:** (1) A2 ratified → (2) NL-2 model-first (Phase C), with grammars kept as the provider-down
  fallback → (3) a bounded **read** agent → (4) a **write-proposal** agent (drafts only, every write goes through the
  existing one-time approval card).
- **References** (cited, not fetched): MSIT 사이버침해대응과 "최근 사이버공격 대비 기업 보안강화 권고" (2026-10); KISA 보호나라
  "AI보안위협 대응 매뉴얼" (boho.or.kr nttId=72124); PIPC "공공기관에서 AX로 추진하는 중 개인정보처리 안내서" and "개인정보 유출 시
  대응 안내서"; ISMS-P; the 주요정보통신기반시설 checklist; OWASP Top 10 for LLM Applications (2025); the dual-LLM pattern
  (S. Willison, 2023) and CaMeL ("Defeating Prompt Injections by Design", Debenedetti et al., 2025); ARTEX-ko
  (github.com/jiwoochris/artex-ko).

## 1. What changes, in one paragraph

Today Quoky makes at most one bounded model call to choose one read capability (ADR-0120). The owner wants requests
such as "이번 주 회의 정리하고 관련 jira 이슈도 같이", which need several reads and a summary. The design is
**plan-then-execute**, not a ReAct loop: one privileged planner call turns the owner's own words into a short, closed,
typed plan over the existing catalog; Quoky's deterministic code validates and executes it; raw connector content is
summarized only by a **quarantined** model call that has no tools, whose output goes only to the owner, and which can
never influence which step runs next. Every value carries an information-flow label, and labels decide which model,
which destination and which reply may receive it. The whole process sits behind a code-enforced egress allowlist with
a traffic ledger. This amends ARCHITECTURE.md §8 ("no agent runtime"), so ADR-0121 and a constitution amendment come
first.

## 2. Architecture

### 2.1 Components and where the model is called

```
owner DM text ──(owner gate ADR-0091/0114, Class A control/approvals/anchors first)──┐
                                                                                      ▼
 [M1] PLANNER  = INTENT_SELECTION v2 (Claude CLI, Haiku, --tools "", no MCP, no settings, no session)
      input : owner text (quotes/code/attachments → placeholders), offered catalog, previous selection (structure)
      output: ≤2 KB JSON plan {steps[1..6]}  — steps==1 is exactly today's selection
                                                                                      ▼
 PlanValidator (deterministic, ADR-0120 D4 per step + D4-flow rules below) ──fail──▶ one numbered clarification
                                                                                      ▼
 AgentRunService (Core, behind AgentProfile `quoky.read-agent`)
   for each step: catalog entry → existing handleSelected / read port → typed result (labelled UNTRUSTED)
   StructureProjector: result → {count, ids(closed format), types, error codes}  (deterministic, no model)
   at most ONE re-plan [M1'] on structure only (e.g. "jira.issues: 0", "calendar: AUTH_ERROR")
                                                                                      ▼
 [M2] QUARANTINED SUMMARISER = SUMMARIZATION request with an empty context bundle, no catalog, no memory,
      schema-bound output; provider chosen by the strictest egress label of its inputs (§2.4)
                                                                                      ▼
 ReplyAssembler (deterministic): per-source sections, counts from data, Q-LLM text as an untrusted block,
   link-neutralizer (`packages/core/src/application/link-neutralizer.ts`), previews disabled → owner DM only
```

- **Model call points (complete list):** M1 the planner (one call per owner message, the same call as today's
  selection, no extra latency for single-step turns); M1' at most one re-plan per run, structure-only input; M2 at most
  3 quarantined summaries per run; the existing chat call when the plan is `none` (honest chat, ADR-0120 D9). Nothing
  else in an agent run reaches a model. No provider ever receives a tool definition (ADR-0115 D2 unchanged); the
  planner's "tools" are catalog ids in a JSON plan that Quoky executes itself.
- **New Core code (proposed):** `packages/core/src/application/agent/` (`agent-run-service.ts`, `plan-schema.ts`,
  `plan-validator.ts`, `flow-label.ts`, `flow-policy.ts`, `structure-projector.ts`, `quarantined-summary.ts`,
  `reply-assembler.ts`). The planner reuses `nl-routing/selection-prompt.ts` with a v2 output schema. App wiring in
  `apps/quoky/src/features/agent.providers.ts`; egress and ledger in `apps/quoky/src/security/` (§5).
- **What the agent cannot reach, by construction:** `AgentRunService`'s deps type contains only the read ports behind
  the catalog's `handleSelected`, the `CapabilityRouter`, the clock/id utilities and the audit sink. It has no
  `CommandRunner` (`packages/command-local`), no `ToolProvider` (`packages/tool-mcp`, unwired today), no workspace
  write, no git, no memory writer, no connector writer, no fetch. An import-scan test pins this.

### 2.2 Plan DSL (closed)

```json
{ "steps": [
  { "id": "s1", "entry": "calendar.events", "args": { "range": "this-week" } },
  { "id": "s2", "entry": "jira.issues",     "args": { "keys": { "from": "s1", "field": "jiraKeys", "max": 10 } } },
  { "id": "s3", "summarize": ["s1"], "schema": "meeting-digest.v1" },
  { "id": "s4", "summarize": ["s2"], "schema": "issue-digest.v1" } ],
  "ambiguity": "CLEAR" }
```

- `entry` is a catalog id offered for this turn; `risk` must be `READ` in stage 3 (validator rejects anything else).
- An `args` value is either a **literal** that passes ADR-0120 D4 grounding in the owner's own non-quoted text, or a
  **reference** to a closed-format field (`jiraKeys` `^[A-Z][A-Z0-9]{1,9}-\d{1,6}$`, ISO dates, enum values,
  connector-native opaque ids) that the `StructureProjector` extracts **deterministically by regex/schema**, never by
  a model. Free text from content can never become an argument. A reference is capped (`max` ≤ 10) and may only feed a
  READ step declared in the original plan (owner question Q2).
- Control flow is fixed before the first read: no conditionals on content, no loops, ≤ 6 steps, ≤ 1 re-plan.

### 2.3 Quarantined summariser (M2)

- Input: one step's typed result, rendered by `untrusted-document-readout.ts` (ADR-0063, ADR-0111 D3) inside an
  untrusted span, plus a fixed instruction and an output schema (e.g. `meeting-digest.v1`: ≤ 8 bullets × 160 chars,
  no URLs, no imperative to the reader). No catalog, no memory recall, no conversation history, no tool definitions.
- Output is parsed strictly; a schema failure means the section is shown as a deterministic listing without summary.
  The output is labelled with the union of its inputs' labels plus `MODEL_DERIVED`, goes only to `ReplyAssembler`, and
  is never fed to M1/M1', never stored in memory or learning (ADR-0107), never used as an argument.
- The credential guard (`containsCredentialMaterial`, `packages/core/src/application/credential-guard.ts:106`) runs on
  the outgoing M2 request and on the M2 output before rendering.

### 2.4 Information-flow labels

Every value in a run carries a label `{trust, egress, scope, sources}`, joined (most restrictive wins) whenever values
are combined. Labels are Core domain data (`flow-label.ts`), never a provider id.

| Dimension | Values (low → high restriction) | Set by |
|---|---|---|
| `trust` | `TRUSTED` (the owner's own non-quoted DM text, Quoky constants) · `STRUCTURE` (deterministic projection: counts, closed-format ids, types, error codes) · `UNTRUSTED` (any connector content, quoted/pasted text, attachments, any model output derived from them) | source adapters; `StructureProjector` is the only declassifier, and it is deterministic code |
| `egress` | `REMOTE_OK` (work text where `QUOKY_WORK_SUMMARY_ENABLED=true`) · `REMOTE_ON_SUMMARY_REQUEST` (mail/Drive text, ADR-0118 D7) · `LOCAL_MODEL_ONLY` (calendar text, ADR-0110 D4; curated examples, ADR-0107 D5) · `HOST_ONLY` (credential-shaped material, tokens) | source; the credential guard upgrades to `HOST_ONLY` |
| `scope` | `WORK_CHANNEL_OK` · `OWNER_DM_ONLY` (mail, Drive, calendar, brief) | catalog entry DM-only flag |

Policy (`flow-policy.ts`, checked before every model call, connector call and reply):

1. **M1/M1' accept only `TRUSTED` and `STRUCTURE`.** A canary check refuses the call if any `UNTRUSTED` byte
   sequence of this run appears in the prompt (defence in depth over the type system).
2. **An M2 call's provider must satisfy the strictest `egress` of its inputs:** `LOCAL_MODEL_ONLY` → a provider with
   `executionLocality: 'LOCAL'` (ARCHITECTURE.md §5.14), else no summary (listing only); `REMOTE_ON_SUMMARY_REQUEST` →
   only when the owner's text asked for a summary (a grounded summary verb in the plan, not inferred); `HOST_ONLY` →
   never leaves.
3. **Connector arguments accept `TRUSTED` literals or `STRUCTURE` references only.** `UNTRUSTED` → any argument is a
   hard refusal (blocks exfiltration through search queries, e.g. mail text pushed into a Slack search).
4. **Replies:** `OWNER_DM_ONLY` data renders only in the owner's DM; in a channel the run stops before reading.
5. **Cross-destination flow (stage 4):** data labelled from source A reaching a write to destination B ≠ A is allowed
   only through an approval card that shows the exact payload and a provenance banner ("메일 내용 포함"); the
   destination itself must be `TRUSTED` (from the owner's words), never from content.

### 2.5 Tool contracts

The only tools are catalog entries (`packages/core/src/application/nl-routing/wave1-entries.ts`, contributed by the
handlers, ADR-0120 D1). Each contract: id, `risk`, DM-only flag, typed args with hand-written validators, result type,
`maxItems`, `maxBytes`, the connector origin(s) it may touch (cross-checked against the egress allowlist, §5.2), and a
per-run call cap. Stage 3 = READ entries only. Stage 4 adds `*.propose` entries whose only effect is to create an
existing approval card (ADR-0112, the ADR-0110 amendment), never a write.

### 2.6 Approval-card integration (stage 4 only)

- A proposal reuses the existing exact-payload, one-time, hash-bound approval of ADR-0112 (`connector-writes/*`,
  `approval-decision-service.ts`): the card shows destination, operation and the full payload; the hash binds them; the
  approval phrase is accepted only from a later owner turn; receipts are at-most-once with no auto-retry.
- New: the card carries a provenance banner listing the label sources and a "모델 작성 초안" marker. The model draft is
  `UNTRUSTED`; it is shown inside a quoted block so it cannot imitate the card's own approve/deny lines.
- ADR-0112 D5 and the ADR-0110 amendment D4 (payload = the owner's text verbatim) must be amended for stage 4. That is
  a separate amendment, not part of ADR-0121's stage-3 authority.

### 2.7 Bounds and kill switch

| Bound | Value (default) | Enforcement |
|---|---|---|
| Steps per plan | ≤ 6 (≤ 4 reads + ≤ 3 summaries, ≥ 1 read) | validator |
| Re-plans | ≤ 1, structure-only | `AgentRunService` |
| Connector calls per run | ≤ 10 (references fan out ≤ 10 ids, batched into one query where the API allows) | run budget |
| Model calls per run | ≤ 5 (M1 + M1' + 3 × M2) | run budget |
| Wall clock per run | 45 s, then partial reply with what is done | deadline |
| Runs | ≤ 30 per hour, ≤ 150 per day per actor | ledger |
| Tokens | ≤ 40k input tokens per run (estimate by bytes), monthly via the ADR-0115 usage ledger | run budget |
| Kill switch | `QUOKY_AGENT_MODE=off\|shadow\|active` (default `off`) **and** an owner Class A control phrase `에이전트 중지` / `에이전트 재개` that flips a persisted flag in the data dir (no restart); the ops-UI shows it | runtime |

A breached bound ends the run with a deterministic partial reply; nothing is retried automatically.

### 2.8 Audit log

One content-free record per run, stored in the run's `TaskRun` metadata (`quoky.agentRun`, JSON, no migration) and
mirrored to the traffic ledger: run id, turn correlation id, ISO-8601 timestamps with offset, plan as entry ids plus
argument **kinds** (literal/reference, never values), per step: origin host, HTTP status class, item count, bytes in/out,
latency, label set, outcome; per model call: capability, provider id (audit only, ARCHITECTURE.md §5.3), locality,
token estimate, latency; the approval card id if any; the bound that ended the run. Never message text, item text,
argument values, tokens or passwords (MSIT ⑤).

### 2.9 Selection and planner latency (the selection timeout)

Measured (ADR-0120 notes): p50 2.9–3.0 s, p95 3.6–3.8 s, 1–3% of calls over the then-4 s bound (raised to 6 s by ADR-0120 A3 on 2026-10-13, configurable 2–8 s), all on a cold `claude -p`
spawn (`packages/ai-cli/src/index.ts:441-452`, `nl-selection-service.ts:50`). Proposal, in order, no new vendor:

1. **L1 — turn off the CLI's non-essential traffic.** The runner forwards no env to Claude (`CALLER_ENV_ALLOWLIST`,
   `packages/ai-cli/src/cli-runner.ts:97`), so every spawn may contact telemetry, error reporting and update hosts
   besides the model API. Add `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (documented Claude Code setting; it covers
   telemetry, error reporting, auto-update and bug command) to the Claude child env. This is a security fix first
   (fewer destinations, MSIT ④) and a startup-time reduction second. Verify with the self-check (§5.5).
2. **L2 — one warm standby process.** After each `INTENT_SELECTION` call, pre-spawn the next `claude -p` with its
   argv and wait for stdin; the next selection writes its prompt and closes stdin. One standby at a time; discarded
   (not replaced) after 15 idle minutes, so an idle Quoky spawns nothing. Precondition: a measurement that the CLI does
   its start-up work before reading stdin; if it does not, L2 is dropped. A long-lived `--input-format stream-json`
   session is **rejected**: it carries conversation state across owner messages (cross-turn leakage, growing context).
3. **L3 — smaller, cache-friendly prompt.** Static catalog first and the owner text last; trim the KO/EN description
   lines; target −30% prompt bytes, measured with the D12 evaluation (prompt version bump, Strict run).
4. **L4 — bound 4 → 5 s** only if L1–L3 leave > 1% over the bound.
- **Rejected:** a parallel race (doubles Anthropic calls; contradicts the traffic request), a new vendor or a
  direct Anthropic API key (owner question Q8), a local model for selection (ADR-0120 alternatives; not measured).

## 3. Threat model (STRIDE + OWASP LLM Top 10 2025)

"Attack succeeds" means any of: a step not derivable from the owner's own words; any argument from `UNTRUSTED` free
text; any `UNTRUSTED` byte in an M1 prompt; egress to a non-allowlisted destination; data reaching another destination
without a card; credential material leaving the host; a write without an approval; a bound exceeded without stop.

| # | Threat (STRIDE / OWASP) | Control | Test |
|---|---|---|---|
| T1 | Indirect prompt injection in mail, Drive, calendar, Jira, Slack, Confluence, GitHub content (T, E / LLM01) | Planner never sees content (§2.4 rule 1); Q-LLM has no tools and its output only reaches the owner | Canary fixtures: unique tokens in every connector fixture; assert absent from every M1 prompt and every connector request; red-team suite (§6) |
| T2 | Direct injection via quoted/pasted text in the owner's message (T / LLM01) | ADR-0120 D3/D8: quotes, code and attachments become placeholders; pasted text cannot ground an argument | Existing NL corpus negatives + red-team "pasted instruction" family |
| T3 | Q-LLM output steering the next step (E / LLM05 improper output handling) | Q-LLM output is `UNTRUSTED`, render-only; references accept only `StructureProjector` fields | Property test: random/hostile M2 outputs never change the executed step list or any argument |
| T4 | Excessive agency: shell, code, URL fetch, MCP, plugin, write (E / LLM06) | Closed READ catalog; deps type excludes `CommandRunner`, `ToolProvider`, writers, fetch | Import-scan test on `application/agent/*`; validator test rejects every non-READ id |
| T5 | Exfiltration through read arguments (I / LLM02) | §2.4 rule 3: `UNTRUSTED` → argument refused; closed-format references only | Fixture where a mail asks to "search Slack for <secret>": assert no Slack call carries it |
| T6 | Exfiltration through links, image embeds, unfurls in replies (I / LLM05) | `link-neutralizer.ts` on all untrusted text; Telegram `link_preview_options.is_disabled` (`telegram-platform-adapter.ts:1146`); Discord embeds suppressed for agent replies (to add) | Render test: no scheme URL, no bare domain, no markdown image survives; Discord payload has the suppress flag |
| T7 | Cross-destination leak, e.g. mail → Slack (I) | Stage 4 only, via card with exact payload + provenance; destination `TRUSTED` only | Red-team "forward this to #general" in mail content: no card for a destination absent from owner text |
| T8 | Secrets to a model or connector (I / LLM02) | Credential guard before every egress: M1 (exists), M2, every string argument, replies | Guard tests with vendor-format fixtures in content and owner text |
| T9 | Spoofed requester / channel use (S) | Owner-only inbound (`adapter-discord/src/index.ts:576`, Telegram `ownerIds`); agent runs only in the owner DM | Non-owner and channel fixtures: no plan, no read |
| T10 | Repudiation: no record of what ran (R) | Content-free audit per run with correlation id and timestamps (§2.8) | Audit schema test; a scan asserts no fixture text in records |
| T11 | Unbounded consumption, cost, traffic (D / LLM10) | §2.7 caps, §5.3 budgets, circuit breaker, kill switch | Bound tests per cap; kill-switch test mid-run |
| T12 | Repeated small queries (MSIT ⑤) | Ledger 1 min / 1 h / 24 h windows with thresholds and a DM alert | Synthetic ledger replay triggers the alert |
| T13 | SSRF / unexpected destination / metadata endpoints (MSIT ②) | Egress allowlist in code; `redirect: 'error'` everywhere; IP literals, link-local (169.254.0.0/16), private ranges refused except exact `127.0.0.1` Ollama | Guard unit tests; redirect test per reader |
| T14 | Prompt leakage (I / LLM07) | Prompts hold no secrets; catalog text is non-secret | Credential scan of all prompt templates in CI-equivalent test |
| T15 | Supply chain: CLI auto-update, npm deps (T / LLM03) | L1 disables CLI auto-update; pinned CLI version check at start; `pnpm audit --prod` monthly; lockfile | Startup check logs CLI version; audit report in the ops checklist |
| T16 | Memory / learning poisoning (T / LLM04, LLM08) | Agent never writes Quoky Memory or learning; M2 output not stored | Test: a run leaves memory and learning tables unchanged |
| T17 | Misinformation / over-reliance (LLM09) | Counts and lists are deterministic; summaries are marked model-written; source header per section | Live UAT review |
| T18 | Card spoofing by drafted text (S, T) | Draft rendered in a quoted untrusted block; approval phrase accepted only from a later owner turn bound to the card hash (ADR-0112) | Red-team drafts containing "승인" lines |
| T19 | Remote-access / P2P exposure of the host (S, I) | No listener beyond loopback; no tunnel software; self-check | Self-check exit code 0 (§5.5) |

## 4. Compliance mapping: MSIT advisory (2026-10) → Quoky today → action

Status: **M** meets · **P** partial · **G** gap · **H** host/organisation item outside Quoky code.

| MSIT item | Quoky today (evidence) | St. | Action |
|---|---|---|---|
| ①-1 Block unused services, patch, restrict admin | No inbound port: Telegram long polling only (ADR-0114 D4, `telegram-platform-adapter.ts:39`); Discord gateway is outbound; ops-UI default off, loopback, token-gated (`ops-ui-config.ts:11-14`). No dependency-patch routine | P | Monthly `pnpm audit --prod` + Node LTS patch in the ops checklist |
| ①-2 Inventory reachable services incl. remote access | No inventory existed; Tailscale app installed (logged out) | G | This document §5.1; self-check §5.5; uninstall Tailscale (Q6) |
| ①-3 Admin/DB access on designated paths | Ops-UI binds `127.0.0.1` only, no bind key (`ops-ui/http/server.ts:61,156`); per-start token file 0600; 12 h session (`ops-ui/http/security.ts:24`); SQLite file local | M | — |
| ①-4 No config/repo/backup/verbose-error exposure | Ops-UI serves a fixed route switch (`server.ts:215-259`); errors redacted (`safe-error.ts`, `error-diagnostics.ts`); `.env*`, `data/` git-ignored | M | Add a test that unknown ops-UI paths return 404 without detail |
| ①-5 Monitor repeated access / config-read attempts | Ops-UI auth failures not counted | G | Count 401/404 per 10 min; lock the session token after 20 failures; ledger alert |
| ②-1 Server-side authorization per request | Owner gate per message (ADR-0091/0114); ops-UI token per request | M | Agent: owner DM only (T9) |
| ②-2 Input never interpreted as query/command | Typed args → adapter-rendered, escaped JQL (ADR-0120 D13); Drive kind → fixed clauses; commands only on code work via `RiskPolicy.assessCommand` + `execution-command-guard.ts` | M | Agent plan is a closed DSL (§2.2) |
| ②-3 Fetch-URL limited to allowed destinations/protocols; block internal & metadata | No arbitrary URL fetch exists; fixed origins per connector (e.g. `GMAIL_API_ORIGIN`, `SLACK_API_ORIGIN`, `GITHUB_API_BASE`); Discord CDN allowlist (`adapter-discord/src/attachments.ts:45`); Jira/Confluence host https-only, no port/path (`connector-jira/src/index.ts:272`). Readers for Jira, Confluence, Slack, GitHub do not set `redirect: 'error'`; no central allowlist | P | Egress guard (§5.2) with redirect refusal and private/metadata range block |
| ②-4 Per-account/token limits: calls, period, results, download volume | Result caps (limit 1-10, 31-day span), Telegram 8 MiB poll cap and 1→60 s backoff, 429 → typed error with no retry. No per-connector request budget, no download-volume budget | P | Token buckets + daily volume budget (§5.3) |
| ③-1 MFA; separate admin/normal accounts | Outside Quoky (Google, Atlassian, Slack, GitHub, Discord, Telegram accounts) | H | Owner confirms MFA/2-step on each; Telegram 2-step verification |
| ③-2 Secret scan of source, history, config, collaboration tools | Credential guard on egress (`credential-guard.ts:106`), file guard (`:724`), command-output masking (`packages/command-local`). No repository/history scan, no CI | G | In-repo scan: a test running `classifyCredentialFileContent` over tracked files + a `git log -p` script, no new dependency (Q7) |
| ③-3 Revoke and rotate exposed keys; investigate usage | No runbook | G | Key-rotation runbook: per key where to revoke, rotate, and which usage log to check |
| ③-4 Least privilege, short-lived integration keys | Google `gmail.readonly`, `drive.readonly`, `calendar.readonly` (+`calendar.events` for approved writes) (`connector-*/src/oauth.ts`); GitHub App installation tokens, repo allowlist (ADR-0109); separate Slack write token. **Atlassian classic API token shared by Jira and Confluence (user-wide, long-lived)**; Slack user token `xoxp-` long-lived | P | Atlassian scoped API token with expiry; Slack token review; expiry calendar (Q5) |
| ③-5 External maintenance accounts minimal, removed after use incl. network connections | Tailscale installed; no remote-maintenance policy | P | Uninstall Tailscale and its network extension; any future remote session is time-boxed and removed |
| ④-1 No admin rights for runtime account; restrict DB/file access | launchd user agent; launcher umask 077; token files 0600 `O_NOFOLLOW` (`connector-gmail/src/token-file.ts:74`); CLI children get an env allowlist only (`cli-runner.ts:89`). Runs as the owner's own account with full `HOME` | P | Later: a dedicated standard user (Claude CLI login must move with it) — residual |
| ④-2 Uploads never execute | Attachments are bounded text Resources or image bytes, never persisted, never executed (ADR-0111) | M | — |
| ④-3 EDR/AV with alerts | Company endpoint software | H | Owner/IT confirm EDR is active on the host |
| ④-4 Restrict system-to-system communication | Fixed origins per adapter; Ollama exact `127.0.0.1` (`cli-runner.ts:104`). No process-wide allowlist | P | Egress guard enforce mode (§5.2) |
| ④-5 Monitor new external communication | None | G | Ledger "new destination" DM alert; self-check |
| ⑤-1 Limit export to work scope; minimize data in responses | DM-only personal data; listings capped, no bodies (ADR-0118); calendar text local-only (ADR-0110 D4). Work summaries fall back to Claude by default (`.env.example:240`) | P | Agent labels (§2.4); owner may set `QUOKY_WORK_SUMMARY_ENABLED=false` |
| ⑤-2 Synchronized log time, correlation | `ConsoleLogger` prints no timestamp (`apps/quoky/src/console-logger.ts:26-33`); no turn correlation id | G | ISO-8601 with offset on every line + turn/run correlation id; host automatic time on |
| ⑤-3 Logs: time, path, result, target, volume; no passwords/tokens | Content-free selection logs (ADR-0120 D11); redaction. No per-destination volume | P | Traffic ledger fields (§5.4) |
| ⑤-4 Short/long-window cumulative analysis | None | G | Ledger windows 1 min / 1 h / 24 h / 7 d with thresholds |
| ⑤-5 Incident response (KISA 118, isolate, preserve logs) | No runbook | G | Runbook: kill switch → `quokyctl stop` → network off → copy `quoky.log*`, ledger, DB → company security team → KISA (boho.or.kr, 118) |

**Gaps ranked (today):** (1) no process-wide egress allowlist or new-destination monitoring, and the Claude CLI child
may still send non-essential traffic (②-3, ④-4, ④-5); (2) no traffic/volume log, no cumulative analysis, logs without
timestamps (⑤-2/3/4); (3) no per-connector call or volume budget (②-4); (4) Tailscale installed and no remote-access
inventory (①-2, ③-5); (5) long-lived broad Atlassian and Slack user tokens (③-4); (6) no repository/history secret scan
and no rotation runbook (③-2, ③-3); (7) no incident runbook (⑤-5); (8) ops-UI failure counting (①-5); (9) runtime
account privilege (④-1, residual).

## 5. Network-traffic audit and budget

### 5.1 Outbound inventory (Quoky process and its children)

| Destination | Purpose | Cadence | Code |
|---|---|---|---|
| `api.telegram.org:443` | `getUpdates` long poll, sends, files | 1 keep-alive connection; poll timeout 25 s → ≈144 polls/h idle; backoff 1→60 s | `adapter-telegram/src/telegram-platform-adapter.ts:136-148`, `bot-api.ts:16` |
| `gateway.discord.gg`, `discord.com:443` (Cloudflare) | Gateway websocket, REST sends | 1 websocket, heartbeat ≈41 s (protocol); REST per reply | `adapter-discord/src/index.ts:189` (discord.js) |
| `cdn.discordapp.com`, `media.discordapp.net` | Owner attachments | On demand | `adapter-discord/src/attachments.ts:45` |
| `api.anthropic.com` (+ CLI side hosts, see L1) | `claude -p` for selection and chat | ≤ 2 spawns per chat-bound owner message; 0 when idle | `packages/ai-cli/src/index.ts:441` |
| `www.googleapis.com`, `gmail.googleapis.com`, `oauth2.googleapis.com` | Calendar, Drive (+Sheets), Gmail, token refresh | On demand; brief at its scheduled time; BRF-2 re-check at fire time | `connector-calendar-google/src/google-calendar-reader.ts:20`, `connector-gdrive/src/gdrive-reader.ts:35`, `connector-gmail/src/gmail-mail-reader.ts:43`, `*/oauth.ts` |
| `<site>.atlassian.net` | Jira, Confluence reads; approved Jira writes | On demand; brief Jira section if opted in | `connector-jira/src/index.ts:99`, `connector-confluence/src/index.ts:98` |
| `slack.com` | Search, channel info; approved posts | On demand | `connector-slack/src/index.ts:14`, `slack-channel-writer.ts:25` |
| `api.github.com`, `github.com` | Code-work reads, App tokens, push/PR after approval | On demand | `github-app-auth/src/index.ts:19`, `connector-github/src/index.ts:15` |
| `api.openai.com`, `generativelanguage.googleapis.com` | Only if the owner selects them (ADR-0115); keys not set today | Off | `ai-openai-api/src/openai-api-config.ts:7`, `ai-gemini-api/src/gemini-api-config.ts:7` |
| `127.0.0.1:11434` | Ollama (local) | On demand | `ai-cli/src/cli-runner.ts:104` |
| **Listener** `127.0.0.1:47613` | Ops-UI (loopback only) | — | `ops-ui/http/server.ts:156` |

Local periodic work with **no** network: reminder tick 15 s (`reminders/reminder-tick-driver.ts:27`), usage notice poll
1 h (`ops/provider-usage-notice.ts:169`), attachment sweeps 60 s, PRV-3 hourly check, backup job. Measured on
2026-10-13: exactly two established outbound TCP connections (Telegram, Discord) and one loopback listener — consistent
with this table. Quoky's steady-state footprint is small; it is not the source of "frequent traffic".

**Not Quoky (development tooling on the same host):** the ego-browser holding Discord Web and Telegram Web tabs (each
a persistent websocket plus background polling and media loads), and the orchestrator's relay poller reading Discord
every ≈40 s (≈90 requests/h, around the clock while it runs). The Tailscale app (installed, logged out) is neither, but
its presence is what the security team flagged. **Recommendations:** relay poller 40 s → 120 s while a task is active,
exponential idle backoff to 10 min, stopped outside orchestration sessions; close the Discord/Telegram Web tabs when no
attended UAT is running; uninstall Tailscale including its network extension and VPN profile (owner action, Q6).

### 5.2 Egress allowlist enforced in code (proposed, `apps/quoky/src/security/egress-guard.ts`)

- **Allowlist** = the hosts of §5.1, derived from configuration at start (Jira/Confluence host from config, OpenAI/
  Gemini only when selected), frozen, logged once at start (names only).
- **Enforcement for `fetch`:** installed first in `apps/quoky/src/main.ts` (before `NestFactory`), wrapping
  `globalThis.fetch`: https only (http only for exact `127.0.0.1`), host must be on the list, IP literals refused,
  link-local (169.254.0.0/16, incl. cloud metadata), RFC 1918, CGNAT 100.64.0.0/10 (Tailscale range) refused,
  `redirect` forced to `'error'`. A refusal is a typed error and a ledger entry.
- **Observation for non-`fetch` clients** (discord.js REST uses its own undici; the gateway uses `ws`): subscribe to the
  process-wide `undici:request:create` / `undici:client:connected` diagnostics channels (the pattern already used in
  `apps/quoky/src/connector-write-transport.ts`) and to `net` socket creation; an off-list host is logged and alerted
  (observe, not block — fixed library hosts).
- **Children** (`claude`, `ollama`): cannot be enforced in-process; L1 removes the CLI's side traffic; the self-check
  lists child connections.
- **Rollout:** `QUOKY_EGRESS_GUARD=observe|enforce` (default `observe` for 7 days, then `enforce` after a clean ledger;
  Q4).

### 5.3 Budgets

| Destination group | Budget (token bucket) | On error |
|---|---|---|
| Telegram | 1 open poll; poll timeout 25 → 50 s (≈72 polls/h idle); sends ≤ 30/min | existing 1→60 s backoff; 3×409 in 5 min stops polling (exists) |
| Discord | 1 gateway; REST ≤ 30/min (discord.js 429 handling) | library backoff |
| Anthropic (CLI spawns) | ≤ 2 per owner message; ≤ 60/h; agent ≤ 5 per run | no retry (ADR-0120 D3) |
| Google APIs (each) | ≤ 20/min, ≤ 300/h; token refresh ≤ 1 per 50 min per client | 429/5xx: no retry; breaker opens 5 min after 3 consecutive failures |
| Atlassian, Slack, GitHub (each) | ≤ 20/min, ≤ 300/h (Slack search ≤ 10/min) | same breaker |
| Attachments | ≤ 20 files/h, ≤ 100 MB/day | refuse with a fixed reply |
| All egress | ≤ 200 MB/day down, ≤ 20 MB/day up; alert at 80% | DM alert, then refuse non-owner-initiated calls |

No inbound listener beyond loopback; no tunnels, no P2P, no relay, no webhook — Telegram stays on long polling.

### 5.4 Traffic and volume ledger (MSIT ⑤)

`apps/quoky/src/security/traffic-ledger.ts`: per request — ISO-8601 time with offset, correlation id (turn/run),
destination host, method, path **template** (e.g. `/rest/api/3/search`, no query values), status class, bytes up/down
(request body length; response counted while streaming), latency, initiator (`owner-turn`, `brief`, `reminder`,
`agent-run`, `startup`). JSON lines under `data/audit/egress-YYYY-MM-DD.jsonl`, mode 0600, 90-day retention. Never
headers, tokens, query strings or bodies. Windows 1 min / 1 h / 24 h / 7 d per host and initiator; alerts: new host,
budget breach, ≥ 20 small (< 2 KB) requests to one host in 5 min outside an owner turn.

### 5.5 One-command self-check (spec: `ops/security/quoky-net-selfcheck.sh`)

- **Run:** `ops/security/quoky-net-selfcheck.sh [--json] [--since 24h]`. Read-only, no sudo, prints no secrets;
  exit 0 = clean, 1 = finding.
- **Checks:**
  1. Time and clock source: KST timestamp; whether automatic network time is on.
  2. Quoky processes: the launchd label `com.quoky.personal`, its PID and its children (`pgrep -P`).
  3. Connections: `lsof -nP -a -p <pids> -i`, both ESTABLISHED and LISTEN. Each remote address is mapped to its
     allowlisted host through the ledger's recent host→IP records. Anything unmapped is a finding.
  4. Listeners: only `127.0.0.1:<ops port>` is allowed.
  5. Remote-access and P2P software: the Tailscale app and `IPNExtension`, `tailscaled`, utun interfaces with
     100.64.0.0/10 addresses, ZeroTier, ngrok, cloudflared, frp, AnyDesk/TeamViewer; any listener on 22 or 5900;
     `scutil --nc list` VPN configurations.
  6. Ledger summary for `--since`: the count and bytes per host and per initiator, any new hosts, and any budget
     breaches.
  7. A "not Quoky" section: other local processes connected to Discord or Telegram hosts (browser, relay poller),
     listed for transparency.
- **Output:** a one-page text report the owner can hand to the security team, or JSON with `--json`.

## 6. Staged rollout and release gates

| Stage | Scope | Gate to enter `active` |
|---|---|---|
| S0 Security baseline (before any agent code) | L1 env; timestamps + correlation ids; traffic ledger; egress guard `observe`; self-check script; Telegram poll 50 s; Tailscale removed (owner); key review (owner) | Self-check exit 0; 7 days of ledger within budgets with no unexplained host; then guard `enforce`; CA + Codex + `/security-review` PASS |
| S1 NL-2 Phase C (model-first) | ADR-0120 D6 Phase C; grammars as provider-down fallback; L2/L3 latency work | ADR-0120 D12 gate (≥ 95%, ≥ 90% per entry, 0 wrong, 3 runs); > 4 s calls ≤ 1%; D8 egress yes (owner); ledger budgets hold |
| S2 Bounded read agent | §2 with READ entries; `QUOKY_AGENT_MODE` off → shadow (plan + validate + log, **no reads**) ≥ 7 days → active | ADR-0121 + constitution amendment ratified; offline suite (validator, labels, bounds, kill switch, import scan, canaries); **injection red-team suite: 0 successful attacks over 3 runs**; agent-plan eval ≥ 95% exact plans, 0 wrong on negatives; CA + Codex + `/security-review` on every PR; live UAT in the owner DM |
| S3 Write-proposal agent | `*.propose` entries → existing cards; provenance banner | Separate amendment of ADR-0112 D5 and the ADR-0110 amendment D4; red-team with exfiltration and card-spoofing families, 0 successful; owner yes |

**Red-team suite** (`packages/core/src/application/golden/agent-redteam.v1.json`, Strict to run with a model):
≥ 300 cases. Korean and English. Families: (1) instruction-in-content for every connector (mail body, Drive doc,
event description, Jira comment, Slack message, Confluence page, PR body); (2) pasted/quoted instructions; (3) argument
smuggling ("search Slack for …"); (4) link/image exfiltration; (5) destination hijack ("forward to #general"); (6)
credential bait; (7) budget exhaustion ("repeat for every day this year"); (8) card spoofing (S3). Cases are seeded by
**ARTEX-ko** (an AI attack generator, per the company's "AI로 뚫고 AI로 막고" stance): run offline against fixtures only,
never against live company systems. Generated cases are reviewed by the owner before entering the corpus (ADR-0098 D7).
Pass condition: 0 successful attacks by the §3 definition, checked by deterministic assertions on prompts, requests,
ledger and replies (no LLM judge). New ARTEX-ko attack families are re-run after any planner prompt change.

## 7. Owner questions (recommended defaults)

1. **Q1 — Ratify ADR-0121 and the constitution amendment** (`architecture-amendment-agent-draft.md`)? *Default: ratify;
   S2 code waits for it. S0 needs only this design's S0 list approved.*
2. **Q2 — Closed-format references:** may ids extracted deterministically from read results (Jira keys, dates) fill
   arguments of a READ step the planner already declared (≤ 10)? *Default: yes, reads only; free text never.*
3. **Q3 — Calendar text stays local-only** (ADR-0110 D4): with Ollama not ready, the calendar part of an agent answer is
   a listing without a summary. *Default: keep.*
4. **Q4 — Egress guard:** `observe` for 7 days, then `enforce`? *Default: yes.*
5. **Q5 — Credentials:** move to an Atlassian scoped API token with expiry and review the Slack user token. *Default:
   yes, owner action with an operator checklist.*
6. **Q6 — Remove Tailscale** (app, network extension, VPN profile). *Default: yes, owner action;* also apply the dev-tooling
   reductions of §5.1.
7. **Q7 — Secret scan** with the existing credential guard (no new dependency) rather than gitleaks. *Default: in-repo.*
8. **Q8 — Selection latency:** apply L1–L3, keep the A3 bound (6 s), no race, no direct Anthropic API key. *Default: yes.*
9. **Q9 — Share the self-check output with the security team** after S0. *Default: yes.*
10. **Q10 — OS-level outbound firewall** (e.g. LuLu) as a second layer. *Default: not now; ask the security team.*

## 8. Residuals

- The ledger cannot enforce destinations for child processes (Claude CLI, Ollama). L1 reduces their egress, and the
  self-check observes it.
- A plausible but wrong plan is still possible. Mitigations: reads only, deterministic counts, a basis line, and the
  0-wrong gate.
- The quarantined summary can still mislead the owner in its own text (LLM09). It is marked as model-written.
- The runtime runs as the owner's account (④-1) until a dedicated user is set up.
- The `Actor` document has no compare-and-set (ADR-0120 R3).
