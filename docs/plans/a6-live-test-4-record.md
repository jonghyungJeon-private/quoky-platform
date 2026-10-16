# A6 live test 4 record: labelled session before promotion (2026-10-17)

Owner-approved (Discord 2026-10-17 03:17, items 4 and 5). Sheet: 112 labelled turns in 3 blocks. Service main d22f0a2a, flags local + R2 jira + work summary only during the test. Owner decisions on disputed labels are pending.


## B1 (05:11-05:17), A6 writes 9
| Turn | Expected | Got | OK |
|---|---|---|---|
| 1 todo list | read | list (owner item only) | Y |
| 2 reminder list | read | #10 only | Y |
| 3 help usage | read:help.topic | asked "어떤 걸 찾으세요? (1 option)" | minor miss (no state) |
| 4,5 calendar today/tomorrow | read | correct | Y |
| 6 할 일에 검증 분기 예산 대조 하나 올려줘 | execute | todo.add executed #2 | Y |
| 7 검증 서버 로그 점검, 할 일로 적어 두세요 | execute | todo.add executed #3 | Y |
| 8 To-do: 검증 vendor invoice recheck | execute | selector none -> chat "not added" | miss (no state) |
| 9 multi-clause add | execute | todo.add executed #4 (title clean) | Y |
| 10 list | read | owner,T1,T2,T4 | Y |
| 11 2번 끝냈으니까 체크해줘 | execute | todo.complete index=2 -> T1 | Y |
| 12 | - | skipped (T3 not created) | - |
| 13 title complete | execute | todo.complete match -> T2 | Y |
| 14 Cancel the ... to-do | execute | todo.cancel match -> T4 | Y |
| 15 question | none | chat advice, no write | Y |
| 16 how-to | chat | help text | Y |
| 17 negation | none | chat, no write | Y |
| 18 EN negation | none | chat, no write | Y |
| 19 retraction | none | no A6 line, chat | Y |
| 20 hearsay | none | refused not-request:reported | Y |
| 21 conditional | none | refused time-in-title (asks todo vs reminder) | Y (no state) |
| 22 Slack post | none | declined, no card | Y |
| 23 Jira create | none | declined read-only | Y |
| 24 jamo garble ㅊㅜ가 | ask | asked (reason ambiguous) | Y |
| 25 리마이너 걸어줘 (noun garble) | ask (sheet) | reminder.create executed #20 10/21 09:00 correct | sheet label error: garble is in the noun, verb clear; intent and target exact. Not a capture. Reported. |
| 26 missing time | ask | refused missing-arg, generic "무엇을/어느 항목을 다시 말씀해 주세요" | Y (no state); UX gap: should ask the time |
| 27,28 reminders | execute | legacy reminder path #21, #22 | Y |
| 29 알림: ... colon label | execute | none, chat "not created" | miss (no state) |
| 30 list | read | #10,#20,#21,#22 | Y |
| 31 22번 알림은 빼줘 | execute | reminder.cancel index -> #22 | Y |
| 32 title cancel | execute | reminder.cancel match -> #21 | Y |

## B3 non-write turns run early (05:19-05:24)
| Turn | Expected | Got | OK |
|---|---|---|---|
| 90 my jira issues | read:jira.issues | 10 issues, 출처 5 | Y |
| 91 slack search | read:slack.search | 1 result | Y |
| 92 EN how-to remove reminder | read:help.topic | help text (EN) | Y |
| 93 calendar venting (neg-037 style) | chat | empathy + commands, no card | Y |
| 94 slack venting | chat | empathy, no search | Y |
| 95 | - | skipped (registry-touching; not approved) | - |
| 96 example question | none | help.topic executed (memory-management topic, irrelevant) | read capture (harmless, no state) |
| 97 deferred 나중에 | none | refused time-outside-when, asks when | Y (no state) |
| 98 EN should I add | none | chat, no write | Y |
| 99 EN reported quote | none | chat, no write | Y |
| 100 Slack post colon | none | declined read-only | Y |
| 101 Jira ticket colon | none | selector none, generic "무엇을/어느 항목을 다시 말씀해 주세요" | Y (no state); UX: should say Jira write unsupported |

## B2 (06:18:43-06:27, real times from message ids), A6 writes 11 (33,34,36,38,46,50,51,52,56,59,69); legacy writes 35,57,65
| Turn | Expected | Got | OK |
|---|---|---|---|
| 33 add casual | execute | todo.add #2 | Y |
| 34 "검증 케이블 정리 건 할 일로 넣어놔줘" | execute | todo.add #3, title kept "건" | Y (minor title fidelity) |
| 35 할 일 추가: (fixed cmd) | execute | legacy add | Y |
| 36 formal | execute | todo.add #5 | Y |
| 37 list | read | 1 owner,2 포트,3 케이블 정리 건,4 영수증,5 서랍 | Y |
| 38 2번 완료 | execute | todo.complete index -> 포트 | Y |
| 39 이번엔 3번이야 | ask | refused not-request:statement (copula -이야); chat LLM asked "3번도 완료?" in prose | N-ish: safe, but UX: chat asks a question Quoky can't act on |
| 40 응 | execute | chat: nothing done (no pending question) | follows 39; no state |
| 41 그럼 4번도 | ask | asked elliptical-confirm "할 일 4번도 완료할까요?" | Y |
| 42 아니 | none | closed, nothing done | Y |
| 43 똑같이 해줘 | ask | chat clarification (no A6 line) | Y (no state) |
| 44 취소 | none | "no pending approval" | Y |
| 45 5번 체크 | ask | asked elliptical-confirm | Y |
| 46 응 | execute | completed #5 서랍 정리 | Y |
| 47 58번 | ask | legacy "no #58", shows list | Y |
| 48 어드해줘 garble | ask | asked (ambiguous) | Y |
| 49 list | read | owner, 케이블 정리 건, 영수증 | Y |
| 50 3번 완료로 바꿔줘 | execute | completed 영수증 | Y |
| 51 되돌려줘 | undo-direct | reopened 영수증 (same item) | Y |
| 52 add 도어락 | execute | todo.add #4 | Y |
| 53 방금 추가한 거 없던 일로 해줘 | undo-confirm | refused no-action-word; chat said "제가 직접 취소할 수 없어요" | miss + misleading chat (no state) |
| 54 아니 | none | chat | Y |
| 55 원상복구 부탁드려요 | undo-confirm | asked undo-confirm | Y |
| 56 응 | execute | undone add (도어락 cancelled) | Y |
| 57 할 일 추가: 와이파이 (fixed) | execute | legacy add | Y |
| 58 reminder no time | ask | refused missing-arg, generic re-ask | Y (no state); UX: should ask time |
| 59 되돌려줘 | undo-direct | undid legacy add 와이파이 | Y (no open question existed, see 58) |
| 60 EN remind no time | ask | refused missing-arg generic | Y (no state) |
| 61 취소 | none | no pending | Y |
| 62 캔쓸 (on #20 검증 도면 회신; R3 never created) | ask | asked garbled-action | Y |
| 63 list | read | #10, #20 | Y |
| 64 7777번 | ask | legacy not found | Y |
| 65 EN 3pm Oct 21 | execute | legacy reminder #23 10/21 15:00 | Y |
| 66 EN "on Oct 22 at 9:30am:" | execute | legacy asked when (EN time parse fail) | miss (residual EN time) |
| 67 list | read | #10,#20,#23 | Y |
| 68 wish | none | generic re-ask, no state | Y |
| 69 회의 끝나고 검증 회의록 정리 할 일에 넣어줘 | none (sheet: deferred) | todo.add executed, title "회의 끝나고 검증 회의록 정리" | LABEL DISPUTED - owner to adjudicate (time qualifier inside title span; plausible intent) |
| 70 past | none | chat | Y |
| 71 volition 추가할게 | none | refused not-request:volition | Y |
| 72 joke | none | refused not-request:joke | Y |
| 73 quoted | none | chat, not treated as instruction | Y |
| 74 EN wish | none | chat | Y |
| 75 calendar add | none | legitimate wave-5 approval preview (not a spoof), then "거절" -> rejected, no calendar write | Y |

## R2 Jira (06:31-06:36), listing turn 102; body OL numbered 1-5 = footer OL 1-5 (#259 fix live): K1 QAI-3844, K2 OP26-1294, K3 OP26-1144, K4 CHA-3961, K5 OP26-1167
| Turn | Message | Resolved | OK |
|---|---|---|---|
| 103 | 1번 이슈 요약 좀 해줘 | index 1 -> QAI-3844 | Y |
| 104 | 4번 이슈 내용 한번 요약해줄래? | index 4 -> CHA-3961 | Y |
| 105 | 5번 이슈 요약해줘 | index 5 -> OP26-1167 | Y |
| 106 | 그거 좀 요약해줘 | this -> OP26-1167 (last summarized) | Y |
| 107 | OP26-1294 요약해줘 | key -> OP26-1294 (label 2) | Y |
| 108 | 47번 이슈 요약해줘 | asked out-of-range "목록에 5건만" | Y |
| 109 | Summarize issue 3 from that list | index 3 -> OP26-1144 | Y; UX: summary opens with a meta sentence "The supplied context contains a single Jira issue and no numbered list" |
R2 numbering 7/7 correct on the real model (owner item 5). Pseudonyms 참여자 A-F, no real names seen. No approval-like card. DM only.

## B3 (07:18:29-07:21; NOTE: started 8 min before the sheet rule of B2 last write 06:26:43 + 60 min; real cap 20/h never reached, no capped result), A6 writes 3 (76, 77, 87)
| Turn | Expected | Got | OK |
|---|---|---|---|
| 76 add | execute | todo.add #5 | Y |
| 77 C02 title cancel | execute | todo.cancel match -> 분기 회의록 정리 | Y (C02 residual not reproduced) |
| 78-80 bare "<title> 할 일" (T7) | execute | 0/3: selector none -> chat "add or view?" | miss x3 (no state); owner decision A not met |
| 81 dup | ask/guard | chat (nothing created earlier) | n/a |
| 82 점검 할 일 완료해줘 | ask | refused none (no match) | Y (no state) |
| 83 reminder | execute | legacy #24 10/24 10:00 | Y |
| 84 F09 메일 회신 알림 취소 | ask | asked other-source | Y (documented) |
| 85 검증 알림 하나 취소 | ask | refused not-found | Y (no state) |
| 86 오후에 ... | ask | asked when (when-unparsed) | Y |
| 87 (R3 never created; used #23 title) | execute | reminder.cancel match -> #23 | Y |
| 88, 89 | - | skipped (items never created) | - |
| 111 list | read | owner + 3 test todos | Y |
| 112 그거 좀 요약해줘 after todo list | none | todo list again, no Jira summary | Y |

## Cleanup 07:21-07:23: fixed commands; final todos = owner item only; reminders = #10 only. Flags restored from backup (shadow, summary false, R2 removed); deployed 198613c1 (#263) in the same restart.

## Totals (112 planned; 104 sent incl. cleanup-excluded; skipped 12,88,89,95,110 + 81 n/a)
- A6 writes executed: 23 (B1 9, B2 11, B3 3), all on the correct item. Undo: 4 (51 direct, 56 confirm, 59 direct, + 55 confirm asked) -> 3 executed undos.
- Wrong targets: 0. Negative captures: 0 by the grammar classes; 2 disputed labels for owner (25 리마이너 noun-typo executed correctly; 69 "회의 끝나고 ..." executed with qualifier in title). External writes: 0 (calendar preview rejected).
- R2: 7/7 correct numbering/targets on the real model.
- Misses (no state change): colon labels (8 "To-do:", 29 "알림:"), T7 bare 할 일 x3, 39 "이번엔 3번이야" copula, 53 "없던 일로 해줘", 66 EN time, 3 help ask, 96 help capture.
- UX: missing-time reminders get a generic re-ask (26, 58, 60); 53 chat says "can't cancel"; 39 chat asks a question it can't act on; 109 meta sentence in EN summary; 34 title keeps "건".
