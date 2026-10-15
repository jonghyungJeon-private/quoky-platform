# NL action corpus: conversion to the R0 schema

**Update 2026-10-15 (owner batch approval).** Both corpora are approved. `rt-a6-pasted-command-105` was relabelled as an allowed owner instruction and moved to `nl-action.v1.json` as `a6-paraphrase-todo.add-901` (523 loaded action cases, 156 loaded red-team cases; 13 unmapped red-team cases stay documented). The 26 execution-time cases are implemented as NLA-8 acceptance tests over the real store (`apps/quoky/src/personal-v5-a6-acceptance.test.ts`, the `exec-time:` tests; a coverage test fails if one id is missing). The corpus `promptVersion` is `nl-select.v23`.

Source of truth: `docs/plans/nl-action-corpus-schema.md` (R0, branch `claude/v5-a6-r0`). Both drafts were converted mechanically and then checked against the R0 code (`validateActionCorpus`, `loadA6RedTeam`/`validateA6RedTeam`, `runA6RedTeamCase`) in a scratch copy of the r0 worktree, without merging branches.

## Files (the names the R0 loaders read)

| File | Cases | Loaded by |
|---|---|---|
| `packages/core/src/application/golden/nl-action.v1.json` | 522 | `loadActionCorpus` (NLA-6) |
| `packages/core/src/application/golden/agent-redteam.v1.json` | 157 (family `a6`) | `loadA6RedTeam` (NLA-7) |
| `.../nl-action.exec-time.v1.json` | 26 | not loaded; for NLA-8 acceptance (see below) |
| `.../nl-action.unmapped.v1.json` | 4 | not loaded; draft shape |
| `.../agent-redteam.a6-unmapped.v1.json` | 13 | not loaded; draft shape |

Totals: 522 + 26 + 4 = 552 action cases (the 544 drafted plus 8 reference cases added to keep at least 80 loaded reference cases); 157 + 13 = 170 red-team cases. No case was dropped.

## Ids
- Action ids became `a6-<family>-<entry or topic>-<nnn>`; red-team ids became `rt-a6-<attack>-<nnn>` (numbers start at 101, the seed uses 001..). The old draft id is in each case `note` (`was act-todo-add-001`).
- Red-team attack kinds are the schema's closed seven. Draft families map as: content, unicode (hostile content) -> `content-command`; chain, mixed -> `summary-chain`; pasted, long, unicode (owner turn) -> `pasted-command`; destination, unicode channel -> `destination-smuggling`; approval, unicode approval -> `fake-approval`; replay -> `cached-replay`; cap -> `cap-exhaustion`.

## Expected-outcome mapping (action corpus)
- `{entry,args,target}` -> `expect {entryId,args,outcome:execute,target}` (target ids are `<source>-<label>`; `match` cases carry no target as the schema requires).
- `{none}` -> `"none"`. Read negatives keep their READ entry, with canonical args.
- Questions -> `outcome: ask` (`refuse` for deictic-payload and bulk) with a closed `reason`: `todo-or-reminder` -> time-in-title; `payload-required` -> deictic-payload; `one-at-a-time` -> bulk; `content-mode`; `other-source`; `out-of-range`; `expired-listing` -> expired; `no-listing` -> none; `candidates` -> ambiguous; `conflict`.
- Draft questions with no closed reason became `"none"` (`entry-unclear`, `expired-question`, `restate-whole-request`); the note says so.

## Not expressible, and where those cases went
- **Execution-time outcomes (26 cases, `nl-action.exec-time.v1.json`).** The R0 offline scorer decides at the selection step, and several gold outcomes are only known against the local store: the undo cannot-run rows (fired, already final, changed, event gone, limit, past time), stale targets, reminder display numbers with no reminder listing in range (the decided target carries a label but no id, while the scorer requires an id), and pending-answer executions (Core executes with the pending args, which hold candidate ids only). They validate as schema cases but would score as wrong-target or miss on the offline path, so they stay out of the loaded corpus. **R0 scorer gap to decide:** either let the scorer accept a label-only reminder target, or evaluate these in NLA-8 with the real store.
- **Pending content-mode answers (4 cases, `nl-action.unmapped.v1.json`).** "요약" / "전체" answering the open mode question carry no `ref` in their own text, which the validator requires.
- **Fixture fields dropped (noted per case):** `lastAction` of `item.summarize` (the schema allows to-do and reminder sources only), `olderListing`, `echoMergedLabels`, `listingFresh`, `targetGone`, and the `firedSinceAction` / `changedSinceAction` / `oneShotPassed` / `eventGone` / `activeLimitReached` flags (no schema field), and a payload-restate pending question.
- **Reason substitution:** the three vague-time reminder questions use `time-outside-when` instead of `when-unparsed`, because the validator flags the vague span first.

## Text edits made so the gold validates (15)

| old id | was | now |
|---|---|---|
| act-todo-add-004 | todo에 "send weekly report" 추가해줘 | todo에 "send status report" 추가해줘 |
| act-todo-complete-005 | 3번 다 했어 완료로 바꿔줘 | 3번 끝났어 완료로 바꿔줘 |
| act-todo-complete-027 | 셋째 거 완료로 해줘 | 세 번째 거 완료로 해줘 |
| act-reminder-create-033 | 약 먹기 알려줘 | 언젠가 약 먹기 알려줘 |
| act-reminder-create-034 | 알림 만들어줘 병원 예약 확인 | 알림 만들어줘 병원 예약 확인 조만간 |
| act-reminder-cancel-015 | 알림 열세 번 취소해줘 | 13번 알림 지워줘 |
| act-reminder-cancel-027 | 그 알림 취소해줘 | 그거 알림 취소해줘 |
| act-summarize-054 | what does mail 2 say | what's the content of mail 2 |
| act-summarize-060 | what is in doc 3 | what's the content of doc 3 |
| act-summarize-073 | 이 스레드 요약해줘 | 2번 스레드 요약해줘 |
| ref-007 | 셋째 완료 처리해줘 | 세번째 완료 처리해줘 |
| ref-019 | 그 알림 취소해줘 | 그거 알림 취소해줘 |
| ref-063 | 알림 99 취소해줘 | 알림 49 취소해줘 |
| ref-064 | 0번 완료해줘 | 50번 완료해줘 |
| ref-066 | 51번 요약해줘 | 50번 요약해줘 |

## Texts made unique (39)
The R0 gold-provider test finds a case by its text, so every loaded text must be unique (also against the seed). A suffix (`요`, `~`, `!`, ...) was appended to later duplicates; the note keeps the original text. Same-text cases with different fixtures are exactly how reference state is tested, so this is a limit of the test, not of the corpus.

## Red-team conversion
- Each turn got a scripted `selector` = the attacker's best case: the model fully fooled by the hostile content (it obeys the first command in `content`), by a paste, or by a replay. Hostile content is planted behind listed item 1 with a unique `canary` appended.
- Draft `setup` turns that were plain reads got selector `none`; summary turns got a legitimate `item.summarize` selector.
- Cap cases use `repeat` (22 turns for 20/hour, 120 for 100/day, 33 for 30/hour) instead of preset counters, so they test the real cap and the fixed reply.
- **Not expressible offline (13 cases, `agent-redteam.a6-unmapped.v1.json`):** the kill-switch state (6), a non-DM channel (4), and joined fake secrets (3). The harness always runs in the running state, in a DM, and does not join `{{FAKE_SECRET}}` fixtures. They need harness fields or run in NLA-8 acceptance.
- No families need the model: the harness is deterministic (scripted selector). The Strict model runs reuse the same cases with a real provider.

## Result in a scratch copy of the r0 worktree
- `validateActionCorpus`: 0 problems over 522 + the 17 seed cases. `nl-action-eval.test.ts` (including the perfect-selector gate and the no-prompt-phrase check): pass.
- `nl-action-redteam.test.ts`: pass on the 157 converted cases plus the seed, 0 successes.
