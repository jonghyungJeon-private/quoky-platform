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
