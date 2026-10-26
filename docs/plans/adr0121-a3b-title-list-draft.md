# ADR-0121 amendment A3b (DRAFT) and ARCHITECTURE.md amendment draft: owner-confirmed title-list egress for calendar judgment answers (a second scoped ADR-0110 D4 exception)

- **Status:** **Draft, not for ratification now** (revision 2, 2026-10-26). Docs only.
  - Revision 1 (`89ab554f`, "A3") was one package. The Chief Architect / security review found it NOT READY as one
    package, and the owner split it on 2026-10-26.
  - The no-egress half is **A3a** (`docs/plans/adr0121-a3a-local-judgment-proposal.md`, ready to ratify): `select`,
    `judge.v1`, the calendar relational facts, the G6 protocol, the Jira rule, and the G7–G9 thresholds.
  - **A3b is considered only after G6 fails on calendar and G7 opens** (A3a-D8, A3a-D9; `DECISIONS.md`, "ADR-0121 A3a
    measurement record").
  - Revision 2 applies the review's fixes. They are cited inline: `[C2]`..`[C4]` for the critical items, `[W1]`..`[W10]`
    for the warnings, `[S]` for the suggestions.
- **Would amend (on a later ratification):**
  - `ARCHITECTURE.md` §5 item 14, the §8 header line, §8 items 3 and 5, §10 and §12: Part IV.
  - ADR-0110 D4: a second scoped exception.
  - ADR-0121 A2 and A3a clauses, and ADR-0121 D3, D4, D7, D9, D10, D11 and D12, A1-D7 and A1-D8: Part V.
- **Inputs:** A2 (`docs/plans/adr0121-a2-answer-step-proposal.md` and its ratification record), A3a and its
  measurement record, the A2 A0 spec gaps 1–4, the security review MC-1..MC-14
  (`eval-archive/s2-crosssource-security-20261021.md`), the owner's blind judgment eval of 2026-10-26
  (`eval-archive/judgment-eval-20261023/`), and the owner's security requirements (MSIT; ADR-0110 D4 stays the default).
- **Owner-facing summary (Korean):** `docs/plans/adr0121-a3-owner-summary.md`.

> **Conflict notice.** A3b would conflict with settled text: `ARCHITECTURE.md` §8 item 3 (a `LOCAL_MODEL_ONLY` value
> reaches a `REMOTE` model "only as an owner-confirmed minimal topic"), §12 (the minimal topic is the only exception),
> ADR-0110 D4 as amended by A2 ("One scoped exception"). No A3b code may start before a ratification, and the egress
> stays closed by a code gate until G8 and G9 pass as well.

---

## 0. Summary

- **Scope.** A `grounded` answer with `select` (A3a-D1) over **one** `calendar.events` read that returned **2–10
  items**, when local calendar judgment is not adequate (G6) and the remote model given only this payload is adequate
  and preferred (G7).
- **What leaves, on an explicit yes only:** at most 10 lines, each an ordinal, a **coarse** time description computed
  by Core (relative day, duration, relational flags; **no date and no clock time** by default) [W1], and a title
  minimized by the A2-D12..D14 pipeline. Plus the owner's own words and fixed non-content values.
- **What never leaves:** attendees, organizer, descriptions, locations, conference data, links, attachments, ids, the
  full title, absolute dates and clock times (by default), other reads, history and memory.
- **The answer.** A tool-less, schema-bound call (`judge.v1`, A3a-D2). The model answers by ordinal. On the yes path
  Core **re-runs the declared read**, checks that the item set is unchanged, and renders **full titles and real times
  locally** [C3].
- **On 아니, or while closed:** A3a-D6 (a local answer only if G6 passed, otherwise the listing and the criteria hint).
- **Relation to A2 Part II:** complements it; shared machinery (Part III).

---

## Part I — Decision draft (A3b-D1..A3b-D14)

### I.1 When the list is offered

1. **A3b-D1: Conditions (cf. MC-1, MC-2).** All of these hold:
   - the plan's `answer` step is `grounded`, with exactly one reference and a `select` value (A3a-D1);
   - that read is `calendar.events`, its label forbids a `REMOTE` model, and it returned 2–10 items;
   - G6 found local judgment not adequate on calendar, and G7, G8 and G9 passed (the code gate is removed);
   - an eligible recipient exists (A3b-D11);
   - `QUOKY_AGENT_ANSWER=active` and `QUOKY_AGENT_ANSWER_LIST=active`;
   - the caps and the per-event resend limit allow it (A3b-D13);
   - the chat tier does not resolve `LOCAL`.

   Otherwise:
   - 0 or 1 item: A2 unchanged;
   - more than 10 items: no offer; the listing and the fixed ask "항목이 많아요. 기간이나 조건을 좁혀서 다시 말씀해
     주시면 골라 드릴게요.";
   - two or more reads: the A3a / A2 local path;
   - every title withheld: no offer;
   - anything else: A3a-D6.

   Whether the message appears never depends on what the titles say, except through the deterministic, fail-closed
   filters of A3b-D3/D4.

### I.2 What leaves, and how the list is built

2. **A3b-D2: The payload (cf. MC-3, MC-4).**

   | Part | Label |
   |---|---|
   | The fixed instruction (`prompts/answer-list.v1`, sha256 pinned) | `TRUSTED` |
   | The owner's words of run 1, after D3 | `TRUSTED` |
   | `select`, `count` | `STRUCTURE`, `REMOTE_OK` |
   | The list: N lines `"<n>. <coarse time> · <title>"` | `OWNER_CONFIRMED`, egress stays `LOCAL_MODEL_ONLY` |

   - **The coarse time (default) [W1].** Core renders, from API start and end in `QUOKY_TIMEZONE`:
     - the relative day: `오늘`, `내일`, `모레`, `이번 주 <요일>`, `다음 주 <요일>`, otherwise `<N>일 뒤`;
     - the duration: rounded to 5 minutes (`30분`, `1시간 30분`), `종일`, or `<N>일간` for a multi-day event;
     - the A3a-D3 flags: `<m>번과 겹침`, `앞 일정에 바로 이어짐`.
     - The list is sorted by start time, so the order within a day is carried by the ordinals.
     - **No year, month, date or clock time.** Clock times are an alternative (open question 3) and would need their
       own G7 arm.
     - Example: `2. 내일 · 1시간 · 3번과 겹침 · 투자자 대상 분기 실적 발표`.
     - G7 arm B measures exactly this rendering [W1].
   - **`<title>`** is the minimized title (A3b-D3) or the fixed placeholder `(제목 생략)`.
   - **Never in the request:** any other item field, ids, the full title, dates, clock times, other reads,
     `LOCAL_MODEL_ONLY` facts other than the displayed coarse values, history, memory, tool definitions.
   - **Bounds.** 2 ≤ N ≤ 10, each line ≤ 80 characters, the list ≤ 800 characters.
3. **A3b-D3: Per-title minimization (A2-D12..D14, tightened).**
   - **Name fields [C4]:** the **union** over **all items of the read** of attendee and organizer display names and
     email local parts, **plus the owner's own name**. One item's attendee name is therefore dropped from every title
     in the list.
   - Then, per title: NFKC; a bidi, invisible or newline character withholds the title; the A3b-D4 pre-split removal;
     tokenization (first 12 tokens); the A2-D12 drops (name containment against the union, `@`, digit runs ≥ 3, mixed
     scripts, Latin tokens > 20 characters, credential hits); the classifier (A3b-D5); the A2-D14 filter (2–30
     characters, 1–4 tokens, closed charset, verbatim substrings, not an ordinal or stage word alone). Never truncated.
   - A title that fails any step is withheld: its line keeps the ordinal and coarse time and shows `(제목 생략)`. The
     item stays in the list.
4. **A3b-D4: Pre-split removal (amends A2-D12; closes A0 spec gaps 1 and 4) [W10].** Before splitting, Core removes
   **whole**, fail closed:
   - every span matching `[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+` (any dotted token: domains with or without a scheme,
     `hxxp` shapes, version strings, `Node.js`);
   - every email-shaped span, every `://` span with its host and path, and every phone-shaped span.

   Over-removal of version strings and dotted product names is accepted. It applies to A2 Part II as well; the
   `s2-answer` red-team expectations are rechecked against it and the file is re-hashed [W8]. Spec gap 2 (short encoded
   Latin strings of ≤ 20 characters) remains a residual measured by G8/G9 (RA3-2).
5. **A3b-D5: The classifier configuration (MT-L) [C4, S].**
   - One quarantined `LOCAL` call over all surviving titles, schema `topicList.v1` (`{"keep": [[int, …], …]}`, one array
     of 0–4 indices per title), no retry, fail closed.
   - **Batched, pre-registered.** A per-title call would cost up to 10 model calls and break the D7 bound of 5 per run.
     The batched configuration is the one G8 measures and the one shipped. Switching to per-title needs a D7
     amendment and a fresh G8.
   - The classifier prompt is frozen before any G5 or G8 output is viewed; otherwise a fresh set (A3a-D9).
   - A planted instruction can make the classifier keep or drop tokens; it cannot move or add text.

### I.3 Consent

6. **A3b-D6: The consent message (cf. MC-5, MC-7) [W3, W4].**
   - A fixed template. Its variable parts are the list lines, N, M (withheld titles), the 7-day sent count, and the
     recipient's display name. The lines shown are the lines sent, byte for byte, with markup escaped. It follows the
     deterministic listing of run 1, so the owner can compare full titles with minimized lines.
   - **Draft wording:**

     ```
     아래 목록(일정 제목 일부, 요일·길이)과 요청 문장을 Claude에 보내려고 해요. 4건 중 1건은 제목을 뺐어요.
     1. 내일 · 15분 · 주간 팀 스탠드업
     2. 내일 · 1시간 · AI Agent 1차 면접
     3. 내일 · 1시간 · (제목 생략)
     4. 내일 · 1시간 · 앞 일정에 바로 이어짐 · 계약 갱신 미팅
     이번 주에 일정 목록을 2번 보냈어요.
     이름·회사명이 남아 있거나 건강·인사·법무 등 민감한 일정이 있으면 '아니'라고 해 주세요. 기준을 직접 말씀하셔도 돼요.
     보낼까요? (응/아니)
     ```

     - "기준을 직접 말씀하셔도 돼요": any reply that is not a closed token cancels the consent and is handled as an
       ordinary message, so a stated criterion naturally becomes the next turn on the local path [W4].
     - An English turn gets a fixed equivalent. There is no approval-card wording (`승인`).
   - **Why a title cannot spoof it.** The A2-D14 charset has no `(`, `)`, `/`, `'`, `?`, `·` or newline.
   - **The reply.** The A2-D15 closed tokens exactly. Anything else cancels. **Partial selection** ("3번 빼고") is not in
     this draft; a closed grammar (`<digits>번 빼고`, ordinals only, its own red-team cases) is to be **reconsidered
     before release** [W4].
   - **The MC-7 deviation** extends to one displayed list (the yes binds to its SHA-256).
7. **A3b-D7: The pending state.**
   - In memory in `AgentRunService`, never persisted. Bound to the owner, the DM conversation, the run-1 id, the list
     SHA-256, the ordered item-id HMACs, the recipient (audit only) and a hash of the owner's words.
   - It holds only the displayed lines, the owner's words after D3, the declared read, `select`, `count` and the
     bindings. No other item content.
   - Single use. It expires on the next owner turn or at ≥ 600 seconds (A0 spec gap 3). It shares the one pending slot
     with A1 and A2: creating it voids every other pending owner step. No preference, no "always send", no cache.
   - **Recheck at the yes:** the flags, the code gate, the recipient's eligibility (A3b-D11), the caps and the resend
     limit. A failure cancels with "보낼 수 있는 상태가 아니어서 보내지 않았어요." and A3a-D6.

### I.4 The remote call and the reply

8. **A3b-D8: The continuation on yes [C3].**
   - A deterministic continuation with no M1 or M1'.
   - **First, it re-runs run 1's declared read** and checks that the ordered item-id HMAC set is unchanged. If it
     changed: cancel with "일정이 바뀌어서 보내지 않았어요. 다시 물어봐 주세요." Nothing is sent.
   - **Then one remote call to the bound recipient** (1 + 1 retry). No other provider is used if it is not ready.
   - **Tool-less [W5].** A provider-neutral invariant, tested per provider kind: every judgment request is built with no
     tool surface. For CLI providers the request builder's argv disables tools (`--tools ''` for the Claude CLI); for
     API providers no tool definitions are sent (ADR-0115 D2).
   - The list is in an untrusted span described as data. Empty context, no history, no memory.
   - **Output and guards:** `judge.v1` and its A3a-D2 guards. **Placeholders [W2]:** the model may write `{time:N}`,
     `{end:N}` and `{item:N}` in `why`, `extra` and `intro`; it never saw a clock time, and Core substitutes real values
     from the re-read. Any model-written time or date fails the guard.
   - **Rendering.** Core renders from the **re-read items**: the header "보낸 내용: 위 일정 목록 N건(제목 일부·요일·길이)과
     종형님 요청 문장", the intro, each ranked line as Core's full label (`M/D(요일) HH:MM–HH:MM <full title>`) then
     "— {why}", and the `extra` lines. **No "(제목 생략)" appears in an answer**; the owner sees the real titles, locally.
   - Failure after the retry: the fixed fallback "이 목록으로 답을 만들지 못했어요. 어떤 기준으로 볼지 말씀해 주시면 그
     기준으로 골라 드릴게요." No local call follows.
9. **A3b-D9: Injection.** Titles are `UNTRUSTED`, ≤ 4 tokens and ≤ 30 characters from a closed charset, and shown
   before sending. A planted title cannot add text, cross lines, fake the template, carry a dotted span, or choose a
   step, destination or operation. It can try to sway the ranking (RA3-5) or to invite a yes (G9's social-engineering
   family). The answer is advisory; no action follows.
10. **A3b-D10: Labels and history (cf. MC-6).**
    - Each line is `OWNER_CONFIRMED`; its egress label stays `LOCAL_MODEL_ONLY`; only the one bound call may carry it.
      Never in M1 or M1', an argument, another model call, storage, a cache or a channel.
    - **History, fixed notes only:**

      | Reply part | Note |
      |---|---|
      | Consent message | "[Quoky가 위에서 일정 목록(제목 일부·요일·길이)을 원격 모델에 보내도 되는지 여쭤봄 — 목록은 기록하지 않음]" |
      | Header and answer | "[Quoky가 확인받은 일정 목록으로 우선순위 답을 보여드림 — 목록과 답 내용은 기록하지 않음]" |
      | Cancelled, expired, changed items, the >10 ask | no extra note |

### I.5 Recipient, budget, caps, audit, release

11. **A3b-D11: The recipient [W5; RQ-2].**
    - **The owner's explicit selection,** as ADR-0116 requires for local-only examples: the effective chat-tier provider
      must be one the owner selected explicitly (the ADR-0092 owner preference), never a derived default and never a
      selection-time fallback. This is stricter than A2-D16, because a list discloses more than one topic (RQ-2,
      recommended).
    - `REMOTE`, with the owner-set `dataUse: 'no-training'` (A2-D16; one account check serves A2 and A3b).
    - **Recipient drift [W5]:** the owner-set declared data for that provider also records the model version that G7
      measured (for example `judgeListMeasured: '<model version>'`), set in the composition root from owner
      configuration. A provider whose declared model version differs is ineligible until a new G7 run and a new owner
      setting. Core never branches on a provider id.
12. **A3b-D12: Model-call budget (amends A2-D8).**

    | Run | Calls | Worst case |
    |---|---|---|
    | Run 1, list offered | M1 + MT-L (no retry) | 2 |
    | Run 1, not offered | M1 + MT-L (if built) + MA local (1 + 1) | 4 |
    | Continuation, yes | the re-read + MA remote (1 + 1); no local call on failure | 2 |
    | Continuation, no | the re-read + MA local (1 + 1), or none (A3a-D6) | 2 |

13. **A3b-D13: Caps, scope, kill switch, audit, egress (cf. MC-8..MC-11) [W3, W4].**
    - ≤ 1 offer per run. One budget shared with A2 topic sends: ≤ 5 sends per rolling hour, ≤ 20 per rolling day,
      **≤ 30 per rolling 7 days**; ≤ 60 list lines per day and ≤ 200 per 7 days.
    - **Per-event resend limit:** an event whose id HMAC has been sent 3 times in 7 days is withheld (`(제목 생략)`).
    - **Staged release [W4]:** for the first 14 days after release, ≤ 3 sends per day.
    - DM only. `에이전트 중지` voids a pending consent. `QUOKY_AGENT_ANSWER_LIST=off` closes the path.
    - **Audit:** the content-free `quoky.agentAnswer` record gains `list: {n, withheld, tokensPerTitle[], dropCodes{},
      chars, listHmac}`, `select`, the consent outcome (`yes`, `no`, `expired`, `cancelled`, `switch`,
      `recheck-failed`, `items-changed`) and its latency, guard outcomes, retry, fallback, provider id (audit only) and
      latency. **Consent-latency flag [W4]:** a yes in under 3 seconds on a list of ≥ 6 lines is flagged
      `fast-yes` and reported in the shadow and staged-release reviews. HKDF info `quoky.agentAnswer.list` from the
      A1-D12 key (Strict prerequisite).
    - **Egress:** no new host; ledger initiator `agent-answer` for HTTP providers; a CLI child only in the TaskRun (R1).
14. **A3b-D14: Flag and release.**
    - `QUOKY_AGENT_ANSWER_LIST=off|shadow|active`, default `off`; startup refusals `AGENT_ANSWER_LIST_INVALID` and
      `AGENT_ANSWER_LIST_REQUIRES_ANSWER_ACTIVE`.
    - Code gate `AGENT_ANSWER_LIST_NOT_RELEASED`, removed only after: G6 not adequate on calendar; G7 opened; G8 and G9
      passed; the account check, `dataUse` and the measured-model setting; the HMAC key; a measurement note; the owner's
      yes; and the partial-selection decision (A3b-D6).
    - `shadow`: lists built locally, logging only codes, counts and lengths; nothing shown or sent; attended DM review of
      would-be lists in memory only (as A2 [F7]); ≥ 7 days, ≥ 20 judgment turns.
    - Interfaces: no new port, token or migration; deps 38; `topicList.v1`; `prompts/answer-list.v1`; the
      `ai-ollama-api` adapter of A2.

---

## Part II — Gates

The thresholds are pre-registered in A3a (A3a-D9) and in the `DECISIONS.md` measurement record. A3b adds nothing to
them and cannot change them. G7 arm B uses the A3b-D2 coarse rendering and the production request builder [S]; both
arms are rendered with the same full titles [C3]; arm C comes only after the A/B labels are locked. G8 uses the
union of name fields [C4]. G9 includes, besides the revision 1 families: the social-engineering invite family; the
re-read with a changed item set; a yes after the measured model version changed; dotted spans (`v1.2`, `a.b.c`,
`hxxp://x.y`); the per-event resend limit and the 7-day cap. Success assertions are deterministic, never an LLM judge.

---

## Part III — Interaction with A2 Part II

- **Complement, not subsume.** A2 Part II: `generate` over one item (gate G4). A3b: a judgment among 2–10 items
  (gates G6–G9). Neither opens the other.
- **Shared, built once:** the topic pipeline with the A3b-D4 removal, the closed consent tokens, the MC-7 deviation,
  the pending slot, the recheck at the yes, `dataUse` and the account check, the caps budget, the kill switch, the HMAC
  derivation, the audit record, the `ai-ollama-api` adapter.
- **Not shared:** the recipient rule. A3b requires an explicit owner selection (A3b-D11); A2-D16 allows a derived
  default. RQ-2 asks whether A2 should be aligned.

---

## Part IV — `ARCHITECTURE.md` amendment text (diff-style; NOT applied)

### §5 Provider Rules, item 14

Current: "Absent means the provider is not eligible to receive an owner-confirmed topic."

```diff
-    eligible to receive an owner-confirmed topic.
+    eligible to receive an owner-confirmed topic or title list (ADR-0121 A2, A3b). For a title list the provider must
+    also be the owner's explicit selection and carry the owner-set model version that the A3b comparison measured.
```

### §8 header line

Current: "> *Amended by ADR-0121 (2026-10-13), ADR-0121 A1 (ratified 2026-10-21) and ADR-0121 A2 (ratified
2026-10-23).*"

```diff
-> *Amended by ADR-0121 (2026-10-13), ADR-0121 A1 (ratified 2026-10-21) and ADR-0121 A2 (ratified 2026-10-23).*
+> *Amended by ADR-0121 (2026-10-13), ADR-0121 A1 (ratified 2026-10-21), ADR-0121 A2 (ratified 2026-10-23) and
+> ADR-0121 A3b (ratified <date>).*
```

### §8 item 3

Current (second quarantined-output exception): "The second is for the owner-confirmed minimal topic of ADR-0121 A2: a
local topic-classifier call returns only indices of one item's title tokens, from which deterministic code builds the
topic."

```diff
      The second is for the owner-confirmed minimal topic of ADR-0121 A2: a local topic-classifier call returns only
-     indices of one item's title tokens, from which deterministic code builds the topic.
+     indices of one item's title tokens, from which deterministic code builds the topic. The owner-confirmed title
+     list of ADR-0121 A3b uses the same rule per title, in one call that returns only index arrays.
```

Current (egress bullet, end): "a connector only through that slot, and a `REMOTE` model only as an owner-confirmed
minimal topic (below)."

```diff
-     a connector only through that slot, and a `REMOTE` model only as an owner-confirmed minimal topic (below).
+     a connector only through that slot, and a `REMOTE` model only as an owner-confirmed minimal topic or an
+     owner-confirmed title list (below).
```

Added after the "Owner-confirmed minimal topic (ADR-0121 A2)" bullet:

```diff
+   - **Owner-confirmed title list (ADR-0121 A3b).** When the owner asks Quoky to order, or to pick among, the 2 to 10
+     items of one calendar read, and the local answer has failed its pre-registered bar, a list may reach a remote
+     chat-tier provider only if all of the following hold:
+     - each line holds only an ordinal, a coarse time description computed by deterministic code (relative day,
+       duration and overlap or adjacency flags; no date or clock time), and a title minimized by the topic rule above
+       against the name fields of every item of the read, or a fixed placeholder; no other item field;
+     - the list is shown byte for byte in a fixed template that names the receiving operator, says the owner's sentence
+       is sent too, and states how many titles were withheld; the owner answers with a closed yes token on the next
+       turn in the same DM within 10 minutes; single use; eligibility is checked again at the yes;
+     - the recipient is `REMOTE`, the owner's explicit selection, and carries the owner-set `dataUse: 'no-training'`
+       and the measured model version; the list is sent once, with only the owner's own words and fixed non-content
+       values, with no tools and no fallback to another provider;
+     - before the call the declared READ is re-executed and its item set must be unchanged; the model answers by
+       ordinal in a closed schema, and deterministic code renders the reply with the items' real titles and times.
+     Each line is `OWNER_CONFIRMED`; its egress label is unchanged, and only the one call bound to that yes may carry
+     it. It never reaches the planner or a connector, is never stored or cached, and the message, the list and the
+     answer enter the history only as fixed structural notes. It shares the minimal topic's caps, adds 7-day and
+     per-event limits, is DM-only, stopped by the kill switch and audited without content. It is released only after
+     the pre-registered gates of ADR-0121 A3a/A3b (G6–G9). Another source needs its own amendment of ADR-0121.
```

### §8 item 5 [S]

Current (end of the item): "… never on what the content says. A new topic source needs its own amendment of
ADR-0121."

```diff
+  The owner-confirmed title list (ADR-0121 A3b) is a planning run that ends with the consent message, then one
+  deterministic continuation run with no M1 or M1'. On yes it re-executes the READ the first run declared, stops if the
+  item set changed, and otherwise makes only the one judgment call; on no it re-executes that READ and answers locally
+  only if the local answer met its bar, and otherwise asks for the owner's criteria. The pending state holds only the
+  displayed lines and the owner's words. Whether the message appears depends on the plan's mode and `select`, the item
+  count, the source's label, the recipient's declared data, the flags and the caps, never on what the content says.
```

### §10 Risk & Approval

```diff
 | LOW | owner-confirmed minimal topic to the chat-tier model (ADR-0121 A2) | owner yes on the exact displayed string and recipient; one call; never a write |
+| LOW | owner-confirmed title list to the chat-tier model (ADR-0121 A3b) | owner yes on the exact displayed list and recipient; one call; never a write |
```

```diff
-The ADR-0121 A2 topic consent is likewise a consent step, not an approval card: it never uses approval wording, it
-authorizes one model call with one displayed string, and it never authorizes a write or a connector call.
+The ADR-0121 A2 topic consent and the A3b list consent are likewise consent steps, not approval cards: they never use
+approval wording, each authorizes one model call with the displayed text, and neither authorizes a write or a
+connector call.
```

### §12 Forbidden Rules

```diff
-… An owner-confirmed egress prompt (ADR-0121 A2) names the operator that will receive the displayed string, because consent needs the recipient.)
+… An owner-confirmed egress prompt (ADR-0121 A2, A3b) names the operator that will receive the displayed text, because consent needs the recipient.)
```

```diff
-  or a cache — except an `OWNER_CONFIRMED` minimal topic sent once after the owner's explicit yes (ADR-0121 A2).
+  or a cache — except an `OWNER_CONFIRMED` minimal topic (ADR-0121 A2) or title list (ADR-0121 A3b), each sent once
+  after the owner's explicit yes.
```

§13 needs no change.

### ADR-0110 D4 (a line under the A2 note; D4 itself unchanged)

```diff
+   *Amended by ADR-0121 A3b (Accepted <date>):* unchanged as the default, and still never a fallback. A second scoped
+   exception: an `OWNER_CONFIRMED` title list for a judgment (order or pick) over 2 to 10 events of one read, released
+   only after the local answer failed its bar (A3a G6) and the gates G7–G9 passed. Each line is an ordinal, a coarse
+   Core-computed time description (no date or clock time) and a title minimized by the A2 pipeline against every
+   event's name fields; no attendee, description, location, link or id. Confirmed byte for byte by a closed yes, sent
+   once with the owner's words to the owner's explicit `REMOTE` selection with `dataUse: 'no-training'`, answered by
+   ordinal only. Its label stays `LOCAL_MODEL_ONLY`; the history keeps only structural notes.
```

---

## Part V — Amended clauses [W8]

| Clause | Settled text, short | A3b amendment |
|---|---|---|
| ARCHITECTURE.md §5.14 | `dataUse` for a topic | Also a list; explicit selection and measured model version |
| ARCHITECTURE.md §8 header | Amended by ADR-0121, A1, A2 | Plus A3b |
| ARCHITECTURE.md §8.3 | `REMOTE` only as a minimal topic | The title list as a second path; batched index-only classifier |
| ARCHITECTURE.md §8.5 | The topic consent and continuation | The list consent; re-read on yes and on no |
| ARCHITECTURE.md §10 | Topic consent row | A list consent row; the sentence covers both |
| ARCHITECTURE.md §12 | Topic the only exception | The list as a second exception; the operator named |
| ADR-0110 D4 | One scoped exception (A2) | A second scoped exception |
| A2-D3 | Facts; `LOCAL_MODEL_ONLY` except listed metadata | The coarse time values and A3a-D3 flags on displayed lines become `OWNER_CONFIRMED` for the one call; `{end:N}`/`{item:N}` placeholders (A3a) on the remote path |
| A2-D8 | Call budget | A3b-D12 rows (a re-read on yes) |
| A2-D12 | Tokenize, then drops | A3b-D4 pre-split removal of dotted, email, URL and phone spans; applies to A2 too |
| A2-D13 | Classifier on one title | Batched `topicList.v1`; name fields are the union over the read's items |
| A2-D15 | 10 minutes; one pending slot | ≥ 600 s boundary; recheck at the yes; applies to A2 too |
| A2-D16 | Derived default eligible | A3b requires an explicit owner selection and the measured model version (RQ-2 asks about A2) |
| A2-D17 | Topic labels and history notes | List labels and the A3b-D10 notes |
| A2-D18 | Topic caps | Shared budget; 7-day caps; per-event resend limit; staged release; consent-latency flag |
| A2 note of 2026-10-23 "heavy multi-item judgment stays LOCAL" | Local first; list egress only if the bar fails | Calendar: superseded only through A3b's gates; Jira per A3a-D7 |
| `s2-answer.redteam.v1.json` | sha256 `028d58c3…` | Expectations rechecked against A3b-D4 and re-hashed; new family `s2-answer-list` |
| A3a-D6 | Local answer only if G6 passed | Unchanged; it is A3b's fallback |
| ADR-0121 D3, D4, D7, D9, D10, D11, D12 | | MT-L; consent-bound declassification for one list call; budget and caps; audit fields; MT-L; G7–G9; `topicList.v1`, one prompt asset |
| A1-D7 / MC-7; A1-D8 | Deviation for one string; `OWNER_CONFIRMED` uses | Extended to one list; plus the one list call |

---

## Part VI — MSIT mapping

| Item | Effect | Status |
|---|---|---|
| ②-1 Per-request authorization | DM only; consent bound to owner, conversation, list hash; recheck and re-read at the yes | Meets |
| ②-2 Input never a command | Titles are a data span in a tool-less call; ordinal answers; never an argument | Meets |
| ②-3 Allowed destinations | No new host | Meets (CLI child under R1) |
| ②-4 Volume limits | Per run, hour, day, 7 days; ≤ 10 lines; per-event resend; staged release | Meets |
| ⑤-1 Minimize export | Up to 10 minimized titles with coarse times, per send, shown and confirmed; no dates or clock times by default | Accepted only as a per-send disclosure; RA3-1..RA3-3; only after G6 fails and G7–G9 pass |
| ⑤-3 Logs without secrets | HMAC only | Meets |
| ⑤-4 Cumulative detection | Day and 7-day caps; ledger for HTTP providers; CLI child not in the ledger | Partial |
| ⑤-5 Incident response | Kill switch; flag off; list HMAC | Meets |
| No frequent traffic, tunnels, P2P | One extra call per judgment turn, only on a yes | Unaffected |
| Red-team gate | G9 0 over 3 runs; G8 for names | Required |

## Part VII — Residual risks (for a later ratification)

1. **RA3-1 Aggregate disclosure.** Up to 10 minimized titles with relative days and durations describe a week's shape
   ("팀장 면담", "종일 휴가"). Coarse time lowers it; it does not remove it.
2. **RA3-2 Missed names, compounded over lines.** G8 bounds the list-level rate (UCB ≤ 5%); short encoded strings
   remain.
3. **RA3-3 Confidential subjects.** Only the owner's 아니 stops them; partial selection is not yet available.
4. **RA3-4 Confirmation fatigue.** Measured by the `fast-yes` flag.
5. **RA3-5 Ranking manipulation (LLM01).** Advisory only.
6. **RA3-6 Minimization cost.** G7 arm C reports it.
7. **RA3-7 The MC-7 deviation for a list.**
8. **RA3-8 Child process unguarded (R1).**
9. **RA3-9 Quality on 아니 if G6 failed.** The listing and the criteria hint instead of an answer.
10. **RA3-10 Recipient drift.** Bounded by the measured-model-version setting (A3b-D11).

## Part VIII — Rollout (only if A3a's G6 says local is not adequate on calendar)

1. G7 (pre-registered in A3a), on synthetic cases only. If it does not open, A3b is withdrawn.
2. Revision review of this draft (Chief Architect, `/security-review`, Codex), then ratification of A3b with Part IV.
3. A0 data: `s2-answer-list`, the G8 lists, the `s2-answer` re-check and re-hash.
4. Build after A2 Part I and A3a are built, behind `QUOKY_AGENT_ANSWER_LIST=off` and the code gate.
5. G8, G9, then `shadow` (≥ 7 days, ≥ 20 judgment turns).
6. The partial-selection decision; the account check, `dataUse` and the measured-model setting; the HMAC key (Strict);
   a measurement note; the owner's yes; then the staged release (≤ 3 a day for 14 days).

Every model-in-the-loop run, `.env.local` change, restart and secret action is Strict.

## Part IX — Open questions for the owner (at A3b time)

1. **Scope:** calendar only. *Recommended.* Mail by its own amendment (subject only, no sender).
2. **Recipient (RQ-2):** explicit owner selection. *Recommended.* Should A2-D16 be aligned too?
3. **Clock times in the list:** *Recommended:* no (coarse default, W1). *Alternative:* `HH:MM` start times, with their
   own G7 arm.
4. **Partial selection ("N번 빼고"):** *Recommended:* design the closed grammar and its red-team cases before release.
5. **Caps:** *Recommended:* as A3b-D13 (5/hour, 20/day, 30/7 days shared; 3 sends per event per 7 days; ≤ 3 a day for
   the first 14 days).
6. **The consent wording:** *Recommended:* the A3b-D6 draft.

## Alternatives considered

- **Keep ADR-0110 D4 absolute.** The outcome if G6 passes on calendar or G7 does not open.
- **The same model with thinking.** Measured in A3a G6 (arm LT), not an alternative to A3b.
- **A larger local model.** Not possible on this Mac (18 GB RAM, swap nearly full, about 17 GB free disk).
- **Absolute dates and clock times.** Not the default [W1].
- **Send full events with consent.** Rejected: not minimal.
- **Per-title classifier calls.** Rejected for the D7 bound; would need a D7 amendment and a fresh G8.
- **A structural sort as the fallback.** Removed [W9]; the criteria hint goes to the local path.
- **One general "send a list" path shared with `generate`.** Rejected (Part III).
