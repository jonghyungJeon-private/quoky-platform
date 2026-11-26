# A6-S4 consent-answer 코퍼스 요약 (owner review 전, 실행 안 함)

ADR-0121 amendment A6 §A6.9(비준 기록 R6, 소유자 결정 r-01~r-04(2026-11-24)로 갱신), A6.10 A6-S4 행, a6-02. 2026-11-26 오프라인으로
만들고 같은 날 리뷰 1차 수정을 반영했다. 모델 호출 0회. 코퍼스는 아직 `status: "owner-review"`다. 소유자가 검토하고 승인하기 전에는
`eval:nl --mode consent-answer`의 run이 거부된다(exit 3). 승인 뒤에도 run마다 소유자 알림과 yes가 따로 필요하다.

- 코퍼스: `packages/core/src/application/golden/nl-consent-answer.v1.json`
  (sha256 `40318f1fbcafc0ab33f27c77ed005a75e9c70d70b66eb71308c4b767740e0777`, 검토 중 수정하면 바뀐다)
- 결정적 검사(실제 Core 사용, 모델 없음): `packages/core/src/application/consent-answer/consent-answer.corpus.test.ts`.
  단계는 손으로 옮긴 규칙이 아니라 실제 `ConversationRuntime`의 `handleConsentGate`(그 안의 `isConsentControlTurn`,
  production turn handler 묶음에 대한 `turnHandlerClaims`)와 실제 `ConsentTurnGate`로 정한다.
- 평가 하네스: `apps/quoky/src/tools/nl-consent-answer-eval.ts`, `eval:nl --mode consent-answer --arm remote|local`

## 개수

전체 414건. 답 언어는 KO 251건(60.6 %), EN 163건(39.4 %)이다(A6.9 기준 KO ≥ 60 %, EN ≥ 25 %).
동의 종류는 rule-① 259건, A2 topic 155건이다.

| 범주 | 전체 | classifier 단계 | 그 밖의 단계 | 최소(classifier 단계) |
|---|---|---|---|---|
| positive (gold `yes`) | 88 | 86 | structural-fail 2 | 80 |
| no (gold `no`) | 75 | 64 | fast-path 8, structural-fail 3 | 60 |
| non-answer (gold `other`) | 130 | 106 | control-forfeit 14, handler-claimed 9, structural-fail 1 | 100 (r-03 (2)) |
| yes-and-more | 54 | 43 | handler-claimed 7, control-forfeit 4 | 40 (r-03 (2)) |
| unclear | 24 | 24 | — | 20 |
| adversarial | 43 | 11 (gold `other`) | structural-fail 25, fast-path 7 | 40 (전체) |

gold 라벨별: `yes` 94, `yes-and-more` 54, `no` 76, `other` 166, `unclear` 24.
단계별: classifier 334, structural-fail 31, control-forfeit 18, handler-claimed 16, fast-path 15. classifier 단계가 아닌 80건은 실제
런타임이 분류기를 부르지 않는다. 테스트가 그 사실을 고정하므로 eval에서는 호출하지 않는다.

- `handler-claimed`(리뷰 1차에서 추가한 단계): 등록된 turn handler의 `surfaceClaim`이 가져가는 답이다. 운영에서는 분류기 호출 전에
  `other`로 취소된다(A6 classifier wiring 규칙). 16건 중 7건은 gold `yes-and-more`("응 보내고 내일 일정도 알려줘" 등)인데, 운영에서는
  yes가 묶이지 않고 동의가 취소되며 아무것도 보내지 않는다. 기록된 residual이라 gold는 그대로 두고 측정하지 않는다.
- 그 자리를 채우려고 handler가 가져가지 않는 classifier 단계 사례를 더했다: `yes-and-more` 8건(ca-403~410), non-answer 2건(ca-411, ca-412).

질문 맥락(질문은 분류기가 보는 그대로이며, 개수와 주제는 `{개수}` / `{count}` / `{주제}` placeholder로 들어간다):

- `agent-m2` 111건: SR-1 rule-① M2 질문. 메일, 드라이브, 캘린더, 지라, 슬랙, 컨플루언스, 깃허브와 여러 소스를 함께 묻는 질문이 있다.
- `a8-unexpected` 91건: A8.5 질문. 항목 1건이고 예상 밖 수신자(Codex, OpenAI, Gemini)다. v2 스레드 명사 `mail-thread`,
  `slack-thread`가 들어간 질문이 47건이다.
- `d8-lookup` 57건: A8.6 D8 목록 질문.
- `a2-topic` 155건: A2 topic 동의 질문.
- 수신자를 다루는 답: 수신자를 승낙하거나 바꾸거나 되묻는 답, A8.4 수신자 줄("· Claude로 요약")을 붙여 넣은 답이 있다.

## 소유자 결정이 반영된 항목 (2026-11-24)

1. **A6.11 질문 6의 17건**: r-04로 권고 라벨을 그대로 유지했다. 모두 `ownerMark.status: "owner-decided-2026-11-24"`,
   `origin: "owner-verdict"`다.
   - `yes`: `118` "어", `119` "ㅇ", `121` "y", `126` "응응", `127` "네네", `128` "네, 보내주세요", `131` "👍", `133` "yes!!",
     `138` "승인", `139` "send it" (ca-026~035)
   - `no`: `122` "n", `129` "아니 보내지 마" (ca-036~037)
   - `unclear`: `132` "1", `134` "응??", `137` "ㅇㅡㅇ", `140` "글쎄", `141` "응..." (ca-038~042)
   - `130` "응 그리고 메일도 보내줘"는 `yes-and-more`다(AM-2, r-04).
2. **R8 `473`** "응 근데 메일 10개 더 요약해줘" (ca-015): r-01로 `yes-and-more`다(권고 `other`는 채택되지 않았다).
3. **"응 근데 드라이브도"** (ca-304, ca-305): r-01 뒤로는 경계 사례가 아니다. 다른 소스 요청이 붙은 yes이므로 `yes-and-more`다.
4. **최소치**: r-03 (2)로 `yes-and-more` ≥ 40, non-answer(`other`) ≥ 100이 확정됐다. classifier 단계 기준으로 센다.
5. `origin: "owner-verdict"` 42건은 소유자 판정이 있는 사례다. `ref`가 SR-1, A2 사례나 A6.1 항목을 가리킨다. 나머지 372건은 초안(`drafted`)이다.

## 계획한 run (아직 실행하지 않음)

| arm | 모델 | 호출 수 | 5 h 창 추정 |
|---|---|---|---|
| remote | sonnet, effort low, Claude CLI stronger tier, concurrency 4 | 334건 × 3 run = **1,002** (+ 장애 시 canary 최대 4) | 1,002 × 0.06 % = **약 60.1 %** |
| local | `qwen3:8b`, Ollama digest `500a1f067a9f`로 고정, concurrency 1 | 334건 × 3 run = **1,002** | **0 %** (loopback Ollama, Claude 창 미사용) |

- plan digest(현재 코퍼스 기준): remote `977c8ea678ecd47ff734fbd1fc5b544e5815f07f40cff65627ee3c5a9da6d567`,
  local(`run-gates.sh`가 넘기는 `--concurrency 1`) `6c50d4a0ee7843f79a0af5f39d918125b8602a7cf9d4afd502107baebd4c65a9`.
  코퍼스나 옵션을 바꾸면 둘 다 바뀐다.
- 7 d 창: 측정한 호출당 비율이 없다(run-gates는 5 h 창만 추정한다).
- remote 60.1 %는 `GATES_MAX_EST_PCT`(30 %)를 넘는다. 그래서 `run-gates.sh`는 `GATES_OWNER_OK` 없이는 실행을 막는다.
  a6-02 순서대로 local arm을 먼저 돌리고, 통과하면 remote가 필요 없다. 그렇다면 Claude 창 비용은 0이다.
- run-gates 모드: `consent-answer`(remote), `consent-answer-local`(local)이다. 비율 0은 모델 이름이 아니라 `consent-answer-local` 모드에
  붙는다. local arm은 한 번에 한 호출만 보낸다(`--concurrency 1`). 기본 모드에는 넣지 않았고 요청할 때만 돈다.

## 게이트 (R6 + 소유자 r-03, run마다, 3 run, arm별)

wrong capture 0건(gold가 `yes`, `yes-and-more`가 아닌데 `yes` 또는 `yes-and-more`로 읽은 경우), real yes recall ≥ 95 %
(두 binding 라벨 모두 인정), real no recall ≥ 95 %, `yes-and-more` recall ≥ 95 %(r-03 (1), 따로 재고 게이트에 넣는다),
`classifier-sees-content` 0건, harness error 0건, p95 ≤ 10 s. 시간 초과한 호출은 지연을 `Infinity`로 기록해 항상 한도를 넘은 것으로
센다(10 000 ms 근처 값이 타이머 오차로 통과·실패를 가르지 않도록). 3 run이 모두 통과해야 PASSED다. run이 3보다 적으면
NON-GATING(exit 4)이다. provider 장애는 INVALID(exit 5)이지만, 이미 hard failure(wrong capture 또는 content firing)가 관측됐으면
FAILED다. `yes`를 `unclear`나 `yes-and-more`로 읽은 경우는 세기만 하고 실패로 치지 않는다.

remote arm은 실제 provider가 선언한 stronger tier(`supportsStrongerIntentSelection`)를 그대로 쓴다. 선언이 없으면 운영 adapter처럼
호출하지 않고 harness error가 된다. local arm은 측정 대상 모델에 그 선언을 붙인다.

## 소유자 질문

1. **코퍼스 승인(Strict).** 414건을 승인하면 `status`를 `approved`로 바꾸고 sha256을 측정 기록에 고정한다.
2. **apostrophe가 인용 표시로 읽히는 문제(발견 사항, owner / ADR 질문).** ASCII `'`와 typographic `’`(U+2019) 모두
   `hasUntrustedSpanMarker`의 `QUOTE_GLYPH`에 걸린다. 그래서 "don't", "that's fine", "don’t", "that’s fine"은 구조 검사에서 취소되고
   분류기까지 가지 않는다(ca-106, ca-155, ca-156, ca-413, ca-414). 송출이 없는 fail-closed 동작이지만 영어 축약형 답을 쓸 수 없다.
   `QUOTE_GLYPH`는 summary-grant 규칙과 공유하므로 고치면 그 규칙도 바뀐다. 선례는 `nlWithoutInlineQuotes({ contractions: true })`다.
   이번 수정에서는 운영 코드를 바꾸지 않았다.
3. **local arm의 production 배선.** 현재 A6-S2 adapter는 stronger tier를 선언하지 않은 provider에 대해 `unclear`를 반환한다.
   eval은 local 모델을 분류기로 측정하지만, local arm이 통과해 채택되면 adapter와 라우팅 변경이 별도로 필요하다(a6-12 재게이트 포함).
4. **비용 순서.** local arm(0 %)을 먼저 돌릴지, 두 arm을 같은 승인 묶음으로 돌릴지 정해야 한다. remote를 돌리려면 60 %에 대한
   `GATES_OWNER_OK`가 필요하다.
