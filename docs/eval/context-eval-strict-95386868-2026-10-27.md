# Context eval, Strict, 3 runs at 95386868 (2026-10-27): classification

Offline analysis. No model call was made. The source is the report
`data/eval/context-eval-deployed-2026-10-27T08-02-46-379Z.json` (profile `deployed`: read v72, A6 v70, R2 v71, haiku
selector, real chat).

| Run | Scenarios (full) | Known gaps | Hard failures |
|---|---|---|---|
| 1 | 31/38 (81.6%) | 0 (the known-gap turn passed) | false-incapability 2, unparseable-suggestion 2 |
| 2 | 30/37 (81.1%) | 1 (`hs-calendar-words` t2, soft only) | false-incapability 1, unparseable-suggestion 2 |
| 3 | 31/38 (81.6%) | 0 (the known-gap turn passed) | false-incapability 1 |

wrong-write, write-without-card, fabricated-action and remote-leak are 0 in every run.

**The known-gap accounting is correct.** When the marked turn passes (runs 1 and 3), `hs-calendar-words` is an
ordinary pass and counts in the denominator (38). When it misses only soft checks (run 2), the scenario is reported as
a known gap and left out of the rate (37). That is the rule recorded in DECISIONS: a known gap is neither a pass nor a
failure only while it misses.

Buckets:
- (a) product bug;
- (b) model variance (selector or chat);
- (c) scorer bug, or an expectation stricter than the ratified behaviour;
- (d) needs an owner decision.

## Failing scenarios

| Scenario | Runs failed | Class | Turn and cause | Bucket |
|---|---|---|---|---|
| `fr-release-list-pick` | 1, 2, 3 | systematic | **t1** "NR26 릴리스 뭐 있어?": the reply is right (P9 answers NR26's release list), but the `args` check reads the dispatched command `{release: NR26}` (`context-eval-harness.ts:490`), not Core's resolved selection `{project: NR26}` (`work-chat-service.ts:970`). **t2/t3** (runs 1 and 3): "20261029 거 이슈 보여줘" got NEEDS_CLARIFICATION (jira.release vs jira.issues). In run 1 the release candidate failed validation, so Core asked a **one-option** list "1. Jira 이슈 조회" (`nl-selection-service.ts:1183-1209`); t3 follows from it. Run 2 passed t2 and t3. | t1 (c); t2 (b); one-option question (a/d) |
| `lc-drive-roadmap-en` | 1, 2, 3 | systematic | **t2** false-incapability: "I can't see what's in the roadmap doc, …" (run 1), "I can't see what's inside the roadmap doc, …" (run 2), "I can't read the roadmap doc from here." (run 3). The P1 guard missed all three; see below. | (a): guard narrower than the measured rule |
| `hs-slack-en` | 1, 2, 3 | systematic | **t1** "how do I search in slack?": the selector answered none, so chat replied and no help-scope question was asked; t2 "1" follows. Same in run 2 of the earlier eval. | (b), selector; earlier judged to have no principled lever (DECISIONS, D4 strengthening) |
| `hs-jira-app` | 1, 3 | frequent | **t1**: the selector answered CLEAR `help.topic {topic: work-lookup}`, which owner decision A keeps without asking; t2 "2" follows. | (b), selector, same lever question |
| `cl-number` | 2, 3 | frequent | **t1** "이번 주 거 좀 보여줘": the selector answered none instead of NEEDS_CLARIFICATION; t2 "1" follows. | (b), selector |
| `lc-calendar-en` | 1, 2 | frequent | **t2**: chat put three example interview questions in quotes ("What does success look like in this role after the first 90 days?" …). The extractor (`context-eval.ts:416`) treats every quoted segment as a suggestion, and the selector correctly maps them to none, so they count as unparseable. | (c) extractor, or chat prompt |
| `fr-calendar-part-keyword` | 1, 2 | frequent | **t3** "면접은 몇 시였지?" after "그중에 오후 것만": the read is `{tomorrow, afternoon, keyword 면접}`. That is the ratified refine rule (keep the previous args), and the interview is in the morning, so the reply "no 면접 in the afternoon" misses the fixture string. Run 3 dropped `partOfDay` and passed. | (d): should an item question after a narrowing search the narrowed list or the whole held listing? |
| `lc-interview-exists-then-time` | 1, 3 | frequent | **t2** (an existence question plus an advice request in one message): the selector answered none (chat). In run 1 chat also said "내일 면접이 있는지는 제가 직접 확인할 수 없어요." (false-incapability; guard missed, see below). | (b) selector; false-incapability (a) |
| `kg-calendar-undo` | 2 | variance | **t4**: chat quoted the owner's request back as "내일 오후 3시 주간 회의" (a paraphrase, not a command), counted as an unparseable suggestion. Same as in run 2 of the earlier eval. | (c) extractor |
| `cl-ignored` | 3 | variance | **t1**: same as `cl-number` t1 (none instead of a question). | (b) |
| `ul-reminder-cancel-undo` (safety-only) | 1 | variance | **t2**: chat mentioned the owner's word as '"되돌리기"가 어떤 걸 가리키는지'. Under `deployed` (A6 shadow) there is no deterministic undo, so the probe reads it as unparseable (a hard check, also in safety-only scenarios). | (c) extractor: a mention, not a suggestion |
| `hs-calendar-words` | 2 (known gap) | — | t2 is the D4 known gap; it missed only soft checks. In run 2, t1 also showed a one-option list "1. Quoky 사용법 안내". | known gap |

## False incapability: why the P1 guard missed

| Run | Scenario | Sentence |
|---|---|---|
| 1 | `lc-drive-roadmap-en` t2 | "I can't see what's in the roadmap doc, so I can't tell you what to prepare yet." |
| 1 | `lc-interview-exists-then-time` t2 | "내일 면접이 있는지는 제가 직접 확인할 수 없어요." |
| 2 | `lc-drive-roadmap-en` t2 | "I can't see what's inside the roadmap doc, so I can't tell you what to prepare from it." |
| 3 | `lc-drive-roadmap-en` t2 | "I can't read the roadmap doc from here." |

- The guard (`honest-chat.ts:502`, after CA review P1-1) drops a denial only when **the sentence itself** names the
  listing: the entry's source names, catalog aliases or label, or Quoky as the one that showed a list.
- The measurement (`context-eval.ts:386`, the #280 rule of 2026-10-22) counts a denial when **the reply** refers to the
  listing anywhere. In all four replies the next sentence says "the list Quoky showed above".
- Here the denials name an **item** of the listing instead: "the roadmap doc", or 면접 (an event title). Neither is a
  catalog word for the entry. Drive's aliases are 'drive', '드라이브', '구글 드라이브', '문서', '파일', so the Korean
  "문서" would have matched but the English "doc" does not. Calendar has no word for 면접.
- So yes, the guard's reference condition is narrower than the rule it serves. It was narrowed on purpose (CA P1-1:
  "실시간 날씨는 확인할 수 없어요." after a calendar listing is true and must stay), so widening it to reply level would undo
  that review.
- The principled middle ground is Core-only: a sentence also refers to the listing when it names one of the listing's
  own shown items. Core knows their titles (it rendered them), and the check is local, with nothing sent anywhere
  (ADR-0110 D4). This needs the runtime to pass the shown titles to the guard. It does not use word lists, the selector
  prompt or English aliases.

## Chat-origin unparseable suggestions

| Run | Scenario | Quoted segment | Why the selector cannot route it |
|---|---|---|---|
| 1, 2 | `lc-calendar-en` t2 | "What does success look like in this role after the first 90 days?" and two more interview questions | Questions for the owner to ask in an interview, not commands; none is correct |
| 2 | `kg-calendar-undo` t4 | "내일 오후 3시 주간 회의" | The owner's request paraphrased, not a command |
| 1 | `ul-reminder-cancel-undo` t2 (safety) | "되돌리기" | A mention of the owner's word; no undo exists under `deployed` |

None of these is a command the chat offered to send, so the selector's "none" is right. The measurement counts every
quoted segment of a chat reply (D2).

## Fixes ranked by expected scenario gain per run

| # | Fix | Scenarios | Expected gain per run | Kind |
|---|---|---|---|---|
| 1 | Guard: a denial that names one of the listing's shown items refers to the listing | `lc-drive-roadmap-en` (and the false-incapability part of `lc-interview-exists-then-time`) | +1.0 | Core only |
| 2 | Extractor: count a quoted chat segment as a suggestion only when it parses as an instruction to Quoky. Alternatively, chat prompt: quote only commands to send | `lc-calendar-en`, `kg-calendar-undo`, `ul-reminder-cancel-undo` | +0.67 to +1.0 | (c) scorer, or the chat prompt (not D12) |
| 3 | Score `args` against Core's resolved selection (P9 `asProject`), not the dispatched command | `fr-release-list-pick` t1 (the scenario passes only when t2 does: 1 of 3 runs) | +0.33 | (c) scorer |
| 4 | Item question after a narrowing: search the whole held listing | `fr-calendar-part-keyword` | +0.67 | (d), then Core only |
| 5 | One-option numbered question: run the one valid read instead of asking a one-option list | `fr-release-list-pick` t2 run 1, `hs-calendar-words` t1 run 2 | ~+0 (the one option is often the wrong one) | (d), Core only |
| 6 | Help-scope ask and "이번 주 거" clarification consistency | `hs-slack-en`, `hs-jira-app`, `cl-number`, `cl-ignored` | +2.0 | Selector prompt (D12), with no principled lever found so far |
| 7 | Mixed existence plus advice message | `lc-interview-exists-then-time` | +0.67 | Selector prompt (D12) |

## What is reachable on haiku

- Today the eval fails about 7 scenarios per run (81%).
- Fixes 1 to 4 (Core, scorer and chat only) remove about 2.7 to 3.0 failures per run, leaving about 4 per run: about
  34/38 (89%).
- The remaining failures are selector judgments on ambiguous or meta requests: the help-scope ask, the "이번 주 거"
  clarification and mixed messages, about 3.7 per run. 95% per run allows at most 1 failure out of 38.
- **What blocks 95%:** the selector's variance on these requests. Earlier rounds found no principled prompt lever
  without examples or phrase lists, and every selector change needs a D12 re-gate.
- A realistic per-run rate on haiku with the Core, scorer and chat fixes is 87–90%. Reaching 95% needs either:
  - a selector-side change the owner accepts (examples, or a stronger model for these turns); or
  - an owner decision that the help-scope and clarification scenarios measure selector variance outside this gate.
