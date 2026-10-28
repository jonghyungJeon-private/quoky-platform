---
name: quoky-ship
description: Quoky Platform 전용 출하 파이프라인. side-job 스킬을 호출해 worktree, 실행 방식, 모델 선택(Codex 레인이 열려 있으면 Codex 병행 작업 포함)을 처리한 뒤, 오프라인 검증 → 독립 리뷰(Codex PASS, 필요 시 Chief Architect) → rebase → Push → PR → Merge → 상시 서비스 배포 → 스모크(quoky-e2e) → 소유자 보고까지 진행한다. Triggers - "quoky-ship", "출하", "머지하고 배포", "ship", "v4 작업 진행", "웨이브 진행", "PR 올리고 머지".
---

# Quoky Ship (side-job + Quoky 출하 절차)

이 스킬은 Quoky 저장소 전용이다. 공통 절차(worktree 격리, 실행 방식, 모델 선택)는 **side-job 스킬을 호출해** 처리하고, 이 스킬은 그 위에 Quoky 출하 절차만 얹는다.

**상시 승인**: 소유자가 v4 웨이브에 대해 "오프라인 검증 + Codex PASS 후 자동 Push → PR → Merge, 배포"를 승인했다(v3와 같은 조건, 2026-10-08 갱신). 이 승인 범위를 벗어나는 Strict 항목(§7)은 그때마다 따로 묻는다.

> **이전(migration) 메모 (2026-10-21):** 이 `SKILL.md` 는 예전에 main checkout 에 **추적되지 않는 파일**로 있었다. 이 브랜치를 main checkout 에서 pull/merge 하기 전에 `mv .claude/skills/quoky-ship/SKILL.md .claude/skills/quoky-ship/SKILL.md.local-bak` 로 치워 둬야 "untracked working tree files would be overwritten" 로 멈추지 않는다. `scripts/` 안의 나머지 untracked 파일(`chat/`, `qa/`, `space_id` 등)은 그대로 둔다.

## 1. 착수: side-job 호출

- Skill 도구로 `side-job` 을 호출한다. 넘기는 인자는 다음과 같다.
  - 저장소: `/Users/seongsujeonjonghyeong/demo_Project/quoky-platform`
  - 베이스: `origin/main`(먼저 fetch)
  - 브랜치명: `claude/<wave>-<task>`
  - `.env.local` 은 복사하지 않는다(코드 작업에는 필요 없음).
  - upstream 은 해제한다.
- side-job §6.5 에 따라 실행 방식을 정하고, 모델·effort 는 `token-budget` 스킬로 정한다(등급 J1/J2/J3/I/M/X, effort = min(기준값, 세션 effort), 예산 모드 포함). Quoky 작업의 등급은 다음과 같다.
  - **J1**: 새 egress·inbound·인증·플랫폼 어댑터·새 provider 설계, ADR 설계·해석·충돌, 필수 CA 대상(PLT-0, TG-1, PRV-1, LRN-5, GML-1, PRV-3, 새 커넥터)의 첫 리뷰
  - **J2**: 기존 쓰기·권한 경로의 보안 수정(token-budget §2 예외는 소유자 승인 전까지 쓰지 않는다), 기존 ADR 안의 설계, 일반 CA 리뷰, 원인 불명 평가 회귀 디버깅
  - **J3**: CA·Codex 지적 수정분의 delta 재리뷰, 조항이 명확한 ADR 대조
  - **I**: 여러 파일에 걸친 명세가 분명한 기능, 평가 실패 원인 분석·분류
  - **M**: 작고 명확한 리뷰 지적, 테스트 행, 문서·기록(DECISIONS/CHANGELOG/CURRENT_STATE), 소유자 승인 골든 반영·승인 표시·시트 상태 갱신, 단순 rebase 충돌 해소
  - **X**: 판단 모델 평가 실행(eval 3회, probe)과 결과 요약, 검증 실행, 승인된 배포 명령, worktree 정리
- 구현 에이전트에게 반드시 지시할 것:
  - `AGENTS.md` 의 loading router 를 따른다.
  - 관련 ADR 과 `docs/plans/personal-v4-plan.md` 해당 행을 읽는다.
  - `DECISIONS.md` 에 구현 노트를, `CHANGELOG.md` 와 `CURRENT_STATE.md` 에 항목을 남긴다.
  - 커밋은 conventional 형식으로 하고 `Co-Authored-By` 트레일러를 넣지 않는다. push 는 하지 않는다.
  - 토큰처럼 생긴 리터럴을 쓰지 않는다. 테스트의 가짜 키는 조각을 이어 만든다.
  - Core 에 provider·platform 분기를 넣지 않는다.

## 1.5 Codex 병행 작업 (소유자 지시 2026-10-28)

Codex 레인이 열려 있으면(token-budget §3.5, `bash ~/.claude/skills/token-budget/scripts/codex-usage.sh` exit 0 = Codex 5h < 90% 그리고 7d < 95%) Claude 에이전트와 **함께** Codex 에도 작업을 나눠 준다. Codex 만 쓰지 않는다. 주 구현·판단은 Claude 에이전트가 맡는다.

- **언제 확인하나**: 웨이브 착수 때, 그리고 Codex 에 작업을 하나 줄 때마다. 닫혀 있으면 그 작업은 Claude 에이전트가 맡는다.
- **맡겨도 되는 Quoky 작업**(Claude 작업과 파일이 겹치지 않을 것):
  - 명세가 확정된 I·M 구현, 테스트 행, 골든 fixture 재생성(소유자 승인 골든에 한함), DECISIONS/CHANGELOG/CURRENT_STATE 초안
  - 평가 결과 파일(`data/eval/*.json`)의 오프라인 실패 분류, 코드 경로 조사
- **맡기지 않는 것**: J1·J2(새 경계·쓰기·권한 경로·ADR 해석), §7 Strict 항목 전부(모델 호출 평가, `.env.local`, live UAT, 배포·재시작), push·PR·merge, 전체 `pnpm test`, 소유자 결정이 필요한 골든·정책 변경.
- **실행**: Codex 전용 worktree `claude/<wave>-<task>-codex` 를 Claude 작업 브랜치의 현재 HEAD 에서 만들고,
  `codex exec -s workspace-write -C <codex worktree> -o <scratchpad>/codex-<task>.md "<지시문>"` 을 Bash `run_in_background` 로 돌린다. 끝나면 오케스트레이터가 Codex 커밋을 Claude 작업 브랜치로 cherry-pick 한다.
- **지시문에 반드시 넣을 것**(§1 구현 에이전트 지시와 같은 규칙):
  - `AGENTS.md` loading router, 관련 ADR 조항, 바꿀 파일 범위(이 밖은 건드리지 않는다)
  - Node 22 PATH 줄(§2), 대상 테스트만(`pnpm vitest run <파일>`), 전체 suite 금지
  - 단어 목록·하드코딩·골드 맞추기 금지, 실제 제3자 이름 금지, 토큰처럼 생긴 리터럴 금지
  - conventional 커밋, `Co-Authored-By` 트레일러 금지, push 금지, 모델 호출 평가 금지
  - 마지막 메시지 형식: `커밋 목록 · 바꾼 파일 · 대상 테스트 결과 · 미해결점`
- **리뷰**: Codex 가 쓴 커밋은 §3 의 Codex 리뷰 대신 Claude 리뷰어(J3 이상, 경계면 J2)가 독립 리뷰한다. 같은 PR 의 Claude 작성분은 지금처럼 Codex 리뷰를 받는다. 오프라인 검증(§2)은 합친 브랜치에서 한 번 한다.
- **보고**(§8): `Codex · <작업> · 결과 · 레인 값(5h%/7d%)` 을 에이전트 목록에 같이 남긴다.

## 2. 오프라인 검증 (worktree 안에서)

**Node 버전 (2026-10-13~):** 저장소 기준은 `.nvmrc`(22.22.1)다. 셸 기본 node는 아직 18일 수 있으므로 모든 pnpm/node 명령 앞에 `export PATH=$HOME/.nvm/versions/node/$(cat .nvmrc | sed 's/^v//;s/^/v/')/bin:$PATH` 를 붙이고, 구현 에이전트에게도 같은 지시를 준다. worktree 의 `better-sqlite3` 가 다른 ABI(NODE_MODULE_VERSION 불일치)로 빌드돼 있으면 `~/Library/Application Support/Quoky/rollback-node18/better_sqlite3.node22.node` 를 `build/Release/better_sqlite3.node` 로 복사한다(로컬 node-gyp 컴파일은 macOS 27 SDK 문제로 실패한다). 롤백용 Node 18 바이너리: `~/Library/Application Support/Quoky/rollback-node18/`.

```bash
pnpm install --frozen-lockfile   # rebase 로 새 패키지가 들어왔으면 필수
pnpm build && pnpm typecheck && pnpm test
git diff --check origin/main..HEAD
git log origin/main..HEAD --format=%B | grep -ci co-authored   # 0 이어야 함
```

실패는 숨기지 않는다. 시계에 의존하는 테스트가 실패하면 별도 PR 로 고친다(#162 선례).

**테스트 메모리 안전 (2026-10-16 PC 멈춤 사고):** vitest 작업 프로세스 하나가 약 3.5GB 이고 이 PC 메모리는 18GB 다. 부모 명령이 시간 초과로 끊기면서 남은 작업 프로세스 8개(약 28GB)가 스왑을 채워 PC 가 멈췄다.
- 전체 `pnpm test` 는 모든 에이전트를 통틀어 **한 번에 하나만** 돌린다. 구현 에이전트는 `pnpm vitest run <관련 파일>` 로 대상 테스트만 돌리고, 전체 실행은 오케스트레이터가 PR 직전에 한 번 한다. 구현 에이전트 지시문에 이 규칙을 넣는다.
- **전체 실행 잠금 (2026-10-21~):** `pnpm test`(인자 없음 또는 옵션만)는 `tools/test-lock/run-full-suite.mjs` 를 거쳐 기계 전체 잠금 `~/Library/Application Support/Quoky/locks/full-suite`(`mkdir` 잠금, `owner` 파일에 PID·vitest PID·worktree)을 잡는다. 다른 전체 실행이 잡고 있으면 메시지를 내고 기다린다. `QUOKY_TEST_NO_WAIT=1 pnpm test` 는 기다리지 않고 exit 75 로 끝난다. 잡은 프로세스와 vitest 가 모두 죽었으면 오래된 잠금으로 보고 넘겨받는다. 대상 실행(`pnpm vitest run <파일>`, 또는 옵션이 아닌 인자가 하나 이상이고 **모두 실제로 존재하는 일반 파일**인 `pnpm test <파일>`)은 잠금을 잡지 않는다. 필터 문자열·디렉터리·옵션 값(`--reporter verbose`)이 섞이면 전체 실행으로 보고 잠금을 잡는다. `pnpm test --version/-v/--help/-h` 는 버전·도움말만 출력하고 테스트를 돌리지 않는다. 잠금은 부팅 이전에 기록됐거나 기록된 PID 가 node 가 아니거나 기록된 시작 시각과 맞지 않으면(PID 재사용) 오래된 것으로 본다. 살아 있는 잠금은 옮기지 않으며, 넘겨받기는 `<잠금>.takeover` mutex(30초 뒤 stale) 안에서 소유자를 다시 확인한 뒤에만 지운다. 값을 받는 옵션(`--config x` 등)의 값은 파일로 치지 않고, 인자는 `*.test.*`/`*.spec.*` 모양이면서 실제 존재해야 한다. 넘겨받기 mutex 는 무작위 토큰으로 소유를 확인하고 `ps` 없이 소유자 신원만 비교한다. 래퍼가 SIGKILL 로 죽어도 vitest 쪽 watchdog 이 2초 안에 프로세스 그룹을 정리하고, 래퍼에 두 번째 SIGINT/SIGTERM 을 보내면 그룹에 SIGKILL 을 보낸다. 잠금 처리만 확인할 때는 `QUOKY_TEST_LOCK_DRY_RUN=1`(vitest 를 띄우기 직전에 exit 0). 래퍼는 vitest 를 별도 프로세스 그룹으로 띄워, 끊기면 작업 프로세스까지 함께 정리한다.
- 전체 실행 전에 `uptime` 과 메모리를 확인하고, 부하가 높으면 기다린다.
- 테스트 명령이 시간 초과로 끊기거나 강제로 끝나면 `ps -axo pid,ppid,rss,command | grep vitest` 로 부모가 없는(PPID 1) 작업 프로세스를 찾아 정리한다.
- vitest 설정은 `maxWorkers` 2, `pool: 'forks'` 가 기본이다(`QUOKY_TEST_MAX_WORKERS` 로 조정).

## 2.5 판단 모델 평가 게이트 (`run-gates.sh`)

D12 / S2 게이트(eval:nl `intent`·`action`·`read-regression`·`r2`, `agent-plan`, `r2-redteam`)는 손으로 띄우지 않고 이 스크립트로 돌린다. tmux 세션에서 분리 실행되므로 Claude 세션이 재시작돼도 계속 돈다.

```bash
S=.claude/skills/quoky-ship/scripts/run-gates.sh
bash $S start <worktree> gates-<topic>-<sha8>-<yyyymmdd> [modes...]   # 기본 modes: action read-regression r2
bash $S status gates-<topic>-<sha8>-<yyyymmdd>                       # 요약: 전체 %, 게이트, 90% 미만 항목, 오답·부정 포착
bash $S status                                                       # 최근 아카이브 10개와 상태
tmux attach -t gates-<name>                                          # 진행 보기(분리: C-b d)
```

- 순서: 사용량 확인 → `pnpm build` → 모드마다 사용량 확인 → plan(digest) → run. 같은 옵션(`--model haiku --runs 3 --concurrency 4`, `GATES_MODEL`/`GATES_RUNS`/`GATES_CONCURRENCY` 로 변경)을 plan 과 run 에 똑같이 넘긴다. `intent`·`agent-plan`·`r2-redteam` 은 plan/run 모드로, 나머지는 같은 모드에 digest 를 붙여 돌린다. `r2-redteam` 은 `--runs` 만 넘긴다(요약 모델은 CLI 기본값, `GATES_REDTEAM_MODEL` 로 지정).
- 아카이브: `~/Library/Application Support/Quoky/eval-archive/<name>/` 에 `head.txt`, `build.log`, `usage.log`, `run.log`, `digests.txt`, `<mode>.plan.log`, `<mode>.log`, `<mode>.report.json`(worktree 의 `data/eval` 보고서 사본)을 남긴다. 실행 중에는 `RUNNING`, 끝나면 `DONE`(모드마다 `<mode> exit=<n> status=<PASSED|FAILED|INVALID|…>`, 마지막 줄은 끝난 시각)이 생긴다.
- **사용량 사전 확인**: `npx ccusage@20.0.37 blocks --active --json`(버전 고정, 20초 제한, `GATES_CCUSAGE_VERSION` 으로 변경) 의 현재 블록 비용이 보정 한도 $218 의 95% 이상이면 블록이 끝날 때까지 기다린 뒤 시작한다(`QUOKY_USAGE_LIMIT_USD`, `GATES_USAGE_PCT`).
- **INVALID(exit 5)**: 실행 중 provider 가 쓸 수 없게 되면(사용량·세션 한도) 평가 CLI 가 남은 호출을 멈추고 `INVALID (provider unavailable: <reason>)` 로 끝낸다. PASSED/FAILED 가 아니므로 회귀로 읽지 않는다. 스크립트는 사용량 블록이 리셋된 뒤 **모드마다 한 번만** 자동 재시도하고(`GATES_NO_RETRY=1` 로 끔), 같은 모드가 다시 INVALID 면 남은 모드를 돌리지 않고 멈춘다. 사유(또는 canary 실패 사유)가 `provider-auth_required` 나 `timeout-streak` 이면 사용량 한도가 아니므로 기다리거나 재시도하지 않고 즉시 멈추며 사유를 출력한다. 실행이 TERM/INT/HUP 으로 끊기면 `DONE` 에 KILLED 표시가 남고, `status` 는 RUNNING 의 pid 가 살아 있는지 확인한다(SIGKILL 은 `DEAD` 로 표시). 첫 시도 로그는 `<mode>.invalid-attempt1.log` 로 남는다.
- **`run-gates.sh run` 의 종료 코드**: 0 = 요청한 모든 모드가 PASSED(또는 NON-GATING), 1 = FAILED 모드가 하나라도 있음, 2 = FAILED 없이 BLOCKED/USAGE/건너뜀(plan digest 없음)이 있거나 build 실패, 5 = INVALID 만 남음(INVALID 로 멈춰서 안 돈 나머지 모드는 세지 않음). 우선순위 1 > 2 > 5. `DONE` 마커와 `status` 는 그대로다.
- 평가 CLI 의 종료 코드: 0 PASSED, 1 FAILED, 2 USAGE, 3 BLOCKED, 4 NON-GATING, 5 INVALID. 판정 기준(provider 실패 연속 5+2×동시성 회, 시간 초과 연속 10+2×동시성 회, 또는 provider 실패가 호출의 5% 초과이며 중간 판정은 max(40, 계획 최대 호출의 10%) 호출부터)은 `apps/quoky/src/tools/eval-provider-guard.ts` 에 있다. 기준에 닿으면 같은 provider 로 아주 짧은 canary 호출을 **백그라운드로**(호출을 막지 않아 지연·bound 초과율은 그대로) 하고(실행 중 최대 3회 + 끝날 때 연속 실패로 끝났으면 예약된 마지막 1회, 합계 4회, 계획 출력에 `up to 4 canary calls (not counted)`, 3회가 끝나면 그대로 채점하되 마지막 1회로 꼬리 장애를 확인; 실패 사유는 `canaryFailure` 로 기록), 답하면 장애가 아니므로 INVALID 없이 그대로 채점한다(too-long, 콘텐츠 필터 400, 지연 악화는 FAILED 로 드러남). **이미 관측된 하드 실패(오답 포착, 잘못된 대상, 부정 포착, red-team 성공; 단 `help.topic` 오포착은 run 부정 골드의 ceil(1%)까지 허용되고 그 초과분만 하드 실패, owner 결정 2026-10-22; `agent-plan` 게이트의 `help.topic` 한 단계 계획도 같은 기준, owner 결정 2026-10-26; `agent-plan` 의 multi-step exact 는 run 들을 합친 pooled 비율로 판정하고 나머지 기준은 run 마다, owner 결정 2026-10-26)가 있으면 장애가 겹쳐도 FAILED(exit 1, `(provider outage also seen: <reason>)`)이고**, INVALID 출력에도 하드 실패 개수(0)를 함께 적는다. 산발적인 실패·시간 초과·파싱 실패는 지금처럼 점수에 들어간다.
- 프롬프트 변경은 이 게이트를 통과하기 전에 배포하지 않는다(§3.5).

## 3. 독립 리뷰 게이트

- **Codex**: `mcp__codex-cli__codex` 를 `sandbox: read-only`, `workingDirectory: <worktree>` 로 호출한다. 프롬프트 규칙은 다음과 같다.
  - diff 범위를 명시한다.
  - hard requirements 를 나열한다.
  - "Do not modify files. Do not print file contents. Final answer ≤N lines: PASS or concrete P1/P2 with file:line" 를 넣는다.
  - `codex review --base` 는 프롬프트와 함께 쓸 수 없다.
  - 출력이 너무 길면 파일로 저장되니 끝부분에서 판정을 찾는다.
  - 사용량 한도로 끊긴 실행은 PASS 로 보지 않는다. 리셋 뒤 다시 실행한다.
- **Chief Architect 리뷰는 필수**다. `code-reviewer` 에이전트로, 구현자와 독립적으로 수행한다. 필수 대상의 첫 리뷰는 J1, 그 외는 J2 다(token-budget). 필수 대상은 다음과 같다.
  - PLT-0, TG-1, PRV-1, LRN-5, GML-1, PRV-3
  - 새 egress, 새 inbound surface, Core 경계 변경. DRV-1 같은 커넥터가 여기에 해당한다.
  - 판정이 CHANGES REQUIRED 이면 수정한 뒤 재리뷰를 받는다.
- **delta 리뷰**: 수정 후에는 `git diff <이전 리뷰 시점>..HEAD` 만 다시 Codex 에 맡긴다. Claude 쪽 delta 재리뷰는 J3 이고, 수정이 인증 순서·기본값·공용 helper·실패 동작을 바꿨으면 J2/J1 로 올린다.
- **Claude ↔ Codex 이견**: token-budget §5 를 따른다(최대 2라운드, 소유자 규칙 → ADR → 재현 근거 → 판단 순, 경계 위험은 엄격한 쪽, 정책 변경은 소유자 결정). 보고에 쟁점별 `Claude 안 / Codex 안 / 결론` 을 남긴다.
- **fix loop 상한**: 같은 지적의 수정은 2회까지다. 그 뒤에는 오케스트레이터가 범위 축소, 잔여 위험으로 수용, 중단 중 하나를 정하고 해당 ADR 구현 노트에 기록한다.
- **ADR 충돌**: 구현이나 결정이 `ARCHITECTURE.md` 또는 확정된 ADR 과 충돌하면 멈추고, ADR 에 맞추거나 소유자에게 보고한다. ADR 을 우회하는 예외를 스스로 만들지 않는다.
- **리뷰 지적 반영에 쓰는 모델 (보내기 전에 분류부터)**: 리뷰 결과를 받으면 지적마다 먼저 분류한 뒤 나눠 보낸다(token-budget §2 등급표).
  - J1·J2 지적(쓰기·권한 경로, 새 경계 규칙, ADR 해석) → 원래 opus 에이전트에 SendMessage 로 이어서(모델·effort 는 처음 값 그대로).
  - M 지적(문구, 테스트 행, 정답·기록 갱신, 주석, 오래된 문서 줄) → 새 haiku · medium 에이전트(여러 파일 I 면 sonnet · high)에 같은 worktree 로.
  - 한 라운드에 두 종류가 섞이면 쪼개서 동시에 보낸다. 같은 파일을 건드리면 opus 작업이 끝난 뒤 haiku 를 띄운다.
  - 보고서에 token-budget §6 형식(예산 줄 + 에이전트별 `<등급> · <model> · <effort>`)으로 라운드마다 남긴다.

## 3.5 Review loop discipline (2026-10-21~)

- **휴리스틱은 2라운드까지.** 같은 휴리스틱 계열(예: 단어 목록, 정규식, 문장 모양 판별)에 대한 Codex 지적이 2라운드 이어지면 3라운드째 휴리스틱을 덧대지 않는다. 구조적 규칙(닫힌 값 집합, 검증기·스키마 제약, 경계에서의 fail-closed 거부)으로 좁혀 다시 설계한다.
- **fail-closed 잔여 사례는 기록하고 쫓지 않는다.** 구조적 규칙이 안전한 쪽(거부·질문·none)으로 실패하는 남은 엣지 사례는 해당 ADR 구현 노트(`DECISIONS.md`)에 사례 id·이유·위험과 함께 적고 닫는다. 잘못 실행되거나 잘못된 대상을 잡는(fail-open) 사례만 계속 고친다.
- **프롬프트 변경은 D12 게이트 통과 전에 배포하지 않는다.** 프롬프트 버전이 바뀐 PR 은 §2.5 의 해당 모드가 모두 PASSED(INVALID·FAILED 아님)인 head 에서만 머지·배포한다. 게이트를 돌린 뒤 프롬프트가 또 바뀌면 다시 돌린다.
- **전체 테스트는 rebase 뒤에, 깨끗한 트리에서만.** 순서는 fetch → rebase → 확인 → `pnpm test` 다. rebase 명령의 종료 코드가 0 인지 확인하고, `git status` 에 `rebase in progress`, `Unmerged paths`, 충돌 표시(`UU`/`AA`/`DU` 등)가 없는지 본다. rebase 중간 상태의 트리에서는 전체 테스트를 돌리지 않는다(결과가 어느 커밋의 것인지 알 수 없고, 잠금만 오래 잡는다).

  ```bash
  git -C <wt> fetch -q origin && git -C <wt> rebase origin/main; echo "rebase exit=$?"   # 0 이어야 함
  git -C <wt> status --short | grep -E '^(UU|AA|DD|AU|UA|DU|UD) ' && echo CONFLICT
  test -d "$(git -C <wt> rev-parse --git-path rebase-merge)" -o -d "$(git -C <wt> rev-parse --git-path rebase-apply)" && echo "REBASE IN PROGRESS"
  ```

## 4. Rebase

```bash
git -C <wt> fetch -q origin && git -C <wt> rebase origin/main
```

- **append-only 문서 자동 병합 (2026-10-21~):** `.gitattributes` 가 `DECISIONS.md`, `CHANGELOG.md` 에 `merge=union` 을 건다. 로컬 rebase·merge 에서 양쪽이 덧붙인 줄은 충돌 없이 모두 남는다. 주의: union 은 충돌을 보여주지 않으므로 양쪽이 같은 기존 줄을 고쳤으면(예: 기존 항목의 `Status:` 줄을 제자리에서 수정) 양쪽 버전이 다 남을 수 있고, 똑같은 줄을 양쪽이 넣었으면 두 번 들어갈 수 있다. rebase 뒤 반드시 `grep '^## ' DECISIONS.md | sort | uniq -d`(중복 제목이 나오면 안 됨)와 `git diff ORIG_HEAD -- DECISIONS.md CHANGELOG.md` 로 확인한다. GitHub 의 충돌 검사는 이 설정을 따르지 않으므로 PR 전에 로컬에서 rebase 한다. `CURRENT_STATE.md` 는 제자리 수정되는 status 절이 있어 union 에서 뺐다.
- `CHANGELOG.md`, `CURRENT_STATE.md` 충돌(union 이 적용되지 않은 경우 포함)은 양쪽을 모두 보존해 해소한다(`python3 .claude/skills/quoky-ship/scripts/resolve_changelog.py <file>`).
  - Bash 셸이 zsh 라서 충돌 목록은 `echo "$c" | while read f; do …; done` 으로 돌린다.
- **문서 파일에만 쓴다.** `resolve_changelog.py` 는 양쪽을 이어 붙이므로 `CHANGELOG.md`, `CURRENT_STATE.md`, `DECISIONS.md` 같은 append-only 문서에만 쓴다. 충돌 루프는 반드시 이 세 파일로 걸러서 돌린다:
  `echo "$c" | grep -E '^(CHANGELOG|CURRENT_STATE|DECISIONS)\.md$' | while read f; do …; done`
  코드(.ts 등)나 다른 문서에 충돌이 있으면 `git rebase --abort` 하지 말고 그 상태로 멈춰서 구현 에이전트에게 두 기능을 모두 살리는 수동 병합을 맡긴다(2026-10-13 GML-2×DRV-2b 사고: 코드 파일에 스크립트를 적용해 빌드가 깨짐).
- 그 밖의 충돌은 구현 에이전트에게 돌려보낸다.
- 새 커밋이 들어왔으면 §2 를 다시 돌린다. rebase 종료 코드와 `git status` 확인(§3.5)을 먼저 한다.

## 5. Push → PR → Merge

```bash
export PATH=/opt/homebrew/bin:$PATH   # 재부팅 뒤 셸에 gh 가 없을 수 있음
export GH_TOKEN=$(gh auth token --user jonghyungJeon-private)   # 절대 gh auth switch 금지
git -C <wt> push -q -u origin <branch>
cd <wt> && gh pr create --base main --head <branch> --title "<conventional title>" --body-file <scratchpad>/pr-<task>.md
gh pr merge <N> --merge
```

PR 본문에 넣을 내용:
- 요약(ADR 번호)
- 설계 요점
- 리뷰 이력: 라운드별 지적과 수정 커밋, 최종 PASS 와 승인
- 검증 수치
- 소유자 전용 Strict 후속 단계
- 마지막 줄: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

## 6. 배포 → 스모크 → 보고 → 정리

```bash
D=/Users/seongsujeonjonghyeong/demo_Project/.worktrees/quoky-platform/quoky-service
export PATH=$HOME/.nvm/versions/node/v22.22.1/bin:$PATH   # 서비스는 Node 22 (plist --node)
cd $D && git fetch -q origin && git checkout -q --detach origin/main \
  && pnpm install --frozen-lockfile && pnpm build \
  && bash ops/launchd/quokyctl.sh restart --apply --repo $D
tail ~/Library/Logs/Quoky/quoky.log    # "[quoky] started" 확인
```

- 다른 worktree 의 fetch 와 겹쳐 ref lock 오류가 나면 다시 시도한다(빌드가 옛 코드로 돌았을 수 있다).
- **스모크**: ego-browser 의 로그인된 Discord 탭(task space id 는 소유자 로컬 main checkout 의 `space_id`, page `p1`)만 쓴다. 새 탭·새 space 로 우회하지 않는다. 재부팅 뒤에는 space 가 사라지므로 `taskSpace("quoky discord relay")` 로 하나 만들어 Discord 로그인 상태를 확인하고 그 id 를 `space_id` 에 적는다(로그아웃 상태면 소유자에게 로그인을 요청).
  - 실행·판정·되돌리기·보고는 **`quoky-e2e` 스킬**로 한다. 넘기는 요청문은 이 PR 의 변경된 기능 경로와 미설정 기능의 기존 동작이다(범위는 출하 승인으로 갈음하므로 시나리오 표는 보고에만 남긴다).
  - 대상은 QA 채널 또는 Quoky DM(봇 "chunsik-bot")이다. 구체 URL·ID 는 저장소에 두지 않고 로컬 `scripts/chat/` 설정과 메모리(`quoky-*`)에 있다.
  - **`chat/`, `qa/`, `space_id` 는 추적되지 않는다.** 소유자 로컬 main checkout `/Users/seongsujeonjonghyeong/demo_Project/quoky-platform/.claude/skills/quoky-ship/scripts/` 에만 있고 worktree 에는 없으므로, 그 절대 경로로 실행한다.
  - 변경된 기능 경로와 미설정 기능의 기존 동작을 하나씩 확인한다.
- **소유자 보고**: 로컬 main checkout 의 `scripts/chat/send.txt` 에 한국어 업데이트를 쓰고 `scripts/chat/relay-send.sh` 로 `#new_chatting` 에 보낸다. 결정이 필요하면 권장안과 함께 묻고, 응답이 없으면 권장안대로 진행한다고 알린다. 폴러 `scripts/chat/poll.sh 3300`(같은 로컬 경로) 을 백그라운드로 계속 띄워 둔다(종료되면 재시작).
- 헬퍼 스크립트는 재부팅에도 남도록 `.claude/skills/quoky-ship/scripts/` 에 둔다(스크래치패드·/tmp 는 재부팅 때 지워진다). 추적되는 것은 `run-gates.sh` 와 `resolve_changelog.py` 뿐이다.
- **정리**: 미커밋 변경이 없고 main 에 머지된 worktree 만 `git worktree remove` 한다. `quoky-service` worktree 는 절대 지우지 않는다.

## 7. 항상 멈추고 소유자에게 묻는 것 (Strict)

- `.env.local` 편집과 시크릿·API 키 입력
- 서비스 DB 마이그레이션
- 새 외부 대상, 그리고 실제 외부 쓰기·전송. 쓰기 UAT 대상은 Slack `#quoky-test`, Jira BE, primary calendar 로 한정한다.
- OAuth 동의와 범위 추가: Gmail, Drive, Telegram 봇 생성
- GitHub App 설치 변경, merge flag, 실서비스 재부팅

## 8. 보고 템플릿

side-job 보고 템플릿에 다음을 덧붙인다.

```
- 리뷰: Codex <라운드/최종 PASS>, Chief Architect <판정>
- PR: #<N> merged
- 배포: <sha> started, 스모크 <결과>
- 소유자 보고: #new_chatting 게시 여부, 남은 Strict 단계
```
