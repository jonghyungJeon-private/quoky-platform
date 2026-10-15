# A6 reference priority — newer listing vs fresh lastAction (analysis and proposal)

- **Status:** Proposed, docs only. No code, no prompt change, no model call. Nothing here is authorised until the owner
  ratifies it as an ADR-0120 A6-D2 clarification.
- **Basis:** the v5 backlog item "newer listing vs fresh lastAction priority".
- **Read at:** `origin/main` (0b1bf5d5), draft PR #230 (`claude/v5-todo-snapshot`) and
  `docs/plans/a6-deictic-write-proposal.md`.
- **Paths** below are relative to `packages/core/src/application/`.

## 1. How the code orders these today

### 1.1 The state and its clocks

| Record | Key | Window | Evidence |
|---|---|---|---|
| Listing slots | `quoky.lastListing`, one slot per source (todo, reminder, mail, drive, ...) | 30 min per slot (`LAST_LISTING_TTL_MS`); 24 h only for reply-to-pick | `last-listing.ts:30`, `:34`, `:155` |
| `mostRecent` | the slot with the greatest `at` across sources | derived on read | `last-listing.ts:517-527` |
| `lastAction` | `quoky.lastAction`, one record per (Session, Actor) | `fresh` 10 min (`LAST_ACTION_TTL_MS`); kept 30 min for reply-to-echo | `nl-routing/last-action.ts:23-25`, `:103-109` |
| Undo | `resolveUndo` | `lastAction` only, `fresh` (10 min); a platform reply to the echo works for 30 min | `nl-routing/item-reference.ts:183-201` |
| referenceContext | one line: `last listing: ...; older listings: ...; last action: ...` | listing 30 min, `lastAction` only while `fresh` | `nl-routing/item-reference.ts:213-228`, built at `nl-routing/nl-selection-service.ts:1530` |

- `referenceState` reads all three on every turn (`nl-routing/nl-selection-service.ts:963-976`).
- The echo of a write is recorded as a `merge` labelled listing, and `merge` sets the slot's `at` to `now`
  (`last-listing.ts:453-499`, `at: now` at the end). So **a local write bumps its own source's slot to the same instant as
  `lastAction.at`.** Any "which is newer" comparison must account for that.

### 1.2 The resolution order (`resolveItemReference`, `nl-routing/item-reference.ts:114-170`)

1. Source-noun cross-check first (`:119-124`): another or several source nouns ask `other-source`.
2. Reply-to-pick names its listing (`:126-134`).
3. Reminder digits ("알림 3번") use the display number `#N`, not the listing (`:137-149`).
4. `recent` and `this` (`:151-165`): a fresh, not-undone `lastAction` of the entry's source **wins**. The only check
   against a listing is a *single-item* listing of the same source with a different id, which gives `conflict`
   (`:153-161`). Otherwise the most recent listing (same source, one item) or ask.
5. `index` and `last` (`:166-169`): **the most recent listing only**. Another source there asks `other-source`
   (`:168`). `lastAction` is never consulted.
6. Undo (`:183-201`, caller `nl-routing/nl-selection-service.ts:1068-1085` and `:1171-1192`): `lastAction` only, listings
   are never read. A number or source noun that disagrees with the record's label or source asks (`:1073-1084`).

`recent` ("방금 거") and `this` ("그거") are one branch (`:151`). The selector's `ref` kind is the only difference
between a recency word and a plain deictic, and Core treats them the same.

### 1.3 The three cases

**(a) Complete a to-do, list reminders, then "그거 취소해".**
- The complete writes `lastAction{todo}` and a merged todo slot at T. The reminder listing makes a reminder slot at T+2,
  which is now `mostRecent`.
- If the selector picks `reminder.cancel`: `lastAction` is another source, so it is skipped and `mostRecent` is the
  reminder listing. One item resolves it, several ask (`:162-164`). Safe.
- If the selector picks `todo.cancel` (the referenceContext line shows both, and nothing tells it which is newer): the
  fresh todo `lastAction` wins at `:155` and `:160`, **although the owner has since looked at another list**. The target
  is the to-do just completed. `mostRecent` is a reminder slot, so `single` is `undefined` and the `conflict` check at
  `:157` cannot fire.

**(b) List to-dos, something else happens, then "2번 완료".**
- `index` goes to `:166-169`. A reminder firing writes no listing, so the to-do listing stays `mostRecent` and "2번" is
  the label the owner saw. Safe.
- Another source's listing in between (or a write that bumps another slot) gives `other-source`, even when the owner said
  nothing that points away from the to-do list. That fails closed and is the A6 R1 decision ("an older mail listing behind
  a newer Drive listing is never used").
- `lastAction` is not consulted for numbers, so "2번" is never hijacked by a newer action. Safe.
- The anchored grammar ("N번 완료", `work-chat`) is a different path. With PR #230 it resolves N against the **to-do slot**
  (`options.todoListing`, `work-chat-service.ts:281-290` on the branch), not against `mostRecent`. See §4.

**(c) "되돌려줘" after a newer listing.**
- `resolveUndo` ignores listings. It undoes the fresh `lastAction`, or says `stale` after 10 minutes, `undo-of-undo`, or
  `no-action`. This is already the undo principle. Safe.

### 1.4 Real bug found

**B1 — `this` and `recent` ignore a newer listing of the same or another source.** (`nl-routing/item-reference.ts:153-161`)
- Case (a) with the selector choosing the to-do entry resolves "그거" to the to-do the owner completed before looking at
  the reminder list. At execution the handler's re-read (owned, actionable) will probably refuse a completed to-do, so
  the owner sees a confusing "not actionable" reply instead of a question. A re-completable or reopened item would be
  written.
- Same-source variant: complete to-do 3, list to-dos (5 items, newer), "그거 완료" completes **3** and never asks about the
  five on screen. The only guard is the single-item `conflict`.
- Not a corruption bug and not reachable while `QUOKY_NL_ACTIONS` is off, but it breaks the A6-D2 rule that "그거" means what
  the owner is looking at. The existing test (`nl-routing/item-reference.test.ts:136-151`) only covers a *single-item*
  listing and `lastAction` older than the listing is not exercised.

Not bugs, but gaps:
- **G1.** `recent` and `this` are not distinguished, so "방금 거" and "그거" get one priority.
- **G2.** The referenceContext line gives ages but no order, so the selector cannot tell a newer listing from a newer action
  when choosing the entry's `source`.
- **G3.** No test covers a `lastAction` older than a newer multi-item listing, a cross-source newer listing, or ties.

## 2. Proposed priority rule (safe)

Applies to A6 selections (`resolveItemReference`, `resolveUndo`). It never widens a write: every change only turns a
resolution into a question, or keeps today's result.

| Words | Resolves to | If it cannot |
|---|---|---|
| 1. Platform reply-to | The listing or echo it points at (unchanged) | ask |
| 2. **Explicit number or ordinal** ("2번", "두 번째", "마지막") | **The listing the number belongs to.** The entry's source slot, as long as the owner's words give no other source. Never `lastAction` | `out-of-range`, `other-source`, `none` (unchanged) |
| 3. **Recency word** ("방금 거", "아까 거", "just now") | The fresh `lastAction` of the entry's source (unchanged). If a **newer listing of another source** is the owner's latest view, ask | `conflict` |
| 4. **Plain deictic** ("그거", "이거", "그 중에서") | The most recent salient thing **by timestamp** (§2.1). Equal or unordered ties ask | `conflict` or `ambiguous` |
| 5. **Undo** ("되돌려줘", "취소 취소", `되돌리기`) | **Always `lastAction`**, by the per-action inverse on the same item. Never a listing, never a newer item | `stale`, `no-action`, `undo-of-undo`, `echo-mismatch` (unchanged) |

### 2.1 Salience by timestamp (rule 4, and the ordering part of rule 3)

Let `A` be the fresh, not-undone `lastAction` of the entry's source, and `L` the most recent listing slot of **any** source.

- Ignore the slot that the action's own echo wrote. It is `L.source === A.source && L.requestId === A.requestId`
  (`last-action.ts` already stores `requestId`; the slot has one, `last-listing.ts:491-497`). Without this the echo's
  `merge` always ties with `A` (§1.1).
- `A` is newer than `L` (or `L` is absent or the echo): resolve to `A.itemId`, as today.
- `L` is newer than `A`:
  - `L` is the same source and has one item: resolve to that item. If it differs from `A.itemId`, `conflict` (as today).
  - `L` is the same source with several items: **ask**, with `L`'s candidates under their shown labels (`ambiguous`). This
    is B1's same-source variant.
  - `L` is another source: **ask** (`other-source`, naming `L`'s source). This is B1's case (a). Quoky does not guess that
    "그거" meant the older action.
- `A` and `L` within the same second, not the echo: ask. A tie is never broken in favour of the write.

Rule 3 keeps "방금 거" bound to the last thing Quoky did, because "방금" is about Quoky's action, so only the
**cross-source newer listing** and **multi-item newer listing** cases ask. A recency word is never rebound to a listing item.

### 2.2 Numbers (rule 2) — what stays and the one open question

- Numbers never fall back to `lastAction`, and never to an older listing (A6 R1, kept).
- Reminder digits keep resolving by the display number `#N` (unchanged).
- **Open owner decision (O1):** with the owner's own matching noun ("2번 할 일 완료") and a newer listing of another source,
  today asks `other-source`. Rule 2 could instead use the to-do slot. It is safe (the noun names the source, the label is
  the one shown). It changes the R1 stance "most recent listing only", so this proposal **keeps today's behaviour** and
  only lists it. Recommended: keep, revisit after live data.

### 2.3 referenceContext (G2, no prompt text beyond the line)

Keep the structural line, but make order explicit and content-free, for example
`...; last action: todo.complete (3 min ago, undoable); newest: listing reminder`. `newest` is one of `listing <source>`,
`action`, `none`, computed by §2.1. This is an ADR-0121 D4 `STRUCTURE` label (no ids, titles or subjects). It changes the
selector prompt, so it needs the usual prompt-version bump and corpus run. It is optional: Core's rule in §2.1 is what
makes the result safe, so the line can wait.

### 2.4 Windows

No TTL change. Listing 30 min, `lastAction` 10 min fresh, 30 min for reply-to-echo, undo 10 min and 30 min by reply. After
10 minutes a "그거" no longer sees `lastAction`, so a plain deictic falls to the listing, or `stale`. That is the existing
behaviour and is consistent with the rule: a recency word needs a fresh action.

## 3. Tests to add

`nl-routing/item-reference.test.ts` (pure, no model):
1. `this`, todo `lastAction` at T, multi-item todo listing at T+1: `ambiguous` with the listing's candidates (B1 same source).
2. `this`, todo `lastAction` at T, reminder listing at T+2, entry `todo.cancel`: `other-source` with `found: reminder` (B1 case a).
3. Same as 2 with entry `reminder.cancel`: resolves from the reminder listing when one item, `ambiguous` when several.
4. `recent` ("방금 거") with the same state as 1 and 2: same-source multi-item newer listing asks; cross-source newer listing
   asks; **no newer listing** resolves to `lastAction` (unchanged).
5. `this` with `lastAction` newer than the listing: resolves to `lastAction`.
6. Echo exclusion: `lastAction` and its own merged slot (same `requestId`, same `at`) resolve to `lastAction`, not a tie.
7. Tie within one second, listing not the echo: asks.
8. Number rules: "2번" with `lastAction` newer than the to-do listing resolves from the listing; a newer other-source listing
   gives `other-source`; "2번" is never taken from `lastAction`.
9. Undo: a newer listing of any source, a newer other action in another session or actor, and a reminder firing leave
   `resolveUndo` on the same `lastAction`; after 10 minutes `stale`; a reply to the echo within 30 minutes resolves; after an
   undo `undo-of-undo`.
10. Expiry boundary: `lastAction` at 9:59 and 10:01 against a listing at 29:59 and 30:01.

`nl-routing/nl-selection-service.test.ts` / `apps/quoky/src/personal-v5-a6-acceptance.test.ts` (fake provider, no model call):
11. Case (a) end to end: "할 일 완료" then a reminder listing, then a selector output `todo.cancel` with `ref: this` →
    question, **no write**, `quoky.lastAction` unchanged.
12. Case (b): list to-dos, an unrelated reminder firing, "2번 완료" completes the item shown as 2.
13. Case (c): complete, list reminders, "되돌려줘" reopens the same to-do id, not a copy, and the audit target equals the
    `lastAction` item.
14. referenceContext rendering with `newest` (only if §2.3 is adopted), and a content-free assertion (no id or title).

Golden corpus: add rows with fixture state for 1, 2 and 11 to `golden/nl-action.v1.json`, expecting `asked` and the reason
`other-source` or `ambiguous`.

## 4. Consistency with PR #230 (to-do snapshot)

- **Same store.** #230 reads and writes the to-do slot of `quoky.lastListing` (the same record, 30-minute TTL, per session
  and actor). It adds no clock. So the timestamp comparison in §2.1 sees its snapshots without change.
- **Drift lists refresh `at`.** When #230 answers a drift it shows the current list and records it as the new snapshot. That
  list is the owner's newest view, so under §2.1 it correctly outranks an older `lastAction` for "그거".
- **Labels never renamed, undo reopens the same id.** This matches rule 5: undo is the per-action inverse on the same item.
- **One difference to record, not to fix here.** The anchored "N번 완료" resolves against the **to-do slot**, whereas the
  A6 index path uses `mostRecent` and asks `other-source` when another source is newer. The anchored words name the to-do
  list by grammar ("할 일 N번", "완료 처리: N"), which is rule 2 with the source known, so this is the O1 behaviour
  already. It is safe and stays. The A6 path stays stricter.
- **No conflict with the HOLD.** This proposal needs no #230 change and #230 needs none from it. Merge order is free.
- Whichever lands first, `receiptLabel` must keep writing the echo with a `requestId` so the §2.1 echo exclusion works.
  A short check is needed on the branch before implementing.

## 5. Consistency with `docs/plans/a6-deictic-write-proposal.md`

- **Same direction, narrower scope.** That proposal orders referents by the **last Quoky reply** (`quoky.lastTurn.reply.kind`)
  for writes that copy text. This one orders **state records** (listing slots and `lastAction`) for the A6 actions that
  target an existing item. They do not overlap: a copied payload (`todo.add` / `reminder.create` with "그거로") is the
  other document's.
- **Rules that agree.**
  - Its rule 2 (a number after a newer chat reply asks) is the same stance as rule 2 here: a number belongs to its listing
    and never to another record. Its version is stricter for payload-copying writes, and that stays.
  - Its rule 5 sends an `echo` to the `lastAction` item and a one-item listing to that item, several to ask. §2.1 gives the
    same result.
  - Its rule 6 asks when "방금" or "아까" points to a fresh `lastAction` and the last reply is another referable object.
    §2.1 is the same ask, expressed on state records rather than on the reply kind.
- **A real difference.** The deictic proposal binds a recency word and a plain deictic to the **last reply**, so a newer
  chat answer blocks both. §2.1 binds a plain deictic to the newest **listing or action**, and a recency word to the action
  unless a newer listing exists. For a copied payload the stricter reply-kind rule wins (it must, since a chat answer is
  model-drafted). Keep both: the strict rule for copying text, this rule for targeting an item.
- **Shared helper.** Both need "newest referable thing, ties ask". Implementing §2.1 as a pure
  `nl-routing/reference-recency.ts` (inputs: `lastAction`, listing record, `now`) lets the deictic resolver call it for
  rule 5 instead of a second ordering. `quoky.lastTurn.at` would then be one more input.
- **No ratified text is touched.** §2.1 is an A6-D2 clarification (resolution step 3). The deictic proposal's A10 can cite it.

## 6. Owner decisions

1. **Approve §2.1** (a newer listing makes "그거" ask, a tie asks, "되돌려줘" stays lastAction-only). Recommended: yes.
2. **O1:** keep "most recent listing only" for numbers even when the owner's noun names an older source. Recommended: keep.
3. Whether to add `newest` to the selector line (§2.3). Recommended: later, after the Core rule is live.
4. Implementation: one small PR (`reference-recency.ts`, `resolveItemReference` step 4, tests 1-13). It touches no prompt
   unless decision 3 is yes. It needs `QUOKY_NL_ACTIONS` on to be observable, and a Codex review (the resolver is the
   write-safety boundary).
