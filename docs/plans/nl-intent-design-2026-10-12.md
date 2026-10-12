# Natural-language capability selection: design input and owner answers (2026-10-12)

Status: design input for ADR-0120 (Chief Architect review, read-only, 2026-10-12). The owner's answers are recorded below. Audit: `docs/plans/nl-intent-audit-2026-10-12.md`.

## 1. Constraints found

### ARCHITECTURE.md

- §1 supports the request: "the system decides *what capability* is needed".
- §3 / §11.5: model reasoning is isolated in its own component.
- §5.1, §5.2, §12: providers are chosen by data, and Core never branches on a provider id.
- §5.5 and ADR-0115 D2: HTTP API providers advertise only chat-tier capabilities.
- §5.14 and ADR-0107 D6: locality is data the provider declares.
- §7.3: the order is Intent → Capability → Provider.
- §8.1, §8.3, and the ROADMAP non-goals: no agent loop and no tool use.
- §10, §12: external writes need approval.
- §11.7: the ADR comes before the code.

### Settled ADR clauses the request conflicts with

These must be amended by ADR-0120. Line numbers refer to DECISIONS.md at origin/main @ 7ae8245, so re-locate them.

| ADR | Clause |
|---|---|
| ADR-0096 (~:14949) | D3: three dispatch points. D4: "Handlers never reach an AI provider". D5: precedence changes only by amendment plus a corpus update. |
| ADR-0032 M3 amendment (~:5862) | `ConversationRuntimeDeps` baseline is 35. |
| ADR-0100 (~:15490) | D1: deterministic work grammar. D2: "no classifier hook". D7: named queries only. |
| ADR-0101 D2 (~:15645) | Reminders use a deterministic grammar and no LLM. Untouched in wave 1 unless reminders are selected. |
| ADR-0110 D3/D4 (~:16446) | A pure schedule grammar, and calendar text never goes to a REMOTE provider. |
| ADR-0117 D3 (~:18846) | Brief: "No model". The brief body stays model-free; only its selection is new. |
| ADR-0118 (~:19163) | D4: no model for a listing. D7: no mail or Drive text leaves the host unless a summary is asked for. D8: routing uses the owner's text only. |
| ADR-0098 D1 (~:15247) | Capability honesty. |
| ADR-0098 D7 | Corpora are owner-curated, with no LLM judge, and each harness run is Strict. |
| ADR-0098 amendment D1 / QUAL-7 (~:15805) | `POLICY_SENSITIVE_CHAT` is assigned deterministically, and personal-data questions take the deflection route (the `브리핑`/`확인` ask-words in `intent-classifier.ts:383-391`). |
| ADR-0104 | D1/D2: the claim-guard lexicon. D4: help-intent is at order 400. |
| ADR-0112 D5 and the ADR-0110 calendar-write amendment | Write payloads are the owner's text verbatim, never drafted by a model. |
| ADR-0111 D3 / ADR-0063 | Readouts are untrusted data. |
| ADR-0091 | Owner-only inbound. |

ADR-0090 is **Proposed** and was never ratified. It already sketches the layering ADR-0120 adopts for Personal:
- L0: deterministic control.
- L1: a small classifier.
- L2: deterministic policy.
- Low confidence leads to a clarification, never to chat.
- When the provider is unavailable, a deterministic fallback is used with no retry.

The v5 ratification decision 2 (no new AI vendor or connector) is respected.

**Verdict:** there is no conflict with ARCHITECTURE.md. There is a conflict with the settled ADRs above, so ADR-0120 must be written and ratified by the owner before any code. Regex widening (e.g. #177 `JIRA_LIST_KO`) stops.

## 2. Architecture

### Capability catalog

The catalog is closed, lives in Core (`application/nl-routing/`), and is contributed by the owning `ConversationTurnHandler` through a new optional `catalog` field, the same way help lines are contributed (ADR-0096 D6). Each entry has:
- `id`
- `risk`: READ, LOCAL_WRITE or EXTERNAL_WRITE
- a DM-only flag
- a typed argument schema, using hand-written validators (no dependencies)
- KO/EN description lines

Only entries for configured sources are shown to the model.

Wave-1 entries (all reads): `jira.issues`, `github.items`, `slack.search`, `confluence.search`, `calendar.events`, `mail.list`, `drive.files`, `todo.list`, `reminder.list`, `brief.today`, `help.topic`.

### Selector

- There is no new port. A new `Capability.INTENT_SELECTION` is served through the existing `CapabilityRouter` (`capabilities`, `priority`, `isAvailable`, `executionLocality`).
- Core builds a provider-neutral prompt spec, and the adapter renders it, including the model and effort.
- The owner's chat-tier model choice does not apply to this capability.

**Input:**
- The owner's text, with quoted and fenced blocks and attachments replaced by placeholders. Text over 600 chars skips selection.
- The previous selection, as structure only.

**Output:**
- One JSON object, at most 2 KB, with unknown keys rejected: `{entryId|none, args, ambiguity: CLEAR|NEEDS_CLARIFICATION, alternatives≤2}`.
- Timeout 4 s, no retry.
- The model's confidence number is logged only and never decides anything.

### Deterministic validation (ADR-0090 L2)

1. Schema check and closed ids.
2. The entry is configured and enabled; the DM-only rule is enforced by the handler.
3. Bounds: limit 1-10, date span at most 31 days.
4. Time is symbolic (`today`, `this-week`, `YYYY-MM-DD..`) and is resolved by Core's clock and `QUOKY_TIMEZONE`. The model never computes timestamps.
5. Grounding: a keyword must appear verbatim in the owner's non-quoted text, or in the previous selection's args.
6. The credential guard runs on every string arg.

### Execution

- The runtime calls the owning handler's new optional `handleSelected(command, ctx)`. It maps to the existing typed commands: `WorkChatCommand` / `desk.handle`, `CalendarQuestion`, `MailQuestion` and `DriveQuestion`.
- Handlers stay provider-free, and approvals are unchanged.

### Ordering

control → approval anchors → Class A exact commands → pre-classify grammars → B0b → **[new] selection** → classifier and chat.

- **Class A** (anchored commands, kept): `할 일 추가:`, `기억해:`, write commands, `N번 메일 요약`, `모델 변경:`, reminders, memory/learning, code work, project registration, and the injection/language checks of `POLICY_SENSITIVE_CHAT`.
- **Phase A:** the model runs only on messages that would otherwise fall through to chat. These already go to Claude chat, so no new class of egress is added.
- **Phase C** (after shadow data): the model runs before the Class B grammars, and those become the fallback for when the provider is down.

### Budget

- At most one selection call per fall-through message.
- Target added latency: p95 ≤ +3 s. This needs measuring in shadow, because a `claude -p` spawn may exceed it.
- An in-memory cache per actor: 10 min, 256 entries, keyed by the normalised text plus a digest of the last selection. It is not persisted.
- A combined "route or answer" call is rejected (ADR-0090 rejected alternatives).

### Failure modes

- **Provider down or timed out:** use the Class B grammar if it matches, otherwise honest chat. No retry.
- **`NEEDS_CLARIFICATION`, two candidates, or a failed validation:** ask one numbered question built from the catalog text. The pending choice is kept in session metadata for 5 min, and replies such as `1` or `지라` resolve it deterministically.
- **Pasted content is data:** it is stripped before the call, cannot ground a keyword, and can never select a write.
- **Follow-ups:** a content-free `quoky.lastSelection` = `{entryId, args, at}` with a 30 min TTL (the same pattern as `last-listing.ts`, with no migration). "그 중에 위클리카만" refines it with `keyword=위클리카`. Item titles, subjects and event text are never sent to the model (ADR-0110 D4, ADR-0118 D7/D8).

### Honest chat

- When the model returns `none`, chat receives an authoritative Core fact listing the configured sources.
- The ADR-0104 guard lexicon gains "cannot connect / access <configured source>" claims, which are replaced by a deterministic offer of the matching command.
- The QUAL-7 personal-data deflection is narrowed to unconfigured sources.

## 3. Capability gaps

**Wave 1:**
- Jira `personal-work` query: a time window (`created`/`updated`/`due` × range), a role (assignee/reporter) and a status (open/all). This is an additive ADR-0100 D7 amendment, with the JQL rendered by the adapter. Both owner phrases need it.
- On-demand `brief.today`: reuses `daily-brief.ts` in the DM, with no model.
- Count answers ("몇 개야").
- Calendar explicit date ranges (`listEvents` already takes from/to).
- Refinement of the last selection for Jira and calendar.

**Wave 2:**
- Mail ranges beyond today, and a subject keyword (shares files with GML-2).
- A Drive modified-since filter.
- A calendar title keyword.
- Jira free-text search (ADR-0100 LATER).
- GitHub filters.

## 4. Testing

- **Corpus:** `golden/nl-intent.v1.json`.
  - Per entry: at least 25 natural phrasings → `{entryId, args}`, plus at least 80 negatives (chit-chat, how-to, mentions, pasted injections, writes that must not run, unconfigured sources).
  - It contains the owner's two phrases and "그 중에 위클리카만" verbatim, seeded from the audit's `scratch/nl-corpus.ts`.
  - The agent drafts and the owner approves each batch (ADR-0098 D7).
- **Offline deterministic suite:**
  - A scripted stub model.
  - Tests for validation, grounding, symbolic time, clarification state, and `handleSelected` for every entry.
  - Class A precedence and the provider-down fallback.
  - The deps baseline asserts 36.
- **Model-in-the-loop eval:**
  - A new mode of `answer-quality-eval-cli`, bound to an approved plan digest. Each run is Strict.
  - Gate: at least 95% exact `{entry,args}` overall, at least 90% per entry, and 0 wrong captures on negatives. A clarification counts as not-a-hit and not-wrong.
  - 3 stable runs, with p50/p95 latency reported.
- **Live UAT** on Telegram and Discord: about 40 phrasings per entry, including a provider-down case.

## 5. Rollout

- Flag: `QUOKY_NL_INTENT_MODE=off|shadow|active`, default `off`.
- **Shadow:** compare the selection with the actual deterministic route, without acting on it. Logs carry no content: entry id, grammar id, agree flag, latency.
- **Class B** (frozen now, kept as fallback, then retired):
  - `detectLookup` / `detectJiraListing`
  - `calendar-question`
  - the `mail-question` and `drive-question` list forms
  - the `help-intent` matcher
  - the QUAL-7 personal-data clauses
  - `isPersonalWorkSurface`
- A Class B grammar retires after 2 weeks active with at least 98% agreement. Until then a miss becomes a corpus case, never a new regex.

## 6. ADR-0120 decision points (draft)

| Point | Decision |
|---|---|
| D1 | Catalog and contributed entries |
| D2 | `INTENT_SELECTION` and provider eligibility |
| D3 | Selector I/O contract: one call, timeout, no retry |
| D4 | Validation, grounding, symbolic time |
| D5 | Reads only in wave 1; writes are suggestion-only; approvals unchanged |
| D6 | Dispatch point and Class A/B precedence by phase |
| D7 | Clarification, `lastSelection`, and the interpretation preference (see owner answer 3) |
| D8 | Egress and privacy |
| D9 | Honest chat and guard extension |
| D10 | Grammar freeze and retirement |
| D11 | Flag and content-free shadow logs |
| D12 | Corpus, gates, Strict eval |
| D13 | Jira window/role/status query (ADR-0100 D7 amendment) |
| D14 | Deps 35→36 (ADR-0032 ratchet) |

## 7. Owner answers (2026-10-12)

1. **Provider and scope.** "우선은 Claude CLI, 놓친 문장만으로 진행하되, 모델은 빠른 모델이니 하이쿠만으로도 대체가 되면 하이쿠만으로도 진행해도 좋아. 이번에 하이쿠 5.5가 발표되면서 하이쿠 성능도 좋아졌으니 …"
   → Only fall-through messages are sent. The provider is the Claude CLI. The selection model is Haiku by default, escalating to Sonnet only if the eval gate fails on Haiku. The model id is adapter configuration, not Core.

2. **Writes.** "1차는 조회, 쓰기는 조회 결과 보고 진행"
   → Wave 1 is reads only. NL-initiated writes stay suggestion-only, and the owner decides on them after seeing the wave-1 read results. They need a later amendment.

3. **Ambiguous meaning ("오늘 등록된 jira 이슈").** "사용자한테 한번 물어보고, 그 물어본 답이 캐시로 되어 특정 시간에는 계속 캐시 연결 → 주제로 넘어가면 좋을거 같은데"
   → Ask once, and remember the answer as an **interpretation preference** per actor and per ambiguity key (e.g. `jira.created-scope`).
   - While the preference is valid, reuse it without asking and go straight to the answer.
   - The orchestrator's proposal (presented to the owner): a 30-day TTL. Every answer shows the basis used in its first line (e.g. `기준: 내가 담당·보고자 / 오늘 생성`), and the owner can change it at any time ("아니 담당만"), which overwrites the preference.
   - The storage must need no DB migration in wave 1. Prefer existing per-actor durable metadata if it exists; otherwise ADR-0120 records the storage choice.

4. **Priority.** "다음 웨이브로 바로"
   → GOV-7 (ADR-0120) and NL-1 become the next wave, alongside BRF-3 and STO-1. GML-2 moves to W3. NL-2 follows the shadow data.

Defaults accepted without a separate question:
- Added latency p95 ≤ +3 s, 4 s timeout.
- Ambiguity gets one clarifying question, never chat.
- Grammar-hit shadowing (sending messages that a grammar already handled) needs a separate owner yes later.
