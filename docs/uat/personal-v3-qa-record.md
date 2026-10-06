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
