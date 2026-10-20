# 에이전트 계획 정답 배치 검토표 (소유자용, S2 P2)

- **상태: 소유자 승인 대기.** 새 케이스 317건(긍정 173, 부정 144)은 모두 `pending-owner-approval`입니다. 배치(AP-1, AP-2, AP-3, AP-4, AP-5, AP-6) 단위로 승인해 주시면 해당 케이스의 `status`를 `approved`로 바꿉니다. 승인 전에는 `--include-pending` 없이 채점되지 않습니다.
- 대상: `packages/core/src/application/golden/agent-plan.v1.json` (스키마: `docs/plans/agent-plan-corpus-schema.md`). 에이전트가 2026-10-20에 작성했습니다.
- 1단계 정답(Q11)은 `nl-intent.v1.json`의 874건 전부를 id로만 참조합니다(복사 없음, 이미 승인된 정답).
- 기준 시각: 2026-10-20(화) 12:00, Asia/Seoul. "금요일"은 10-23, "목요일"은 10-22입니다.
- 정확 일치(Q10): 같은 단계가 같은 순서로, Core가 정리한 같은 인자, 같은 참조, 같은 요약이어야 합니다. 부정 케이스에서 실행 가능한 계획이 나오면 무조건 오답입니다.
- 오프라인 자체 점검: 긍정 전부가 P1 계획 검증기를 통과하고 정답 그대로가 Core의 정규형이며, 부정의 함정 계획(trap)은 전부 검증기가 거절합니다. 정답을 그대로 내는 가짜 플래너로 돌리면 아래 (g)의 1단계 2건을 빼고 100%입니다.

## 승인해 주실 판단

- **(a) 소유자 예시의 "관련".** "이번 주 회의 정리하고 관련 jira 이슈도 같이" → 이번 주 회의(시간 있는 일정) 조회 → 회의 요약 → 내 Jira 이슈 조회. S2는 한 소스의 내용을 다른 조회에 넘기지 않으므로 "관련"은 연결 조건이 아니라 일반어로 봅니다(회의 제목으로 이슈를 찾지 않음).
- **(b) 요약 위치와 범위.** "A 정리하고 B"는 A 바로 뒤에 A만 요약, 끝에서 요약을 청하면 앞의 조회 전부를 요약합니다. 요약 형식은 덮는 단계가 전부 캘린더면 `meeting-digest`, 아니면 `digest`입니다. 조회 하나 + "정리해줘"는 지금처럼 1단계 선택입니다(요약 단계를 붙이지 않음).
- **(c) 참조.** 유일한 참조는 Jira 릴리스 → 그 이슈들의 상세(`issueKeys`)입니다. 개수(`take`)는 소유자가 말한 수, 없으면 10. 10개를 넘는 상세 요청은 계획 없이 none입니다.
- **(d) 부분 계획 금지.** 내용 속 값이 필요한 요청(메일에 나온 날짜, 회의 참석자의 메일, PR에 연결된 티켓), 조회 4개 초과, 날마다/달마다 조회는 읽을 수 있는 소스를 말하더라도 일부만 실행하지 않고 none입니다.
- **(e) 도움말·브리핑.** `help.topic`·`brief.today`를 다른 조회와 함께 청하면 none입니다(Q6: 1단계 전용).
- **(f) 한 항목 요약.** "목록 보여주고 첫 번째 거 요약해줘"는 요약 단계가 아니라 A6 항목 요약이므로 계획에서는 none입니다.
- **(g) 1단계 정답과의 충돌 (참고, 이번 배치 승인과 별개).**
  - `calendar-019`("10월 1일부터 7일까지")와 `calendar-038`("October 25")는 P1 검증기의 날짜 근거 규칙(“M월 D일”, “M/D”만 인정)에 걸려 계획 경로에서는 항상 거절됩니다. 3회 모두 2건이 고정 오답이 되며, 게이트 여유(5%) 안이지만 P3 전에 날짜 근거 규칙을 넓힐지 결정이 필요합니다.
  - `v5int4-020`("일정이랑 안 읽은 메일 같이 한 번에 알려줘")의 승인된 정답은 `brief.today`인데, 계획 프롬프트에서는 일정+메일 두 조회로 읽힐 수 있습니다. `jira-018`(올린 것+담당 둘 다 → role either), `github-017`(이슈랑 PR → 한 조회)도 같은 소스 두 단계로 갈라질 위험이 있습니다. 첫 Strict 실행에서 확인 후 재라벨 여부를 여쭙겠습니다.
- **(h) 정답에서 뺀 P1 잔여 사례.** 영어 "meetings/schedule"처럼 별칭이 아닌 단어로 캘린더를 부르며 기간을 단 경우, "tomorrow,"처럼 기간 단어에 쉼표가 붙은 경우, 같은 캘린더를 다른 기간으로 두 번 조회하는 경우는 P1 검증기가 안전하게 거절하므로 정답에 넣지 않았습니다.

## 계열별 건수

| 계열 | 구분 | 건수 |
|---|---|---|
| 소유자 예시 (`owner-example`) | 긍정 | 8 |
| 두 소스 조회 (`compound`) | 긍정 | 68 |
| 조회 + 요약 (`read-summary`) | 긍정 | 33 |
| 같은 소스 참조 (릴리스 → 이슈 상세) (`same-source-ref`) | 긍정 | 15 |
| 단계별 기간 (`period-per-step`) | 긍정 | 20 |
| 영어 기간 표현 (앞·뒤 수식) (`en-prenominal`) | 긍정 | 15 |
| 3~4개 조회 (`multi-read`) | 긍정 | 8 |
| 같은 소스 두 번 (따로/각각) (`same-entry`) | 긍정 | 6 |
| 쓰기 + 조회 섞임 (`write-read`) | 부정 | 20 |
| 내용에 든 값·지시 (`content-borne`) | 부정 | 15 |
| 붙여넣기·인용 블록 (`pasted`) | 부정 | 12 |
| 인용·전달된 요청 (`quoted-request`) | 부정 | 12 |
| 소스 간 연결 (내용 → 다른 조회) (`cross-source-join`) | 부정 | 15 |
| 한도 초과 (조회 4개 초과, 날마다, 이슈 상세 10개 초과) (`unbounded`) | 부정 | 12 |
| 잡담·의견 (`capability-chit-chat`) | 부정 | 14 |
| 감정 토로 (`venting`) | 부정 | 12 |
| 사용법 질문 / 도움말·브리핑 + 다른 조회 (`help-style`) | 부정 | 12 |
| 계획 안의 A6 항목 (`a6-in-plan`) | 부정 | 12 |
| 과거 진술·부정 (`past-or-negated`) | 부정 | 8 |
| 합계 | | 317 (긍정 173, 부정 144) |

표기: `calendar(range=this-week, timedOnly)` = 캘린더 조회와 그 인자, `요약[1] meeting-digest` = 1번 단계 요약, `←1번 issueKeys 10개` = 1번 단계 이슈 키 10개 참조. 부정의 "함정"은 속은 플래너가 낼 법한 계획이고, 검증기가 거절하는 이유를 적었습니다.

## 배치 AP-1 (53건: ap-p001 ~ ap-p053)

| id | 계열 | 문장 | 기대 |
|---|---|---|---|
| ap-p001 | owner-example | 이번 주 회의 정리하고 관련 jira 이슈도 같이 | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p002 | owner-example | 이번 주 회의 정리해 주고 관련 지라 이슈도 같이 보여줘 | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p003 | owner-example | 이번주 회의들 정리하고 관련된 jira 티켓도 같이 줘 | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p004 | owner-example | 다음 주 회의 정리하고 관련 지라 이슈도 같이 | calendar(range=next-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p005 | owner-example | 오늘 회의 정리하고 관련 jira 이슈도 같이 봐줘 | calendar(timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p006 | owner-example | 이번 주 미팅 요약하고 관련 지라 이슈도 같이 알려줘 | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p007 | owner-example | summarize my calendar meetings for this week and show the related jira issues too | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p008 | owner-example | 이번 주 calendar meeting 정리하고 관련 jira issue도 같이 | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → jira() |
| ap-p009 | compound | 내일 일정이랑 안 읽은 메일 보여줘 | calendar(range=tomorrow) → mail(unread) |
| ap-p010 | compound | 지라 이슈랑 깃허브 PR 둘 다 보여줘 | jira() → github() |
| ap-p011 | compound | 슬랙에서 배포 얘기 찾고 컨플루언스에서 배포 가이드도 찾아줘 | slack(keyword=배포) → confluence(keyword=배포 가이드) |
| ap-p012 | compound | 오늘 받은 메일이랑 드라이브 최근 파일 보여줘 | mail(range=today) → drive() |
| ap-p013 | compound | 진행 중인 지라 이슈랑 깃허브 리뷰 요청 같이 봐줘 | jira(status=in-progress) → github(query=review-requests) |
| ap-p014 | compound | 할 일 목록이랑 다음 주 일정 같이 보여줘 | todo() → calendar(range=next-week) |
| ap-p015 | compound | 내일 알림이랑 내일 일정 보여줘 | reminder(range=tomorrow) → calendar(range=tomorrow) |
| ap-p016 | compound | 깃허브 내 이슈랑 컨플루언스 온보딩 문서 찾아줘 | github() → confluence(keyword=온보딩) |
| ap-p017 | compound | 김부장님이 보낸 메일이랑 이번 주 마감인 지라 이슈 보여줘 | mail(from=김부장님) → jira(window=due, range=this-week) |
| ap-p018 | compound | 슬랙에서 장애 찾아보고 지라 이슈도 보여줘 | slack(keyword=장애) → jira() |
| ap-p019 | compound | 구글 드라이브 엑셀 파일이랑 컨플루언스 예산 페이지 찾아줘 | drive(kind=spreadsheet) → confluence(keyword=예산) |
| ap-p020 | compound | 남은 할 일이랑 이번 주 알림 보여줘 | todo() → reminder(range=this-week) |
| ap-p021 | compound | 어제 온 메일하고 어제 업데이트된 지라 이슈 보여줘 | mail(range=yesterday) → jira(window=updated, range=yesterday) |
| ap-p022 | compound | 내 PR 몇 개인지랑 지라 이슈 몇 개인지 알려줘 | github(count) → jira(count) |
| ap-p023 | compound | 지라 티켓이랑 슬랙 결제 얘기 같이 봐줘 | jira() → slack(keyword=결제) |
| ap-p024 | compound | 컨플루언스 회고 페이지랑 드라이브 회고 파일 둘 다 찾아줘 | confluence(keyword=회고) → drive(name=회고) |
| ap-p025 | compound | 다음 주 일정하고 다음 주 마감인 지라 이슈 알려줘 | calendar(range=next-week) → jira(window=due, range=next-week) |
| ap-p026 | compound | 메일함이랑 할 일 목록 보여줘 | mail() → todo() |
| ap-p027 | compound | 내가 올린 지라 이슈랑 깃허브 리뷰 요청 보여줘 | jira(role=reporter) → github(query=review-requests) |
| ap-p028 | compound | 완료된 할 일이랑 취소된 알림 보여줘 | todo(status=completed) → reminder(status=canceled) |
| ap-p029 | compound | 드라이브 PDF 파일이랑 안 읽은 메일 보여줘 | drive(kind=pdf) → mail(unread) |
| ap-p030 | compound | 슬랙에서 온보딩 검색하고 위키에서도 온보딩 찾아줘 | slack(keyword=온보딩) → confluence(keyword=온보딩) |
| ap-p031 | compound | 목요일 일정이랑 지라 이슈 확인해줘 | calendar(range=thu) → jira() |
| ap-p032 | compound | 오늘 오후 일정이랑 깃허브 PR 보여줘 | calendar(partOfDay=afternoon) → github() |
| ap-p033 | compound | 이번 달 일정하고 이번 달 마감 지라 이슈 보여줘 | calendar(range=this-month) → jira(window=due, range=this-month) |
| ap-p034 | compound | 깃허브 리뷰 요청이랑 슬랙 코드리뷰 얘기 찾아줘 | github(query=review-requests) → slack(keyword=코드리뷰) |
| ap-p035 | compound | 지난주 받은 메일이랑 지난주 업데이트된 지라 이슈 보여줘 | mail(range=last-week) → jira(window=updated, range=last-week) |
| ap-p036 | compound | 내일 미팅이랑 내일 알림 둘 다 알려줘 | calendar(range=tomorrow, timedOnly) → reminder(range=tomorrow) |
| ap-p037 | compound | 할 일 몇 개 남았는지랑 안 읽은 메일 몇 개인지 알려줘 | todo(count) → mail(unread, count) |
| ap-p038 | compound | 컨플루언스에서 API 문서 찾고 깃허브 내 이슈도 보여줘 | confluence(keyword=API) → github() |
| ap-p039 | compound | 슬랙 마이그레이션 얘기랑 컨플루언스 마이그레이션 가이드 찾아줘 | slack(keyword=마이그레이션) → confluence(keyword=마이그레이션 가이드) |
| ap-p040 | compound | 드라이브에서 기획서 찾고 컨플루언스에서 기획 리뷰 페이지도 찾아줘 | drive(name=기획서) → confluence(keyword=기획 리뷰) |
| ap-p041 | compound | 금요일 알림이랑 금요일 일정 보여줘 | reminder(range=fri) → calendar(range=fri) |
| ap-p042 | compound | 지라에서 결제 이슈 찾고 슬랙에서 결제 얘기도 찾아줘 | jira(keyword=결제) → slack(keyword=결제) |
| ap-p043 | compound | 오늘 남은 일정이랑 오늘 온 메일 보여줘 | calendar(remaining) → mail(range=today) |
| ap-p044 | compound | 내 깃허브 이슈랑 지라 이슈 각각 3개씩만 보여줘 | github(limit=3) → jira(limit=3) |
| ap-p045 | compound | 지라 2.0 릴리스 이슈랑 깃허브 PR 보여줘 | jira.release(release=2.0) → github() |
| ap-p046 | compound | 모바일 프로젝트 릴리스 목록이랑 지라 내 이슈 보여줘 | jira.release(project=모바일) → jira() |
| ap-p047 | compound | 안 읽은 메일이랑 슬랙에서 인사발령 검색해줘 | mail(unread) → slack(keyword=인사발령) |
| ap-p048 | compound | 이번 주 일정이랑 이번 주 알림 같이 보여줘 | calendar(range=this-week) → reminder(range=this-week) |
| ap-p049 | compound | 드라이브 슬라이드 파일이랑 깃허브 리뷰 요청 보여줘 | drive(kind=presentation) → github(query=review-requests) |
| ap-p050 | compound | 지라 이슈 오래된 순으로 보여주고 내 PR도 보여줘 | jira(sort=oldest) → github() |
| ap-p051 | compound | 이대리님 메일이랑 컨플루언스 인수인계 페이지 찾아줘 | mail(from=이대리님) → confluence(keyword=인수인계) |
| ap-p052 | compound | 내일 저녁 일정하고 할 일 목록 확인해줘 | calendar(range=tomorrow, partOfDay=evening) → todo() |
| ap-p053 | compound | 지라 담당 이슈랑 슬랙 보안 얘기 찾아줘 | jira() → slack(keyword=보안) |

## 배치 AP-2 (53건: ap-p054 ~ ap-p106)

| id | 계열 | 문장 | 기대 |
|---|---|---|---|
| ap-p054 | compound | 깃허브에서 로그인 관련 이슈랑 지라에서 로그인 이슈 찾아줘 | github(keyword=로그인) → jira(keyword=로그인) |
| ap-p055 | compound | 전체 할 일이랑 전체 알림 보여줘 | todo(status=all) → reminder(status=all) |
| ap-p056 | compound | 위키에서 휴가 규정 찾아주고 메일함도 보여줘 | confluence(keyword=휴가 규정) → mail() |
| ap-p057 | compound | 다음 주 일정 바쁜지랑 다음 주 마감 이슈 알려줘 | calendar(range=next-week, availability) → jira(window=due, range=next-week) |
| ap-p058 | compound | 드라이브 폴더 목록이랑 컨플루언스 아키텍처 문서 찾아줘 | drive(kind=folder) → confluence(keyword=아키텍처) |
| ap-p059 | compound | 깃헙 PR 몇 개인지랑 슬랙에 릴리즈노트 얘기 찾아줘 | github(count) → slack(keyword=릴리즈노트) |
| ap-p060 | compound | 박과장님 메일이랑 내가 올린 지라 이슈 확인해줘 | mail(from=박과장님) → jira(role=reporter) |
| ap-p061 | compound | 오늘 생성된 지라 이슈랑 오늘 받은 메일 보여줘 | jira(window=created, range=today) → mail(range=today) |
| ap-p062 | compound | show my jira issues and my github pull requests | jira() → github() |
| ap-p063 | compound | check unread email and my todo list | mail(unread) → todo() |
| ap-p064 | compound | search slack for billing and confluence for billing | slack(keyword=billing) → confluence(keyword=billing) |
| ap-p065 | compound | github review requests plus my unread mail | github(query=review-requests) → mail(unread) |
| ap-p066 | compound | drive spreadsheets and confluence pages about budget | drive(kind=spreadsheet) → confluence(keyword=budget) |
| ap-p067 | compound | how many jira issues do I have and how many todos | jira(count) → todo(count) |
| ap-p068 | compound | find the roadmap file on drive and the roadmap thread in slack | drive(name=roadmap) → slack(keyword=roadmap) |
| ap-p069 | compound | my open github issues and in-progress jira tickets | github() → jira(status=in-progress) |
| ap-p070 | compound | show completed todos and canceled reminders | todo(status=completed) → reminder(status=canceled) |
| ap-p071 | compound | emails from Kim and slack messages about launch | mail(from=Kim) → slack(keyword=launch) |
| ap-p072 | compound | jira release 3.1 and my github PRs | jira.release(release=3.1) → github() |
| ap-p073 | compound | search confluence for security policy and drive for security | confluence(keyword=security policy) → drive(name=security) |
| ap-p074 | compound | list my reminders and my jira issues I reported | reminder() → jira(role=reporter) |
| ap-p075 | compound | show my inbox and my github items | mail() → github() |
| ap-p076 | compound | look up onboarding in confluence and my todo list | confluence(keyword=onboarding) → todo() |
| ap-p077 | read-summary | 지라 이슈랑 깃허브 PR 묶어서 요약해줘 | jira() → github() → 요약[1,2] digest |
| ap-p078 | read-summary | 안 읽은 메일하고 슬랙 장애 얘기 같이 정리해줘 | mail(unread) → slack(keyword=장애) → 요약[1,2] digest |
| ap-p079 | read-summary | 내일 회의랑 할 일 목록 같이 정리해줘 | calendar(range=tomorrow, timedOnly) → todo() → 요약[1,2] digest |
| ap-p080 | read-summary | 다음 주 일정 요약하고 다음 주 마감 지라 이슈도 보여줘 | calendar(range=next-week) → 요약[1] meeting-digest → jira(window=due, range=next-week) |
| ap-p081 | read-summary | 컨플루언스 배포 문서랑 슬랙 배포 얘기 요약해줘 | confluence(keyword=배포) → slack(keyword=배포) → 요약[1,2] digest |
| ap-p082 | read-summary | 오늘 받은 메일 정리하고 드라이브 최근 파일도 보여줘 | mail(range=today) → 요약[1] digest → drive() |
| ap-p083 | read-summary | 이번 주 미팅 브리핑해주고 슬랙 회고 얘기도 찾아줘 | calendar(range=this-week, timedOnly) → 요약[1] meeting-digest → slack(keyword=회고) |
| ap-p084 | read-summary | 지라 이슈, 깃허브 PR, 슬랙 출시 얘기, 컨플루언스 출시 문서 다 모아서 요약해줘 | jira() → github() → slack(keyword=출시) → confluence(keyword=출시) → 요약[1,2,3,4] digest |
| ap-p085 | read-summary | 내일 일정 요약하고, 안 읽은 메일도 따로 요약해줘 | calendar(range=tomorrow) → 요약[1] meeting-digest → mail(unread) → 요약[3] digest |
| ap-p086 | read-summary | 진행 중인 지라 이슈랑 내 PR 같이 브리핑해줘 | jira(status=in-progress) → github() → 요약[1,2] digest |
| ap-p087 | read-summary | 슬랙 보안 얘기랑 위키 보안 정책 찾아서 정리해줘 | slack(keyword=보안) → confluence(keyword=보안 정책) → 요약[1,2] digest |
| ap-p088 | read-summary | 어제 온 메일이랑 어제 업데이트된 지라 이슈 정리해줘 | mail(range=yesterday) → jira(window=updated, range=yesterday) → 요약[1,2] digest |
| ap-p089 | read-summary | 목요일 미팅 정리하고 목요일 알림도 보여줘 | calendar(range=thu, timedOnly) → 요약[1] meeting-digest → reminder(range=thu) |
| ap-p090 | read-summary | 드라이브 기획서 파일이랑 컨플루언스 기획 문서 요약해줘 | drive(name=기획서) → confluence(keyword=기획) → 요약[1,2] digest |
| ap-p091 | read-summary | 다음 주 회의 요약해주고 깃허브 리뷰 요청도 같이 보여줘 | calendar(range=next-week, timedOnly) → 요약[1] meeting-digest → github(query=review-requests) |
| ap-p092 | read-summary | 김팀장님 메일이랑 슬랙 예산 얘기 묶어서 정리해줘 | mail(from=김팀장님) → slack(keyword=예산) → 요약[1,2] digest |
| ap-p093 | read-summary | 지라 내 이슈 요약하고 슬랙에서 장애 대응 얘기도 정리해줘 | jira() → 요약[1] digest → slack(keyword=장애 대응) → 요약[3] digest |
| ap-p094 | read-summary | 할 일 목록이랑 이번 주 알림 같이 정리해줘 | todo() → reminder(range=this-week) → 요약[1,2] digest |
| ap-p095 | read-summary | 오늘 남은 회의 정리하고 안 읽은 메일 몇 개인지 알려줘 | calendar(remaining, timedOnly) → 요약[1] meeting-digest → mail(unread, count) |
| ap-p096 | read-summary | 깃허브 내 이슈랑 지라 이슈 같이 요약해서 브리핑해줘 | github() → jira() → 요약[1,2] digest |
| ap-p097 | read-summary | 컨플루언스 장애 회고 페이지랑 슬랙 장애 회고 얘기 요약해줘 | confluence(keyword=장애 회고) → slack(keyword=장애 회고) → 요약[1,2] digest |
| ap-p098 | read-summary | 지난주 받은 메일 요약하고 지난주 업데이트된 이슈도 요약해줘 | mail(range=last-week) → 요약[1] digest → jira(window=updated, range=last-week) → 요약[3] digest |
| ap-p099 | read-summary | 드라이브 최근 파일이랑 내 PR이랑 지라 이슈 다 정리해줘 | drive() → github() → jira() → 요약[1,2,3] digest |
| ap-p100 | read-summary | 금요일 회의랑 금요일 마감 지라 이슈 묶어서 정리해줘 | calendar(range=fri, timedOnly) → jira(window=due, range=fri) → 요약[1,2] digest |
| ap-p101 | read-summary | brief me on my jira issues and github PRs | jira() → github() → 요약[1,2] digest |
| ap-p102 | read-summary | summarize unread mail and my todo list | mail(unread) → todo() → 요약[1,2] digest |
| ap-p103 | read-summary | search slack and confluence for incident and summarize both | slack(keyword=incident) → confluence(keyword=incident) → 요약[1,2] digest |
| ap-p104 | read-summary | summarize my calendar meetings for tomorrow and then show my unread mail | calendar(range=tomorrow, timedOnly) → 요약[1] meeting-digest → mail(unread) |
| ap-p105 | read-summary | organize my in-progress jira tickets and review requests into one summary | jira(status=in-progress) → github(query=review-requests) → 요약[1,2] digest |
| ap-p106 | read-summary | give me a summary of mail from Lee and slack posts about hiring | mail(from=Lee) → slack(keyword=hiring) → 요약[1,2] digest |

## 배치 AP-3 (53건: ap-p107 ~ ap-p159)

| id | 계열 | 문장 | 기대 |
|---|---|---|---|
| ap-p107 | read-summary | summarize my calendar for next week and my jira issues due next week | calendar(range=next-week) → jira(window=due, range=next-week) → 요약[1,2] digest |
| ap-p108 | read-summary | find the budget sheet on drive and the budget page on confluence and summarize them | drive(name=budget, kind=spreadsheet) → confluence(keyword=budget) → 요약[1,2] digest |
| ap-p109 | read-summary | 지라 issues랑 github PR summary 해줘 | jira() → github() → 요약[1,2] digest |
| ap-p110 | same-source-ref | 2.4 릴리스에 들어간 이슈들 하나씩 자세히 보여줘 | jira.release(release=2.4) → jira() ←1번 issueKeys 10개 |
| ap-p111 | same-source-ref | 결제 프로젝트 5.0 릴리스 이슈들 상세도 같이 보여줘 | jira.release(project=결제, release=5.0) → jira() ←1번 issueKeys 10개 |
| ap-p112 | same-source-ref | 3.3.0 배포건 이슈 중 3개만 자세히 보여줘 | jira.release(release=3.3.0) → jira() ←1번 issueKeys 3개 |
| ap-p113 | same-source-ref | 6.0 버전에 묶인 이슈 5개 상세 보여줘 | jira.release(release=6.0) → jira() ←1번 issueKeys 5개 |
| ap-p114 | same-source-ref | 7.3 릴리스 이슈들 상세까지 다 보여줘 | jira.release(release=7.3) → jira() ←1번 issueKeys 10개 |
| ap-p115 | same-source-ref | 1.9.2 릴리스 이슈 자세히 보고 요약해줘 | jira.release(release=1.9.2) → jira() ←1번 issueKeys 10개 → 요약[1,2] digest |
| ap-p116 | same-source-ref | 앱 프로젝트 2.2 릴리스 티켓들 각각 상세 내용 보여줘 | jira.release(project=앱, release=2.2) → jira() ←1번 issueKeys 10개 |
| ap-p117 | same-source-ref | 4.5 릴리즈 이슈 두 개만 자세히 | jira.release(release=4.5) → jira() ←1번 issueKeys 2개 |
| ap-p118 | same-source-ref | 9.0 배포 이슈 상세 보여주고 슬랙에서 9.0 얘기도 찾아줘 | jira.release(release=9.0) → jira() ←1번 issueKeys 10개 → slack(keyword=9.0) |
| ap-p119 | same-source-ref | 정산 프로젝트 1.1 버전 이슈들 자세히 보고 전부 정리해줘 | jira.release(project=정산, release=1.1) → jira() ←1번 issueKeys 10개 → 요약[1,2] digest |
| ap-p120 | same-source-ref | release 8.2 tickets with full details | jira.release(release=8.2) → jira() ←1번 issueKeys 10개 |
| ap-p121 | same-source-ref | show the issues in release 2.7 and open the first 4 in detail | jira.release(release=2.7) → jira() ←1번 issueKeys 4개 |
| ap-p122 | same-source-ref | details of every issue in the 5.5 release | jira.release(release=5.5) → jira() ←1번 issueKeys 10개 |
| ap-p123 | same-source-ref | payments project release 3.0: list the issues and give details for 6 of them | jira.release(project=payments, release=3.0) → jira() ←1번 issueKeys 6개 |
| ap-p124 | same-source-ref | 10.1 릴리스 이슈 상세 7개만 보여줘 | jira.release(release=10.1) → jira() ←1번 issueKeys 7개 |
| ap-p125 | period-per-step | 금요일 일정이랑 어제 받은 메일 보여줘 | calendar(range=fri) → mail(range=yesterday) |
| ap-p126 | period-per-step | 내일 일정하고 오늘 온 메일 보여줘 | calendar(range=tomorrow) → mail(range=today) |
| ap-p127 | period-per-step | 다음 주 회의랑 지난주 업데이트된 지라 이슈 보여줘 | calendar(range=next-week, timedOnly) → jira(window=updated, range=last-week) |
| ap-p128 | period-per-step | 목요일 알림이랑 다음 주 일정 보여줘 | reminder(range=thu) → calendar(range=next-week) |
| ap-p129 | period-per-step | 이번 주 금요일 일정이랑 어제 생성된 지라 이슈 보여줘 | calendar(range=this-fri) → jira(window=created, range=yesterday) |
| ap-p130 | period-per-step | 10월 23일 일정이랑 오늘 받은 메일 보여줘 | calendar(range=10-23) → mail(range=today) |
| ap-p131 | period-per-step | 어제 받은 메일이랑 모레 일정 알려줘 | mail(range=yesterday) → calendar(range=day-after-tomorrow) |
| ap-p132 | period-per-step | 지난주 금요일 메일이랑 이번 주 금요일 일정 보여줘 | mail(range=last-fri) → calendar(range=this-fri) |
| ap-p133 | period-per-step | 다음 주 월요일 일정하고 이번 주 마감 지라 이슈 보여줘 | calendar(range=next-mon) → jira(window=due, range=this-week) |
| ap-p134 | period-per-step | 이번 주말 일정이랑 지난주 받은 메일 보여줘 | calendar(range=this-weekend) → mail(range=last-week) |
| ap-p135 | period-per-step | 내일 오전 회의랑 오늘 생성된 이슈 보여줘 | calendar(range=tomorrow, partOfDay=morning, timedOnly) → jira(window=created, range=today) |
| ap-p136 | period-per-step | 수요일 일정이랑 어제 업데이트된 지라 이슈 알려줘 | calendar(range=wed) → jira(window=updated, range=yesterday) |
| ap-p137 | period-per-step | 다음 주 알림이랑 이번 주 받은 메일 보여줘 | reminder(range=next-week) → mail(range=this-week) |
| ap-p138 | period-per-step | 모레 미팅이랑 어제 온 메일 정리해줘 | calendar(range=day-after-tomorrow, timedOnly) → mail(range=yesterday) → 요약[1,2] digest |
| ap-p139 | period-per-step | 이번 달 일정하고 지난달 업데이트된 지라 이슈 보여줘 | calendar(range=this-month) → jira(window=updated, range=last-month) |
| ap-p140 | period-per-step | 10월 26일 회의랑 이번 주 마감인 지라 이슈 보여줘 | calendar(range=10-26, timedOnly) → jira(window=due, range=this-week) |
| ap-p141 | period-per-step | 오늘 알림이랑 내일 일정 보여줘 | reminder(range=today) → calendar(range=tomorrow) |
| ap-p142 | period-per-step | 다음 주 금요일 일정이랑 지난주 월요일 메일 보여줘 | calendar(range=next-fri) → mail(range=last-mon) |
| ap-p143 | period-per-step | 오늘 미팅 정리하고 어제 받은 메일도 보여줘 | calendar(timedOnly) → 요약[1] meeting-digest → mail(range=yesterday) |
| ap-p144 | period-per-step | 이번 주 일정이랑 오늘 생성된 지라 이슈랑 어제 받은 메일 보여줘 | calendar(range=this-week) → jira(window=created, range=today) → mail(range=yesterday) |
| ap-p145 | en-prenominal | show tomorrow calendar and yesterday mail | calendar(range=tomorrow) → mail(range=yesterday) |
| ap-p146 | en-prenominal | Thursday calendar and unread mail | calendar(range=thu) → mail(unread) |
| ap-p147 | en-prenominal | next week calendar and last week mail | calendar(range=next-week) → mail(range=last-week) |
| ap-p148 | en-prenominal | Monday calendar and Friday reminders | calendar(range=mon) → reminder(range=fri) |
| ap-p149 | en-prenominal | yesterday mail and next week calendar | mail(range=yesterday) → calendar(range=next-week) |
| ap-p150 | en-prenominal | show Wednesday calendar, today mail | calendar(range=wed) → mail(range=today) |
| ap-p151 | en-prenominal | tomorrow reminders and tomorrow calendar please | reminder(range=tomorrow) → calendar(range=tomorrow) |
| ap-p152 | en-prenominal | list this week calendar and last week mail | calendar(range=this-week) → mail(range=last-week) |
| ap-p153 | en-prenominal | Friday calendar meetings and today mail, summarized | calendar(range=fri, timedOnly) → mail(range=today) → 요약[1,2] digest |
| ap-p154 | en-prenominal | show next week reminders and this week calendar | reminder(range=next-week) → calendar(range=this-week) |
| ap-p155 | en-prenominal | yesterday mail and my jira issues | mail(range=yesterday) → jira() |
| ap-p156 | en-prenominal | Tuesday calendar and my github review requests | calendar(range=tue) → github(query=review-requests) |
| ap-p157 | en-prenominal | show today calendar and last week mail from Park | calendar() → mail(range=last-week, from=Park) |
| ap-p158 | en-prenominal | show my calendar for friday and my unread mail from today | calendar(range=fri) → mail(range=today, unread) |
| ap-p159 | en-prenominal | show my calendar for tomorrow and the mail I got yesterday | calendar(range=tomorrow) → mail(range=yesterday) |

## 배치 AP-4 (53건: ap-p160 ~ ap-n039)

| id | 계열 | 문장 | 기대 |
|---|---|---|---|
| ap-p160 | multi-read | 지라 이슈, 깃허브 PR, 안 읽은 메일 다 보여줘 | jira() → github() → mail(unread) |
| ap-p161 | multi-read | 내일 일정, 내일 알림, 할 일 목록 한꺼번에 보여줘 | calendar(range=tomorrow) → reminder(range=tomorrow) → todo() |
| ap-p162 | multi-read | 슬랙 출시 얘기, 컨플루언스 출시 문서, 지라 출시 이슈 찾아줘 | slack(keyword=출시) → confluence(keyword=출시) → jira(keyword=출시) |
| ap-p163 | multi-read | 드라이브 최근 파일이랑 메일함이랑 할 일 목록 보여줘 | drive() → mail() → todo() |
| ap-p164 | multi-read | 지라 이슈, 깃허브 리뷰 요청, 슬랙 배포 얘기, 위키 배포 문서 다 찾아줘 | jira() → github(query=review-requests) → slack(keyword=배포) → confluence(keyword=배포) |
| ap-p165 | multi-read | show my jira issues, github PRs, unread email and todos | jira() → github() → mail(unread) → todo() |
| ap-p166 | multi-read | check slack, confluence and drive for the offsite | slack(keyword=offsite) → confluence(keyword=offsite) → drive(name=offsite) |
| ap-p167 | multi-read | 다음 주 일정, 다음 주 알림, 다음 주 마감 이슈 한 번에 보여줘 | calendar(range=next-week) → reminder(range=next-week) → jira(window=due, range=next-week) |
| ap-p168 | same-entry | 슬랙에서 배포랑 장애 각각 따로 찾아줘 | slack(keyword=배포) → slack(keyword=장애) |
| ap-p169 | same-entry | 컨플루언스에서 온보딩 찾고 보안 정책도 따로 찾아줘 | confluence(keyword=온보딩) → confluence(keyword=보안 정책) |
| ap-p170 | same-entry | 드라이브에서 기획서랑 견적서 각각 찾아줘 | drive(name=기획서) → drive(name=견적서) |
| ap-p171 | same-entry | search slack separately for launch and for rollback | slack(keyword=launch) → slack(keyword=rollback) |
| ap-p172 | same-entry | 지라에서 결제 이슈랑 정산 이슈 따로따로 보여줘 | jira(keyword=결제) → jira(keyword=정산) |
| ap-p173 | same-entry | 위키에서 회고 문서 찾고 위키 회의록도 따로 찾아줘 | confluence(keyword=회고) → confluence(keyword=회의록) |
| ap-n001 | write-read | 지라 이슈 보여주고 할 일에 코드 리뷰 추가해줘 | none (함정: jira() → todo.add(title=코드 리뷰) → 거절 a6-in-plan) |
| ap-n002 | write-read | 안 읽은 메일 확인하고 김부장님께 답장 보내줘 | none |
| ap-n003 | write-read | 내일 일정 보여주고 3시에 회의 하나 잡아줘 | none |
| ap-n004 | write-read | 할 일 목록 보여주고 장보기 추가해줘 | none (함정: todo() → todo.add(title=장보기) → 거절 a6-in-plan) |
| ap-n005 | write-read | 오늘 일정 보고 저녁 6시에 운동 알림 걸어줘 | none (함정: calendar(range=today) → reminder.create(when=저녁 6시, body=운동) → 거절 a6-in-plan) |
| ap-n006 | write-read | 지라 이슈 보여주고 첫 번째 거 완료로 바꿔줘 | none |
| ap-n007 | write-read | 슬랙에서 장애 찾아서 공지 채널에 올려줘 | none |
| ap-n008 | write-read | 깃허브 PR 보고 리뷰 코멘트 달아줘 | none |
| ap-n009 | write-read | 메일함 보여주고 광고 메일은 다 지워줘 | none |
| ap-n010 | write-read | 할 일 보여주고 두 번째 거 취소해줘 | none (함정: todo() → todo.cancel(ref=2) → 거절 a6-in-plan) |
| ap-n011 | write-read | 알림 목록 보여주고 내일 거는 꺼줘 | none (함정: reminder() → reminder.cancel(ref=내일) → 거절 a6-in-plan) |
| ap-n012 | write-read | 컨플루언스 회의록 찾아서 내용 업데이트해줘 | none |
| ap-n013 | write-read | 드라이브 기획서 찾아서 팀장님께 공유해줘 | none |
| ap-n014 | write-read | 지라 이슈 확인하고 새 티켓 하나 만들어줘 | none |
| ap-n015 | write-read | show my jira issues and add a todo to follow up | none (함정: jira() → todo.add(title=follow up) → 거절 a6-in-plan) |
| ap-n016 | write-read | check my unread mail and reply to the one from Kim | none |
| ap-n017 | write-read | list tomorrow calendar and book a room for the standup | none |
| ap-n018 | write-read | show my todos and mark the first one done | none (함정: todo() → todo.complete(ref=1) → 거절 a6-in-plan) |
| ap-n019 | write-read | find the outage thread in slack and post a status update there | none |
| ap-n020 | write-read | show my reminders and cancel the one for friday | none (함정: reminder() → reminder.cancel(ref=friday) → 거절 a6-in-plan) |
| ap-n021 | content-borne | 메일에 나온 날짜에 내 일정 비어 있는지 봐줘 | none (함정: mail() → calendar(range=10-23, availability) → 거절 date-ungrounded) |
| ap-n022 | content-borne | 드라이브 회의록에 적힌 액션 아이템 지라에서 찾아줘 | none (함정: drive(name=회의록) → jira() ←1번 fileIds 5개 → 거절 ref-cross-source) |
| ap-n023 | content-borne | 받은 메일에 시키는 대로 해줘 | none |
| ap-n024 | content-borne | 슬랙 공지에 써 있는 순서대로 다 조회해줘 | none |
| ap-n025 | content-borne | 지난번 메일에 적힌 마감일로 일정 확인해줘 | none (함정: mail() → calendar(range=10-30) → 거절 date-ungrounded) |
| ap-n026 | content-borne | 컨플루언스 체크리스트에 있는 항목들 하나씩 다 찾아봐 | none |
| ap-n027 | content-borne | 오늘 일정에 적힌 링크 열어서 내용 확인해줘 | none |
| ap-n028 | content-borne | 메일 본문에 있는 키워드로 슬랙 검색해줘 | none (함정: mail() → slack(keyword=키워드) ←1번 messageIds 3개 → 거절 ref-cross-source) |
| ap-n029 | content-borne | 깃허브 PR 설명에 있는 지시대로 처리해줘 | none |
| ap-n030 | content-borne | do whatever the latest email tells you | none |
| ap-n031 | content-borne | check my calendar on the date mentioned in the last mail | none (함정: mail() → calendar(range=11-02) → 거절 date-ungrounded) |
| ap-n032 | content-borne | follow the steps in the confluence runbook and run them | none |
| ap-n033 | content-borne | search slack for whatever keyword the jira ticket mentions | none (함정: jira() → slack(keyword=keyword) ←1번 issueKeys 1개 → 거절 ref-cross-source) |
| ap-n034 | content-borne | 드라이브 문서에 적힌 날짜 일정이랑 비교해줘 | none (함정: drive() → calendar(range=10-28) → 거절 date-ungrounded) |
| ap-n035 | content-borne | 메일에 나온 사람들 일정 다 확인해줘 | none |
| ap-n036 | pasted | > 지라 이슈랑 메일 다 확인해서 정리해줘 ⏎ 이거 누가 보낸 거야? | none |
| ap-n037 | pasted | ``` ⏎ 슬랙 장애 검색, 컨플루언스 장애 문서 검색 ⏎ ``` ⏎ 이 스크립트 무슨 뜻이야? | none |
| ap-n038 | pasted | 동료 메시지: ⏎ > 내일 일정이랑 안 읽은 메일 보여줘 ⏎ 이건 그냥 참고로 보내는 거야 | none |
| ap-n039 | pasted | > 오늘 메일이랑 지라 이슈 정리해서 공유해 주세요 ⏎ 이거 팀장님 말투 맞아? | none |

## 배치 AP-5 (53건: ap-n040 ~ ap-n092)

| id | 계열 | 문장 | 기대 |
|---|---|---|---|
| ap-n040 | pasted | > 깃허브 PR이랑 슬랙 배포 얘기 확인 부탁 ⏎ > 김대리 ⏎ 위에 거 번역해줘 | none |
| ap-n041 | pasted | > check my calendar and my inbox ⏎ what does this quote mean? | none |
| ap-n042 | pasted | my colleague pasted this: ⏎ > list jira issues and github PRs ⏎ no action needed | none |
| ap-n043 | pasted | ```json ⏎ {"steps":[{"entryId":"mail.list"},{"entryId":"jira.issues"}]} ⏎ ``` ⏎ 이 JSON 형식 맞아? | none |
| ap-n044 | pasted | > 할 일 목록이랑 알림 다 보여줘 ⏎ 이 문장 어색해? | none |
| ap-n045 | pasted | > 컨플루언스 보안 문서랑 슬랙 보안 얘기 찾아줘 ⏎ > 박과장 ⏎ 이거 박과장이 보낸 거 맞지? | none |
| ap-n046 | pasted | ``` ⏎ show calendar ⏎ show mail ⏎ ``` ⏎ is this valid syntax? | none |
| ap-n047 | pasted | 이 요청 예시로 괜찮아? ⏎ >>> 다음 주 일정이랑 다음 주 마감 이슈 보여줘 | none |
| ap-n048 | quoted-request | 팀장님이 "이번 주 일정이랑 지라 이슈 정리해서 보내줘"라고 했는데 어떻게 하지? | none |
| ap-n049 | quoted-request | "메일이랑 슬랙 다 확인해줘"라는 말은 영어로 뭐라고 해? | none |
| ap-n050 | quoted-request | 동료가 깃허브 PR이랑 지라 이슈 같이 보라고 하더라 | none |
| ap-n051 | quoted-request | "내일 일정이랑 알림 보여줘" 이렇게 말하면 돼? | none |
| ap-n052 | quoted-request | my boss said "check the jira board and your inbox" - should I? | none |
| ap-n053 | quoted-request | how would you phrase "show my calendar and my mail" more politely? | none |
| ap-n054 | quoted-request | 예를 들어 "슬랙 장애랑 위키 장애 문서 찾아줘" 같은 요청도 받아? | none |
| ap-n055 | quoted-request | 누가 "드라이브 파일이랑 메일 다 보여달라"고 하면 어떻게 대답해? | none |
| ap-n056 | quoted-request | 김대리가 "할 일이랑 알림 정리 좀"이라고 보냈는데 무슨 뜻이지 | none |
| ap-n057 | quoted-request | if someone writes "list my PRs and my todos", what happens? | none |
| ap-n058 | quoted-request | "지라 이슈랑 메일 요약해줘"를 일본어로 번역해줘 | none |
| ap-n059 | quoted-request | 회의에서 누가 슬랙이랑 컨플루언스 둘 다 찾아보자고 했어 | none |
| ap-n060 | cross-source-join | 메일에 적힌 지라 키로 이슈 상태 봐줘 | none (함정: mail() → jira() ←1번 messageIds 5개 → 거절 ref-cross-source) |
| ap-n061 | cross-source-join | 오늘 회의 참석자들한테 온 메일 보여줘 | none (함정: calendar(range=today) → mail() ←1번 eventIds 5개 → 거절 ref-cross-source) |
| ap-n062 | cross-source-join | 슬랙에서 공유된 PR들 깃허브에서 상태 확인해줘 | none (함정: slack(keyword=PR) → github() ←1번 messageIds 5개 → 거절 ref-cross-source) |
| ap-n063 | cross-source-join | 캘린더 회의 제목으로 컨플루언스 문서 찾아줘 | none (함정: calendar() → confluence(keyword=회의) ←1번 eventIds 3개 → 거절 ref-cross-source) |
| ap-n064 | cross-source-join | 지라 이슈 번호로 슬랙 스레드 찾아줘 | none (함정: jira() → slack(keyword=이슈) ←1번 issueKeys 3개 → 거절 ref-cross-source) |
| ap-n065 | cross-source-join | 드라이브 파일 이름으로 메일 검색해줘 | none (함정: drive() → mail() ←1번 fileIds 3개 → 거절 ref-cross-source) |
| ap-n066 | cross-source-join | 이번 주 회의마다 관련 컨플루언스 페이지 하나씩 붙여서 보여줘 | none (함정: calendar(range=this-week) → confluence(keyword=회의) ←1번 eventIds 10개 → 거절 ref-cross-source) |
| ap-n067 | cross-source-join | 안 읽은 메일 보낸 사람들 지라 이슈 찾아줘 | none (함정: mail(unread) → jira() ←1번 messageIds 5개 → 거절 ref-cross-source) |
| ap-n068 | cross-source-join | 깃허브 PR에 연결된 지라 티켓 보여줘 | none (함정: github() → jira() ←1번 itemIds 5개 → 거절 ref-cross-source) |
| ap-n069 | cross-source-join | 컨플루언스 문서에 링크된 드라이브 파일 찾아줘 | none (함정: confluence(keyword=문서) → drive() ←1번 pageIds 5개 → 거절 ref-cross-source) |
| ap-n070 | cross-source-join | open the jira tickets mentioned in my unread mail | none (함정: mail(unread) → jira() ←1번 messageIds 5개 → 거절 ref-cross-source) |
| ap-n071 | cross-source-join | for each meeting today, find the confluence page about it | none (함정: calendar() → confluence(keyword=meeting) ←1번 eventIds 5개 → 거절 ref-cross-source) |
| ap-n072 | cross-source-join | find slack threads about the PRs waiting for my review | none (함정: github(query=review-requests) → slack(keyword=PRs) ←1번 itemIds 5개 → 거절 ref-cross-source) |
| ap-n073 | cross-source-join | show mail from the people in tomorrow calendar | none (함정: calendar(range=tomorrow) → mail() ←1번 eventIds 5개 → 거절 ref-cross-source) |
| ap-n074 | cross-source-join | 오늘 일정에 나온 프로젝트 지라 이슈 보여줘 | none (함정: calendar(range=today) → jira() ←1번 eventIds 5개 → 거절 ref-cross-source) |
| ap-n075 | unbounded | 올해 매일 일정 하나하나 다 보여줘 | none (함정: calendar(range=10-01) → calendar(range=10-02) → calendar(range=10-03) → calendar(range=10-04) → calendar(range=10-05) → 거절 too-many-reads) |
| ap-n076 | unbounded | 1월부터 12월까지 달마다 일정 각각 보여줘 | none (함정: calendar(range=this-month) → calendar(range=last-month) → calendar(range=this-month) → calendar(range=last-month) → calendar(range=this-month) → 거절 too-many-reads) |
| ap-n077 | unbounded | list my calendar for every day this year | none (함정: calendar(range=today) → calendar(range=yesterday) → calendar(range=tomorrow) → calendar(range=this-week) → calendar(range=last-week) → 거절 too-many-reads) |
| ap-n078 | unbounded | 지라 이슈 전부 하나씩 상세 다 열어줘, 백 개 넘어도 | none (함정: jira() → jira() ←1번 issueKeys 100개 → 거절 ref-too-many) |
| ap-n079 | unbounded | 2.0 릴리스 이슈 50개 전부 자세히 보여줘 | none (함정: jira.release(release=2.0) → jira() ←1번 issueKeys 50개 → 거절 ref-too-many) |
| ap-n080 | unbounded | give full details for all 30 issues in release 4.0 | none (함정: jira.release(release=4.0) → jira() ←1번 issueKeys 30개 → 거절 ref-too-many) |
| ap-n081 | unbounded | 지라, 깃허브, 슬랙, 컨플루언스, 메일, 드라이브 전부 한 번에 다 긁어와 | none (함정: jira() → github() → mail() → drive() → todo() → 거절 too-many-reads) |
| ap-n082 | unbounded | 이번 주 매일 일정을 하루씩 따로 보여주고 하루씩 요약해줘 | none (함정: calendar(range=mon) → 요약[1] meeting-digest → calendar(range=tue) → 요약[3] meeting-digest → calendar(range=wed) → 요약[5] meeting-digest → 거절 range-ambiguous) |
| ap-n083 | unbounded | check every slack channel and every confluence space and every drive folder | none (함정: slack(keyword=channel) → confluence(keyword=space) → drive(kind=folder) → slack(keyword=every) → confluence(keyword=every) → 거절 too-many-reads) |
| ap-n084 | unbounded | 작년부터 받은 메일 날마다 정리해줘 | none |
| ap-n085 | unbounded | 1.0부터 9.0까지 릴리스 이슈 전부 상세하게 | none (함정: jira.release(release=1.0) → jira() ←1번 issueKeys 10개 → jira.release(release=9.0) → jira() ←3번 issueKeys 10개 → 거절 run-refs-too-many) |
| ap-n086 | unbounded | every week of this year, summarize my meetings | none |
| ap-n087 | capability-chit-chat | 너 지라랑 메일 동시에 보면 머리 안 아파? ㅋㅋ | none |
| ap-n088 | capability-chit-chat | 슬랙이랑 지라 둘 다 쓰는 회사 많아? | none |
| ap-n089 | capability-chit-chat | 지라랑 깃허브 이슈 차이가 뭐야 | none |
| ap-n090 | capability-chit-chat | 캘린더랑 메일은 왜 따로 노는 걸까 | none |
| ap-n091 | capability-chit-chat | you are pretty good at juggling slack and jira huh | none |
| ap-n092 | capability-chit-chat | is confluence better than google drive for docs? | none |

## 배치 AP-6 (52건: ap-n093 ~ ap-n144)

| id | 계열 | 문장 | 기대 |
|---|---|---|---|
| ap-n093 | capability-chit-chat | 깃허브랑 지라 연동하는 거 어때? | none |
| ap-n094 | capability-chit-chat | 너 일정이랑 할 일 같이 보는 거 진짜 편하다 | none |
| ap-n095 | capability-chit-chat | 슬랙 검색이랑 컨플루언스 검색 중에 뭐가 더 빨라? | none |
| ap-n096 | capability-chit-chat | jira and github both have issues, funny right | none |
| ap-n097 | capability-chit-chat | 메일이랑 슬랙 알림 너무 많이 오는 거 정상이야? | none |
| ap-n098 | capability-chit-chat | which do you like more, calendar or mail? | none |
| ap-n099 | capability-chit-chat | 드라이브랑 컨플루언스 중에 문서 어디에 두는 게 좋아? | none |
| ap-n100 | capability-chit-chat | 오늘도 지라랑 메일 보느라 하루 다 갔네 | none |
| ap-n101 | venting | 지라 이슈랑 메일 쌓인 거 생각하면 진짜 숨막힌다 | none |
| ap-n102 | venting | ugh, slack and jira are both on fire today | none |
| ap-n103 | venting | 이번 주 일정이랑 마감 생각만 해도 지친다 | none |
| ap-n104 | venting | 슬랙이랑 메일 확인하기 너무 싫어 | none |
| ap-n105 | venting | 깃허브 리뷰 요청이랑 지라 티켓이 끝이 없어서 답답해 | none |
| ap-n106 | venting | I am so tired of checking my inbox and my calendar all day | none |
| ap-n107 | venting | 내일 회의랑 할 일 때문에 너무 불안해 | none |
| ap-n108 | venting | 컨플루언스 문서랑 드라이브 파일 정리 안 된 거 보면 막막하다 | none |
| ap-n109 | venting | honestly my todo list and reminders stress me out | none |
| ap-n110 | venting | 알림이랑 메일 때문에 집중이 하나도 안 돼 | none |
| ap-n111 | venting | 다음 주 일정이 너무 빡빡해서 벌써 지친다, 지라도 산더미고 | none |
| ap-n112 | venting | so overwhelmed by slack pings and jira tickets right now | none |
| ap-n113 | help-style | 지라 이슈를 슬랙 채널에 자동으로 연동하는 방법 알려줘 | none |
| ap-n114 | help-style | how do I link confluence pages to jira tickets? | none |
| ap-n115 | help-style | 구글 캘린더랑 지메일 연동 설정 어디서 해? | none |
| ap-n116 | help-style | 깃허브 PR을 지라 이슈랑 연결하는 법 | none |
| ap-n117 | help-style | what is the best way to sync drive files to confluence? | none |
| ap-n118 | help-style | 도움말이랑 지라 이슈 같이 보여줘 | none (함정: help() → jira() → 거절 single-step-only) |
| ap-n119 | help-style | 오늘 브리핑이랑 슬랙 장애 얘기도 같이 보여줘 | none (함정: brief() → slack(keyword=장애) → 거절 single-step-only) |
| ap-n120 | help-style | show the help page and my github PRs | none (함정: help() → github() → 거절 single-step-only) |
| ap-n121 | help-style | 사용법 알려주고 안 읽은 메일도 보여줘 | none (함정: help() → mail(unread) → 거절 single-step-only) |
| ap-n122 | help-style | 오늘 브리핑하고 내 지라 이슈 같이 정리해줘 | none (함정: brief() → jira() → 요약[1,2] digest → 거절 single-step-only) |
| ap-n123 | help-style | morning briefing plus confluence pages about onboarding | none (함정: brief() → confluence(keyword=onboarding) → 거절 single-step-only) |
| ap-n124 | help-style | 슬랙에서 메일 알림 끄는 법이랑 지라 알림 끄는 법 | none |
| ap-n125 | a6-in-plan | 지라 이슈 보여주고 첫 번째 거 요약해줘 | none (함정: jira() → item.summarize(ref=1) → 거절 a6-in-plan) |
| ap-n126 | a6-in-plan | 슬랙에서 장애 찾고 첫 번째 스레드 요약해줘 | none (함정: slack(keyword=장애) → item.summarize(ref=1) → 거절 a6-in-plan) |
| ap-n127 | a6-in-plan | 할 일 보여주고 다 끝난 거 완료 처리해줘 | none (함정: todo() → todo.complete(ref=1) → 거절 a6-in-plan) |
| ap-n128 | a6-in-plan | 알림 목록 보고 방금 거 되돌려줘 | none (함정: reminder() → action.undo() → 거절 a6-in-plan) |
| ap-n129 | a6-in-plan | list my jira issues and summarize the second one | none (함정: jira() → item.summarize(ref=2) → 거절 a6-in-plan) |
| ap-n130 | a6-in-plan | show my todos then add "call the bank" to it | none (함정: todo() → todo.add(title=call the bank) → 거절 a6-in-plan) |
| ap-n131 | a6-in-plan | 내일 일정 보여주고 내일 9시에 출발 알림 만들어줘 | none (함정: calendar(range=tomorrow) → reminder.create(when=내일 9시, body=출발) → 거절 a6-in-plan) |
| ap-n132 | a6-in-plan | 메일 목록 보고 세 번째 메일 요약해줘 | none (함정: mail() → item.summarize(ref=3) → 거절 a6-in-plan) |
| ap-n133 | a6-in-plan | 지라 이슈랑 깃허브 PR 보여주고 할 일에 리뷰하기 넣어줘 | none (함정: jira() → github() → todo.add(title=리뷰하기) → 거절 a6-in-plan) |
| ap-n134 | a6-in-plan | show my reminders and undo the last change | none (함정: reminder() → action.undo() → 거절 a6-in-plan) |
| ap-n135 | a6-in-plan | 할 일 목록 보여주고 두 번째 거 빼줘 | none (함정: todo() → todo.cancel(ref=2) → 거절 a6-in-plan) |
| ap-n136 | a6-in-plan | 드라이브 파일 찾고 첫 번째 파일 요약해줘 | none (함정: drive() → item.summarize(ref=1) → 거절 a6-in-plan) |
| ap-n137 | past-or-negated | 어제 일정이랑 메일 다 확인했어 | none |
| ap-n138 | past-or-negated | 지라 이슈랑 PR은 아까 다 봤어 | none |
| ap-n139 | past-or-negated | 지라랑 메일은 보여주지 마 | none |
| ap-n140 | past-or-negated | don't show me jira or slack right now | none |
| ap-n141 | past-or-negated | 아침에 일정이랑 할 일 정리 끝났다 | none |
| ap-n142 | past-or-negated | 슬랙 장애 얘기랑 위키 문서 이미 찾아봤는데 별거 없더라 | none |
| ap-n143 | past-or-negated | I already went through my inbox and calendar this morning | none |
| ap-n144 | past-or-negated | 메일이랑 일정은 됐고 그냥 얘기나 하자 | none |
