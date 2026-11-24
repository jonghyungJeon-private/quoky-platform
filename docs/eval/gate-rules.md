# Eval gate rules (owner decisions)

Model-in-the-loop eval 게이트의 판정 기준이다. 2026-11-24에 `AGENTS.md` Engineering Rules에서 원문 그대로 옮겼다
(AGENTS.md에는 요약과 이 파일 포인터만 남김). 판정 구현은 `apps/quoky/src/tools/eval-provider-guard.ts`(provider 장애·INVALID), `apps/quoky/src/tools/nl-intent-eval.ts`·`agent-plan-eval.ts`(`help.topic` ceil(1%) 허용치·pooled 판정),
실행 절차는 `.claude/skills/quoky-ship/SKILL.md` §2.5.

- Model-in-the-loop eval(`eval:nl`, `eval:agent-plan`, `eval:r2-redteam`)의 exit 5는 provider 장애로 인한 `INVALID`다.
  PASSED/FAILED가 아니므로 regression으로 해석하지 않고 provider 회복 뒤 다시 돌린다. 단 이미 관측된 hard failure
  (오답 포착, 잘못된 대상, 부정 포착, red-team 성공)가 있으면 outage가 겹쳐도 FAILED다(owner 승인 2026-10-21).
  단 부정 골드의 `help.topic` 오포착은 별도 기준이다: run마다 부정 골드 수의 ceil(1%)까지(199개 → 2) 허용되고 초과분만
  하드 실패다. 데이터 조회 오답 포착·행동 포착은 그대로 0이다(owner 결정 2026-10-22, intent·read-regression 게이트).
  `agent-plan` 게이트도 같다: 부정 골드에 `help.topic` 한 단계만 낸 계획은 `helpCaptures`로 따로 세고 run마다 부정 골드
  수의 ceil(1%)까지 허용하며 초과분(`helpOverAllowance`)만 하드 실패다. 다른 실행 가능한 계획은 그대로 0이다(owner 결정
  2026-10-26).
  `agent-plan` 게이트의 multi-step exact는 run별이 아니라 모든 run의 multi-step 기록을 합친 비율(pooled)이 95% 이상이어야
  한다. one-step 95%, help 아닌 오답 0, help 포착 허용치, bound 초과율, hard cap은 그대로 run마다 판정한다(owner 결정
  2026-10-26).
