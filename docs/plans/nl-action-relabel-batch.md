# A6 재라벨 배치 (소유자 검토용)

- 근거: A6 비준 기록 결정 10. A5의 "요약은 이 설계(this design)" 규칙 때문에만 gold가 `none`이던 `nl-intent.v1` 케이스를 `item.summarize`로 바꾸는 안입니다.
- **`nl-intent.v1.json`은 아직 수정하지 않았습니다.** 소유자 승인 후에 반영합니다.
- 조사 범위: `nl-intent.v1.json`의 `expect: "none"` 178건 전부를 훑었고(요약, 내용, 정리, 번역, 문서/메일 대상 문장 포함), 단건 요약 요청이라서 `none`이던 케이스는 아래 4건뿐입니다.
- 반영 시 함께 필요한 변경: 이 케이스들은 `prior`(직전 선택)만 있고 목록 상태(`lastListing`)가 없습니다. A6 평가(`eval:nl --mode read-regression`)는 목록 상태를 컨텍스트로 받으므로, 반영할 때 `context.lastListing`을 함께 넣습니다(아래 표의 "필요 컨텍스트").
- 이 4건은 게이트의 "read 케이스를 A6 엔트리가 가로채면 0건" 쪽에서 **읽기가 아니라 요약**으로 분류가 바뀝니다. 목록 읽기(`mail.list`, `drive.files`)로 가면 여전히 오답입니다.

## 재라벨 대상 (4건)

| id | 문장 | 현재 gold | 제안 gold | 필요 컨텍스트 | 비고 |
|---|---|---|---|---|---|
| neg-098 | 1번 메일 요약해줘 | none (prior mail.list today) | `item.summarize` `{source: mail, ref: "#1", mode: summary}` | 직전 목록 = 메일 (번호 1 존재) | 요약 단어가 명시되어 mode는 summary |
| neg-099 | 이 문서 요약해줘 | none (prior drive.files) | `item.summarize` `{source: drive, ref: "this", mode: summary}` | 직전 목록 = Drive 1건, 또는 lastAction이 Drive 항목 | 목록이 여러 건이면 질문이 정답이므로, 목록 1건으로 고정해야 gold가 확정됩니다 |
| neg-100 | summarize document 1 | none (prior drive.files) | `item.summarize` `{source: drive, ref: "#1", mode: summary}` | 직전 목록 = Drive (번호 1 존재) | 영어 표현 |
| uat5r6-07 | 그거 요약해줘 | none (prior mail.list) | `item.summarize` `{source: mail, ref: "recent", mode: summary}` | 직전 목록 = 메일 1건 (그 외에는 질문) | 2026-10-14 실사용에서 나온 문장. "그거" 단독은 지시어만으로 선택하지 않으므로, 목록이 1건일 때만 실행으로 gold 처리 |

## 재라벨하지 않는 근접 케이스 (none 유지)

| id | 문장 | 이유 |
|---|---|---|
| neg-054 | 이거 요약해줘: 오늘 회의에서 … | 붙여넣은 텍스트를 요약하는 일반 대화이고, 목록 항목이 아닙니다 |
| neg-053 | 다음 메일 내용 번역해줘: Dear team, … | 번역 요청이며 붙여넣은 텍스트입니다 |
| neg-032 | 드라이브 파일 정리 잘하는 법 | 주제 질문입니다 |
| neg-079 | 스팸 메일 정리해서 삭제해줘 | 삭제는 A6 범위 밖 쓰기입니다 |
| neg-075, neg-076, neg-078 | 1번 메일에 답장해줘 / 이 메일 삭제해줘 / forward this mail | 메일 쓰기. A6 엔트리가 아닙니다 |
| neg-200 | can you post to Slack for me? | 쓰기 가능 여부 질문 (R3 이전에는 none) |

## 소유자께 확인 요청

1. 위 4건을 `item.summarize`로 바꾸는 것에 동의하시나요? (`mode`는 문장에 요약 단어가 있어 모두 summary입니다.)
2. neg-099와 uat5r6-07처럼 목록 크기에 따라 정답이 갈리는 케이스는, 목록 1건 조건을 컨텍스트로 고정해 gold를 확정하는 방식이 괜찮으신가요?
3. 같은 문장을 목록 여러 건 컨텍스트로 만든 변형(정답 = 질문)은 `nl-action.v1.json`의 참조 케이스(`a6-reference-*`)에 이미 들어 있어 중복 추가하지 않았습니다.
