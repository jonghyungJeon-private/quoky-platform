# Personal v4 — QA record

Owner-attended live QA of Personal v4 on the deployed always-on service. Same conventions as `personal-v3-qa-record.md`:
IDs, PASS/FAIL, fixes and residuals are recorded faithfully, and nothing here claims a step that was not run. "Pending"
means not run; it is never a soft pass. The offline acceptance suite for the same tracks is
`apps/quoky/src/personal-v4-acceptance.test.ts` (INT-3); it proves behaviour against fakes and is not a live result.

## Session 1 — 2026-10-12 (owner present; every step executed through ego-browser on the deployed service)

### Google read connectors (GML-1 Gmail, DRV-1 Drive)

The owner completed the Gmail and Drive consent.

| ID | Input / step | Result |
|---|---|---|
| G1 | `안 읽은 메일` (DM) | PASS — listed 2 |
| G2 | `오늘 온 메일` | FAIL, then FIXED — first reply "응답을 해석하지 못해서". Root cause: Google answered HTTP 204 (no body) to a partial-response list with no match, and the client expected JSON. Fixed in #171 (a 204 list is an empty result). Re-test PASS: "오늘 받은 메일이 없어요" |
| G3 | `1번 메일 요약해줘` | PASS — summary with the untrusted-content footer |
| G4 | `최근 문서` | PASS — listed 53 |
| G5 | `1번 문서 요약해줘` on a Google Sheet | PASS |
| G6 | `메일 보내줘` | PASS — the fixed read-only refusal |
| G7 | `드라이브 코스 찾아줘` | Observed — fell through to ordinary chat (not a Drive name search; the grammar expects `드라이브에서 <이름> 찾아줘`) |
| G8 | `안 읽은 메일` in the QA channel | PASS — the DM-only refusal, no read |
| G9 | Summary text showed literal `**` markers | FIXED in #172 (Core strips emphasis and heading markers from document summaries). Fix verified by offline tests; the re-run on the live service is not recorded |

### Telegram (TG-1, TG-2, TG-3)

The owner created the bot. The token was entered through a hidden dialog. An earlier token had been pasted into the chat
by mistake; it was revoked with BotFather `/revoke` and replaced before use. Identity was verified and polling started.

| ID | Input / step | Result |
|---|---|---|
| T1 | START | PASS |
| T2 | `오늘 일정` | PASS |
| T3 | `할 일 목록 보여줘` | PASS — same Actor: the to-do added on Discord was visible |
| T4 | `안 읽은 메일` (private chat) | PASS |
| T5 | A reminder created on Telegram | PASS — delivered on Telegram at 12:40 |
| T6 | An image with a caption | PASS — answered correctly in 12 s |
| T7 | A 👍 reaction on a reply | PASS — recorded in `feedback_signals` as `REACTION POSITIVE`. **This settles the TG-2 spike: `message_reaction` is delivered in private bot chats.** |

### Morning brief and pre-meeting reminders (BRF-1, BRF-2)

| ID | Step | Result |
|---|---|---|
| B1 | The daily brief | PASS — fired every day from 10/9 to 10/12 at 08:00; its calendar section matched `오늘 일정` |
| B2 | A test event created through Quoky with approval (13:30), a reminder 10 minutes before, then the event moved to 13:45 through Quoky with approval | PASS — at 13:20 nothing was sent and the tick logged `eventRescheduled=1`; at 13:35 the reminder was delivered once with "…오후 1:45에 시작해요". The test event was then deleted through Quoky |

### Merge enablement (CODE-9, strict)

`QUOKY_GIT_MERGE_ENABLED` was temporarily `true` on the service, as the owner chose. Sandbox repository
`quoky-uat-sandbox`, scenarios A → B → C.

| ID | Step | Result |
|---|---|---|
| C1 | A new-file change, commit, push, pull request | PASS — commit `7cdea1e`, push, PR #3 |
| C2 | Merge | PASS — merge commit `5c11cad`, verified MERGED on GitHub |
| C3 | Main sync, local branch cleanup, remote branch deletion | PASS after one fix to the reply: the first local branch cleanup was refused because the branch was checked out (the reply now names that reason, #172); after switching to `main` it passed. Main was untouched and only `main` remains |
| C4 | The flag after the run | Set back to `false` |

### Settings now on

`QUOKY_BRIEF_JIRA_ENABLED=true` and `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=true` (the second only matters once a remote
chat provider is the owner's explicit selection and `QUOKY_LEARNING_EXAMPLES_ENABLED` is on).

## Earlier live checks (2026-10-08)

- UNC-1 network-fault test, live (#155). See the ADR-0112 note in `DECISIONS.md`.
- DET-2 and TBL-1 live checks.

## Pending (not run; not claimed)

| Item | Why it is pending |
|---|---|
| PRV-1 OpenAI API provider, live | No API key has been issued to the service. Offline only |
| PRV-2 Gemini API provider, live | No API key. Offline only |
| PRV-3 monthly usage DM | First fires in November. The usage ledger and the ops panel were not live-checked with a real DM |
| BRF-1 Jira section of the brief | The setting is now on; the first check is the next morning's brief |
| LRN-5 remote examples, live round trip | No remote provider is selected (none is configured), so no example has left the host |
| TG-3 Telegram ops panel, visual check | Not looked at in a browser |

## Fixes from this session

| PR | Fix |
|---|---|
| #171 | A 204 No Content list from Gmail or Drive is an empty result |
| #172 | Document summaries lose literal Markdown markers; code-work next-step copy names the execute phrases; a refused local branch cleanup names its reason |
