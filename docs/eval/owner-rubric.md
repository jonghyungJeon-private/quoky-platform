# Owner rubric: judgment answers (v1, 2026-10-26)

Quoky가 소유자 요청("중요한 거 하나만", "순서대로 줄 세워줘", "답장 안 해도 되는 메일" 등)에 대해 나열된 항목을 비교·판단해
답하는 답변을 평가하는 기준이다. `quoky-eval-judge` subagent(`.claude/agents/quoky-eval-judge.md`)가 이 기준을 적용한다.

이 rubric은 **소유자 본인의 blind label과 note에서만** 뽑았다. 각 rule 옆의 case id가 근거다. 근거 없는 규칙은 넣지 않았고,
근거가 약한 것은 "근거 없음/약함"으로 따로 적었다.

## Source and split

- Source: judgment blind eval 2026-10-23/26. 35개 synthetic case × 답변 2개(A/B). 항목은 모두 합성 데이터
  (`example.test`, `acme/*`, 가상의 일정·이슈)다. 소유자가 답변마다 `useless | usable | good`, 선호 `A | B | same`, note를 남겼다.
  Archive: `~/Library/Application Support/Quoky/eval-archive/judgment-eval-20261023/` (`blind.json`, `owner-labels.json`,
  `judge-split.json`). Arm map(`key.json`)은 judge에 절대 주지 않는다.
- Split (rubric 작성 **전에** 고정): `sha256("quoky-eval-judge-holdout-20261026" + id)` hex 순으로 정렬해 앞 18개가 held-out.
  - Calibration (17, note를 rubric 근거로 씀): lj-002 003 005 006 007 011 012 014 017 020 021 023 025 026 027 028 032
  - Held-out (18, note를 rubric에 쓰지 않음): lj-001 004 008 009 010 013 015 016 018 019 022 024 029 030 031 033 034 035
- Calibration half 분포: good 17, usable 9, useless 8 (34개 답변). 모든 case에서 선호는 A 또는 B였고 `same`은 없었다.
  선호는 항상 label이 더 높은 쪽이었다.

## Labels

| Label | 소유자 기준 (calibration 근거) |
|---|---|
| `useless` | 요청한 **형태**를 못 지킴(순위를 달라는데 1개만, 해당 항목을 빠뜨림, 질문의 한 갈래를 빼먹음), 고른 것과 이유가 서로 모순, 또는 이유 없이 항목 이름/번호만 던진 조각 답. 핵심 pick이 맞아도 이 중 하나면 useless다. (lj-006 B, lj-007 A, lj-011 B, lj-012 A, lj-014 A, lj-017 A, lj-027 A, lj-032 A) |
| `usable` | 요청 형태는 지켰고 핵심 pick도 납득 가능하지만 얇다: 이유가 일반론 한 줄, 번호만 쓰고 제목을 안 붙임, 나머지 항목·추가 고려사항 언급 없음. (lj-002 B, lj-005 A, lj-020 A, lj-021 B, lj-023 A, lj-025 A, lj-026 A, lj-028 B; lj-003 B는 pick 자체가 의심스러운데도 usable) |
| `good` | 요청 형태를 정확히 지키고, pick마다 항목 데이터(시간·마감·우선순위·상태·발신자)에 근거한 이유, 대개 나머지 항목이 왜 뒤인지 짧게 또는 한 줄 추가 고려사항, 제목(+ID)으로 지칭, 사람 말투. (lj-002 A, lj-003 A, lj-005 B, lj-007 B, lj-011 A, lj-012 B, lj-014 B, lj-017 B, lj-020 B, lj-021 A, lj-023 B, lj-025 B, lj-026 B, lj-027 B, lj-028 A, lj-032 B) |

## Rules

### R1. 물어본 형태 그대로 답한다 (shape compliance) — 위반 시 useless

- "순위/줄 세워줘/rank"면 **모든 항목**을 순서대로 놓는다. 1등만 말하면 useless.
  - lj-011 B (inbox rank 요청에 1번만): "B는 랭크매기지 않은거 같은데?" → useless
  - lj-027 A (위험도 rank 요청에 1순위만): "순위를 매겨달라는 의도인데 … 1순위만 언급했어" → useless
  - lj-002: 전부 순서+근거(A good) vs 2개만 순서, 나머지 3개 뭉뚱그림(B usable). "중요도 순서로 줄세우고 그에 대한 근거를
    적어놓은게 더 보기좋아" — 부분 순위(상위만 순서, 나머지는 "낮다"로 묶음)는 이유가 얇아도 useless까진 아니고 usable.
- "~만 골라줘/있으면 알려줘"처럼 **항목 데이터로 조건이 객관적으로 정해지는**(마감일, noreply/영업 발신자, Blocked 상태)
  필터 질문이면 조건에 맞는 항목을 전부 고른다. 하나라도 빠지면 useless.
  - lj-012 A (답장 불필요 메일 2개 중 1개만): "신제품 소개에 대한 언급이 없었어" → useless
  - lj-017 A (마감 임박 3건 중 APP-45 누락): "푸시 알림 문구 수정에 대한 언급이 없어" → useless
- 반대로 판단이 필요한 "제일 나은 걸 골라줘"형 질문은 근거 있는 pick 하나로 형태를 충족한다. 두 번째 후보를 안 말해도
  useless가 아니다.
  - lj-028 B ("작아서 금방 볼 수 있는 것": 1번만, 3번 문구 정리 미언급) → usable
  - lj-003 B ("which can I safely skip": 하나만) → usable
- 질문이 "A 또는 B"(겹치거나 **또는** 빡빡한)처럼 여러 갈래면 갈래마다 답한다.
  - lj-007 B good: "질문이 or 조건으로서, 잘 대답을 한거 같아". A(겹침 하나만, "가장 급함"으로 엉뚱하게 마무리) useless.

### R2. pick과 이유가 맞고 서로 모순되지 않는다 (correctness, internal consistency) — 모순이면 useless

- lj-006 B: "고객 데모가 미루기 쉬운 일정"이라면서 "시간 조정이 어려울 수 있다" → "앞의 말과 뒤의 말이 서로 상이", 그리고
  고객 데모는 중요한 단계라 미루기 어렵다 → useless.
- 항목 데이터와 다른 사실(마감일 오기 등)을 말하면 감점 근거다. lj-017 A는 APP-52 마감을 11-03이라고 잘못 말했다(누락과 함께 useless).
- 소유자는 pick이 틀려 보여도 문장이 스스로 모순되지 않으면 usable을 줬다(lj-003 B: 계약 갱신 통화를 건너뛰라고 함 →
  usable). pick에 대한 judge의 이견만으로 useless를 내리지 않는다. useless는 자기모순, R1 형태 위반, 조각 답(R6)일 때다.
  이 경계는 confidence를 낮춰 소유자 검토로 보낸다.

### R3. pick마다 항목 데이터에 근거한 이유를 붙인다 (specific reasons)

- lj-005: A "1번은 … 중요한 의사결정이 필요하고" 수준 → "A는 내용이 부실하네" usable; B는 시간·장소·준비할 것까지 → good.
- lj-003 A good: "세부적으로 잘 설명해줘서, 선택에 용이하게 됨".
- lj-014 A useless: "1과 3" (pick은 정답). B good: "세부적인 추가내용이 좋았어".
- lj-020, lj-023, lj-025, lj-028: 같은 pick이어도 근거가 구체적인 쪽이 good, 일반론 한두 문장은 usable.

### R4. 나머지 항목과 짧은 추가 고려사항을 덧붙인다 (brief extra considerations)

- lj-023 B good: "나머지 두 건에 대해서도 언급해줬어. 질문 외에 챙겨야할 것들도 추가로 얘기해줘서 더 좋은거 같네."
- lj-025 B good: "모든 이슈에 대한 언급과 중점으로 볼 이슈에 대해서 요약". (A도 "쓸만했던게 … 중점 이슈를 언급하고 요약" → usable)
- lj-021 A good: Blocked 이슈 + 같이 지연될 수 있는 INT-11까지. lj-003 A, lj-012 B, lj-014 B, lj-017 B, lj-028 A도 같은 패턴.
- 개수 지정(count)이 있어도 "2순위는 …"처럼 보조로 하나 더 언급하는 건 감점이 아니다(lj-026 B, count=1, good). 개수가 없는
  질문에서 "하나만 꼽으면 …"으로 좁히고 다른 후보를 보조로 말하는 것도 good이다(lj-032 B).
- 나머지 항목이 왜 뒤인지는 good 답변에 흔하지만 필수는 아니다. lj-032 B는 점심 예약·팀 문서를 언급하지 않았는데도 good이다.
- 짧게: 모든 good 답변이 10줄 이하였다. 장황함 자체를 칭찬한 note는 없다.

### R5. 항목은 ID/번호 + 제목으로 부른다 (name items)

- lj-021 B: "INT-8 이라고 할 때 해당 주제도 … INT-8(외부 API 키 발급 대기) 등으로 표기해주면 더 좋을거 같아" → usable.
- lj-023 A "1번 PR" (usable) vs B "acme/web #501("Fix login redirect loop")" (good). lj-025, lj-026, lj-028도 같은 방향.
- 번호/키만 쓴 답("1번 PR", "INT-8")은 다른 조건이 다 맞아도 good으로 올리지 않는다. 제목만 따옴표로 쓴 것은 충분하다
  (lj-032 B '장기 프로젝트 기획서 초안', good).

### R6. 사람 말투, 조각 답 금지 (human tone)

- lj-032 A "건강검진 예약" 한 마디 → "너무 AI 틱한거 같아. 사람스러워야할거같은데" → useless.
- lj-014 A "1과 3" → useless (R3과 같이).
- 한국어 질문엔 자연스러운 한국어. 영어 질문에 한국어로 답한 good 사례가 여럿이라(lj-003 A, lj-005 B, lj-025 B, lj-027 B)
  언어 불일치만으로 감점하지 않는다.

### R7. 중요도 판단은 소유자 감각에 맞춘다 (owner priorities)

- 고객·외부가 걸린 일, 되돌리기 어려운 변경은 중요하게 본다(lj-006 고객 데모; lj-026 DB 마이그레이션과 캐시 정책 둘 다
  "한번 더 체크해서 머지하는게 좋아", lj-027 테이블 삭제 1순위).
- 소유자와 순서가 다르더라도 근거가 타당하면 good이 가능하다(lj-026 B good, 소유자는 A·B를 "섞었으면" 했음). 다만
  이런 case는 confidence를 낮춘다.

### Preference

- label이 높은 쪽을 고른다. calibration에서는 예외가 없었다.
- label이 같으면 R1 → R2 → R3 → R4 → R5 → R6 순으로 더 잘 지킨 쪽. 실질적으로 차이가 없을 때만 `same`.

## Evidence-free or weak (적용 시 confidence를 낮춘다)

- **Count compliance**: 요청에 개수가 있는데 개수를 어긴 답은 calibration half에 없었다. 원래 생성 지시(`run.py`)는 "정확히
  그 개수"를 요구했지만 소유자 label 근거가 아니므로 rubric 규칙으로 확정하지 않는다. 보조 언급은 허용(R4).
- **"오늘 기준 이번 주가 아님" 같은 날짜 메타 코멘트**: lj-002 A, lj-017 B에 있었고 둘 다 good이지만 note가 이를 언급하지
  않았다. 가점/감점 근거로 쓰지 않는다.
- **URL/길이 제한 위반**: calibration에 사례 없음.

## Rubric context from AP-8 plan-gold review (not calibration)

AP-8(2026-10-23)은 답변 품질이 아니라 plan gold(어떤 step/mode로 답할지)에 대한 ok/fix 리뷰라 calibration set으로 쓰지 않는다.
답변 평가와 겹치는 방향만 참고로 둔다.

- 질문이 놓인 맥락 그대로 답한다: "pull request 목록 **기준으로** 코드 리뷰 코멘트 … 알려줘야 하지 않을까?" (ap-p818). R1과 같은 방향.
- 필요한 정보가 없으면 되묻는다: "참석자가 누군지 등등 되묻기 필요" (ap-n809). judgment eval에는 해당 case가 없다.
- 여러 소스를 엮는 무거운 판단은 더 강한 생성 경로가 맞다는 의견(ap-p821 계열). judge 기준이 아니라 routing 의견이다.

## Calibration-half tuning log

Rubric v1 초안으로 calibration half(17)를 1회 돌린 결과(in-sample) exact 88.2%, usable+ 91.2%, 선호 100%였다. 불일치 4건은
모두 judge가 소유자보다 엄격한 방향이었다: lj-002 B·lj-003 B·lj-028 B (owner usable, judge useless), lj-032 B (owner good,
judge usable). 위 R1(판단형 질문은 pick 하나로 충족, 부분 순위는 usable), R2(이견만으로 useless 금지), R4(나머지 항목 설명은
필수 아님), R5(제목만으로 충분) 문구가 그 결과로 다듬어졌다. 근거는 모두 calibration case다. Held-out case는 이 단계에서
보지 않았다.

## Re-calibration

새 소유자 label이 생기면(새 blind eval, 새 note) 이 문서를 갱신하고 `quoky-eval-judge`의 rubric 블록을 맞춘 뒤 held-out 측정을
다시 한다. 절차와 현재 결과는 `docs/eval/README.md`.
