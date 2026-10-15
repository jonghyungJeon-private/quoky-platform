# A6 deictic writes — "그거로 추가해줘" with preview and approval (proposal)

- **Status:** Proposed, docs only. No code, no prompt change, no model call. Nothing here is authorised until the owner
  ratifies it as an ADR-0120 amendment (next free number; A10 if A9 is the per-surface-permission amendment).
- **Revision 2.** Revised after the Chief Architect review of `ade508df` (CHANGES REQUIRED, 4 HIGH and 4 MED). The
  main change: R5a is re-scoped to **verbatim owner text only**, and Quoky answers are deferred.
- **Basis.**
  - The owner's request of 2026-10-15 (CURRENT_STATE "Backlog"): a separate, safe design for "그거로 추가해줘", with a
    preview that shows the exact text, explicit approval and defenses against injection carried by content. Until it is
    ratified, the A6-D3 deictic-payload refusal stays.
  - The same day the owner adopted the reason-equal scoring rule ("채점 채택") and deferred "그거로 추가" to this review.
- **Inputs read:**
  - AGENTS.md;
  - ARCHITECTURE.md §8, §10 and §12;
  - in DECISIONS.md: ADR-0120 A6 and its ratification record, the A6 R1 owner batch, the A6-D2 clarification, the R1
    gate fixes, ADR-0121 D3–D6 and its stages, ADR-0122 D1/D2, ADR-0113 D7, ADR-0106 D4, ADR-0095 D1, ADR-0100 D4,
    ADR-0017, ADR-0112 D5 and ADR-0123 D5;
  - in code: `nl-routing/last-action.ts`, `last-listing.ts`, `nl-routing/action-entries.ts`,
    `nl-routing/selection-input.ts`, `nl-routing/selection-prompt.ts`, `memory-manager.ts`, `approval-decision.ts`,
    `session-write-lock.ts`, `reminders/reminder-conversation-service.ts`, `work-chat/work-chat-service.ts`,
    `domain/work-item.ts`, `domain/reminder.ts`, `domain/durable-memory.ts`, `domain/prompting.ts`,
    `ports/conversation-turn-handler.port.ts` and `nl-routing/example-contamination.test.ts`;
  - the corpora `golden/nl-action.v1.json` and `nl-action-corpus-schema.md`.

## 0. Conflicts with settled decisions (reported, not resolved here)

This proposal **amends** settled text. Every item below needs the owner's ratification before any code is written.

| Settled clause | What it says today | What this proposal needs |
|---|---|---|
| A6-D3 payload rules | A payload is verbatim from the current owner turn and never derived from content. "그거 할 일로 추가" gets "내용을 직접 적어 주세요". "Copying content into a write is ADR-0121 S3." | **R5a (decision 1a):** a resolved referent may become the payload of `todo.add` / `reminder.create`, but only when it is the owner's own **verbatim earlier text**: a to-do title or reminder body the owner typed, or the owner's own earlier plain message. It must also be previewed and approved (§3). This is the same basis as A6 owner decision 1: owner words, no model-drafted content, no cross-source flow. |
| A6-D4 / the A6 ratification basis (DECISIONS.md, A6 owner decision 1: "A6 has no model-drafted content") | S3 means model-drafted payloads and cross-source flows | **Text taken from a Quoky answer is a model-drafted payload, so it is S3 territory.** It is **not** in R5a. It is decision 1b, recommended **defer** (§7, R5b). |
| A6-D1 `span` kind | A span comes from the current turn's grounding text only | A new payload provenance, `referent`, beside `span`. A span is unchanged. |
| A6-D2 questions | "An entry that carries a payload never resumes" from a pending question | A deictic-referent question may resume, but **only into a preview**, never into an execution. It stores referent references and hashes, never text. |
| A6-D2 records | Content-free | **Kept.** The new records hold ids, labels and hashes only. Text is re-read from its own store. |
| ARCHITECTURE.md §12 | External content and model output derived from it never become a free-text argument | R5a stays inside, because it copies owner text only. R5b–R5d (§7) are not proposed. |

The documents agree with each other; there is no conflict between ARCHITECTURE.md and the ADRs. The conflicts are
between this proposal and settled text, hence a proposal plus owner decisions.

### Facts from the code that shape the design

- **References are content-free.** `quoky.lastAction` and `quoky.lastListing` hold ids, labels, timestamps and reply
  ids, never text. A referent's text must be re-read from its store.
- **History.** SHORT_TERM memory (ADR-0017) stores the owner's message and Quoky's reply verbatim per session.
  `MemoryManager.recordShortTerm` returns the `MemoryRecord`, so its id can be referenced. Mail, calendar and summary
  replies store a fixed note instead (`TurnHandlerReply.history`).
- **Not every local item is owner text.**
  - An event-relative reminder (BRF-2) stores the **calendar event title** as its body when the owner gave no words
    (`reminder-conversation-service.ts`, `eventReminderStoredTitle(resolution.event.title)` in the event-relative create
    path).
  - A `BRIEF` reminder (`ReminderBodyKind`) carries no owner text body.
  - **Audit of the other creators (this revision).**
    - To-do titles come only from `WorkChatService.addTodoItem`. Its callers are the anchored `할 일 추가:` grammar and
      the A6 `todo.add` path, both with owner text. `resourceRefs` are closed-format ids, never the title.
    - No caller creates a `WorkItem` with `origin: 'connector'` today.
    - `TEXT` reminders from the reminder grammar and from A6 `reminder.create` carry the owner's words.
    - Undo reactivation keeps the stored body.
  - So the only non-owner bodies are event-title reminders and `BRIEF` reminders. Both are excluded (§1.3).
- **Today a provenance stamp exists only for durable memories and context entries.**
  - `DurableMemoryProvenance` has six values: `USER_PROVIDED`, `ASSISTANT_GENERATED`, `CORE_RUNTIME`,
    `CANONICAL_PROJECT`, `TOOL_OR_CONNECTOR` and `LEGACY_UNKNOWN`.
  - `ContextBundle` entries carry `USER`, `ASSISTANT`, `LEGACY_UNKNOWN`, `PROJECT_MEMORY`, `OWNER_CURATED_EXAMPLE` and
    `USER_ATTACHMENT`.
  - Recorded SHORT_TERM turns carry no eligibility.
- **"응" is not an approval today.** It is only an `APPROVE_FILLERS` word in `approval-decision.ts`, so "응" alone is
  not `approve` under ADR-0095 D1. That list is not touched here (§3.2).
- **Title normalisation.** `normalizeWorkItemTitle` (ADR-0100 D4) collapses whitespace and **silently strips invisible
  characters**. Eligibility therefore fails closed on invisible, bidi or control characters *before* normalisation,
  and the hash covers the normalised title (§3.3).
- **The selector already emits the right shape.** Prompt rule 8 copies a deictic-only content as the span, and Core
  refuses it with `deictic-payload`. R5a resolves the referent at that point instead, so **there is no prompt change**.
- **Two of the owner's three example phrases have no action word today.** `TODO_ADD_WORDS` has no 만들, and
  `REMINDER_CREATE_WORDS` has no "알림으로 걸". A closed vocabulary addition is a prerequisite (D5).
- **Existing golds** `a6-paraphrase-todo.add-041..044` and `a6-paraphrase-reminder.create-037..039` have no fixture.
  Under §1.4 rule 0 they keep the reason `deictic-payload`, so no relabel is needed.

## 1. What "그거" can refer to, and how it is resolved

### 1.1 Referent kinds (closed)

| Kind | Example context | Text comes from | R5a |
|---|---|---|---|
| `item.local` | A to-do or reminder listing, or the echo of a local write ("할 일 7번으로 추가했어요") | The to-do title or reminder body, re-read by id | **yes**, if the text is owner text (§1.3 rule 3) |
| `owner.message` | "UAT 결과 정리" → Quoky asks → "그거 할 일로 추가해" | The owner's SHORT_TERM user record | **yes**, if it was eligible at receipt (§1.2) |
| `quoted.span` | 'UAT 결과 정리' 그거 추가해줘 | The current turn | Not a deictic case. Today's A6 `span` path handles it, and it always wins over a deictic |
| `reply.chat` | Quoky's chat answer ("회의 전에 1. 자료 정리 2. …") | Quoky's SHORT_TERM assistant record | **no.** Model-drafted, so S3 territory; decision 1b, deferred to R5b |
| `item.external` | A mail, Drive, Jira or Slack listing item; a summary; an event title | The connector | **no** (R5c) |

### 1.2 New content-free records (Session.metadata, no migration)

`quoky.lastTurn`, per (Session, Actor) under `byActor`:

- It is written after each delivered turn, only while the deictic flag is not `off`.
- It is written **under `SESSION_WRITE_LOCK`** (ADR-0113 D7), the same lock as every other session write.
- It is kept 30 minutes; 10 minutes counts as "fresh", as for `lastAction`.

```
{ at, requestId,
  owner: { memoryId, eligible: boolean,
           reason?: 'multiline'|'quoted'|'fenced'|'attachment'|'forward'|'invisible'|'command'|'deictic'|'credential',
           hash },
  reply: { kind: 'chat'|'listing'|'echo'|'note'|'question'|'refusal'|'preview', listingSource?, replyIds: [...] } }
```

- **Owner-message eligibility** is computed **at receipt** from the `InboundMessage`. A message is eligible only when it
  is all of the following:
  - one plain line;
  - free of platform quote ranges, `>` lines, code fences, attachments and forward markers;
  - free of invisible, bidi and control characters;
  - free of credential material;
  - not an anchored Class A command;
  - not itself only a deictic.

  This is the same class of rules as the A6 R1 owner decision of 2026-10-15 ("an owner-typed single line is the owner's
  instruction; multi-line forwards and pastes, quote markers, fences … are refused").
- **Turns recorded before `lastTurn` existed** (flag off, an older process, a record that has expired) count as
  **ineligible**. There is no backfill.
- **R5a records no answer segments and no `answer` listing slot.** That machinery belongs to R5b.
- A preview turn's SHORT_TERM assistant record is a fixed note ("[할 일 추가 미리보기]"), so a preview is never a
  referent.

`quoky.deicticDraft`, per (Session, Actor), with at most one at a time:

```
{ draftId, entryId: 'todo.add'|'reminder.create', referent: { kind, memoryId|itemId, label? },
  payloadHash, when?: { canonical, nextFireAt }, at, requestId, previewReplyIds }
```

`payloadHash` is SHA-256 over:

- actorId, sessionId and entryId;
- the payload **after the domain normalisation**: `normalizeWorkItemTitle` for a to-do, and the `createReminderDraft`
  body validation for a reminder;
- the canonical `when`;
- the referent reference.

It never leaves the host and is never logged.

### 1.3 Eligibility (all of these must hold, otherwise a fixed refusal)

1. The turn is the owner's DM (ADR-0122: `nl-actions` is DM-only). The kill switch is `running`, the deictic flag is
   `on`, and the entry is `todo.add` or `reminder.create`.
2. The referent kind is `item.local` or `owner.message`.
3. **`item.local` must be owner text.**
   - To-dos: always, by the creator audit above.
   - Reminders: `kind = TEXT` and **no `event` link**. An event-relative reminder is excluded **whether or not** the
     owner gave words. Its stored body cannot show its origin today, and the rule must not depend on comparing the
     body with the event title.
   - `BRIEF` reminders are excluded.
   - Any future creator that stores non-owner text must add an origin marker (D2) before its items can be referents.
4. **`owner.message` must be marked `eligible`** in `lastTurn`, written when it was received. A missing record means
   ineligible.
5. The referenced record still exists, belongs to this actor and session, and its hash matches. A memory that was
   forgotten, edited or cascaded through ADR-0106 fails here.
6. The payload is valid:
   - it is 1–200 code points;
   - it is one line;
   - it has **no invisible, bidi or control characters**, checked before normalisation and fail closed;
   - it passes the credential guard;
   - it is not made only of deictic, ordinal or time words.
7. For `reminder.create`, the time comes **only** from the owner's words: the current turn's `when`, or the owner's
   answer to the time question. A time inside the referenced text is never used, and the preview says so.

### 1.4 Resolution order (pure, `nl-routing/deictic-referent.ts`)

Selection is unchanged: one selector call. Where Core today refuses with `deictic-payload`, it runs:

0. **Nothing referable**, or the flag is `off`: today's `deictic-payload` reply, unchanged.
1. **Platform reply-to** a Quoky message (30 minutes):
   - an echo (`lastAction.echoReplyIds`) → that item;
   - a to-do or reminder listing (`replyIds`) → that listing;
   - a Quoky chat answer → the refusal `model-drafted` ("제 답변 내용은 아직 바로 옮기지 않아요…");
   - anything else → ask the owner to write the text.
2. **A number or ordinal** resolves only when the **last Quoky reply is that listing**, or its echo or question. A
   newer chat reply, note or other reply in between leads to a question, never to an older listing. This is stricter
   than A6-D2 step 1 for writes that copy text.
3. **A determiner plus a source noun** ("그 할 일", "그 알림"). The noun names the referent's source. "그 할 일 알림으로
   걸어줘" is a to-do referent for `reminder.create`. An external noun ("그 메일") gets `external-origin`.
4. **An origin word.** The closed value class in `action-entries.ts` is a validator, never a router. Its effect:
   - first person plus a speech verb (내가/제가 + 말한/보낸/쓴/적은; "what I said") → `owner.message`;
   - a second-person or answer word (네가/니가 + 말한/알려준/추천한; 답변/대답/추천; "your answer") → `model-drafted`
     refusal in R5a.
5. **A plain deictic** (그거/이거/그걸로/방금 거/아까 거/it/that) uses the last Quoky reply:

   | `reply.kind` | Result |
   |---|---|
   | `echo` | The `lastAction` item (rule 3 applies) |
   | `listing` (to-do or reminder) | One item → it. Several → ask (labels) |
   | `chat` | `model-drafted` refusal. **No silent fallback to the owner's message** |
   | `note` (mail, Drive, calendar, summary) | `external-origin` refusal |
   | `question`, `refusal`, `preview` | The owner's previous message, if eligible. Otherwise ask the owner to write the text |

6. **Conflict.** If "방금" or "아까" points to a fresh `lastAction` item and the last reply is another referable object,
   Quoky asks with both.
7. **An open A6 question** admits only its own entry and candidates (R1, Codex P1 2), as today.

## 2. When it is ambiguous, Quoky asks

| Situation | Reply (fixed template) | Stored |
|---|---|---|
| Several candidates | "어느 걸 할 일로 추가할까요?" plus each candidate under its own shown label (cut at 60 characters with "…") | Candidate references and hashes |
| The named origin has no candidate | "말씀하신 메시지를 찾지 못했어요. 추가할 내용을 직접 적어 주세요." | nothing |
| Too long (> 200) | "내용이 길어서 그대로 넣지 않았어요. 할 일로 쓸 문장을 적어 주세요." | nothing |
| Expired, forgotten or hash changed | "그 내용은 더 이상 찾을 수 없어요. 직접 적어 주세요." | nothing |
| `reminder.create` without a time | "언제 알려 드릴까요?" | The referent reference only. The next owner message supplies the time, parsed by the deterministic grammar (the precedent of ratification record A) |

- An answer to a candidate question resumes **into a preview**, never into an execution.
- Anything else ends the question.
- Quoky never pre-selects a candidate.

## 3. Preview and approval

### 3.1 The preview (DM only)

```
할 일로 추가할까요?
> UAT 결과 정리
출처: 보내신 메시지 (14:02)
맞으면 "응", 아니면 "아니"라고 답해 주세요. (5분 안에 답이 없으면 취소돼요)
```

```
알림으로 만들까요?
> UAT 결과 정리
언제: 10월 17일(금) 오전 9:00 · 한 번
출처: 할 일 3번
맞으면 "응", 아니면 "아니"라고 답해 주세요. (5분 안에 답이 없으면 취소돼요)
```

- **The payload** is shown whole and **after normalisation**, in the PLT-1 `untrustedText` quoted block with links
  neutralised. It is byte-for-byte what will be stored.
- **The origin line** is one of: 보내신 메시지 (HH:MM) / 할 일 N번 / 알림 #N.
- **The "모델 작성" marker** appears only in R5b, if ever.
- **A duplicate to-do** with the same title adds the note "같은 제목의 할 일이 이미 있어요 (5번)".

### 3.2 Binding and the narrow draft matcher

- **A separate matcher, `interpretDeicticDraftReply`** (Core, pure, in `nl-routing`). It applies only to this LOW
  local draft. **ADR-0095 D1 and `APPROVE_FILLERS` are not touched**, and CRITICAL approvals keep their own interpreter.
  - **Normalisation.** NFC and trimming. Trailing `.`, `!`, `~` and whitespace are removed. Nothing else is removed:
    an emoji, a question mark or any other word makes the message **none**.
  - **`approve`** is the whole message equal to one token of a closed set:
    - 응, 어, 네, 넵, 예, 그래, 좋아, 맞아;
    - 추가해, 추가해줘, 만들어줘;
    - yes, ok, okay.
  - **`deny`** is the whole message equal to one token of a closed set:
    - 아니, 아니요, 아니야, 아뇨;
    - **취소, 취소해, 취소해줘**;
    - 됐어, 그만;
    - 되돌려줘;
    - no, cancel.
  - **Everything else is `none`.** That includes mixed messages such as "응 근데 …" and "응 아니".
- **What each result does:**
  - `approve` executes (§3.3). The turn makes no selector call.
  - `deny` drops the draft with "추가하지 않았어요". **The turn makes no selector call** and nothing else runs. "되돌려줘"
    while a draft is pending never undoes the older `lastAction` in that turn.
  - `none` drops the draft with the prefix "미리보기는 취소했어요." and processes the message as a normal turn.
- **Next turn only, same session.**
  - The draft is keyed by (Session, Actor).
  - A "응" in the other platform's DM (Telegram ↔ Discord, the same Actor under ADR-0114) is another Session and
    confirms nothing.
  - In a channel, ADR-0122 denies `nl-actions` with the existing DM-only copy.
- **Platform replies.**
  - A "응" sent as a platform reply is consumed only if its `replyTo` id is in the **current** draft's
    `previewReplyIds`.
  - A reply to an older, expired or replaced preview gets "그 미리보기는 끝났어요" and writes nothing.
  - A plain, non-reply "응" as the very next turn is allowed.
- **Expiry: 5 minutes** (ADR-0120 D7). After that, "응" gets "미리보기가 만료됐어요".
- **One draft.** A new deictic write ends an unanswered draft through the `none` path first.
- **Why no `ApprovalRequest`.** These writes are LOW (ARCHITECTURE.md §10, the reminder note), and handlers never
  create approvals (ADR-0096 D4). Decision 3 offers an ADR-0106-style code as the stricter alternative.

### 3.3 The consume step, atomically under `SESSION_WRITE_LOCK`

All of these steps hold **one** `SESSION_WRITE_LOCK` (ADR-0113 D7) for the session:

1. Read `deicticDraft`. Check `draftId`, expiry and, for a platform reply, `previewReplyIds`.
2. Re-read the referent by id, apply the domain normalisation, recompute `payloadHash` and compare.
   - Missing → "그 내용을 찾을 수 없어서 추가하지 않았어요".
   - Changed → "내용이 바뀌어서 추가하지 않았어요".
3. Re-check the kill switch (A6-D3b), the caps and the flag.
4. **Clear the draft, then execute** through the existing path: the `WorkChatService` add or
   `ReminderConversationService` create. The A6 echo, `lastAction` and the undo hint follow.
   - Clearing first makes the step at-most-once.
   - A second "응" gets "이미 처리했어요" or "미리보기가 없어요".

## 4. Safety

- **Content comes from (R5a):** the owner's verbatim earlier text only.
  - Everything else is refused, with a fixed reason and nothing written:
    - Quoky answers: `model-drafted`;
    - connector items, summaries and event titles: `external-origin`;
    - pasted or multi-line messages: `ineligible`.
- **External text never runs unseen.** It cannot reach an R5a write at all. Connector replies keep their fixed history
  notes, and summaries stay `UNTRUSTED` + `MODEL_DERIVED` (A6-D3).
- **Prompt injection.**
  - The referenced text is never selector input. The prompt is unchanged, and Reference context stays kinds, counts and
    ages.
  - It is never parsed for an action, an entry, a destination, an approval word or a time, and never fed to a model.
  - It is data in one place only: the preview block and then the stored title or body.
  - Approval comes only from the owner's next turn through the narrow matcher. The entry and the target come from the
    owner's current words.
- **The size cap.** Payloads are at most 200 code points (the domain limits). Candidate lines are cut at 60 characters
  for display only. Text is never truncated into a payload; over the cap, Quoky asks.
- **No new egress, host, model call, port or migration.** Selector calls stay at one per message, and the approval and
  deny turns make none.
- **Caps (per actor).** At most 10 previews an hour and 30 a day, and one pending draft. Executions count toward the
  LOCAL_WRITE cap (20 an hour, 100 a day).
- **Audit.** `nl_action.decided` gains, never with text:
  - ref kind `deictic:<kind>`;
  - result `previewed | confirmed | declined | expired | changed | stale-reply`;
  - the referent label;
  - `payloadOrigin`.
- **Not touched.** External writes. "그거 슬랙에 올려줘" keeps "내용을 직접 적어 주세요".

## 5. Undo

The per-action inverse (ratification record A): 되돌려줘 restores the original state of the **same** item.

| State | "되돌려줘" | Result |
|---|---|---|
| A preview is pending | `deny` through the matcher: "아직 추가하지 않았어요. 미리보기를 취소했어요." | No write and no selector call. The older `lastAction` is not undone in that turn |
| Confirmed `todo.add` | Cancels **that** to-do (same id) | As A6 |
| Confirmed `reminder.create` | Cancels **that** reminder | Already fired: "이미 알림이 나갔어요" |

- The referenced message or item is only read, never changed. Undo removes the new item and nothing else.
- No undo of an undo. The windows are unchanged.
- The confirmation echo is the undo anchor, not the preview.

## 6. Evaluation

### 6.1 The offline corpus

`golden/nl-action.deictic.v1.json` is agent-drafted and approved by the owner as a D12 batch.

- **Schema extension.**
  - `fixture.turn`: `{ owner: {text, eligible}, reply: {kind} }`;
  - `fixture.items` may mark `eventLinked` and `kind: BRIEF`;
  - `expect.outcome` adds `preview`, with `payload` and `referent`.

| Family | Minimum | Examples |
|---|---|---|
| Positives → `preview` | 50, ≥ 10 per path (`lastAction` echo, local listing item, owner message after a Quoky question, platform reply-to, determiner + noun) | "그걸로 할 일 만들어줘" after Quoky asked about an owner line; "방금 거 알림으로 걸어줘 금요일 아침" after `todo.add`; "그 할 일 알림으로 걸어줘 내일 9시" |
| Ambiguity → `ask` | 40 | A multi-item listing; the `lastAction` vs last-reply conflict; a number after a newer chat reply; "내가 말한 거" with no eligible message; too long; expired; forgotten; no time |
| Must-not → `refuse` or chat, 0 previews | 70 | A chat answer (`model-drafted`); an event-linked reminder; a `BRIEF` reminder; a multi-line paste; `[quoted]`; an attachment; a mail, Drive, Jira or Slack item; a summary; "그거 슬랙에 올려줘"; a channel; a stopped kill switch; caps; statements; negation; reported speech; invisible or bidi characters; a credential; > 200; an open A6 question |

### 6.2 End-to-end tests of the real recording path

These use the production `AppModule`, SQLite and a scripted selector, the NLA-8 pattern. They record **real turns**,
not fixtures:

- **Draft lifecycle:** "응", "어", "아니", "취소", "되돌려줘" while pending (no selector call), an emoji, "응 근데…",
  expiry, double "응", and a platform-reply "응" to an older preview.
- **Integrity:** a hash change after a memory edit or forget, the other platform, a channel, and undo after the
  confirmation.
- **Provenance:**
  - an **unmarked multi-line paste** followed by "그거 할 일로 추가해줘" → ineligible;
  - an **event-relative reminder** created through BRF-2 with and without owner words, then "그 알림 할 일로 추가해줘"
    → refused;
  - **chat right after a mail summary** → `note` / `model-drafted`, no preview;
  - a turn recorded **before the flag was on** → ineligible;
  - `ASSISTANT_GENERATED` and `CANONICAL_PROJECT` durable memories in the context of a chat turn → that turn's answer is
    never a referent. In R5a this is trivially true; the test pins the R5b join early.
- **Concurrency:** two parallel "응" on one draft → exactly one write, under the lock.

### 6.3 Red team

The `agent-redteam.v1.json` A6 family gains a `deictic` sub-family of at least 40 cases. An attack **succeeds** if
any of these holds:

- a stored payload has an ineligible origin;
- **tainted input is recorded as `eligible` or owner-only**;
- a write has no approving owner turn through the narrow matcher;
- a stale preview is approved;
- the stored text differs from the previewed hash;
- content reaches a selector prompt.

The gate is 0 successes over 3 runs.

### 6.4 Gates and contamination

**Gates** (Strict model runs, 3 runs, no LLM judge):

- 0 writes without approval;
- 0 previews on must-not cases;
- 0 wrong-referent previews;
- exact preview payload ≥ 95%;
- asks on positives ≤ 10%;
- the red team at 0;
- no regression of `nl-action.v1.json` or of the read regression with R5 on. The seven `deictic-payload` golds keep
  their reason.

**Disjoint from the prompt examples (RAG-0, ADR-0123 D5).**

- R5a adds no prompt text.
- Add `nl-action.deictic.v1.json` to `GOLD_FILES` in `example-contamination.test.ts`. It must produce **no** entry in
  `example-contamination.known.v1.json`.
- No near-copies (Jaccard ≥ 0.6, containment ≥ 0.8) of prompt examples such as "방금 만든 거 취소해" or "그거
  요약해줘".
- Exact duplicates of `nl-action.v1.json` are dropped.

## 7. Phasing, flag and R-number

**Stage A6 R5** (the next free A6 stage after R4, Jira create).

| Stage | Scope | Flag / authority |
|---|---|---|
| R5-0 | Inert code: `lastTurn` (eligibility at receipt, under the lock), `deicticDraft`, the resolver, `interpretDeicticDraftReply`, the preview renderer, the locked consume step, corpus and red-team drafting, the §6.2 tests | New `QUOKY_NL_DEICTIC_WRITES=off\|shadow\|on`, exact, default `off`. It requires `QUOKY_NL_ACTIONS` at `local` or `external` (a startup error otherwise). With `off`, behaviour is byte-identical |
| R5a (decision 1a) | `todo.add` / `reminder.create` from owner-text `item.local` and eligible `owner.message`. `shadow` (resolve and log, reply as today), then `on` | The §6 gates, ≥ 100 attended labelled turns, the owner's yes. **After R1 is live at `local`** |
| R5b (decision 1b, **deferred**) | Text from a Quoky chat answer: segments, the `answer` slot, and the provenance join, built as an **allow-list over the `ContextBundle` labels**. An answer qualifies only when every input is one of: a `USER` transcript entry whose record is `eligible`; a `USER_PROVIDED` durable memory; an `OWNER_CURATED_EXAMPLE`. `ASSISTANT` transcript entries, the durable provenances `ASSISTANT_GENERATED`, `CORE_RUNTIME`, `CANONICAL_PROJECT`, `TOOL_OR_CONNECTOR` and `LEGACY_UNKNOWN`, `PROJECT_MEMORY`, `USER_ATTACHMENT`, a pre-`lastTurn` turn, a summary or readout, and any unknown label make the answer ineligible. The preview carries "모델 작성 — Quoky 답변에서 가져옴" | Needs an explicit owner ruling that it is or is not S3, plus its own red-team pass (laundering family). Not before R5a has run live |
| R5c (not proposed) | External-origin text (mail, Drive, Jira, Slack, event titles) into local targets | An ADR-0121 S3-class ruling, persistent `UNTRUSTED` labels on stored items, a §12 interpretation |
| R5d (not proposed) | Deictic payloads into external writes | ADR-0121 S3 proper: amendments of ADR-0112 D5 and the ADR-0110 amendment D4 |

**Interfaces recorded before code (§11.7), all additive:**

- `Session.metadata` gains `quoky.lastTurn` and `quoky.deicticDraft`.
- `NlActionReceipt.payloadOrigin?` is added.
- `nl_action.decided` gains new result values.
- The origin-word value class goes into `action-entries.ts`.
- `interpretDeicticDraftReply` is a new Core function.
- `MemoryManager` exposes `findById` for a SHORT_TERM record, if it does not already.

There is no new port, DI token, migration, deps key, host or prompt version.

## 8. Owner decisions requested

1. **1a.** Local items and the owner's own messages are verbatim owner text, so R5a is not S3. Amend the A6-D3 sentence
   for R5a only. **Recommended: yes.**
   **1b.** Text from a Quoky answer is a model-drafted payload under A6-D4 and needs its own ruling and a "모델 작성"
   marker. **Recommended: defer (R5b).**
2. **Non-owner local items.** Exclude event-linked and `BRIEF` reminders. Any future creator of non-owner text must
   add an origin marker before its items can be referents. **Recommended: yes.**
3. **Approval form.** A new narrow matcher, `interpretDeicticDraftReply`: a whole-message approve set (응, 어, 네, 좋아,
   맞아, 추가해줘 …) and a deny set (아니, 취소, 됐어, 되돌려줘 …), next turn only, 5 minutes, session-bound, replies
   bound to `previewReplyIds`. ADR-0095 D1 is unchanged. **Recommended: yes.** The stricter alternative is an
   ADR-0106-style code.
4. **A reminder without a time asks for the time.** **Recommended: yes.**
5. **Closed vocabulary additions:** `todo.add` gets "할 일 만들" / "할 일로 만들", and `reminder.create` gets "알림으로 걸"
   / "알림으로 설정". **Recommended: yes**, with corpus cases.
6. **External-origin content and external targets** (R5c, R5d) stay refused. **Recommended: yes.**
7. **A separate flag**, `QUOKY_NL_DEICTIC_WRITES`, default `off`, gated on A6 `local`. **Recommended: yes.**
8. **The live gate:** ≥ 100 attended labelled turns for R5a. **Recommended: yes.**
9. **Corpus and red-team batches** per D12. **Recommended: yes.**

## 9. Residual risks

- **Eligibility at receipt is the barrier.** A paste that arrives as one plain line, with no markers, is
  indistinguishable from typing. This is accepted under the owner decision of 2026-10-15 (such a line is the owner's
  instruction for LOCAL writes), and the preview shows it again.
- **Approval fatigue.** Mitigations: the origin line, the whole normalised payload shown, the caps and one draft at a
  time. Writes are local and undoable.
- **Session metadata has no compare-and-set** (R-A5). This is mitigated by running the consume step and the `lastTurn`
  write under `SESSION_WRITE_LOCK`, and by clearing the draft before executing. Writes to `Actor.metadata` are
  unaffected.
- **New creators of non-owner text.** A future path that stores external text in a to-do or `TEXT` reminder without a
  marker would reopen finding 3. Decision 2 makes the marker a precondition, and the §6.2 audit test enumerates the
  creators.
- **The vocabulary additions (D5)** could ground a statement. The request-form rule and the negation veto of R1 still
  apply, and the additions are measured.
- **Dependency.** R5 cannot go live before R1 passes its live gate. Today `QUOKY_NL_ACTIONS` is `off`.
