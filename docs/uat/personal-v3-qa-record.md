# Personal v3 — QA record

Owner-attended live QA on the dev bot (owner account, Discord). Same conventions as `personal-v2-qa-record.md`:
IDs, PASS/FAIL, fixes and residuals are recorded faithfully; nothing here claims a Strict action that was not run.

## Wave 1 (integration claude/v3-wave1) — SUB-1, DET-1, LLM-1 (ADR-0102, ADR-0104)

Runtime: plain `node apps/quoky/dist/main.js` from the integration worktree (the launchd service from SUB-1 is NOT
installed on the owner's host yet — that is a separate Strict step).

| ID | Input | Result |
|---|---|---|
| H2 | 알림은 어떻게 설정해? | PASS — help-intent answer from the reminder help lines (no provider) |
| H3 | 오늘 기분이 좀 별로야 | PASS routing — ordinary chat. NOTE (model quality): odd memory-tinged reply |
| D1 | 브랜치 삭제했어 | PASS — deterministic: Quoky did not create/switch/delete a branch and cannot see the owner's git |
| D2 | 보고서 초안 쓰기 다 했어 (to-do already closed) | PASS — chat acknowledgement, no Quoky action claim |
| G2 | 내일 아침에 우유 사라고 할 일에 넣어줬어? | PASS — model's to-do claim replaced by the deterministic notice (`internal action claim replaced domain=todo`) |
| H1 | 완료 처리 어떻게 해? | FAIL W1-L01 (MEDIUM) — a pending file-path clarification captured it → FIXED f355026; retest PASS (help-intent to-do lines) |
| G1 | 방금 내가 말한 거 기억해 줬지? | FAIL W1-L02 (MEDIUM) — "네, 당신이 말한 거 기억했습니다." not caught → FIXED 7e18f6e; retest PASS (memory notice) |
| G3 | git commit 은 어떻게 하는 거야? | FAIL W1-L03 (MEDIUM) — treated as a commit request; copy exposed `WORKSPACE_APPLIED` → FIXED f355026; retest PASS (chat answer). NOTE (model quality): the local answer echoes the question |
| R4 | 커밋해줘 (no applied change) | PASS — "먼저 코드 변경을 적용한 뒤에 …" without internal state names |

Codex review: CHANGES_REQUIRED (2 P1 instance-lock races, 6 P2 guard/sanitizer) → fix loop 1 (16bf759 generation-file
lock; 7e18f6e/54906e8/f355026) → re-review 3 P2 → fix loop 2 (12dcef3) → 3 P2 → orchestrator follow-up 530e757 +
accepted residual R5 (best-effort lexical claim guard, `DECISIONS.md`) → PASS.

Pending Strict live steps for SUB-1 (owner approval required): `ops/launchd/quokyctl.sh install --apply` on the owner's
Mac, Claude CLI under the minimal launchd environment, restart within 30 s after `kill -9`, a reminder across a
restart, and moving the dev DB into the service DB location.

## SUB-1 host install (Strict, owner-approved 2026-10-06 "응 계속 진행해")

| ID | Step | Result |
|---|---|---|
| SV0 | Deploy worktree `.worktrees/quoky-platform/quoky-service` (detached at main eef71a9), built; `.env.local` copied (mode 600) + `QUOKY_DISCORD_EXPECTED_BOT_ID`; dev DB (v13, integrity ok) + vectors copied to `~/Library/Application Support/Quoky/` with a separate pre-migration backup; QA runtime stopped first (no duplicate bot) | DONE |
| SV1 | `quokyctl.sh install --dry-run` then `--apply` | PASS — gui/501/com.quoky.personal loaded, running; startup identity verified (bot/guild/2 channels match) |
| SV2 | Claude CLI under the launchd minimal env: "내일 오전 9시에 내 일정 뭐 있어?" | PASS — POLICY_SENSITIVE_CHAT answered by Claude, truthful "확인할 수 없어요" |
| SV3 | `kill -9` of the app process | PASS — launcher logged exit 137 and restarted within ~1 s; stale lock taken over (dead pid); identity re-verified |
| SV4 | Reminder created in #reminder before the kill, due 12:14 | PASS — delivered once in #reminder after the restart (viaChannel=1) |

## LLM-2 answer-quality harness (Strict, owner-approved 2026-10-06; Ollama only, local-process egress)

`pnpm eval:answers -- --mode run --target ollama --model <m> --calls 3 --approved-plan-digest <digest>`; 11 cases × 3
calls; results in the QA worktree `data/eval/answer-quality-2026-10-06T03-*-ollama.json`.

| Model | languageMatches | noComplianceAnnouncement | noCapabilityPromise | noLiteralEscapes | lengthWithin | Overall (7 checks) | Wall time | Qualitative |
|---|---|---|---|---|---|---|---|---|
| llama3.1:8b (current) | 25/30 | 29/33 | 33/33 | 32/33 | 32/33 | 211/225 (93.8%) | ~3 min | still appends "(Translated from …)" |
| qwen3:8b | 9/29 | 31/32 | 32/32 | 26/32 | 6/32 | 164/218 (75.0%) | ~13 min | thinking output / overlength; 1 error |
| gemma3:4b | 27/30 | 33/33 | 33/33 | 33/33 | 28/33 | 214/225 (95.1%) | ~1 min | concise natural Korean; one wrong translation source |
| granite3.3:8b | 28/30 | 30/33 | 33/33 | 33/33 | 32/33 | 216/225 (96.0%) | ~4 min | verbose, imitates system instructions, English answer to a Korean translate request |
| mistral:7b | 27/30 | 29/33 | 32/33 | 33/33 | 29/33 | 210/225 (93.3%) | ~8 min | — |

(noTranslationBlock and noSystemCopyImitation were 30/30 for all.) Recommendation (ADR-0105 D1): gemma3:4b.

### LLM-2 follow-up: helpfulness checks (offline only, no provider run)

Live QA showed gemma3:4b passing the 95% policy table above while answering ordinary questions with non-answers
("도움말을 확인해보세요", "도움말: … 안내를 제공합니다.") and llama3.1:8b inventing facts, so the table measures policy
compliance, not helpfulness. Checker version is now `answer-quality-checkers-v2` with four heuristic checks
(`noHelpDeflection`, `containsRelevantTokens`, `hedgesUncheckable`, `noInventedSpecifics`) and six Korean helpfulness
cases (recommendation, python sort how-to, tips list, two hedge cases, small talk), 17 cases in total. The live gemma
non-answers are recorded as known-bad fixtures (the elided middle of the "도움말: …" line is reconstructed); the
llama invented-weather and invented-index outputs are synthetic reconstructions of the failure shape, not saved live
text. The new fixture digest and checker version change the plan digest, so the earlier approval does not carry over:
a re-run of the model comparison needs a fresh `--approved-plan-digest`. A pass means "none of the known non-answer
or invention shapes", not "the answer is correct".

## Wave 2 deployment to the always-on service + live QA (2026-10-06, owner-approved "응 둘 다 진행해")

| ID | Step / input | Result |
|---|---|---|
| DP1 | Service DB backup (`Quoky-backup-pre-v14-*`), deploy worktree → main 28817ae, build, `quokyctl restart --apply` | PASS — SUB-2 took its own verified pre-migration backup (`backup.pre_migration.verified`, userVersion 13), migration v13→v14 applied (`PRAGMA user_version`=14, integrity ok), identity verified, backup schedule started |
| LM1 | OLLAMA_MODEL → gemma3:4b (LLM-2 recommendation), live chat: "점심 뭐 먹을지 추천해줘", "파이썬 리스트 정렬 방법", "비 오는 날 노래 3곡", "회의 팁" | FAIL QA-V3-W2-LM (MAJOR, model quality) — non-answers prefixed "도움말:" ("도움말을 확인해보세요", "…안내를 제공합니다."). The harness measures policy compliance, not helpfulness → reverted to llama3.1:8b immediately (answers, but invents facts: song/artist pairs). Follow-up: add helpfulness cases to the harness (v3 LLM), re-evaluate candidates with the chat prompt |
| M1 | 기억 목록 | PASS — 2 memories listed, management hints |
| ME1–ME4 | 기억 1 수정: … → 기억 확인 0000 → 기억 확인 96D2 → 기억 확인 96D2 | PASS — preview + code; wrong code refused; correct code edits; replay refused |
| MF1–MF3 | 기억 2 잊어줘 → 기억 확인 4TK4 → 기억 목록 | PASS — forgotten incl. 1 earlier version; list shows 1 memory |
| MF4 | 내가 좋아하는 커피가 뭐였지? (after forget) | FAIL W2-L01 (MEDIUM) — answered "아이스 아메리카노였어요": LONG_TERM rows removed, but 10 SHORT_TERM session-history rows (incl. the memory-command turns) still carried the text → side-job fix (forget/edit purge the actor's short-term copies) |
| M3 | 피드백 후보 | PASS — truthful empty state |
| P0–P10 | Register sandbox, 브랜치 만들어줘 feature/quoky-uat-2, new file preview, 적용해줘/승인/패치 만들어줘/패치 적용해줘, 커밋해줘/승인/커밋 실행 | PASS — commit d050b2d |
| P11–P13 | 푸시해줘 → 승인 → 푸시 실행 | FAIL W2-L02 (MAJOR) — "push를 완료하지 못했어요": git-local uses a 5 s timeout for every git command; the same App-token push took 3.3 s warm under the launchd minimal env and exceeded 5 s in the service → side-job fix (longer bounded network timeouts + sanitized failure reason in logs). Diagnosis pushed the approved commit to the approved target |
| P14 | 푸시 실행 (retry) | PASS — "원격에 새 브랜치로 push했어요: d050b2d → origin/feature/quoky-uat-2" |
| P15–P17 | PR 만들어줘 → 승인 → PR 생성 실행 | PASS (CODE-7) — approval preview showed the exact title "chore: update docs/release-notes.md" (commit subject, not the raw instruction) and body (commit, branch, changed files); PR #2 created with that title/body |
| P18 | PR 상태 알려줘 | PASS — 열림, 병합 가능 여부(GitHub 보고): 충돌 없음, checks none, reviews 0/0 |
| CLEAN | gh pr close 2 --delete-branch (GH_TOKEN of jonghyungJeon-private) | DONE — sandbox has only main |

### W2-L01 retest after PR #121 (memory archive), deployed to the service

| ID | Input | Result |
|---|---|---|
| A1–A3 | 기억해: 내가 제일 좋아하는 과일은 샤인머스캣이야 → 내가 좋아하는 과일이 뭐였지? → 기억 목록 | PASS — answered 샤인머스캣 (paraphrased into history); listed |
| A4–A5 | 기억 2 잊어줘 → 기억 확인 7YJ4 | PASS — "이제 대화에 쓰지 않아요. 보관함에 7일 …", "이번 대화 기록도 비웠어요." |
| A6 | 내가 좋아하는 과일이 뭐였지? | PASS (W2-L01 fixed) — the forgotten content is no longer used. FAIL W3-L01 (MEDIUM, model) — the local model invented "귤이였어요" (fabricated personal fact with no memory) → side-job: deterministic "기억에 없어요" for memory-recall questions with no hit |
| A7 | 보관함 | PASS — 1 archived, "(7일 남음)", separate numbering note |
| A8–A10 | 기억 복원 1 → 기억 확인 W489 → 기억 목록 | PASS — restored, listed again |
| A11 | 내가 좋아하는 과일이 뭐였지? | PASS — 샤인머스캣 (restored memory used again) |

## Waves 3–4 deployment + live QA (2026-10-06)

| ID | Step / input | Result |
|---|---|---|
| D3 | Deploy wave 3 + W3-L01 (PR #122/#123) to the service (backup first; no migration) | PASS — identity verified, archive purge ran at startup |
| GCP | Google Cloud (owner-approved, via ego-browser after the owner re-authenticated): project quoky-personal-510806 under org gcar.co.kr, Calendar API enabled, OAuth consent **Internal**, scopes calendar.readonly + calendar.events, Desktop client quoky-calendar; client id/secret written straight to main + service .env.local (0600, never printed). The Google API user-data policy checkbox was accepted during setup | DONE |
| D4 | Deploy wave 4 (PR #125) incl. migration **v15** (owner-approved) | PASS — SUB-2 pre-migration backup verified (userVersion 14), user_version 15, integrity ok |
| CA | `calendar-auth --with-events` → consent in ego-browser (company account; screen listed exactly 2 scopes) → token file 0600 in the service data dir; QUOKY_CALENDAR_GOOGLE_TOKEN_FILE set; writes stay off | PASS — "Saved a calendar.readonly + calendar.events refresh token (mode 600)"; token never printed |
| C1 | 오늘 일정 뭐야? | PASS — 2 real events (times, rooms), "(Asia/Seoul 기준 · 캘린더 읽기 전용)" |
| C2 | 이번 주 일정 알려줘 | PASS — 5 events grouped by day |
| C3 | 다음 회의 언제야? | PASS — next event after now |
| C4 | 내일 오후 3시에 회의 잡아줘 | FAIL W4-L01 (MEDIUM) — fell to chat (model asked back) → FIXED PR #126 (natural booking pattern; Codex P2 content-request hijack fixed); retest PASS — "지금은 캘린더를 읽기만 할 수 있어요 … 아무것도 바꾸지 않았어요." |
| C5 | 내일 회의록 만들어줘 | PASS — ordinary chat (not a booking) |
| C6 | 내일 바빠? | FAIL W4-L02 (MEDIUM) — chat; model asserted "회의가 잡혀있었잖아요" → FIXED PR #127; retest PASS — tomorrow's real event list |

## Wave 5 deployment + connector/calendar write live UAT (2026-10-07, owner-approved targets)

Service at main 4a23f76 (wave 5, PR #129; no migration). Allowlists: Jira project BE, Slack #quoky-test (C0C83C52PFS,
private). QUOKY_CONNECTOR_WRITES_ENABLED=true and QUOKY_CALENDAR_WRITE_ENABLED=true on the service only. Slack bot
token (chat:write, separate from the read token) added by the owner. Test issue BE-881 created via the Atlassian
connector for the UAT and cancelled at the end.

| ID | Input | Result |
|---|---|---|
| J1 | BE-881에 댓글: Quoky UAT 댓글 테스트입니다. | PASS — exact preview, CRITICAL, "승인" then "댓글 실행" |
| J2 | 댓글 실행 (before approval) | PASS — still waiting for 승인/거절; nothing sent |
| J3 | 승인 | PASS — approval recorded, not executed |
| J4 | 댓글 실행해도 돼? | PASS (nothing executed). NOTE W5-L01 (MINOR): fell to chat; the model replied "네, 댓글을 실행할 수 있어요." → deterministic hint wanted |
| J5 | 댓글 실행 | PASS — comment posted, link returned |
| J6 | 댓글 실행 (repeat) | PASS (nothing sent). NOTE W5-L02 (MINOR): "승인된 외부 쓰기 요청이 없어요" instead of "이미 보냈어요" |
| T1–T3 | BE-881 작업중으로 바꿔줘 → 승인 → 상태 변경 실행 | PASS — preview shows status id 10247 / transition id 21; transitioned |
| T4–T5 | BE-881 완료로 바꿔줘 → 거절 | PASS — picked transition 2 whose destination is exactly 완료 (another transition named 완료 leads to 배포 완료); rejected, nothing sent |
| T6/T8 | BE-1에 댓글 … → 거절 | PASS (BE is allowlisted) |
| T7 | OP26-918 comment while another approval is pending | PASS — pending approval intercepts; nothing sent |
| T9 | OP26-918에 댓글: … | PASS — "쓰기가 허용된 대상이 아니에요 … 아무것도 보내지 않았어요." |
| S1–S3 | #quoky-test 게시 → 승인 → Slack 게시 실행 (bot not invited yet) | PASS (truthful NOT_SENT: "대상을 찾지 못했어요. 아무것도 보내지 않았어요."). NOTE W5-L03 (MINOR): particle "Slack 게시을(를)" |
| S4–S6 | after the owner invited the bot | PASS — posted, Slack link |
| S7 | same request again | PASS — "이미 보냈어요 — 다시 실행하지 않았어요." + link |
| K1–K4 | 내일 오후 5시에 "Quoky UAT 테스트" 일정 잡아줘 → 승인 → 일정 추가 실행 → 내일 일정 뭐야? | PASS — primary calendar, no attendees, sendUpdates=none; event listed. NOTE W5-L04 (MINOR): the list footer still says "캘린더 읽기 전용" while writes are on |
| K5–K7 | 일정 오후 6시로 옮겨줘 → 승인 → 일정 변경 실행 | PASS — preview binds the event as previewed; moved |
| K8–K11 | 일정 취소해줘 → 승인 → 일정 삭제 실행 → 내일 일정 뭐야? | PASS — deleted, no cancellation mail; calendar back to its original state |
| J7–J9 | BE-881 취소로 바꿔줘 → 승인 → 상태 변경 실행 | PASS — cleanup: test issue cancelled |

## Wave 6 — operations UI sign-in, model re-selection, OPS-2b (2026-10-07, orchestrator-observed)

Host: the owner's Mac (always-on launchd service). Facts below were observed by the orchestrator; any line
marked PENDING has not been run and is not claimed.

| ID | Step / input | Result |
|---|---|---|
| W6-O1 | Operations UI sign-in (Chromium, per-start token from `ops-ui.token`) | FAIL W6-L01 — refused with "허용되지 않은 출처예요": under `Referrer-Policy: no-referrer` Chromium sends `Origin: null` on the same-origin sign-in POST, which the ADR-0113 D4 exact Origin check rejects → FIXED PR #131 (d305d21, header and referrer meta `same-origin`; Origin check, CSRF, loopback bind and CSP unchanged). Retest PASS — browser sign-in succeeded |
| W6-M1 | LLM-2 re-run of the model comparison with the helpfulness checks (`answer-quality-checkers-v2`, Ollama only) | DONE — granite3.3:8b best: `containsRelevantTokens` 9/10 (llama3.1:8b 7/10, gemma3:4b 0/10); `hedgesUncheckable` 3/4 (llama3.1:8b 1/4); `noInventedSpecifics` 4/4; `languageMatches` 96.9% (qwen3:8b 16.1%). Other per-model cells are not recorded here |
| W6-M2 | Host spec check on the owner's Mac (Apple M3 Pro, 18 GB) | PASS — granite3.3:8b loads at 5.7 GB, 100% GPU; 15–17 tok/s idle and 15.3 tok/s under heavy CPU load; cold load about 16 s. The Ollama default keep-alive (5 min) is kept |
| W6-M3 | Service model switch (operator change, no code change) | DONE — `OLLAMA_MODEL=granite3.3:8b` on the service (ADR-0105 D1) |
| W6-M4 | First live check of granite3.3:8b on the service (4 chat prompts) | INCONCLUSIVE — the Ollama readiness probe (5 s) failed at startup while the host load average was about 20 from unrelated Gradle builds, so 3 of 4 replies came from the Claude CLI fallback (77–142 s). The one granite reply (110 s, including a 40 s embedding-recall timeout) still invented song and artist names (same shape as QA-V3-W2-LM) |
| W6-M5 | granite3.3:8b live re-test on an idle host (daily-chat prompts, latency, invented specifics) | **PENDING** — not run |
| W6-A1 | OPS-2b (UI approve and reject, PR #132) merged after 4 Codex rounds: round 1 P1 (reset, expiry and override send bypassed the approval lock), round 2 P2 (a stale chat `touch` overwrote a UI-set anchor), round 3 P2 (unlocked, non-atomic field-scoped session saves), round 4 PASS | DONE offline — `pnpm build`, `pnpm typecheck`, `pnpm test` green (314 files, 9600 tests per the PR) |
| W6-A2 | Live UI approve and reject (confirmation code from the chat preview, `OPS_DECISION_RESULT` DM, chat/UI race) on a DB copy against the sandbox repository | **PENDING** — not run |

Wave 5 follow-ups: W5-L01..L04 were fixed in PR #130 (cf0e70b, d63860c) and unit-tested; a live re-run of those four
inputs is not recorded (**PENDING**).

### v3 live items still PENDING at closeout (each needs its own session; none is claimed)

- W6-M5 granite3.3:8b on an idle host, and the LLM live QA set (QA-V2-003/008/W7-06 re-run plus a 20-prompt Korean
  daily-chat set, plan LLM track).
- W6-A2 operations UI approve/reject; OPS-2 reminder cancel and memory forget from the UI; the per-panel check against
  chat output, a foreign-Origin request and token rotation across a restart (ADR-0113 live QA).
- MM: attachments live (text log, screenshot with a local vision model set in `QUOKY_OLLAMA_VISION_MODEL`, oversize,
  unsupported type, non-allowlisted channel, injection caption).
- LRN: `후보 N 메모`, `예시로 저장` and example injection with `QUOKY_LEARNING_EXAMPLES_ENABLED=true` (only the empty
  `피드백 후보` state ran live, M3).
- CWR: network failure mid-send (`UNCERTAIN` path); W5-L01..L04 re-run.
- SUB: reboot start, scheduled daily backup observed on the host, and a restore drill on a DB copy (only the SUB-2
  pre-migration backup ran live, DP1/D4).
- DET: the ~40-phrasing edge-case sweep per feature state (wave 1 covered a sample).
- Slack read lookups (no user token; v2 PC-9 NOT RUN). SUB-3, CODE-8, CODE-9 and LLM-3 were not implemented.
