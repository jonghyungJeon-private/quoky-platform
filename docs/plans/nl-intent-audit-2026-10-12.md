# Natural-language intent routing audit (2026-10-12)

Status: audit record (input to ADR-0120). No product code changed.

## Why

During live Telegram QA the owner sent two messages, and both fell through to general chat, which deflected:
- "오늘 jira 이슈 등록된거 브리핑해줘"
- "오늘 나한테 할당된 jira 이슈가 있을텐데 ?"

Owner requirement (2026-10-12):
- "이런식의 자연어 테스트로 정상적인 결과가 도출되어야 한다"
- "특정 단어로만 호출되는건 원치 않아. (하드코딩이면 안된다는 말임)"
- "비단 jira 말고도 다른 케이스들도 다 마찬가지니까 전체 검수도 한번 필요하겠다"

## Method

The harness is on branch `claude/nl-intent-audit`, commit `09f355c`, at `scratch/` (throwaway). It is based on `origin/main` @ `c204cae`.

- It boots the production `AppModule` and calls the real `ConversationRuntime.handle()`, so it exercises the real dispatch order, handler registry and classifier.
- Only the AI providers, the calendar, mail and Drive readers, and the command runner are stubbed. Jira, GitHub, Slack and Confluence are unconfigured, so the harness measures routing, not connector data.
- The corpus has 417 phrases across every capability. They mix casual and polite forms, questions, time qualifiers, indirect requests ("~있을텐데?", "정리해줘", "브리핑해줘"), typos, follow-ups and English, plus 45 negatives.
- Each phrase is run twice: with and without a registered sandbox project.

## Results

**Overall: 221 of 417 phrases routed correctly (53%).**
- Of the 372 phrases that should reach a capability, 176 did (47%). 193 of the 196 misses fell to general chat.
- All 45 negatives stayed in chat. The grammars are precise, but their recall is very low.

| Capability | Hit | Capability | Hit |
|---|---|---|---|
| jira | 9/26 | mail list | 7/20 |
| github | 6/16 | mail summary | 3/15 |
| slack search | 8/16 | mail write (refusal) | 5/15 |
| confluence search | 8/16 | drive list | 7/16 |
| to-do | 11/20 | drive summary | 3/15 |
| calendar read | 14/20 | reminders | 15/20 |
| calendar write | 11/15 | daily brief | 2/15 (scheduled form only) |
| help | 13/20 | code change | 12/15 (7/15 with no project) |
| run tests | 5/10 (0/10 with no project) | project analysis | 7/8 |
| project register | 4/4 | git branch | 3/4 |
| git flow | 4/11 | learning | 2/8 |
| feedback | 1/7 | memory | 4/15 |
| model | 4/10 | jira write | 5/9 |
| slack write | 3/6 | negatives | 45/45 |

### Top failure patterns

1. **Closed verb lists.** "정리해줘", "브리핑해줘", "요약해줘", "확인해줘", "있나?" and "있을텐데?" all miss.
2. **A source word is required in a fixed slot.** "나한테 할당된 이슈 정리해줘" misses even though `my-items` exists.
3. **Time words only match inside fixed spans.** Elsewhere the phrase misses, or the time word is silently turned into search text.
4. **Follow-ups need an exact "N번 + noun".** Mail and Drive summaries hit 3/15 each; follow-ups overall hit 14/48.
5. **English** matches only the exact imperative templates.
6. **Typos miss**, e.g. "슬렉", "컨플", "ㅈㅣ라".
7. **Learning, memory, feedback and model switching** are reachable only through anchored commands.
8. **Capability questions** such as "너 jira 볼 수 있어?" go to chat.

### Wrong captures (with a project registered)

| Phrase | Wrong destination |
|---|---|
| "jira 이슈 만들어줘 …" | code change (file-path clarification) |
| "codex로 바꿔줘" | code change |
| "좋은 아침! 오늘 뭐 있어?" | calendar-only answer |

Two hits are misleading:
- "진행중인거만" drops the status filter.
- "어제 논의된 내용" is searched as literal text.

## Capability gaps (routing alone cannot fix)

- Jira:
  - No created-date or resolved-date filter. The JQL is fixed to assignee, unresolved and not done.
  - No status or reporter filter.
  - No single-issue lookup by key from a natural phrasing.
- No on-demand daily brief. It exists only as a scheduled reminder body.
- GitHub has no merged or authored queries.
- Slack has no channel reads or mentions.
- Confluence has no recents and no page summary.
- Mail has no time window beyond "today".
- Drive has no time filter.
- Calendar has no past-week or month span.
- Git status and log are unavailable outside an apply anchor.
- Jira cannot create or assign issues.

"나한테 할당된 이슈" is not a gap: it maps to `my-items`. It is a phrase miss only.

## Where chat deflects

`CHAT_CAPABILITY_HONESTY_RULE` tells the chat model not to act and to point to "도움말". The chat prompt carries no capability facts, so any missed phrase becomes "use a command".

Mail-write phrasing that the grammar does not recognise goes to `POLICY_SENSITIVE_CHAT`. The deterministic replies themselves are honest: not configured, writes off, no approval.

## Routing order (first match wins)

1. `detectConversationControl`
2. Control stage: `feedback.summary` (100)
3. Pending-approval, credential-override and image intercepts
4. Post-anchor stage: `git-branch` (100)
5. Anchored git/PR chain states, stray-decision, connector-write-execution and `기억해:`
6. Pre-classify stage, by order:

   | Order | Handler |
   |---|---|
   | 50 | memory-commands |
   | 60 | feedback.learning |
   | 70 | model-selection |
   | 100 | work-chat.todo |
   | 140 | mail |
   | 145 | drive |
   | 150 | calendar |
   | 200 | reminders |
   | 300 | work-chat.lookup |
   | 400 | help-intent |

7. Internal-action status question
8. `IntentClassifier`: to-do surface, `/preview`, register, run tests, code change, project analysis, otherwise chat
9. Execution handler, project analysis, or general chat (`GENERAL_CHAT` / `POLICY_SENSITIVE_CHAT`, no tools)

## Reuse

`scratch/nl-corpus.ts` (417 phrases) is the seed for the versioned NL evaluation corpus required by ADR-0120. Under ADR-0098 D7, the owner approves each batch.
