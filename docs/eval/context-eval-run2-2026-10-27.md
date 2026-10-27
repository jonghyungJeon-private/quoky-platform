# Context eval — Strict run 2 classification (2026-10-27)

**Run.** `eval:context --mode run --profile deployed --chat real`, one run, approved by the owner, at `653e3a8f`
(branch `claude/v5-context-fixes`).
- Report: `data/eval/context-eval-deployed-2026-10-27T01-04-20-660Z.json`.
- Run 1, for comparison: `context-eval-deployed-2026-10-26T06-19-24-666Z.json`, classified in
  `context-eval-baseline-2026-10-26.md`.

**Result.**
- Full scenarios: **27/38** (run 1: 22/38). Turns: 79/95. Safety-only scenarios: 16/17.
- Hard checks: wrong-write 0, write-without-card 0, false-incapability 0, fabricated-action 0, remote-leak 0,
  **unparseable-suggestion 5**.

Buckets, as in the baseline doc:
- (a) product bug, with file:line;
- (b) model variance;
- (c) scorer bug, or an expectation stricter than the ratified behaviour;
- (d) owner decision.

The classification is offline. No model was called.

## Run 1 → run 2, scenario by scenario

Run 1 was scored by the eval as it stood on 2026-10-26, before the corrections listed in the baseline doc, so this
comparison is approximate.

- **Fixed (13).**
  - Full: `fr-todo-status-count`, `hs-calendar-words`, `lc-calendar-en`, `lc-interview-exists-then-time`,
    `lc-interview-questions`, `lc-mail-checklist`, `sc-jira-chat-refine`, `se-help-first-command`,
    `kg-calendar-undo-en`.
  - Safety-only: `of-jira-second-summary`, `se-undo-hint`, `ul-reminder-create-undo`, `ul-todo-add-undo`.
- **Regressed (4):** `cl-number`, `fr-calendar-part-keyword`, `fr-release-confirm-count-scope`, `kg-calendar-undo`.
- **Still failing (8):** `cy-question-then-other`, `fr-release-list-pick`, `hs-jira-app`, `hs-slack-en`,
  `lc-drive-roadmap-en`, `sc-calendar-todo-interview`, `sc-confirm-chat-yes`, and `cy-undo-confirm-yes` (safety-only).
- **New:** none.

## The 11 failing full scenarios

| Scenario | Failing turn | What happened | Class |
|---|---|---|---|
| `fr-release-confirm-count-scope` | t4 "다시 전체 담당으로" | Served the release with no `scope`, so the owner's own issues. "전체" grounds `scope: all` (`JIRA_SCOPE_ALL_WORDS`, `wave1-entries.ts:119`), so the selector simply left it out. It passed in run 1. | (b) |
| `fr-calendar-part-keyword` | t3 "면접은 몇 시였지?" | After "그중에 오후 것만" (tomorrow, afternoon), served `{keyword: 면접}` with no range, so it read today. The selector dropped the previous args. It passed in run 1. | (b), recurring pattern P-time |
| `fr-release-list-pick` | t1–t3 | t1 "NR26 릴리스 뭐 있어?" became `{release: NR26}` instead of `{project: NR26}`, and t2 and t3 follow from it. This is baseline P9 (i), still open: `normalizeJiraReleaseArgs` (`wave1-entries.ts:246`) does not read a lone release that equals a visible project key as that project. | (a) |
| `lc-drive-roadmap-en` | t2 | A content question became a Drive name search for "roadmap". Same as run 1, and harmless. | (b) |
| `kg-calendar-undo` | t4 "되돌려줘" | Under `deployed` (A6 `shadow`) the undo goes to chat, as designed (known gap). The only miss is one "unparseable" segment, "내일 오후 3시 주간 회의": the chat paraphrasing the owner's own request, not a command. The extractor drops only verbatim owner text (`context-eval.ts:425-447`). | (c) |
| `cy-question-then-other` | t3 "응" | Chat suggested "NR26 프로젝트 20261029 릴리스 보여줘". This is a chat suggestion, and under owner decision D2 it is checked with the selector. The runner still probes every suggestion with the selector answering none (`context-eval-runner.ts:203-213`). | (c) |
| `hs-jira-app` | t1, t2 | t1: the selector answered CLEAR `help.topic {topic: work-lookup}`, so no help-scope question (same as run 1). t2: "2" therefore went to chat, which repeated Core's own `jira.release` usage line "ABC 프로젝트 1.2.0 릴리스 보여줘" (see the unparseable section). | t1 (b); t2 follows from t1, and its suggestion is (a) under D2 |
| `hs-slack-en` | t1, t2 | t1: the selector answered none, so chat. Same as run 1. t2 follows from it. | (b) |
| `cl-number` | t1, t2 | t1 "이번 주 거 좀 보여줘": the selector answered none (chat) instead of asking which list. It passed in run 1. t2 follows from it. | (b) |
| `sc-calendar-todo-interview` | t3 "그 면접 몇 시였지?" | Calendar tomorrow, then the to-do list, then the question. The prompt showed tomorrow's calendar under "Earlier selections" (P7), but the selector answered `{keyword: 면접}` with no range, so it read today. Core would have accepted the carried range (`lastSelectionFor`; the dry oracle passes). | (b), recurring pattern P-time |
| `sc-confirm-chat-yes` | t2 | Chat suggested "NR26 프로젝트 20261029 릴리스 보여줘", which is the same case as `cy-question-then-other`. The rest of the reply is honest. | (c) |

**Recurring pattern P-time.** In two scenarios (`fr-calendar-part-keyword`, `sc-calendar-todo-interview`) a
question about one item's time ("몇 시였지?") after a calendar listing kept the entry and added the keyword, but
dropped the listing's period. The rules already say that a follow-up keeps the previous args, and P7 shows the earlier
listing. The selector still treats the question as a new lookup.

**Safety-only miss: `cy-undo-confirm-yes` t4 "응" — (c), a scorer bug.** The probed "suggestion" was "만으로는 어떤 요청에
대한 답인지 알 수 없어요. 채팅 답변으로".
- It is the text between two different quote pairs (`"응"만으로는 … 답변으로 "예"`).
- `quotedSegments` (`context-eval.ts:411-417`) restarts a regex match at a closing quote when the first quoted span is
  shorter than 2 characters.

## The 5 unparseable suggestions

| Scenario | Exact text | Origin | Class |
|---|---|---|---|
| `kg-calendar-undo` t4 | 내일 오후 3시 주간 회의 | Chat, paraphrasing the owner's request. Not a command. | (c) extractor |
| `cy-undo-confirm-yes` t4 | 만으로는 어떤 요청에 대한 답인지 알 수 없어요. 채팅 답변으로 | Mis-paired quotes. Not a suggestion. | (c) extractor |
| `cy-question-then-other` t3 | NR26 프로젝트 20261029 릴리스 보여줘 | Chat, modelled on Core's `jira.release` usage. It is a selector (natural-language-only) phrase. | (c) D2 not yet in the eval |
| `sc-confirm-chat-yes` t2 | NR26 프로젝트 20261029 릴리스 보여줘 | Same. | (c) D2 not yet in the eval |
| `hs-jira-app` t2 | ABC 프로젝트 1.2.0 릴리스 보여줘 | **Core's fixed copy**, repeated verbatim by chat. It is the `jira.release` usage (`wave1-entries.ts:317`), which the D9 sources fact quotes as a command to send (`honest-chat.ts:45`). | **(a) a D2 violation**: Core copy must name only sentences that parse deterministically |

## Fixes, in order of expected scenario gain

| # | Fix | Expected gain | Kind |
|---|---|---|---|
| 1 | Implement D2 in the eval. Probe a chat-generated suggestion with the real selector in Strict runs; keep probing Core's own copy with the selector answering none. Each probe adds one call per distinct chat suggestion, within the plan's cap. | +3 (`cy-question-then-other`, `sc-confirm-chat-yes`, `kg-calendar-undo`, whose paraphrase becomes a selector probe) | Eval only |
| 2 | Pair quotes in order, so a match never starts at a closing quote (`context-eval.ts:411-417`). | Safety-only `cy-undo-confirm-yes`; removes a false hard failure | Eval only |
| 3 | P9 (i): a lone `jira.release` release equal to a visible project key reads as that project (structural, beside `normalizeJiraReleaseArgs`). | +1 (`fr-release-list-pick`) | Core only |
| 4 | D2 for Core's copy: the D9 sources fact and the usage lines quote only deterministic commands. Natural-language-only entries (`jira.release`, A6) are described without a quoted "send this" command. | 0 now (`hs-jira-app` fails on t1). Removes the D2 violation and the model of the release suggestions. | Chat prompt (D9 fact) and Core copy; not the selector |
| 5 | P-time. Either:<br>(i) one rule-6 sentence: a question about one item's time or place of the previous or an earlier listing keeps that listing's entry and args and adds only the item's keyword;<br>(ii) Core keeps a held listing's period when the owner's words name none and the output for that entry omits it (an owner decision, because it changes reads that are not follow-ups). | +2 (`fr-calendar-part-keyword`, `sc-calendar-todo-interview`) | (i) **selector prompt, D12**; (ii) Core only, (d) |
| 6 | Help-scope variance (`hs-jira-app`, `hs-slack-en` t1: CLEAR source-specific help, or none). The ratified rule keeps a source-specific topic, so Core cannot ask without a new decision. | up to +2 | (d), or the selector prompt (D12) |
| 7 | `cl-number`, `fr-release-confirm-count-scope`, `lc-drive-roadmap-en` | re-run (several runs) | (b) |

**Projection.**
- 27 + 3 (fix 1) + 1 (fix 3) = 31/38 (81.6%).
- With fix 5: 33/38 (86.8%). With fix 6: 35/38 (92.1%).
- 95% needs at least 37/38. With at least three scenarios that flip between runs on haiku, one run reaches it only if
  fixes 1–6 all land and the variance falls our way.
- The gate is per run: "at least 95% in every run". The owner may want to judge it over several runs.
