---
name: quoky-e2e
description: Quoky 상시 서비스에 실제 채팅 채널(Discord DM·QA 채널, 필요 시 Telegram)로 말을 걸어 끝에서 끝까지 확인한다. 요청문을 시나리오 표로 바꿔 보여준 뒤 → 사전 점검 → nl-uat.sh 실행 → 결정적 판정(응답·대상·다시 읽기) → 답변 품질 판정 → 쓰기 되돌리기와 원상복구 확인 → 보고. 시나리오는 스킬에 두지 않고 매번 요청문에서 만든다. 모델·effort 는 token-budget 스킬. quoky-ship 배포 스모크도 이 스킬로 돈다. Triggers - "e2e", "e2e 돌려줘", "라이브 테스트", "실서비스 테스트", "UAT 돌려줘", "디스코드로 테스트", "텔레그램으로 테스트", "스모크".
---

# Quoky E2E (실채널 끝-끝 확인)

이 스킬은 **어떻게 돌리는지**만 정한다. **무엇을 돌릴지**는 매번 요청문(소유자 요청, 또는 quoky-ship 이 PR 변경으로 만든 요청)에서 받는다. 고정 시나리오 목록을 두지 않는다.

경로 약속(이하 `$Q`): 헬퍼는 추적되지 않는 소유자 로컬 main checkout 에만 있다.
`Q=/Users/seongsujeonjonghyeong/demo_Project/quoky-platform/.claude/skills/quoky-ship/scripts`
채널 URL·ID 는 이 파일에 쓰지 않는다(`$Q/qa/nl-uat.sh` 와 메모리 `quoky-*` 에 있다).

## 0. 모델·effort

`token-budget` 스킬로 정한다. 이 스킬의 단계별 등급은 다음과 같다.

| 단계 | 등급 |
|---|---|
| 사전 점검, 실행(`nl-uat.sh`), 다시 읽기, 되돌리기, 잠금·정리 | X (haiku · low) |
| 결정적 판정: 응답 여부, 대상 일치, 원상복구 여부 | M (haiku · medium) |
| 답변 품질 판정(시나리오의 기대 체크리스트 대조) | J3 (sonnet · medium, 애매하면 J2) |
| 요청문 → 시나리오 표 변환 | I (sonnet · high). 짧은 요청이면 메인이 직접 |
| 실패 원인 분석 | J2 (opus · high), 분류만이면 I |
| 엉뚱한 대상 쓰기, 권한 누수, 되돌리기 실패 | J1 (opus · cap) + 즉시 중단·보고 |

실행 로그는 길다. 판정 에이전트에는 해당 시나리오 블록만 넘기고, 스크린샷은 실패 확인이 필요할 때만 찍는다.

## 1. 요청문 → 시나리오 표

요청문을 아래 형식의 TSV 로 바꾼다. 파일은 `$Q/qa/e2e-<YYYY-MM-DD>-<slug>.tsv`.

```
# id<TAB>expected<TAB>msg
DM1	<기대: 대상·동작·답 형식, 쓰기면 대상 id 와 되돌리기>	<보낼 말 그대로>
CH1	...	...
```

- **id 접두사로 채널을 정한다**: `CH*` 는 QA 채널, 그 외는 DM(또는 Telegram). 같은 대화 맥락이 필요한 시나리오는 연속 id 로 둔다(예: 조회 → "그 중 …" → "되돌려줘").
- **expected 는 판정 가능한 문장**으로 쓴다: 어느 대상(항목 id·이름)에 무슨 동작, 답에 반드시 있어야 할 것과 없어야 할 것. "잘 답한다" 같은 말은 쓰지 않는다.
- **채널**: 기본은 Discord. 요청문이 Telegram 을 말하거나 Telegram 전용 기능이면 `tg` 도 돈다.
- **쓰기 시나리오**는 허용 대상(Slack `#quoky-test`, Jira BE, primary calendar)에만 만들고, 각 쓰기 뒤에 되돌리기 줄("되돌려줘" 등)과 그 기대(같은 항목이 원래 상태로)를 붙인다. 허용 대상 밖 쓰기가 필요하면 §7 로 멈춘다.
- 보낼 말은 소유자가 실제로 쓸 자연어로 쓴다. 통과시키려고 문구를 기능 키워드에 맞추지 않는다.
- 표를 소유자에게 보여주고 시작한다. quoky-ship 스모크처럼 요청자가 이미 범위를 승인한 경우에는 보고에만 남기고 바로 진행한다.

## 2. 사전 점검 (하나라도 실패하면 실행하지 않고 보고)

1. 서비스: `bash ops/launchd/quokyctl.sh status` 와 `tail ~/Library/Logs/Quoky/quoky.log` 에서 `[quoky] started`. 서비스 worktree(`.worktrees/quoky-platform/quoky-service`)의 HEAD 가 요청이 기대하는 SHA(보통 `origin/main`)인지 확인한다.
2. 브라우저: ego-browser task space(`$Q/space_id`)가 살아 있고 Discord(page `p1`), Telegram 이 필요하면 Telegram Web(page `p2`)에 로그인돼 있다. **재부팅 뒤에는 space 가 없어진다**(`taskSpace(<id>)` 가 resolveTaskSpace 오류로 실패): `taskSpace("quoky discord relay")` 로 다시 만들어 Discord 로그인을 확인하고 새 `spaceId` 를 `$Q/space_id` 에 적는다(2026-10-26 첫 실행에서 1 → 2). 로그아웃이면 소유자에게 로그인을 요청한다.
3. 자원: 전체 `pnpm test` 가 돌고 있지 않다(`ps -axo pid,command | grep vitest`). 동시에 돌리지 않는다.
4. 잠금: `$Q/chat/busy` 가 이미 있으면 다른 실행이 탭을 쓰는 중이다. 끝날 때까지 기다린다(`nl-uat.sh` 가 잠금을 걸고 푼다).
5. 쓰기 시나리오가 있으면, 대상의 **실행 전 상태**를 읽어 기록한다(§4 의 다시 읽기 방법).

## 3. 실행

```bash
TIMEOUT=240000 SETTLE=6000 bash "$Q/qa/nl-uat.sh" dm "$Q/qa/e2e-<date>-<slug>.tsv" > "$Q/qa/e2e-<date>-<slug>-dm.txt"
bash "$Q/qa/nl-uat.sh" ch <같은 tsv> > …-ch.txt     # CH* 가 있을 때
bash "$Q/qa/nl-uat.sh" tg <같은 tsv> > …-tg.txt     # Telegram 이 필요할 때
```

- 세 번째 인자(id 정규식)로 일부만 다시 돌릴 수 있다.
- **쓰기 흐름은 한 줄씩 돈다.** 쓰기는 `미리보기 → "승인" → "<동작> 실행"` 단계를 거치고, 봇이 번호 선택("1번")이나 되묻기로 갈라질 수 있다. 표 전체를 한 번에 보내지 말고 `'^<id>$'` 로 한 줄씩 보내 답을 확인한 뒤 다음 줄을 정한다. 승인·실행·선택 줄은 실제로 보낸 그대로 표에 덧붙여 기록한다(예: `DME1a 승인`, `DME1b 일정 추가 실행`). 미리보기 내용(대상·시간·참석자·메일 발송 여부)이 기대와 다르면 "거절"하고 멈춘다.
- 출력은 시나리오마다 `### <id> | sent: … | <초>s` 블록과 봇 답으로 나온다. 실행이 중간에 끊기면(타임아웃·탭 오류) 그 시나리오는 FAIL 이 아니라 **미실행**으로 두고 다시 돌린다.

## 4. 판정

1. **결정적 판정(M)**: 시나리오마다
   - 답이 왔는가, 응답 시간(블록의 초).
   - 쓰기면 실제 대상이 바뀌었는가를 **Quoky 밖에서 읽어** 확인한다. **MCP 로 쓰지 않는다** — 쓰기는 Quoky 가 한 것만 검증한다.
     - 캘린더: `node $Q/calendar-events-probe.cjs <서비스 worktree> "<제목 표시>"` (Node 22). primary 의 앞으로 7일 중 제목에 표시가 들어간 일정만 `id | 제목 | 시작 → 끝 | 상태` 로 출력한다. 테스트 일정 제목에는 항상 고유 표시(예: `Quoky E2E`)를 넣는다.
     - Jira: Atlassian MCP 읽기(`searchJiraIssuesUsingJql`, cloudId 는 사이트 호스트명). 예: `project = BE AND summary ~ "Quoky E2E" AND created >= -1d`.
     - Slack: Slack MCP 읽기(`slack_read_channel` on `#quoky-test`).
   - 엉뚱한 대상(다른 항목·다른 채널)을 건드렸으면 즉시 J1 로 올리고 남은 쓰기 시나리오를 멈춘다.
2. **답변 품질 판정(J3)**: expected 의 "있어야 할 것 / 없어야 할 것"을 하나씩 대조해 PASS/FAIL 과 근거 문장을 낸다. 표현 차이는 문제 삼지 않고, 대상·기준·수치·누락만 본다.
3. 판정 반환 형식은 token-budget §4 를 따른다: `판정 · 근거(시나리오 id, 답의 해당 줄) · 미해결점`.

## 5. 되돌리기와 원상복구 확인

- 쓰기 시나리오마다 되돌리기 줄이 실행됐는지, 그리고 **같은 항목**이 실행 전 상태(§2-5)로 돌아왔는지 §4 와 같은 방법으로 다시 읽어 확인한다. 새 번호로 다시 만든 복사본은 원상복구가 아니다.
- 되돌리기가 FAIL 이어도 **테스트 흔적은 반드시 지운다.** Quoky 의 다른 정상 경로(예: "방금 추가한 일정 취소해줘" → 번호 선택 → 승인 → 실행)로 같은 항목을 지우고, 다시 읽어 실행 전 상태와 같은지 확인한다. 정리 줄도 `DMC*` 처럼 표에 기록하고, 판정은 원래 되돌리기 줄의 FAIL 을 그대로 둔다.
- 되돌리기가 실패했거나 확인이 안 되면 J1: 남은 실행을 멈추고, 무엇이 어떤 상태로 남았는지 소유자에게 바로 보고한다. 직접 MCP 로 고치지 않는다(외부 쓰기는 소유자 승인 대상).

## 6. 보고

결과 요약을 `$Q/qa/e2e-<date>-<slug>-result.md` 로 남기고, 소유자 보고는 quoky-ship §6 의 relay(`$Q/chat/send.txt` → `relay-send.sh`)로 보낸다.

```
## E2E 결과 — <slug> (<채널들>, 서비스 <sha>)
- 예산: token-budget §6 형식
- 시나리오: <n>개 · PASS <a> · FAIL <b> · 미실행 <c>
- 엉뚱한 대상: <0 또는 목록>   되돌리기: <성공/실패 목록>
| id | 판정 | 응답 | 근거 / 실패 이유 |
- 실패 분석: <등급 · 원인 · 다음 조치>
```

FAIL 이 있으면 원인 분석(J2/I)까지 붙이되, 코드 수정은 이 스킬에서 하지 않는다. 수정은 side-job/quoky-ship 으로 넘긴다.

## 6.5 기능 존재 확인

요청문의 기능이 서비스에 실제로 있는지 시나리오를 만들기 전에 확인한다(ADR 승인만 되고 미구현인 기능이 있다. 예: 2026-10-26 기준 Jira 이슈 생성). 서비스 worktree 의 NL catalog(`packages/core/src/application/nl-routing/`)와 플래그(`QUOKY_NL_ACTIONS` 등, 값만 읽고 시크릿은 출력하지 않는다)를 본다. 없는 기능은 "미지원을 사실대로 말하고 아무것도 하지 않는가"로 기대를 바꿔 넣고, 다시 읽기로 아무것도 생기지 않았음을 확인한다.

## 7. 멈추고 소유자에게 묻는 것

quoky-ship §7 과 같다. 특히: 허용 대상 밖의 실제 쓰기·전송, 새 외부 대상, `.env.local`·시크릿, OAuth 동의·범위 추가, 실서비스 재부팅·마이그레이션.
