# Held-out homonym / source-word cases (APPROVED 2026-11-04)

Status: APPROVED 2026-11-04 (owner, verbatim: "16건 승인, 평가 도구 연결 진행해"). The 16 cases are approved as written and live in
`packages/core/src/application/golden/nl-intent.homonym-heldout.v1.json` (select with `--fixture homonym-heldout`); this document is
the record of their intent. Never use them as prompt examples (RAG-0).

Purpose: the one-step corpus holds exactly one homonym negative (`neg-033`), so the source-name principle of
`nl-select.v74` / `agent-plan.v11` cannot be measured on it without fitting the prompt to that case. These 16 cases use
other source words and other sentence shapes. If the owner approves them, they become a small held-out set for the
v73-versus-v74 (and v10-versus-v11) comparison, screened with a bounded number of calls only after the owner approves
the eval quota. None of the wording was used when the v74 text was written, and none of it may be used as a prompt
example (RAG-0).

Checked against `nl-intent.v1.json`, `agent-plan.v1.json`, `nl-action.v1.json` and `agent-redteam.v1.json`: no case below
is an exact or near copy of an existing case (searched by its key nouns). Several existing cases are in the same family
and are not repeated: `neg-033` (car drive), `neg-037` (venting about issues), `neg-024` (calendar app recommendation),
"알림 소리 끄는 법", "오늘 할 일이 너무 많아서 정신없어", the a7s intention cases.

Expectation column: `none` = the executable plan or selection must be none; a clarification question is also
acceptable on a NEGATIVE (the scorer does not count it), but is recorded separately here so the comparison can show it.
For a POSITIVE only the stated entry and args count; a clarification or none is a miss.

## Negatives (the source word is present, but it is not the requested data or place)

| id | message | expected | why |
|---|---|---|---|
| hm-n01 | 우리 집 벽에 걸어둔 캘린더 색이 너무 칙칙해서 바꾸고 싶어 | none | 캘린더 is a wall calendar (an object) and the message is a remark about it. No request to see the owner's events. |
| hm-n02 | 제주도 여행 일정 짜는 게 이렇게 어려운 줄 몰랐어 | none | 일정 means a trip itinerary the owner is planning, and the sentence is a feeling. It does not ask for the calendar. |
| hm-n03 | gmail 주소 새로 만들 때 아이디 뭘로 하는 게 무난해? | none | A general question about choosing an e-mail address. The word names the product, the request is advice, not the owner's mailbox. |
| hm-n04 | I really need to cut myself some slack this week | none | English "slack" meaning leniency. Not the chat tool, and nothing is asked. |
| hm-n05 | 지라 티켓 번호를 커밋 메시지에 붙이는 규칙을 팀에 어떻게 설명하면 좋을까? | none | Jira is the topic of a team-process question (advice). The owner asks for no ticket data. |
| hm-n06 | 깃허브 프로필 소개 문구 좀 센스 있게 써줄 사람 없나 | none | GitHub is where the owner's profile text lives, but the request is for writing help, not for issues or pull requests. |
| hm-n07 | 하드 드라이브에서 딸깍 소리가 나는데 이거 고장 난 걸까? | none | Hardware drive (a disk), not Google Drive. A repair question. |
| hm-n08 | 알림이 쌓일 때마다 폰이 계속 진동해서 정말 짜증나 | none | 알림 is a phone notification, and the message is a complaint. It asks for no list of Quoky reminders. |
| hm-n09 | 내일 발표할 브리핑 자료 첫 장 문구를 좀 다듬어줘 | none | 브리핑 is a presentation to give. The owner asks for text editing, not for Quoky's daily brief. |
| hm-n10 | snail mail은 제주까지 왜 이렇게 오래 걸리지 | none | Postal mail (English wording), a remark and a rhetorical question. It does not ask for the inbox. |

## Positives (the source word is the place or the data, with weak or indirect phrasing)

| id | message | expected | why |
|---|---|---|---|
| hm-p01 | 드라이브에 지난주에 올려둔 게 뭐였더라 | drive.files, args {}, CLEAR | The owner names Drive as the place and wants to recall what is there; no file type or name, so recent files. Past tense and "더라" must not turn it into a remark. |
| hm-p02 | 슬랙에서 배포 공지 누가 올렸나 싶은데 | slack.search, keyword 배포 공지, CLEAR | Slack is named as the place to look; the request is indirect ("싶은데"). |
| hm-p03 | 캘린더 보니까 금요일엔 뭐 잡혀 있어? | calendar.events, range fri, CLEAR | The calendar is the place; "금요일엔" is the period. |
| hm-p04 | 메일 중에 오늘 들어온 것만 좀 | mail.list, range today, CLEAR | A clipped, verbless request. The mail is the data, the period narrows it. |
| hm-p05 | 지라에 나한테 걸린 것 중에 이번 주까지인 거 | jira.issues, window due, range this-week, CLEAR | Jira is the place; "이번 주까지인" is the due window; no verb at all. |
| hm-p06 | 깃허브에서 내 리뷰를 기다리는 게 있나 보려고 | github.items, query review-requests, CLEAR | GitHub is named, the review request is the data, and the sentence ends in an intention ("보려고"). |

## Notes for the owner

- Weak-phrasing positives (hm-p01, hm-p05, hm-p06) are the ones most exposed to the stricter reading of the v74
  principle. They are here on purpose: a regression to none or to a clarification on them is the cost to measure.
- hm-p02 and hm-p05 have a plan-form twin only if two of the sources are combined; that is not drafted here.
- No real person, company or ticket is named. Notion is not used: Quoky has no Notion connector in the catalog.
- Approved as written on 2026-11-04 and added as a separate fixture (not to `nl-intent.v1.json`), so the existing corpora and their
  digests do not move. Running them against a model still needs the owner's quota approval of the plan digest.
