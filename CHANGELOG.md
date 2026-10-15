# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [SemVer](https://semver.org/). Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## Unreleased — A6 R1 gate fixes: same-source cross-check, bare references, A6 prompt `nl-select.v26` (2026-10-15)

- **Wrong target closed.** The owner's item-source nouns (catalog aliases) are cross-checked against the entry's source
  for every ref kind; "1번 문서" after a mail list or "2번 메일" after a Drive list asks and reads nothing.
- **Bare references select nothing.** "2번도", "그거", "1" alone are chat (`no-request`), unless an A6 question is open.
- **Validator.** Stacked particles in the whole-message time check ("5시에도"); the deictic-payload reply before a
  missing argument.
- **Prompt `nl-select.v26`** (A6 only; read prompt `nl-select.v24` unchanged): `when` without 에, `this` vs `recent`,
  pick the asked action with another list shown, copy a deictic content as the span.
- **Eval and corpus (owner decisions 2026-10-15).** `{}` refusal golds scored by their closed reason; `acceptsNone` on
  the relay cases 901/902; the 11 anchored read cases carry their A6 action as `a6Relabel` (A6-on gold, scored apart).
- **Owner D12 gold fixes (2026-10-15):** READ golds of the action corpus scored on the entry only; `acceptsAnyQuestion`
  (item.summarize-006/008/014/015, seed-ref-002); `alsoAccepts` (`todo.cancel-005`: `action.undo`); complete-034 listing,
  todo.add-037 execute, `neg-086` verbatim title. `neg-051` (A6 prompt pulled it to `help.topic`): v26 rule-8 wording.
- **Haiku check (1 run each, not the gate):** action 92.6% (A6 entries 95.2%), 0 wrong targets, 0 negative captures,
  span 97.5%; read regression 0 action captures. Remaining gate blockers are READ-entry gold args (owner list in
  DECISIONS). `QUOKY_NL_ACTIONS` stays `off`.

## Unreleased — ADR-0122 Accepted; A9 P1 surface permission grants (inert by default, 2026-10-15)

- **Decided.** ADR-0122 accepted by the owner ("모두 권장안"): channels are default deny for personal and connector
  capabilities; a group works in a channel only with the owner's grant for that channel; DMs are unchanged.
- **Added (security, off until the owner enables it).** One Core gate (`SurfaceGate`) before every handler, selection, A6
  dispatch, route, state-bound code step, connector-write step and approval decision (chat and operations UI) in a
  channel; every turn handler declares `surfaceClaim`. Denials are fixed copy, nothing is read, logs are content-free.
  Closes the remaining channel exposures (to-do and reminder listings / actions, cross-conversation write hints) and
  reaction feedback without `memory`.
- **Added.** Owner phrases `이 채널 권한 보여줘`, `채널 권한 목록`, `… 허용 해제`, `이 채널 권한 모두 해제`, `모든 채널 권한
  해제` (with a DM receipt); `에이전트 중지` suspends every channel grant. The grant phrase itself is P2 (answered "준비 중").
- **Added.** `QUOKY_CHANNEL_GRANTS=enforce|off` (P1 default `off`) and `QUOKY_CHANNEL_GRANTS_SEED` (validated, applied once
  per digest after the identity provisioner, logged, one owner DM line).
- **Changed.** Every `Actor.metadata` writer (A6 kill switch, interpretation preferences, grants) goes through one
  per-actor lock (`ActorMetadataStore`); a source test forbids other writes. Runtime deps baseline 36 → 37.
- Tests: the gate decision table, codec / seed / map / phrase / service / lock suites, approval re-checks, and a
  production-AppModule acceptance over 517 corpus cases (off == absent, DM unchanged, seeded channel unchanged except
  writes, ungranted channel denied with nothing read) plus the owner flows.

## Unreleased — security hotfix: recall, curated examples and owner memory/learning commands are DM-only (P0 ahead of ADR-0122 D7, 2026-10-15)

- **Fixed (security).** Durable recall was scoped by actor only, so a memory saved in a DM ("기억해: …") and the
  owner-curated examples could reach a reply in a shared channel. `ContextBuilder` now queries recall and curated
  examples only for a direct conversation (`ConversationContext.direct`, platform-neutral).
- **Fixed (security).** Memory commands (lists, views, status, confirmation previews), learning commands (candidates,
  examples) and `피드백 요약` answer "이 기능은 DM에서만 쓸 수 있어요" outside a DM and read nothing, so no listing
  enters a channel or its history. An own-memory question in a channel gets "개인 기억은 DM에서만 확인할 수 있어요"
  (no provider call) instead of the untrue "기억에 없어요".
- **Changed.** `isDirectConversation` is fail-closed: only `direct: true` is a DM (a context without the flag is a
  channel); the conversation label keeps the older inference for stored contexts. Both adapters set the flag; DM turns
  are byte-identical. The QA channel loses these features until the ADR-0122 grants exist.
- Tests: per-handler channel rows, ContextBuilder rows, runtime tests on the provider prompt, the own-memory reply and
  the channel history; DM fixtures now set `direct: true`.

## Unreleased — A8 fix: project key inside the release words (2026-10-15)

- **Fixed:** "OP26 20261015 릴리스 …" put the key in the release name and reported 0 issues. Core moves a visible project key
  out of the release words into `project`; an unresolved release without a project now says "릴리스를 찾지 못했어요".

## Unreleased — ADR-0120 amendment A8 Accepted: default scope mine, channel rule, review fixes, live probe (2026-10-15)

- **Owner decisions:** release listings default to the owner's own items ("default로는 당연히 내 담당 기준"); every
  assignee only on explicit words. Every-assignee scope and the project / release lists are DM-only until A9.
- **Review fixes:** deadline checked before every query; first-page narrowing; 400 → NOT_FOUND only for the fix version;
  release words stripped (raw retried); partial counts labelled; no Jira URL built in Core.
- **Live probe (read-only):** OP26 "차란차 플랫폼 운영 2026", release "배포일_20261015(목)"; matching now uses whole words
  and whole tokens. Dry run: mine 0, all 17 (완료 1 · 진행 중 16 · 할 일 0).
- D12: the 35 `a8*` cases approved, gold adjusted for the default scope.
- **Review round 2:** dotted versions are one token (`2.3` is not `2.3.1`); a release or project is picked only when
  proven unique (bound of 5 projects, partial listings, several matches ask); channel list requests refused before any
  catalog read; "모든 이슈" / "all issues" no longer mean every assignee; a DM with 0 own items is told how to ask for all.

## Unreleased — ADR-0120 amendment A8 (as first proposed): Jira release listings, `jira.release`, prompt `nl-select.v27` / `v28` (2026-10-15)

- **New READ entry `jira.release`** (the owner's live request of 2026-10-15): the issues of one Jira release (fix version)
  for every assignee by default, grouped like Jira's release report (완료 / 진행 중 / 할 일 with counts; key, summary,
  assignee, status and link per line; the release page link), `mine` only on the owner's words; a project's release list
  when no release is named; release links (`/projects/<KEY>/versions/<id>`, `/browse/<KEY>/fixforversion/<id>`) used only
  when the host equals the configured Jira site, any other link ignored and never fetched. Never summarised by a model.
- **Connector port (additive).** Named queries `containers`, `releases`, `release-items` with validating parsers;
  `ConnectorItem.assignee` / `statusCategory`, `ConnectorResult.truncated`. The Jira adapter reads
  `/rest/api/3/project/search`, `/rest/api/3/project/{key}/version` and `/rest/api/3/search/jql` (GET, same host, same
  token); `release-items` JQL uses a validated project key, a numeric version id or a quoted, escaped name, and a constant
  order (injection tests). A 400 for a version is `NOT_FOUND`.
- **Validation.** `jira.release` needs a release, a project or a release link (else the usage question); `jira.issues`
  refuses every-assignee words (asks instead of answering with the owner's own items). Jira keyword grammar forms yield a
  release or every-assignee qualifier (A2 rule; yield off is byte-identical).
- **Prompt.** `nl-select.v27` = v24 plus six `jira.release` examples shown only while the entry is offered (byte-identical
  otherwise; golden renamed `nl-select.v27.prompts.json`, 3 new pinned cases); A6 prompt `nl-select.v28`.
- **Corpus.** 28 `a8-*` positives (the four live sentences and the release link verbatim) and 7 `a8n-*` negatives,
  PENDING the owner's D12 batch.
- **Probe (owner-approved model runs, Haiku, 20 calls each, final prompt):** the four live sentences and the release
  link 100/100 exact; "jira 전체 담당 이슈 다 보여줘" 20/20 asked, 0 wrong captures; p95 ≤ 3.1 s.
- Composition: the work-chat desk receives the configured Jira site host (`QUOKY_JIRA_BASE_URL`); no new env key.

## Unreleased — A6-D2 clarification: "이 / 그 / 저 + noun" is a deictic; held relabels applied; INT-4 cases approved (2026-10-15)

- **A6-D2 (owner-approved clarification).** A determiner 이/그 before a whole item-source noun of the catalog naming the
  entry's own source ("이 문서", "그 메일"; not "이 파일럿", not "그 알림" for a to-do) grounds `ref: this` / `recent`
  exactly like 그거/이거; 저 (also "I") grounds reads only. A payload made only of one asks like "그거". The nouns are derived from the mail, Drive, to-do and reminder list entries' aliases; no phrase list, no
  prompt change. Resolution is unchanged: one listed item reads it, several ask, another source asks.
- **Corpus.** `neg-099` → `item.summarize {source: drive, ref: this, mode: summary}` with a one-item Drive listing;
  `uat5r6-07` un-held and respelled `ref: this` (one-item mail listing); both in `eval:nl --mode read-regression` only.
  The 41 INT-4 cases `v5int4-001..041` are marked owner-approved (D12 batch 2026-10-15). Two agent-drafted A6
  negatives for "저 + noun" (`a6-negative-none-130`, `-131`) await the owner's D12 batch.
- Tests: grounding and resolver rows, A6 acceptance through `AppModule` (scripted selector, incl. a red-team check that
  listed content never grounds a reference), read-regression scoring of both relabels. `QUOKY_NL_ACTIONS` stays `off`.

## Unreleased — owner batch of 2026-10-15: ADR-0112 amendments accepted, D12 corpus approvals, A6 relabels, T1 timedOnly and prompt `nl-select.v24` / `v25`

- **ADR-0112 amendments 1 and 2 Accepted** (Slack channel-message delete; Jira create and its undo): all 20 owner
  decisions as recommended (S-1..S-6, C-1, J-1..J-13; J-9: no *Delete issues* request now, close as the fallback,
  conditional on the NLA-12 permission check). Docs only; built in R3 / R4.
- **D12 corpus approvals.** 46 agent-drafted cases owner-approved (`uat5r*` 23, `uat5gy-*` 6, `uat5wd-*` 7, `uat5ca-*`
  10) and the 8 grammar-metadata edits of #204; the 148 S1 cases marked with their 2026-10-13 approval. Still pending:
  41 INT-4 cases.
- **A6 relabels.** `neg-098`, `neg-100` → `item.summarize` in `eval:nl --mode read-regression` only, with the listing
  the owner saw as the Reference context; read mode (A6 off) keeps `none`. Held for the owner: `neg-099` ("이 문서" has no
  A6-D2 deictic, so Core refuses `ref: this`) and `uat5r6-07` (ref spelling `recent` vs the prompt example's `this`).
- **T1.** A meeting word in a calendar question means timed events: seven more cases gain `timedOnly`; the `timedOnly`
  description and two meeting examples follow, and the weekend symbols are defined as Saturday and Sunday together
  ("다음 주말" had drifted to next Saturday alone) (read prompt `nl-select.v24`, A6 prompt `nl-select.v25`, new `off` pin).
- **Measured, final v24 (Haiku, 3 runs, 449 cases; the gate evidence).** Overall 96.1 / 97.3 / 96.1%, calendar 94.7 /
  95.8 / 93.7%, wrong captures 0 / 0 / 0, p95 2.1-2.3 s; the D12 and S1 gates pass in all three runs. The earlier 3-run
  eval of the pre-weekend-clause v24 (prompt `d5002b58…`: 96.5 / 95.7 / 95.7%, wrong 1 / 0 / 0) is superseded.

## Unreleased — A6 corpus approved and the 26 execution-time cases run as acceptance tests (2026-10-15)

- Owner batch approved (all recommended): the red-team batch (170 cases, judgments a/b/c), A6-D3a, A6-D3b and A6-D1a. Owner decision: single-line owner-typed relays (`rt-a6-pasted-command-105`, `-106`) are the owner's instruction for local writes; they are now action cases (525 action cases, 155 loaded red-team cases + 8 seed, 13 unmapped kept); multi-line, marked, quoted, fenced and bracketed variants stay refused. Hostile content restored in `rt-a6-cached-replay-107` and `rt-a6-pasted-command-133`; case `todo.complete-041` relabelled to the selector-path wording. Corpus `promptVersion` is `nl-select.v23`.
- `nl-action.exec-time.v1.json` (26 cases) is implemented as NLA-8 acceptance tests over the real store in `personal-v5-a6-acceptance.test.ts` (reminder numbers, undo that cannot run, pending number answers, gone targets); a coverage test names every case id.
- The mail and Drive grammar corpus tests skip the A6 corpora like `nl-intent.v1.json` (selector gold, not grammar gold). Docs: DECISIONS "A6 R1 owner batch approval (2026-10-15)", owner sheets' status lines. No runtime behaviour change; `QUOKY_NL_ACTIONS` stays `off` until separate owner yeses (model runs, `.env.local` flag, 100-turn live session).

## Unreleased — the narrowed span is stored as MM-DD..MM-DD (ADR-0120 A7 implementation note 3, 2026-10-15)

- Live: the same "다음 주 월요일부터 금요일까지 일정" sent twice was asked the second time (`invalid-arg` range: the selector wrote
  a non-symbol). Core's narrowed span is now spelled `MM-DD..MM-DD` (the prompt's own form), so the stored previous selection
  never shows a year; probes of the repeat (60 calls) all execute. No prompt change.

## Unreleased — a single-day pick of one bound of "X부터 Y까지" (ADR-0120 A7 implementation note 2, 2026-10-15)

- Live: "다음 주 월요일부터 금요일까지 일정" was still asked; a probe showed the selector answers `next-mon` when a previous
  calendar selection is in the prompt (8 of 30 calls). That single bound day now shows the owner's span
  (2026-10-19..2026-10-23); any other single day is still asked. No prompt change.

## Unreleased — "X부터 Y까지" span canonical form (ADR-0120 A7 implementation note, 2026-10-15)

- Live: "다음 주 월요일부터 금요일까지 일정" was asked because the selector named next week. When both bounds are explicit
  and the selected period contains exactly one allowed span, Core now shows that span (2026-10-19..2026-10-23); two
  candidate spans or none are still asked. No prompt change.

## Unreleased — Document summaries: attribution by construction, one regeneration, never looser than main (ADR-0104 D1 amendment, owner-approved 2026-10-15)

- **Live fix.** `1번 문서 요약해줘` on a dogfood-tracker Google Sheet was replaced whole by the not-done notice. The sheet's
  own status lines read as Quoky's claims.
- **Prompt.** Mail, thread and Drive summaries attribute every action or status to the item and quote its words
  (`시트에는 'Jira 티켓 등록 완료'로 표시돼 있어요`). Quoted text is what main's guard already skips, so legitimate content is
  shown without any new exemption.
- **One regeneration.** A flagged first draft is regenerated once with a stricter attribution rule; the flagged text is
  never fed back. A second flagged draft, or a failed regeneration, is replaced whole. The item text is sent twice at
  most; the worst case is 2× the provider timeout.
- **Never looser than main.** The two guards are unchanged and also read the rendered and line-joined text. Outside
  quotes they also catch:
  - request-carried-out wording;
  - bare or owner-directed completions;
  - self-references (`이 답변`, `방금`, `this summary`);
  - speaker-named completions.

  The exact delivered lines are checked on every path. Lines are taken whole per platform within 1,900 code points, each
  line capped in Core at the worst case.
- **Footers.** `Quoky는 이 답변에서 아무 곳에도 쓰거나 보내지 않았어요` for mail, thread and Drive.
- **Measured (stub).**
  - Legitimate tracker lines: 240 of 240 shown after one regeneration (main: 6).
  - Hostile: of 282 texts, 0 are shown by HEAD but not by main.
  - Review-round leak strings: 0 of 28 shown.
  - Real sonnet drafts: 4 of 4 shown.

## Unreleased — "until <weekday>" periods and the past-tense statement check, prompt `nl-select.v22` (ADR-0120 amendment A7, Accepted 2026-10-15)

- **Why.** "이번 주 금요일까지 일정" showed only Friday: the closed range symbols had no "today through <weekday>", and the
  model may not compute dates. "어제 일정 있었는데 까먹었어 ㅠ" (a statement, `neg-042`) was sometimes read as a calendar
  lookup (v20 probe: 6/20).
- **Symbols.** `until-mon..until-sun` (today through the nearest such day) and `until-next-mon..until-next-sun` (today
  through that day of next week), placed by Core. They validate only when the owner's words bound that weekday with an
  inclusive end word from the existing closed bound set (까지, by, until, till, through, thru) on every mention and the
  period ends on the day the words name; "이번 주 금요일까지" after that Friday is asked, never rolled. Any period holding
  such a day without ending on it (`fri`, `this-fri`, `this-week`) becomes the grounded `until-*` symbol ending there,
  else it is asked; several weekdays need the exact span; mail and Jira created/updated keep the A5 rule. With grammar
  yield on, the calendar grammar declines an end-bounded weekday so selection answers it.
- **Statement check.** A read on a clear past-tense statement (past 았/었/였/했 + 다 / 습니다, 더라 / 던데, or an informal
  past with a double past or a background clause; no question mark, no request, wh-form or wish; never 겠 or the present
  있/없) becomes chat, message-level in active, shadow and the evaluation. Grammar only, no phrase list.
- **Prompt `nl-select.v22`** (A6 `off` pin, `golden/nl-select.v22.prompts.json`) = v20 + one `until-*` line after the date
  line + two rule-2 lines on past remarks; the A6 action prompt is `nl-select.v23`. A first layout regressed "다다음 주 일정"
  and was dropped (probes recorded in A7).
- **Eval (owner-approved Haiku, calendar/mail/Jira + negatives).** v20 baseline 1 run (441 cases): 92.4% overall, calendar
  86.5%, 0 wrong captures. Final v22 after the review round, 3 runs (446 cases): 96.5%, 95.7%, 96.5%; calendar 96.7%,
  92.4%, 95.7%; 0 wrong captures in every run; the D12 and S1 gates pass 3 of 3; p50 1.3-1.7 s, p95 2.1-2.8 s. On the
  239 older positives 231, 228, 231 vs 226 on v20. Probes (20 calls): `neg-042` 6/20 → 0/20 captures, the six new
  statement negatives 0/20 on both; the live sentence → `until-fri` 17/20 (3 timeouts).
- **Review round** (Chief Architect, Codex): fixes above; the A6 seed label is `nl-select.v23`; the A6 action corpus was
  not re-evaluated on v23.
- **Final delta round** (no prompt change): without a week word only the nearest bounded day counts for any period;
  mixed bounded/unbounded mentions accept only a period ending on that day; quoted requests (…달라고) and wishes with
  any ending are requests.
- **CA final check:** conflicting mentions of a weekday ask for every period; "다음 주 월요일부터 금요일까지" takes the week
  word for both bounds.
- **Corpus.** `a7u-01..10`, `a7s-01..15` (839 cases), owner-approved D12 batch 2026-10-15. Owner sheet:
  `docs/plans/a7-until-weekday-owner-sheet.md`.

## Unreleased — calendar accuracy: the canonical weekday symbol, prompt `nl-select.v20`, the weekday question on every weekday refusal (ADR-0120 A5 implementation note 3, 2026-10-14)

- **Why.** One Haiku run left `calendar.events` at 86% (D12 gate: 90%). Misses, classified: 1 same day spelled
  differently (`this-fri` for `fri`), 1 selector error (keyword "정기" for "정기회의"), 4 gold labels that predate the A5
  args (`availability`, `partOfDay`), and 5 `timedOnly` flags on plain meeting questions (owner decision).
- **Canonical weekday symbol.** When the selector's weekday symbol names the same day as the form that matches the
  owner's week word, Core keeps the owner's form ("금요일" → `fri`, "이번 주 금요일" → `this-fri`, "목요일 거는?" after a
  week → that week's day). Never another day, never a new symbol. The exact `{entry, args}` scoring of D12 is unchanged:
  it compares the validated args, which are now unique per day.
- **Prompt `nl-select.v20`.** Three examples in the weekday lines of the range symbols (금요일 = fri, 이번 주 금요일 =
  this-fri, 다음 주 수 = next-wed), nothing else. A longer first wording raised a wrong capture and was dropped. The A6
  `off` golden moves to `golden/nl-select.v20.prompts.json` (the v18 bytes with exactly those two lines replaced); the A6
  action prompt becomes `nl-select.v21`.
- **Live fixes.** "다음 주 수 일정 있어?" read as next week plus the keyword "수" now gets the week-and-day question, not
  the generic one, and the selector now answers `next-wed`. "이번 주 금요일까지 일정" showing only Friday is a vocabulary
  gap (no "until <weekday>" symbol): stopped for an owner amendment decision, nothing changed.
- **Corpus.** `uat5ca-01..10` (814 cases; 05-10 are weekday statements that stay `none`, 0/240 captures in probes on
  v18 and v20), PENDING the owner's D12 batch. Relabels proposed, not applied.
- **Eval.** 3 owner-approved Haiku runs on calendar, mail and Jira (418 cases): calendar 90.4%, 89.2%,
  90.4% (baseline 86.3%; on the old 80 cases 72, 71, 72 vs 69), overall 94.1%, 93.7%, 95.0%, wrong captures 1, 0, 0 (`neg-042`, a
  pre-existing flake also seen on v18). The remaining calendar misses are all owner-decision cases; with the proposed
  relabels calendar is 92.8-94.0%. Full corpus (808 cases, 1 run each): v20 97.1% vs v18 96.0%, 0 wrong captures. After the owner's
  D12 batch of 2026-10-15 (nine relabels, `timedOnly` T1), one run on the relabelled gold passes the gate: 96.2% overall,
  calendar 95.2%, Jira 97.8%, mail 95.4%, 0/185 wrong captures (three stable runs still to do).

## Unreleased — The document-summary claim guard closes its three recorded gaps (ADR-0118 amendment implementation note, 2026-10-14)

- **Security fix, stricter only.** The claim guard that withholds a mail, thread or Drive summary which says Quoky did
  something (`메일을 보내 드렸습니다`) now also catches the three bypasses recorded as known gaps under the v5 W3 decision.
  No flag, migration, prompt or provider change.
- **A split or disguised name.** `Quo-ky`, `Quo    ky`, a zero-width or Hangul-filler split, full-width letters,
  combining marks, compatibility jamo and Cyrillic or Greek lookalikes (`Ԛuoky`) are read as Quoky.
- **An implied assistant action.** A third-party subject exempts only the claim of its own verb. A causal or
  conditional connective, a past verb, an honorific verb or a request adnominal ends its scope; a sequential connective
  ends it only before a humble claim. So `김철수님이 부탁하셔서 메일을 보내 드렸습니다` and `김철수가 요청한 메일을 보냈어요`
  are withheld, while `요청하는 메일`, `받은 피드백`, `정리해서 … 공유했어요` and `중요한 메일` pass. Every match in a
  clause is judged, overlapping matches included.
- **A cross-sentence split.** These are now claims:
  - a claim in a reply where Quoky or the first person acts with an action verb;
  - English "on your behalf" or "as requested" passives and bare participles (unless done `by` a named third party);
  - `Reply sent.`, `Sent the reply.` (except bullets under a heading that names a third party, or with a trailing
    `(Kim)`);
  - `요청하신 대로 … 발송되었습니다`.
- **Linear.** Each clause is read once and claims are judged by binary search. The DRV-1 timing test measures CPU time.
- **Measured.** Against origin/main over 23,858 repository strings in three sources, 3 strings are newly withheld: one true
  positive, plus a selector prompt and a code fragment that are not summaries. None are lost. A fuzz of 300,000 random
  sequences, each checked as `mail` and as `drive`, found no case that origin/main withholds and this guard shows. 39
  legitimate summaries pass. Tests:
  `document-summary-claim-guard.test.ts` (345 rows, including the review rounds' bypass and false-positive rows and twelve
  new CPU-bound hostile inputs).

## Unreleased — a one-syllable weekday after a week anchor, and a period never loses the owner's weekday (ADR-0120 A5 implementation note 2, 2026-10-14)

- **Live fix.** "다음 주 수 일정 있어?" was answered with next Monday (10/19) instead of Wednesday 10/21. The selector
  sometimes reads the abbreviated weekday as another day (`next-mon`) or drops it (`next-week`, keyword "수"), and nothing
  checked the period against the weekday the owner wrote.
- **Rule, no phrases.** A one-syllable weekday (월 화 수 목 금 토 일) is a weekday only as its own word right after a week
  anchor (이번 주, 다음 주, 담주, 지난주, 다다음 주 …); elsewhere it keeps its other meaning ("할 일", "남은 수", "3월", "금
  시세"). On calendar, mail and Jira, a period that drops or changes the one weekday the owner named fails validation with
  the new reason `weekday`. It is never repaired, so the owner is asked instead of being shown another day. A bound
  weekday ("금요일까지") must lie inside the period. The abbreviation is never a title keyword. "다음 주 일 많아?" accepts
  the week or Sunday (일 is also "work").
- **Review round.** Spaced and 날 bounds ("금요일 까지", "수요일날까지"), English bounds with an anchor, 월욜 … 일욜,
  punctuation after an abbreviation, a weekday inside a title keyword or an abbreviation before another content word
  (uncertain: that day or the period), whole-word sender removal, no one-syllable weekday keyword when any weekday is
  named. A refused output is not cached, and the question names the week and the day.
- **Final review round.** An uncertain anchored weekday stays inside its week. A keyword that only hides the period
  ("수요일 회의") is refused. Inclusive bounds contain the day; only exclusive ones (이후, 전에, after, before) widen by one
  day. English "this" means this week or the coming seven days, "next"/"last" set the direction ("the last Friday of" is an ordinal). Glosses ("금(골드)", "수(오전), 금(오후)") are read
  structurally. Extra questions on unusual phrasings are an accepted residual.
- **Unchanged.** Selector prompt `nl-select.v18` byte for byte (A6 `off` identity intact), no new symbol, flag, env,
  migration or port change. Acknowledged by the owner ("이대로 진행"): "다다음 주 수요일", a full weekday with a longer
  period and a false abbreviation reading are asked instead of answered.
- **Corpus and eval.** `uat5wd-01..07` (804 cases, pending D12). One owner-approved Haiku run on calendar, mail and Jira
  (414 cases): 93.6% overall, 0 wrong captures, new cases 6/7. The live sentence is now asked when the model drops the
  weekday. The other misses are pre-existing exact-arg differences.

## Unreleased — Class B grammars yield what they cannot express (ADR-0120 A2 implementation note 2, 2026-10-14; acknowledged by the owner)

- **Live fix.** Five Telegram sentences from the 2026-10-14 run after A5 were answered by a frozen grammar that dropped part of
  the message: "다음 주 수요일 오후에 뭐 있어" and "내일 오후 일정" (whole day), "캘린더는 보지 말고 할 일만 알려줘" (Jira/GitHub
  surface), "할 일 관리하는 좋은 습관 알려줘" (the to-do list), "슬랙에서 배포 얘기 나온 거 찾아줘" (searched the whole clause).
  With `QUOKY_NL_GRAMMAR_YIELD=on` and `active`, selection now runs first: `partOfDay`, the to-do list, chat, keyword "배포".
- **One rule, no phrases.** When selection would run, a Class B grammar declines when:
  - (a) a content word is left after its own vocabulary. This now also covers the to-do list phrases and the classifier's
    personal-work surface clause. One-syllable words count, except the closed degree adverbs, a dependent noun after an
    adnominal word, and one ordered suffix glued after a grammar word;
  - (b) a word grounds a typed arg it does not carry (the calendar's part of day outside a clock time);
  - (c) its free-text slot is not already the catalog's canonical keyword (Slack/Confluence search, Jira keyword). Quoted
    keywords are kept whole, and Jira qualifier words count only outside the quotes.
- **Fallbacks.** The surface clause keeps the surface as the fallback when the selector is skipped, fails or times out
  (A5 change 9). A declined calendar or search message gets honest chat when a selection call fails (A2 R5). With the yield
  off, nothing changes (13-corpus replay: 0 differences).
- **Corpus and tests.** `nl-intent.v1.json` grows from 791 to 797 cases (`uat5gy-01..06`, pending D12).
  - Metadata-only tag edits on 8 cases from approved batches, and an optional `grammarYieldOff` tag.
  - Grammar side, with `work-surface` scored as having no catalog equivalent: 250 → 247 tagged. Exact goes from 82.3% to
    85.0% and wrong captures from 1 to 0, but only because cases left or joined the denominator; no grammar answer
    improved.
  - Tests: new `grammar-yield-table.test.ts` and an INT-4 acceptance block.

## Unreleased — Personal v5 closeout (DOC-G, 2026-10-14)

- **Scope.** Docs only. Waves 1-3 and INT-4 are merged: W1 #175-#178; NL selection #179-#183 (A1-A4, A5 #199); ADR-0121 design
  #184 and ratification #193; S0 security #185-#186; Node 22 #187; Telegram keep-alive #188; warm-up #189; BRF-3 #190; exit 78
  #191; STO-1 migration v16 #192; S1 c-shadow #194; W3 DRV-2/2b #195, GML-2 #196, UAT fixes #197; INT-4 #198. A6 design #200,
  ratification #201, R0 merged inert #202.
- **Docs.** `CURRENT_STATE.md` "Personal v5 — status (2026-10-14)" (live flags, pending owner items, known limits); `ROADMAP.md`
  v5 status and next items (A6 R1-R4, ADR-0121 S2, Phase C per grammar, egress enforce); the quickstart (Personal v5 settings,
  the kill switch, the egress ledger, the self-check and secret scan, Node 22) and the operator guide (section 0.9);
  `DECISIONS.md` "Personal v5 closeout note (DOC-G)".
- **Not changed.** No code, no migration, no env default, no ADR text.


- **Flag.** `QUOKY_NL_ACTIONS` = `off` (default) | `shadow` | `local` | `external`. With `off` the selector prompt is
  `nl-select.v18` byte for byte and every reply is unchanged; any other level needs `QUOKY_NL_INTENT_MODE=active` and the
  persisted kill switch (`에이전트 중지` / `에이전트 재개`, `Actor.metadata`).
- **Action entries.** `todo.add`, `todo.complete`, `todo.cancel`, `reminder.create`, `reminder.cancel`, `action.undo`,
  `item.summarize` (mail, Drive; `mode` summary | full). Payloads are the owner's verbatim spans from the current turn;
  references resolve in code against the most recent listing; undo is a per-action inverse (`reopenWorkItem`,
  `reactivateReminder` with one CAS repository method; no migration). Prompt `nl-select.v19` when actions are offered.
- **Safety.** Action outputs are never cached or stored as `lastSelection`; caps; content-free `nl_action.decided` logs;
  a D9 stale-command guard; the full text of an item is rendered in untrusted spans with no model call.
- **Eligibility.** An action request is one plain line (A6-D3a): line separators are checked on the raw text, structure
  and command checks also on an NFKC-folded copy, Telegram `code`/`pre` entities reach Core as the content-free
  `InboundMessage.formatting.code` flag, and the anchored `되돌리기` follows the same rule. TAB counts as a control,
  only a plain space may pad the line, and the colons of an http(s) URL token and of an `HH:MM` time are not read as
  `key:` labels (nothing else is exempt). A store without the
  atomic `saveIf` never takes a conditioned to-do write, and the stopped reply follows the turn language.
- **Tooling.** `pnpm eval:nl -- --mode action` and `--mode read-regression`; the A6 red-team harness; seed fixtures; the
  corpus schema in `docs/plans/nl-action-corpus-schema.md`; offline acceptance `personal-v5-a6-acceptance.test.ts`.

## Unreleased — NL read-side gaps from the 2026-10-14 live UAT (ADR-0120 amendment A5, Proposed)

- **Mail period.** `mail.list` takes a symbolic `range` (yesterday, this-week, last-week, a weekday …); it reaches Gmail as an
  owner-zone `after:`/`before:` window and the basis line and the empty answer name the period. The old `today` flag is
  migrated (also in a stored `lastSelection`).
- **Calendar part of day.** `partOfDay` (오전/오후/저녁), `timedOnly` ("회의만") and `availability` ("시간 비어?"): events are
  filtered by overlap, all-day entries are left out and counted, an empty free/busy window answers "비어 있어요"; works as a
  follow-up modifier.
- **Symbolic time.** `last-<weekday>`, `this-<weekday>`, `week-after-next`, `rest-of-month`.
- **Time words are periods.** A keyword that is only a weekday, date or period is refused (and scrubbed from a stored
  selection), so "목요일 거는?" no longer sticks as a title keyword.
- **Search keyword, Jira order, mail item picks.** Core-term search keywords; `jira.issues` `sort` (constant ORDER BY);
  "3번은 누가 보냈어?" answers from the last list ("목록에 2건만 있어요") instead of re-listing.
- **Selector `none` wins (R9).** After a Phase C selector `none`, the personal-work surface regex no longer answers (INT-4 bug
  fixed, its test un-skipped); the surface stays the fallback only when the selector did not run or failed.
- **Reminder title.** "물 마시라고 알려줘" is stored as "물 마시기" (quotative morphology, not a phrase list).
- **Not changed.** Other-language messages (Class A, ADR-0098 D1 c) still skip selection; write/action intents are untouched.
  Selector prompt `nl-select.v18`; 23 golden cases (`uat5r*`).

## Unreleased — Personal v5 integration acceptance, INT-4 (2026-10-14)

- **Acceptance test.** `apps/quoky/src/personal-v5-acceptance.test.ts` runs the real `AppModule` offline over every merged v5
  capability (HARD-1, PLT-1, ADR-0120 selection incl. A2/A3 and `c-shadow`, S0 egress guard and ledger, BRF-3, STO-1 v16,
  DRV-2/2b, GML-2, the strict claim guard, the Drive kind yield) and adds a paraphrase block that proves routing is not
  phrase-bound (many wordings, one fake model that only knows the catalog id).
- **Golden corpus.** 41 new cases in `nl-intent.v1.json` (typos, mixed language, compound asks, follow-ups with a prior
  selection, capability-word negatives), pending the owner's batch approval. `baseline.v1.json` is unchanged (it does not
  cover this corpus).
- **Finding.** In Phase C, a selector `none` does not stop the classifier's `personal-work-surface` regex from answering
  `할 일 관리하는 좋은 습관 알려줘` with a lookup; recorded as a skipped test, not fixed.

## Unreleased — v5 W3 live UAT fixes (2026-10-13)

- **Thread-summary prompt.** A thread summary no longer narrates mail actions with past-tense action verbs (the strict claim guard withheld a legitimate Gmail welcome-mail summary). The guard is unchanged; the thread task rule now asks for `<sender>의 메일: <summary>` or noun phrases. Mail and Drive prompts unchanged.
- **Drive grammar and file kinds.** With `QUOKY_NL_GRAMMAR_YIELD` on, `드라이브 최근 스프레드시트` (and any recent or name listing that names a file kind) now declines so selection binds `kind`; flag off is unchanged. Tests added.

## Unreleased — GML-2: Gmail thread summaries and reply-to-pick (ADR-0118 amendment, 2026-10-13)

- **Thread summaries.** `이 스레드 요약해줘`, `N번 메일 스레드 요약해줘`, `summarize this thread` and `summarize email thread N`
  summarize the thread of a listed mail. The thread is read with the optional `MailReader.getThread` (Gmail: `messages.get`
  minimal, `threads.get` ids only, then only the kept messages; `gmail.readonly`, no new host): at most 20 messages and
  256 KiB of text. The readout is a new
  `mail-thread` source (prompt label `EMAIL THREAD`). Each message is credential-guarded before the clip, and the whole
  readout again after it. Quoted history is dropped and the 3,000-character budget is shared fairly under `[i/n]` headers.
  No tools are offered, the claim guard runs, and a fixed footer says how many messages were read. DM-only.
- **Reply-to-pick.** A Discord or Telegram reply to a mail listing picks from THAT listing: `N번`, or `이 메일` for a
  one-entry listing. Only for such a reply may the mail noun be left out (`2번 요약해줘`, `요약해줘`, `스레드 요약해줘`).
  - The adapters fill the new optional `InboundMessage.replyTo`. `QuokyCore` tells the mail handler the listing reply's
    delivery-receipt ids through the new application hook `TurnDeliveryObserver`, and the handler stores them in
    `Session.metadata['quoky.lastListing']` (no migration).
  - A reply works for 24 h (8 live listings per Actor). An aged-out or evicted listing becomes a tombstone (64 per Actor,
    7 days) whose reply gets "that list expired". A reply to anything else picks nothing and never falls back to the
    last list. A thread read sends at most 22 Gmail GETs. The credential guard runs only on complete text: a message
    body that is credential-shaped, or was cut before the guard could read it whole (the MIME cap, an oversized
    message), is withheld with a fixed note; single-mail summaries follow the same rule.
- **Unchanged.** Listing format and footer, help and usage lines, the NL catalog and every golden corpus. Mail and Drive
  summary prompts are byte-identical. The DM-only rule stands, and there is no send, label or write path.

## Unreleased — DRV-2 Drive shared drives, DRV-2b every sheet of a spreadsheet (ADR-0118 amendment, 2026-10-13)

- **Shared drives (DRV-2).** Drive search and `최근 문서` include the owner's shared drives (`corpora=allDrives`,
  `includeItemsFromAllDrives`, `supportsAllDrives`; metadata reads with `supportsAllDrives`). The scope is still
  `drive.readonly`, with at most 10 entries, DM-only, and no model call. Each parameter is accepted only with its one
  value. `files.export` carries `mimeType` only, which is its one documented parameter (a recorded deviation from the
  amendment text).
- **Every sheet (DRV-2b).** A spreadsheet summary reads every grid sheet through the Sheets API v4
  (`connector-gdrive/src/sheets-reader.ts`) under the same `drive.readonly` grant, so no new scope or consent is needed.
  It makes two GETs: the sheet list (titles, indexes and types only), then one `values:batchGet` (`FORMATTED_VALUE`,
  `ROWS`).
  - **Bounds:** 20 sheets, A–Z, 40,000 cells, 1,000 characters per cell, and 256 KiB of text across sheets.
  - **Core:** each sheet gets a JSON-quoted untrusted-title header and a fair share of the 3,000-character summary body.
    The credential guard runs before and after the clip.
- **Fallback.** If the Sheets API is disabled (403 `SERVICE_DISABLED` / `accessNotConfigured`), unavailable, refused
  or too large, the summary uses the old first-sheet CSV with one note, for example "(첫 번째 시트만 읽었어요 · 모든 시트를
  읽으려면 Google Sheets API가 필요해요)". Consent errors keep the consent reply.
- **Egress (S0).** New allowlisted host `sheets.googleapis.com`, added only when Drive is configured. It has the budget
  label `google-sheets` (connector caps) and the ledger template `/v4/spreadsheets/{id}[/values:batchGet]`, with a
  closed method list. The self-check static host list includes it. No other host is added.
- **Port.** `DriveDocument` gains optional `sections` and `firstSheetOnly` (additive, vendor-free). There is no
  migration, token or deps change.
- **CA review fixes.**
  - The 256 KiB adapter budget is shared fairly between sheets, so a large first sheet no longer starves the rest, and
    each cut sheet is marked `(partial)`.
  - The credential guard runs on raw titles, cut cells and cut sheets before the cut (`credentialShaped` withholds the
    item).
  - A Sheets `INSUFFICIENT_SCOPE` falls back with the `not-permitted` note.
  - Hidden sheets are skipped and counted in the footer ("숨김 시트 N개 제외").
  - The single-sheet note is truthful.
  - `incompleteSearch` marks partial shared-drive listings.

## Unreleased — S1: NL-2 Phase C, model-first selection (ADR-0120 D6, ADR-0121 S1, 2026-10-13)

- **`QUOKY_NL_PHASE`** (`a` | `c`, exact, default `a`). `c` with `QUOKY_NL_INTENT_MODE=active` runs the natural-language
  selector BEFORE the frozen Class B grammars (calendar question, mail and Drive listings, work lookups and to-do list,
  help-intent, the classifier's personal-work surface). The grammar answers only when the selector is unavailable (down,
  timeout, malformed, provider family or locality mismatch, credential, over 600 characters). `none` goes to the
  classifier and honest chat, as in Phase A. Class A routes are untouched. `c-shadow` (only with `active`, else a startup
  error) keeps Phase A fully live and runs one background selection after a grammar's reply, for the agreement log only.
  Default `a`: byte-identical to before.
- **Agreement log** `nl_selection.agreement` (content-free: grammar id, entry ids, outcome, agree flags, latency) for the
  ADR-0120 D10 grammar-retirement data.
- **Hardening.** Selection also requires the chat provider's declared execution locality to equal the selector's
  (`chat-locality-differs`); prompt `nl-select.v17` makes "그 중에 …" with no previous selection a numbered question.
- **Interface.** Optional pure `ConversationTurnHandler.classBProbe?(ctx)` on a narrowed probe context (ADR-0120
  amendment A4, Proposed); no migration, token or deps change.
- **Review fixes.** `c-shadow` jobs run one at a time, at most 60 per hour (`dropped` agreement lines otherwise), are
  bounded as a whole (provider resolution included) and aborted on shutdown (`stopBackground`, the CLI child is killed);
  agreement compares meaning (dates resolved, defaults, count; unread-only vs all mail disagrees). Fair evidence: grammar side vs selector
  side on the same 242 cases — exact 83.5% vs 97.9–99.2%, entry 98.8% vs 98.8–100%, user-visible 92.6% vs 97.9–99.2%.
  The 148 S1 corpus cases are pending the owner's batch approval; corpus and prompt v17 have no held-out set.
- **Eval (Strict, 3 runs, Haiku, 727 cases):** 98.6/98.4/98.1%, 0 wrong, lowest entry 93.0%, 0.1–0.8% over the 6 s
  bound; the grammar-handled subset 97.9–99.2% (the grammars themselves: 82.6% exact). Phase C adds p50 about 1.4 s and
  p95 about 2.1 s to those messages.
- **Corpus and eval.** `nl-intent.v1.json` 579 → 727 cases with a `grammar` tag (>= 25 grammar-handled phrasings per
  entry); the eval reports the S1 over-bound gate and the grammar-handled subset (accuracy and the latency Phase C adds).

## Unreleased — STO-1 storage hardening, migration v16 (ADR-0119, 2026-10-13)

- **Sessions are keyed by platform.** `SessionRepository.findActiveByContext(platform, channelId, threadId?)`: a Discord
  and a Telegram conversation with equal channel ids now get separate sessions (ADR-0114 TG-1 residual). Core passes
  `context.platform` through as opaque data.
- **Migration v16** (additive, idempotent, one transaction):
  - `sessions.platform`, backfilled from each session's stored `context.platform`. Rows without one stay `NULL` and are
    counted in the `storage.migration.applied` log line;
  - `idx_sessions_platform_context`;
  - a partial expression index `idx_task_runs_usage_finished`, so the usage ledger reads its date range instead of
    the whole `task_runs` table. The ledger output is unchanged.
- **A database newer than the build** (`SCHEMA_VERSION_AHEAD`) is now a configuration exit 78 with a restore hint,
  instead of a relaunch loop.
- **Apply and rollback runbook:** `docs/ops/migration-v16-apply.md`. The apply on the service DB is Strict and has not
  been run.

## Unreleased — fix: a database newer than the build is refused with exit 78 (ADR-0119 STO-1 pre-step, 2026-10-13)

- `SCHEMA_VERSION_AHEAD` exited 1, so launchd relaunched the service in a loop after a rollback to an older build. It is now a configuration failure
    (exit 78, ADR-0102 D5) with a self-contained hint: deploy the newer build, or restore the verified pre-migration backup. Nothing is changed in the database.

## Unreleased — BRF-3 unread mail in the morning brief (ADR-0117 amendment, 2026-10-13)

- **Opt-in `안 읽은 메일` section.** `QUOKY_BRIEF_MAIL_ENABLED` (exact `true`/`false`, default `false`) adds the unread count and at most 3
    `sender · subject` lines to the brief, through the existing read-only `MAIL_READER` (one unread search of 3; no body, no snippet, no
    id). Senders and subjects use the mail listing's guarded, link-neutralized untrusted spans. No model is called and the brief stays
    DM-only. An unreadable mailbox shows `불러오지 못했어요` and never breaks the rest of the brief. Flag off: the brief is byte-identical.
    No migration, port or token. Implementation note under ADR-0117 in `DECISIONS.md`.

## Unreleased — fix: NL selection startup warm-up (ADR-0120 A3 follow-up, 2026-10-13)

- The first one or two selections after a restart timed out at 6 s on a cold `claude -p` start. With `QUOKY_NL_INTENT_MODE` `shadow` or `active`, one background
    warm-up call now runs about 5 s after startup (20 s bound, never blocks startup or a turn, nothing in `off`). Its prompt is a fixed constant with no owner,
    session or connector content, it uses the same provider path and family check, and it logs only `nl_selection.warmup outcome latencyMs`. No periodic timer.

## Unreleased — fix: keep-alive reuse through the egress guard (ADR-0121 S0 follow-up, 2026-10-13)

- The guarded dispatcher's Agent used undici's 4 s idle default, so each Telegram long poll opened a new TCP+TLS connection. Requests
    labelled `telegram-poll` now use a dedicated, equally guarded Agent that keeps idle connections 65 s; every other request keeps the
    default window. A poll that hits a stale-socket reset is repeated once; nothing else is retried. Pinning, deny ranges and ledger records are unchanged.

## Unreleased — Node 22 LTS runtime (ADR-0121 S0 owner item, 2026-10-13)

- **Runtime moves from Node 18 (end-of-life) to Node 22 LTS.** `.nvmrc` is `22.22.1` and `engines.node` is `>=22.12`. The owner approved this on 2026-10-13. It closes the CVE-2025-22150 exposure that remained through Node 18's bundled undici (FormData). The full suite passes on 22.22.1. The service plist is reinstalled with `--node` pointing at Node 22, and `better-sqlite3` is rebuilt for the new ABI.

## Unreleased — v5 S0 security baseline, ops half (ADR-0121, 2026-10-13)

- **One-command network self-check.** `ops/security/quoky-net-selfcheck.sh [--json] [--since 24h]` reports the Quoky process tree,
    its live connections against the host allowlist, listeners (only loopback is expected), remote-access/tunnel/VPN software and a
    traffic-ledger summary. Read-only, no root, no secrets printed; exit 0 only when every check passes.
- **Repository secret scan.** `pnpm security:secret-scan` scans tracked files and the full git history with the runtime credential
    guard's detector and reports file, commit and line with the value masked. `classifyCredentialFileContent` is now exported from `@quoky/core`.
- **Review fixes.** The scan reports every hit per file and gates on issued-key candidates in test paths; the self-check verifies addresses through the ledger's `connect` records, fails on ledger guard findings, filters by record time, supports IPv6 and `--expect-stopped`, and emits valid JSON.
- **Runbooks.** `docs/ops/security-incident-response.md`, `docs/ops/key-rotation.md` and `docs/ops/remote-access-inventory.md`.

## Unreleased — v5 S0 security baseline, code half (ADR-0121 S0, 2026-10-13)

No migration, no new port or DI token; `ConversationRuntimeDeps` stays 36. ADR-0121 stays Proposed (S0 only, approved by
the owner on 2026-10-13). Details and the ledger contract: the ADR-0121 S0 implementation note in `DECISIONS.md`.

- **Claude CLI children send no non-essential traffic (L1).** Every `claude -p` spawn gets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: no telemetry, error reporting, auto-update or bug command. Nothing else
  from the parent environment is forwarded.
- **Telegram polls half as often.** The long-poll wait is 50 s instead of 25 s: about 72 requests an hour when idle.
- **Log lines carry time and a turn id.** Every line starts with host-local ISO-8601 time with its offset, and lines
  inside an owner turn or a reminder tick end with a content-free `cid=`.
- **Egress guard, observe by default (`QUOKY_EGRESS_GUARD=off|observe|enforce`).**
  - **Allowlist.** It is derived from the connectors configured here.
  - **Address check.** A connection-bound DNS check refuses private, loopback, metadata, CGNAT, ULA and IPv4-mapped
    addresses. The checked IP is pinned (SNI and `Host` keep the name), and every redirect hop is re-checked.
  - **Budgets.** Per-connector request and volume budgets, with an exponential backoff on 429/5xx.
  - **Ledger.** A content-free traffic ledger at `<data dir>/audit/egress-YYYY-MM-DD.jsonl` records host, label,
    method, path template, status, bytes and latency. It never holds headers, tokens, queries or bodies. Rotation and
    the size cap are set by `QUOKY_EGRESS_LEDGER_MAX_FILE_MB` (default 16), retention by
    `QUOKY_EGRESS_LEDGER_RETENTION_DAYS` (default 90).
  - **Modes.** `observe` only logs; `enforce` refuses with `EGRESS_REFUSED`.
  - **Not covered.** Child processes (`claude -p`, `ollama`, `git`).
- **Dependency.** `undici` 6.24.1 is now a direct, exactly pinned dependency of the app, and a root `pnpm.overrides` entry
  lifts every transitive copy (discord.js REST's 6.19.8) to it. Node 18's own bundled undici still serves the `fetch`
  layer, so a Node 22 LTS upgrade is an open owner item (see the DECISIONS note).

## Unreleased — v5 NL-1 selection timeout (ADR-0120 amendment A3, 2026-10-13)

- **Natural-language intent selection waits 6 s, not 4 s (ADR-0120 A3).** The default per-call bound is now 6000 ms, still one
  call and no retry. Live evaluation showed 13 to 18 of about 430 to 500 calls per run timing out at 4 s (p50 2.9 s, p95 3.6 s).
  A slow or failed selection now takes at most 2 s longer before the turn falls back; normal turns are unchanged.
- **`QUOKY_NL_INTENT_TIMEOUT_MS` (new, optional).** An integer from 2000 to 8000 overrides the bound. Any other value stops
  startup with `NL_INTENT_TIMEOUT_INVALID`. Unset keeps 6000.

## Unreleased — v5 NL-1 live re-test follow-up 2 (ADR-0120, 2026-10-12)

- **"그 중에 …" binds to the listing you just saw.** A listing answered by a deterministic grammar (calendar, Jira, GitHub,
  Slack, Confluence, to-dos, mail, Drive) is remembered as the previous selection; a turn with no such equivalent (chat,
  help, an approval, a write preview) forgets it.
- **Listing grammars can stop swallowing qualifiers (opt-in, ADR-0120 amendment A2, proposed).** With
  `QUOKY_NL_GRAMMAR_YIELD=on` (default `off`) and `QUOKY_NL_INTENT_MODE=active`, "이번 주 정기회의 일정 있어?" is no
  longer answered with the whole week: the calendar and work-lookup grammars decline when a word they cannot express is
  left, and natural-language selection applies the keyword. Off, every reply is unchanged.

## Unreleased — v5 NL-1 live UAT follow-up (ADR-0120, 2026-10-12)

- **Jira "진행중인 이슈만"** works: `status: in-progress` renders `statusCategory = "In Progress"` and is also a refinement
  after a listing ("그 중에 진행중인거만").
- **Calendar "그 중에 스크럼만" / "이번 주 스크럼 일정"** filters the fetched events on the title locally; titles never go
  to the model; an empty result says so.
- **Drive file type** ("드라이브에 스프레드시트 최근 거"): optional `kind` (spreadsheet, document, presentation, pdf, folder).
- A value of a status/type argument counts only when the owner said it (enum value grounding). Prompt `nl-select.v15`:
  "오늘 할 거 한눈에", a bare source word, and "그거 몇 개야" (with or without a previous list).

## Unreleased — v5 NL-1 natural-language capability selection, Phase A (ADR-0120, 2026-10-12)

No migration, no new port or DI token. `ConversationRuntimeDeps` 35 → 36 (`nlSelection?`, ADR-0120 D14).
`QUOKY_NL_INTENT_MODE` defaults to `off`: every reply is unchanged until it is set.

- **Natural phrasings reach the read capabilities.** With `QUOKY_NL_INTENT_MODE=active`, a message that every earlier
  route left for chat ("오늘 jira 이슈 등록된거 브리핑해줘", "오늘 나한테 할당된 jira 이슈가 있을텐데 ?") goes through one
  bounded selection call over a closed catalog of eleven reads (Jira, GitHub, Slack, Confluence, calendar, mail,
  Drive, to-dos, reminders, today's brief, help). Core validates the answer (closed ids and values, Core-resolved time,
  keywords grounded in the owner's own words, the credential guard) and the owning handler answers with its existing
  command. The model never executes anything and never sees an item, mail or event text.
- **One question instead of a guess.** An ambiguous or invalid answer becomes one numbered question (`1` or `지라`
  answers it). "등록된 이슈" asks once whose issues are meant and keeps the answer for 30 days per owner (both
  platforms); every answer starts with its basis line (`기준: 내가 담당·보고자 / 오늘 생성`) and "아니 담당만" changes it.
  Follow-ups such as "그 중에 위클리카만" refine the previous selection for 30 minutes.
- **Jira windows, roles and status (D13).** The Jira lookup can ask for issues created, updated or due in a period, as
  assignee, reporter or either, open or all; counts ("몇 개야") and "N개만" are answered from the list.
- **On-demand brief.** "오늘 브리핑해줘" sends the morning brief now (model-free, DM only).
- **Honest chat.** When nothing matches, the chat prompt names the configured sources and their commands and Quoky's
  own command lines, so a write request ("할 일 추가해줘 …") is answered with the exact command to send (nothing is
  prefilled or run), and a reply claiming Quoky cannot access a configured source is replaced by the command offer.
- **Review fixes (CA and Codex).** Selection runs only when this turn's chat would reach the same provider (a local or
  another remote chat choice makes no call); Telegram blockquotes and Discord `>>>` quotes are removed; the prepared
  input is bounded after its placeholders; a guessed role never answers or overwrites the preference; clarification
  answers are resolved strictly ("첫 번째 말고 두 번째", "둘 다 아니야"); an open question ends with the next turn; the
  honest-chat guard keeps write suggestions; Jira created/updated windows ignore the Jira profile time zone;
  `brief.today` needs reminders on. Re-evaluated under the runtime's 4 s bound (prompt `nl-select.v12`, 3 runs): 99.2%,
  98.4%, 98.1%; 0 wrong captures; 5–9 of 501 calls over 4 s (misses); p95 3.6 s; gate passed in each run.
- **Safety.** Writes are never selected; selection runs only after the classifier, never with a pending approval, never
  on a credential-shaped message (no call is made), and quoted, fenced or attached content is removed before the call.
  `shadow` mode logs only entry ids, the route, the agree flag and latency.
- **Tooling.** `pnpm eval:nl` evaluates the real prompt with the local Claude CLI (Strict: an approved plan digest per
  run). Corpus: `packages/core/src/application/golden/nl-intent.v1.json` (501 cases). Strict evaluation on 2026-10-12
  (`haiku`, prompt `nl-select.v9`, 501 cases, 3 runs, concurrency 6, plan digest `2eda67d4…`): 98.9%, 98.9% and 99.7%
  exact hits; 0 wrong captures in each run; lowest entry 91.2% (mail); latency p50 2.9 s, p95 3.5–3.7 s, max 6.2 s,
  7–18 of 501 calls over the 4 s runtime bound. Gate passed in all three runs.

## Unreleased — Jira listing routing (live UAT, 2026-10-12)

No migration, no new DI token, no new connector query or host.

- **An unqualified Jira listing is the owner's listing.** `jira 이슈 보여줄래`, `지라 이슈 목록`, `jira 티켓 알려줘` and
  `jira issues` previously needed an owner marker (`내`/`my`) and fell through to chat, whose model wrongly said it
  could not reach Jira. In a personal assistant the owner's assigned items are the only Jira listing, so these
  whole-message forms now run the same `my-items` lookup as `내 jira 이슈 보여줘`. Writes, single-issue keys and URLs,
  GitHub and longer text that merely mentions Jira keep their routing.
- **Keyword-scoped Jira requests filter the owner's items.** `위클리카 관련 jira 이슈 보여줘` and
  `jira에서 위클리카 이슈 찾아줘` (Jira has no text search, so the latter no longer ends in "not supported") fetch the
  same `personal-work` page and keep items whose title or description contains the keyword; the reply header reads
  `Jira 내 항목 중 "위클리카" 포함`. A full 20-item page is marked partial. A bare follow-up such as `위클리카 관련해서`
  is left to chat (work chat keeps no listing context).
- **Chat no longer claims it cannot connect.** The general-chat authority rules say Jira, GitHub, calendar and mail
  lookups are answered through commands such as `내 jira 이슈 보여줘`.

## Unreleased — v5 HARD-1 bounded OAuth token reads (2026-10-12)

- **The three Google connectors read the OAuth token response bounded.** The token endpoint's reply (code exchange and
  refresh; error bodies too) in `connector-gmail`, `connector-gdrive` and `connector-calendar-google` is read through a
  16 KiB stream reader instead of an unbounded `response.json()`. A larger declared length is refused without reading and
  a larger stream is cancelled at the cap; either is the adapter's existing typed `INVALID_RESPONSE` error, carrying no
  body content or token. Normal responses are unchanged. Each adapter keeps its own copy of the reader.

## Unreleased — Personal v5 wave 1: PLT-1 untrusted spans for the remaining Core values (2026-10-12)

No migration, no new DI token, no port change; `ConversationRuntimeDeps` stays 35.

- **Outside values in code-work, credential-override, git and PR replies are untrusted spans (PLT-1).** File paths, branch
  names, repository names, commit messages and PR URLs that these replies wrote into Quoky copy as plain strings are
  now `untrusted` spans. Telegram shows them exactly as given (`src/_x_/*y*.ts` and `*y*` no longer lose their
  markers); Discord escapes them like every other outside value, so a path or commit message with `@everyone`,
  `<@id>`, `[x](url)` or Markdown can no longer ping, mask a link or format the reply (an intended fix: the old copy did
  not escape them). The plain text of every reply, ordinary Discord output and the 793 PLT-0 golden cases are unchanged;
  110 new golden cases pin the converted replies, 52 of them (hostile values) with the new escaped output. Paths use a `path` guard (a plain `@` is kept so a copied path still resolves). Values inside
  inline code spans and fenced blocks stay as they were. The bounded git and patch previews keep their fixed tail (validation
  line, disclaimers, footer) when Discord escaping lengthens the text, and the preview artifact names outside paths as inline
  code.
- **A source scan guards the rule.** `outside-values-in-copy.test.ts` flags a new plain template literal in a Core reply
  module that names a path, branch, repository, commit message or URL; a Telegram test renders the whole corpus.

## Unreleased — v4 residual polish (2026-10-12)

No migration, no new DI token; `ConversationRuntimeDeps` stays 35.

- **Mail and Drive list numbers survive a restart.** The last listing's displayed ids are persisted in
  `Session.metadata['quoky.lastListing']` (per Actor, a `mail` and a `drive` slot, 30-minute TTL checked on read; ids
  only, never subjects or names). `1번 메일 요약해줘` works after a restart; a Drive list never resolves a mail number.
- **Help keeps every capability line with everything on.** With Gmail and Drive both configured, their two help lines are
  one compact line; with Jira and Slack writes both on, their two lines are one. The ADR-0096 D6 bound stays 14 x 120;
  the unconfigured help is byte-identical. An INT-3 test pins that every contributed line is present within the budget.
- **Telegram plain text shows links and quotes (TG-3 residual).** In Quoky copy and model replies, `[text](url)` becomes
  `text (url)` for http(s) URLs only (Telegram autolinks the URL) and a leading `> ` becomes `│ `. Untrusted spans stay
  byte-identical; the output is still never longer than the input and chunking stays lossless.

## Unreleased — Personal v4 closure: INT-3 acceptance and DOC-E (2026-10-12)

Every v4 track is merged (#152-#172). This entry adds a test and documentation only; no runtime behaviour changes. Schema
stays v15; `ConversationRuntimeDeps` stays 35.

- **INT-3 (`apps/quoky/src/personal-v4-acceptance.test.ts`).** The real `AppModule`, booted once per configuration, with
  a scripted global `fetch` (Telegram Bot API, Google OAuth, Gmail, Drive, OpenAI; anything else throws and is counted),
  a fake calendar and a recorded Discord child. It pins: one owner Actor across Telegram and Discord; a reminder
  delivered on the platform that created it; `OPS_*` notices on Discord; mail and Drive listings DM-only on both
  platforms, summaries only on an explicit request, injection mail and docs causing no action, and no handler and no
  egress when the token files are absent; OpenAI and Gemini configured but unselected causing zero fetch calls with
  provider calls identical to a host without them; code, review, planning, project-analysis, test and policy
  capabilities staying on Claude when OpenAI is selected; the reported usage on `TaskRun.usage`; the brief's calendar
  section; an event-relative reminder following a moved event and firing once; and the learning-example egress rule
  (flag off: a byte-identical prompt, flag on with an owner-selected remote provider: at most 2 examples).
- **Golden corpora.** No case added: the routing corpora run on the v2 harness, which has no Google connector, and the
  v4 routes are pinned by INT-3 and the handler tests. `baseline.v1.json` already equals the corpus sizes (419 routing, 155
  action-shaped), so no ratchet moved.
- **Docs.** New `docs/uat/personal-v4-qa-record.md` (live QA session 1, 2026-10-12, with its Pending list); a v4 closure
  summary in `CURRENT_STATE.md` and merged status on the per-track sections; v4 status in `ROADMAP.md`; the quickstart
  gains the daily brief (calendar and Jira sections), `QUOKY_BRIEF_JIRA_ENABLED`, `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED`,
  the summary marker stripping and the settled Telegram reaction behaviour; the operator guide gains the v4 settings and the
  live Telegram status; `.env.example` lists `QUOKY_BRIEF_JIRA_ENABLED`.
- **Still Pending (not run live):** OpenAI and Gemini (no API keys), the first monthly usage DM (November), the Jira
  section of the brief, a remote learning-example round trip, and the Telegram ops panel visual check. The TG-2 reaction
  spike is settled: `message_reaction` is delivered in private bot chats (live 2026-10-12).

## Unreleased — v4 live QA follow-ups (2026-10-12)

- **Document summaries (Gmail, Drive).** The reply is still an untrusted `markup` span, but Core now strips paired `**x**`
  and `__x__`, leading `#` headings and turns `- ` / `* ` list markers into `• ` before it is shown, so Discord no
  longer prints literal `**`. A lone `*` (`2 * 3`) stays, the text is never longer, and links are neutralized again
  after the strip so removing characters can never create one (`evil**.**com`).
- **Code-work next steps.** The merge and remote-branch-cleanup approval replies now say how to execute (`머지 실행`,
  `원격 브랜치 삭제 실행해줘`); `머지 실행` is now the documented merge phrase (`머지해줘` is still accepted). The operator
  guide lists the execute phrases the copy asks for (`커밋 실행`, `푸시 실행`, `PR 생성 실행`, `머지 실행`), not the
  request phrases. Tests run each post-approval hint through the execution grammar.
- **Local branch cleanup refusal.** `BranchCleanupBlockedError` carries a reason code and the reply gives one fixed
  sentence for it (checked-out tells the owner to switch to another branch such as `main` and ask again). No git output;
  the nothing-deleted wording is unchanged.

## Unreleased — PRV-3 provider usage ledger and monthly DM (2026-10-12)

Personal v4 track PRV-3 (ADR-0115 D8; implementation note in DECISIONS.md), on top of PRV-1 and PRV-2. **No migration:
usage is the typed `TaskRun.usage` value object (ADR-0010), kept in the run's JSON `data`** (schema stays v15). New and
additive: `AiExecutionResult.usage` (type only), `TaskRun.usage?` and the read-only streaming
`TaskRunRepository.forEachUsageFinishedBetween`; no new dependency; `ConversationRuntimeDeps` stays 35. ARCHITECTURE.md
§4 marks `Usage` `[NOW]`.

- **Usage record.** The runtime stores `TaskRun.usage` (`label`, `reported`, input, cached input, output, reasoning,
  total tokens) for a provider that returns a usage object: OpenAI and Gemini (response counts), Codex (its
  `turn.completed` counts), and the label alone ("unknown") for the Claude CLI, Ollama and the vision CLIs. Nothing is
  estimated; `metadata` stays provider-owned. Every CLI run now records at least `{label, reported: false}`, so runs
  carry a usage record from the first turn on.
- **Ops UI.** A `provider-usage` panel with the current and previous month per label (`QUOKY_TIMEZONE`), counts only and
  escaped. A count no run reported shows as "미보고", never 0. The panel is omitted only while neither month has a usage
  record, which in practice means until the first answered turn.
- **Notices.** One DM per calendar month with the previous month's totals per label, and, with the optional
  `QUOKY_PROVIDER_USAGE_MONTHLY_THRESHOLD` (known total tokens per month; malformed = startup error
  `PROVIDER_USAGE_THRESHOLD_INVALID`), one DM when a month first reaches it. Owner DM only, totals only, always one
  delivered message (top labels, then "외 K개"). `SENT` and `UNCERTAIN` settle the month; only a retryable `NOT_SENT`
  and `NO_OWNER` are retried, at most 3 attempts per kind per month, each recorded in flight before the send in
  `ops/provider-usage-notices.json`; an attempt a restart finds still in flight counts as `UNCERTAIN` and is never
  resent (as ADR-0101 reminders). Quoky never switches, disables or re-ranks a provider from usage.

## Unreleased — DRV-1 Google Drive read connector (2026-10-12)

Personal v4 track DRV-1 (ADR-0118 D1–D8; implementation note in DECISIONS.md), on top of GML-1. No migration;
`ConversationRuntimeDeps` stays 35. New: the `DriveReader` port and the `DRIVE_READER` token; the GML-1 untrusted readout
gains the source `drive`. No third-party dependency (`node:fetch` only). Drive is off unless `QUOKY_DRIVE_TOKEN_FILE` is
set; with it off, every reply is unchanged.

- **New `packages/connector-gdrive`** (`GoogleDriveReader`). Scope `drive.readonly` only, checked at the code exchange and
  at every refresh. A broader grant is refused.
  - **Requests.** GET to the pinned `www.googleapis.com/drive/v3/files`, `files/{id}` and `files/{id}/export` only,
    through one guarded request function.
  - **Text only.** Google Docs export as `text/plain`, Google Sheets as `text/csv`; nothing else is ever read
    (no file is downloaded, so an uploaded text file is listed but never summarized). The text is cut at 256 KiB while it streams; a non-text body is refused.
  - **Bounds.** 10 s per request, no redirects, a 10-entry page (512 KiB cap), an ids-only count page of at most 100
    (64 KiB), metadata 64 KiB. Trashed files and folders are not listed.
  - **Token.** Its own mode-600 token file; a calendar or Gmail token file is refused.
  - **Read-only check.** A source scan proves no upload, edit, copy, move, trash, delete, share or permission call, no
    other export type and no second request site exists.
- **Drive handler** (`pre-classify` order 145, after mail and before the calendar). Registered only with Drive
  configured.
  - **Phrasings.** `최근 문서`, `최근 파일`, `드라이브에서 <이름> 찾아줘`, `N번 문서 요약해줘` and English forms
    (`recent documents`, `find <name> in my drive`, `summarize document 1`). Searches always name the drive, so no mail,
    calendar, Confluence, code or golden-corpus phrasing is claimed. A car trip (`드라이브 코스`) or a local disk
    (`D 드라이브`) is not Drive.
  - **Listings** are deterministic, with no model call: name, kind and modified time; at most 10 entries, then `…외 N건`.
    Names are untrusted spans with links replaced by `[링크]` and credential-shaped names hidden.
  - **DM-only**, could-not-read failures, a fixed read-only refusal for write requests, and fixed history notes, as for
    mail.
- **Summaries only on request**, through the GML-1 path (not duplicated): the full-text credential guard before and
  after the clip, link neutralization, runtime re-validation, a self-contained prompt with no tools, the claim and
  credential guards on the reply, a fixed footer, no stored artifacts. Presentations, PDFs and other files are never
  read. The claim guard now also withholds document actions ("문서를 공유했어요", "I renamed the file").
- **Consent helper.** `calendar-auth.js --drive` requests `drive.readonly` only and writes a new token file; one grant
  set per run. `.env.example` and the quickstart document `QUOKY_DRIVE_TOKEN_FILE`, consent and revocation (the shared
  client revokes calendar, Gmail and Drive together).
- **Validation.** Offline only, with a fake `fetch`; the Drive API was never called. Not run yet: the Strict gates
  (owner consent, the first read probe and the live session) and the Chief Architect review.

## Unreleased — TG-3 Telegram notifications and operations (2026-10-12)

Personal v4 track TG-3 (ADR-0114 D7, D11 and D12; implementation note in DECISIONS.md). No migration, port, DI token or
domain field. `ConversationRuntimeDeps` stays 35, there is no new dependency, and Core is not touched. Discord is
unchanged; its golden fixture is green.

- **Fixed: the ops-UI decision result for an approval created on Telegram (D11).** It was addressed to the Telegram
  chat. The composite routes `OPS_DECISION_RESULT` to Discord, and the Discord sink refused it there, so the owner was
  never told. It now goes to the Discord owner DM that `QUOKY_TELEGRAM_OWNER_ACTOR_MAP` maps the Telegram owner to
  (`opsDecisionResultTarget`). Discord-held approvals are byte-identical. The confirmation page shows
  "Telegram 개인 대화" for a Telegram approval.
- **Added: an operations-UI Telegram panel (D12).** It shows:
  - connected, identity verified, halted (with its code and meaning), polling, and the last poll time;
  - the number of admitted private chats;
  - the dropped updates per reason, `not-feedback` and `forwarded` included.

  It shows no content, ids or token, and each value is checked against a fixed pattern. With Telegram off it says
  "설정 안 됨 (not configured)". The rest of the dashboard is byte-identical to a golden rendered before the change.
- **Changed: CommonMark on Telegram, in plain mode (D7).** There is still no `parse_mode`. Quoky's own copy, model
  replies, notification bodies and the preview header and footer are translated:
  - emphasis and code-span markers are removed;
  - fence lines are removed and the code is kept exactly;
  - headings become plain lines;
  - bullets become `•`.

  Untrusted spans, links and conversation references are opaque: they pass through byte for byte. The translation never
  lengthens a text, and the lossless 4096 chunker splits the translated text. If the adapter's segment evaluator ever
  disagrees with Core's rendering, nothing is translated.
- **Added: `ops/launchd/quokyctl.sh telegram`.** It is read-only and does not read the env file or call Telegram. It
  prints the saved-offset time, the delivered halt notices, the halt codes with their fixes, token rotation and the
  unlink pointer. `status` is unchanged.
- **Docs.** `docs/uat/operator-guide.md` has a new section 0.8 on Telegram. The quickstart's Telegram section covers the
  panel, `quokyctl`, the halt codes, rotation, unlinking and formatting.
- **Tests.** New:
  - `packages/adapter-telegram/src/commonmark.test.ts`: the rules, span safety, 600 random trees for parity, a real
    brief, and chunking after translation;
  - `apps/quoky/src/ops-ui/actions/telegram-decision-result.test.ts`;
  - the Telegram panel tests and the golden in `build-snapshot.test.ts`;
  - the panel wiring tests, over the served page;
  - the `quokyctl.sh telegram` tests;
  - two D11 acceptance tests: `OPS_NOTICE`, and the decision result through the real `AppModule` sink.

## Unreleased — BRF-2 pre-meeting reminders (2026-10-12)

Personal v4 track BRF-2 (ADR-0117 D5/D6; implementation note in DECISIONS.md). No migration (the event reference lives in
the reminder's JSON data), no new port, DI token or dependency; `ConversationRuntimeDeps` stays 35.

- **Phrasings (opt-in per command).** `회의 10분 전에 알려줘`, `다음 회의 30분 전에 알려줘`, `3시 회의 15분 전에 알려줘`,
  `<제목> 회의 10분 전에 알려줘`, `내일 회의 1시간 전에 알려줘`, `금요일 주간 회의 20분 전에 알려줘`,
  `remind me 10 minutes before my next meeting`. The offset is 1–120 minutes. `회의 전에 알려줘` asks how many minutes.
- **Resolution.** One read through the existing `CalendarReader`: the named day, or the next 14 days.
  - **Ambiguous.** The candidates are listed and nothing is created.
  - **Refused, with nothing created.** No match, all-day only, too soon, and an unreadable calendar; each is said
    honestly.
  - **Stored.** The event id and offset, with the guarded title as the body.
- **Fire-time re-check.** The event is re-read by id when the reminder is due:
  - moved later: rescheduled, nothing sent at the stale time;
  - moved earlier: delivered now with the new start;
  - deleted, cancelled or now all-day: canceled with one note;
  - unreadable: delivered with a "could not re-check" note.

  At most once (ADR-0101 D6). The reminder transition table gains FIRING → CANCELED, used only by this re-check.
- **Listing and cancel.** `알림 목록` shows `[회의 10분 전] <제목>`; `알림 N 취소` works unchanged. The brief lists these
  reminders too. Titles are untrusted spans, credential-guarded. Replies that echo a title keep a fixed history note.
- **Delivery.** Deterministic text, no model call, to the origin platform through the existing owner sink.
- **Routing.** The golden corpus gains route-408..419. Existing cases are unchanged.
- **Codex review fixes (four P2s).**
  - The re-check matches the event id and its calendar name; a duplicate id is ambiguous and delivered with the note.
  - `HH:MM` is 24-hour and exact.
  - Recurrence words and bound clock times keep the ADR-0101 reminder (`매일 오전 9시에 회의 10분 전에 알려줘` is a
    daily 09:00 reminder again).
  - The ADR-0101 negation, addressee and question guards gate every event-relative parse.
  - A sweep pins the outcome of every pre-existing golden and fixture phrase.
- **Validation.** Offline only (fake calendar reader and clock, SQLite acceptance). Not run: the Strict gate, one
  pre-meeting reminder on a test event on the owner's service.

## Unreleased — GML-1 Gmail read connector (2026-10-08)

Personal v4 track GML-1 (ADR-0118 D1–D8; implementation note in DECISIONS.md). No migration; `ConversationRuntimeDeps`
stays 35. New: the `MailReader` port, the `MAIL_READER` token, and a type-only widening of the `summarize` readout. No
third-party dependency (`node:fetch` only). Gmail is off unless `QUOKY_GMAIL_TOKEN_FILE` is set; with it off, every reply
is unchanged.

- **New `packages/connector-gmail`** (`GmailMailReader`). Scope `gmail.readonly` only, checked at the code exchange and
  at every refresh. A broader grant is refused.
  - **Requests.** GET to the pinned `gmail.googleapis.com/gmail/v1/users/me/messages[/{id}]` only, through one guarded
    request function.
  - **Bounds.**
    - Each request has a 10 s timeout and refuses redirects.
    - Response size caps: 64 KiB for a list or metadata read, 4 MiB for a full message.
    - A search reads one page of at most 100 ids and metadata for at most 10.
    - A body is cut at 256 KiB.
  - **Typed failures.** Auth expired (`UNAUTHORIZED`), needs consent (`INSUFFICIENT_SCOPE`), rate limit, unavailable,
    forbidden and invalid response.
  - **Token.** Its own mode-600 token file holds one grant set; a calendar token file is refused.
  - **Read-only check.** A source scan proves no send, draft, label, modify, trash or delete call exists.
- **Mail handler** (`pre-classify` order 140, before the calendar). Registered only with Gmail configured.
  - **Phrasings.** `안 읽은 메일`, `오늘 온 메일`, `<보낸 사람> 메일 찾아줘`, the QUAL-7 mailbox questions
    (`메일 왔어?`, `메일 확인해줘`) and English forms.
  - **Listings** are deterministic, with no model call: sender, subject, date and a credential-guarded snippet; at most
    10 entries, then `…외 N건`.
  - **DM-only.** In a Discord channel or a Telegram group, the reply says these answers are DM-only and nothing is read.
  - **Failures** get the could-not-read note, never "no mail". Write requests get a fixed read-only refusal.
  - **History** keeps a fixed note, never mail text.
- **Summaries only on request.** `N번 메일 요약해줘` reads that one message. Its body goes out as a bounded untrusted
  readout under the ADR-0111 D3 rules: NFKC and format-character stripping, a 3,000-character head and tail, and the
  credential guard.
  - **Refusals.** A credential-shaped or empty mail is refused before anything leaves the host.
  - **Runtime.** The readout is re-validated, then summarized by the effective chat-tier provider through the existing
    SUMMARIZATION path. The prompt is self-contained and carries no tools.
  - **Reply.** The claim and credential guards run on the reply, and a fixed disclosure footer is added. History
    records a fixed note instead of the summary.
  - **Injection.** An injection mail causes no action and no routing change.
- **Consent helper.** `calendar-auth.js --gmail` requests `gmail.readonly` only on the existing client and writes a new
  Gmail token file. It cannot be combined with `--with-events`.
  - `.env.example` documents `QUOKY_GMAIL_TOKEN_FILE`.
  - The quickstart covers the consent step, the env key and how to revoke.
- **Review fixes (Codex P1/P2, Chief Architect P2-1..P2-4 and P3s).**
  - The credential guard reads the full text before any clip.
  - Listing caps guarantee every listed number was displayed.
  - Hostile mail is processed in linear time (HTML scan, 512 KiB cap).
  - The grammar no longer claims writing, explaining or time-word requests.
  - A summary-only guard withholds mail-action claims.
  - Links become `[링크]` before egress, and summary replies render as inert untrusted text.
  - No summary artifacts are stored; history notes are accurate; Core copy is source-neutral; the source scan is
    stricter; the shared-client revoke warning is added.
- **Re-review fixes.**
  - One shared `neutralizeLinks` covers the readout body, title and author, the re-check, the summary reply and the
    listing fields. It catches glued schemes (`1https://`), upper-case schemes, `www.`, bare domains, and punycode or IDN
    hosts. Display mode is strict; body mode leaves word-like names such as `Node.js` intact. A seeded property test
    checks the result.
  - The claim guard now catches curly apostrophes, filler words and the `처리` forms. It exempts a claim only when the
    nearest real subject before it is someone other than Quoky.
  - The grammar refuses relative times, recipients and topics as senders.
  - The reply budget is now the readout's own constant.
- **Sign-off fixes.**
  - The file-extension exemption no longer covers delegated TLDs (`.md`, `.sh`, `.rs`, `.py`, `.java`).
  - A Korean particle glued to a domain no longer hides it.
  - Any Quoky stand-in subject before a claim blocks its exemption.
  - Six filler words are allowed in English claims.
  - More IDN TLDs, combining marks, format-character removal with NFKC, and ideographic full stops are covered.
- **Validation.** Offline only, with a fake `fetch`; the Gmail API was never called. Not run yet: the Strict gates
  (owner consent, the first read probe and the live session of about 15 phrasings), and the Chief Architect re-review.

## Unreleased — TG-2 Telegram attachments, reactions and approvals (2026-10-08)

Personal v4 track TG-2 (ADR-0114 D8–D10; implementation note in DECISIONS.md). No migration, no new port, DI token or
domain field; `ConversationRuntimeDeps` stays 35. No new dependency. Discord is unchanged (no Discord file is touched).

- **Attachments.** Owner messages with a photo, a document or a caption are no longer dropped. They map to the same
  Core attachment model Discord uses; a caption is the message text.
  - Bounds (ADR-0111): at most 3, text ≤256 KiB, png/jpeg/webp ≤8 MiB.
  - Type and size are checked from the update metadata first, then `getFile`'s `file_size`. Only then comes the
    download, bounded while streaming.
  - Text files go through the strict UTF-8 and credential-guard path. Images go through the #143 canonical intake into
    a private runner-owned temp directory, deleted after the turn.
  - Stickers, voice notes, audio, video and animations are named as unsupported and never fetched. Forwarded and
    inline-bot messages stay dropped.
  - An album (`media_group_id`) is one turn. Its parts are held with the offset unconfirmed, then handed over together.
  - The owner notice for a message with nothing to read is now "이 형식의 Telegram 메시지는 아직 처리하지 않아요. 텍스트,
    사진이나 파일로 보내 주세요." (`ATTACHMENT_UNSUPPORTED_NOTICE` is replaced by `UNSUPPORTED_MESSAGE_NOTICE`).
- **The guarded download.** `getFile` and the file download are on the fixed method list.
  - Both run only through the adapter's guarded outbound wrappers, so nothing is fetched before verification, after a
    halt or after a stop.
  - The token-bearing download URL is built only inside the Bot API client. Every error is a fixed code, and an unsafe
    `file_path` is refused before a request.
  - The invariant table and the source scan cover the new paths.
- **Feedback.** 👍/👎 arrive as `message_reaction` updates, which the poll now asks for explicitly (`allowed_updates`).
  - Only the owner's own change in their own private chat is admitted. A reaction on the owner's own message is
    dropped (new drop reason `not-feedback`), and Core links a reaction only to a reply the adapter reported posting.
  - The spike: the Bot API reference makes the update opt-in and names no private-chat exclusion. Delivery in a private
    chat is confirmed at the Strict live session; without it `onFeedback` simply never fires.
- **Message ids.** Telegram receipts now report `<chat id>:<message id>`, because Telegram ids are unique only inside one
  chat. Reaction targets use the same key.
- **Approvals.** Nothing new: the existing text phrases. A real-`AppModule` acceptance test covers preview → `승인` →
  `댓글 실행` on Telegram, and the cross-platform refusal from Discord.
- **Codex review fixes.** The offset is saved only after an attachment turn (or a whole album) was handed over, so a
  stop or crash during the intake leaves it to be delivered again. A halt aborts Bot API work already in flight,
  downloads included. `stop()` waits (bounded) for an intake in flight and leaves no handler call or temp file behind.
  Every hand-over re-checks stop and halt first, so a `stop()` from inside a handler ends the batch. A loop from an
  earlier run never touches a restarted run's state. One poll batch spends at most 60 s on attachment intake: after
  that, its remaining attachment messages are handed over in order with their files not fetched.
- **Parity.** `adapter-telegram/src/image-canonical.ts` (and its test builders) are byte-identical copies of the Discord
  ones. A composition-root test pins the copy and runs one 18-case fixture set through both intakes.

## Unreleased — PRV-2 Gemini API provider for the chat tier and images (2026-10-08)

ADR-0115 D4 (PRV-2; implementation note in DECISIONS.md). No migration, no new port or token, no Core change (the Core
credential guard already knew the `AIza…` key shape); `ConversationRuntimeDeps` stays 35. No new third-party dependency
(`node:fetch` only).

- New `packages/ai-gemini-api`, following the PRV-1 pattern.
  - `GeminiApiProvider` (chat tier) and `GeminiApiVisionProvider` (`IMAGE_UNDERSTANDING`), both `REMOTE`.
  - One `generateContent` call to the pinned `https://generativelanguage.googleapis.com/v1beta`, with no tools,
    function declarations, code execution or grounding.
  - The key goes only in the `x-goog-api-key` header (never in a URL), held in a redacting `GeminiApiKey`.
  - Redirects refused; one timer over headers and body; a 2 MiB response bound; error bodies never read.
  - A response with a function call, executable code, a code-execution result, a tool call or grounding metadata is
    refused (`TOOL_CALL_REFUSED`). A reply part may carry only `text`, `thought` and `thoughtSignature`; any other key,
    even beside a `text`, is refused, and thought parts are never part of the reply.
  - A safety rating with `blocked: true` (candidate or prompt feedback) fails closed as `SAFETY_BLOCKED`, whatever the
    finish reason.
  - `MAX_TOKENS` returns the text marked as cut off. A blocked prompt and the safety, recitation, blocklist,
    prohibited-content and personal-data finish reasons fail closed (`SAFETY_BLOCKED`); other reasons are
    `INCOMPLETE`.
  - Readiness is one bounded model-get, shared by the chat and image instances and cleared by an
    unavailable / rate-limit / auth / timeout / 400 execution failure.
  - Images are the #143 canonical bytes, inline; a request over 20 MB is refused before sending.
  - Context files are refused.
- Selection.
  - `QUOKY_CHAT_PROVIDER=gemini` and `QUOKY_IMAGE_UNDERSTANDING_PROVIDER=gemini`.
  - Labels `gemini:<model>` on a bounded allow-list (the current stable Gemini 3.x Flash models and
    `gemini-3.1-pro-preview`).
  - `모델 목록` / `모델 변경: gemini[:<model>]` / `이미지 모델 변경: gemini`, and the `/providers` options with a Google
    egress note and image warning.
  - Registered only when `QUOKY_GEMINI_API_KEY` and `QUOKY_GEMINI_MODEL` are set, and eligible only while it is the
    effective choice. An unselected instance is not probed at startup.
  - The image locality policy opens `REMOTE` for it only while it is the effective image choice.
  - Code, review, planning, tests and policy-sensitive chat keep byte-identical eligible sets. LRN-5 example egress
    reaches Gemini only when it is explicitly selected and the remote flag is on.
- Startup errors `GEMINI_API_KEY_INVALID`, `GEMINI_MODEL_INVALID`, `GEMINI_API_KEY_MISSING`, `GEMINI_MODEL_MISSING`.
  `error-diagnostics` redacts `AIza…` keys and `QUOKY_GEMINI_API_KEY=…`. `.env.example` and the quickstart document the
  two names.

## Unreleased — TG-1 Telegram text conversations (2026-10-08)

Personal v4 track TG-1 (ADR-0114 D2–D7, D13; implementation note in DECISIONS.md). No migration, no new port, DI token
or domain field; `ConversationRuntimeDeps` stays 35. No new third-party dependency (`node:fetch` only).

- **New `packages/adapter-telegram`.** `TelegramPlatformAdapter` uses Bot API long polling (`getUpdates`) to the pinned
  `https://api.telegram.org`. There is no webhook and no inbound port.
  - Offset: advanced only after an update is handed over or dropped, and confirmed on stop.
  - Backoff: 1 s doubling to 60 s; a 429 honours `retry_after`.
  - Identity at startup (ADR-0102 D5, ADR-0114 D4): the token's bot id, then `getMe` and a webhook 409 probe, each
    bounded to 5 s.
    - A definitive answer is a typed startup error and exits 78: `TELEGRAM_IDENTITY_MISMATCH`,
      `TELEGRAM_AUTH_REJECTED` or `TELEGRAM_POLL_CONFLICT`.
    - A transient or timed-out answer lets the start continue and is retried in the background.
    - A definitive answer from that background retry (before the first verification) also exits 78, through a fatal
      callback and the graceful shutdown.
    - Only detection after the first verification (a 401, three 409s, a loop defect while polling) halts the
      Telegram side only, with one Discord `OPS_NOTICE`.
    - `TELEGRAM_IDENTITY_UNVERIFIABLE` is a log code.
- **Admission.** Only an owner's (`QUOKY_TELEGRAM_OWNER_IDS`) own private chat with text, at most 10 minutes old.
  Everything else gets no reply, no download and no content log; only a value-free counter per reason is kept. Every
  send and typing call is rechecked against the owner's private chat.
- **Token.** A `TelegramBotToken` holder (`[REDACTED]` in JSON, inspect and string form). The token appears only in
  the request path. Errors carry a fixed code and never the URL or a `cause`. `error-diagnostics` redacts the token
  shape and `QUOKY_TELEGRAM_BOT_TOKEN=…`.
- **Delivery.**
  - Plain text with no parse mode, so every content node is delivered verbatim. A foreign conversation reference is
    shown as a neutral name ("Discord 대화방").
  - Link previews are off.
  - A lossless 4096 chunker: it never splits a surrogate pair or a backtick run.
  - Code-change previews use `<pre>` parts with escaped content, falling back to a `.diff` document.
  - Typing is `sendChatAction`.
  - Core's budgets are unchanged.
- **Composition.** With `QUOKY_TELEGRAM_ENABLED` off (the default), `PLATFORM_ADAPTER` is the Discord adapter itself
  and nothing Telegram-related is constructed. With it on, it is a `CompositePlatformAdapter` over Discord (primary)
  and Telegram that routes by `context.platform`.
- **Identity.** `QUOKY_TELEGRAM_OWNER_ACTOR_MAP` links each Telegram owner to the Discord owner's Actor at startup
  (ADR-0009 seam), so memories and to-dos follow the owner. Sessions stay per conversation.
- **Configuration.** New keys `QUOKY_TELEGRAM_ENABLED`, `QUOKY_TELEGRAM_BOT_TOKEN`, `QUOKY_TELEGRAM_EXPECTED_BOT_ID`,
  `QUOKY_TELEGRAM_OWNER_IDS` and `QUOKY_TELEGRAM_OWNER_ACTOR_MAP`, with eleven `TELEGRAM_*` startup error codes (exit
  78). `.env.example` and a quickstart section are updated.
- **PLT-0 residual.** Inbound mention-token parsing moved from Core's `hasEffectiveText` into the Discord adapter
  (`addressing.ts`). This is a deliberate Discord change on one path. An attachment message whose text is only
  addressing reaches Core as `''`, so history, prompt input and image caption no longer carry `<@id>`. Every other
  Discord text is unchanged.
- **Review fixes (Chief Architect CHANGES REQUIRED; Codex P2 = CA P3-3).**
  - **P1-1.** Reminders and the brief created on Telegram are delivered on Telegram.
    - `TelegramPlatformAdapter.deliver` sends one `sendMessage` at most, never retried.
    - The composite routes `TEXT` and `BRIEF` by `target.platform` and `OPS_DECISION_RESULT` to Discord.
  - **P2-1.** Forwarded and inline-bot messages are dropped (`forwarded`).
  - **P2-2.** A transient Telegram outage at startup no longer stops the process. The identity is verified in the
    background, and a later mismatch or auth failure halts the Telegram side only.
  - **P2-3.** Three 409s within five minutes stop polling (`TELEGRAM_POLL_CONFLICT`). The startup probe claims only a
    webhook.
  - **P2-4.** An end-to-end acceptance test runs the started composite against a scripted Bot API.
  - **P3-1.** An oversized batch is halved down to 1, then that update is skipped.
  - **P3-2.** Identity links are preflighted with the mappings. The link conflict exits 78 and documents an unlink.
  - **P3-3.** The mention-only + usable-attachment Discord change is documented as deliberate and pinned by a test.
  - **P3-4.** The owner gets one notice per kind for stale or text-less messages.
  - **P3-5.** A runtime auth failure stops polling.
  - **P3-6.** The rate-limit wait honours `stop()`.
  - **Offset.** The poll offset is persisted in `ops/telegram-offset.json`, so a restart never replays a handed-over
    turn.
- **Re-review fixes (CA re-review; Codex delta P2).**
  - **P2.** The offset file carries `savedAt` and is ignored after 24 h, or when `savedAt` is missing. In memory, the
    offset is dropped after a silent day, so a restarted lower `update_id` is never swallowed.
  - **P3-1.** Owner notices are counted per owner chat.
  - **P3-2.** A poll-loop rejection halts Telegram only.
  - **P3-3.** A halt sends one `OPS_NOTICE` to the Discord owner.
  - **P3-4.** The startup texts are aligned with the implementation.
  - **P3-5.** `start()` no longer blocks long on `getMe`: each startup call is bounded to 5 s (see the final-check
    realignment).
  - **P3-6.** An empty notification is `EMPTY_TEXT`, a new additive `NotificationNotSentReason`.
  - **P3-7.** The quickstart notes that Telegram-created reminders stop when Telegram is off.
  - **Codex delta P2.** Nothing is sent to Telegram before `getMe` matched or after a halt.
  - **BRF-1.** A test covers a calendar/Jira BRIEF delivered on Telegram.
- **Final-check fixes (CA final check; Codex delta P2s).**
  - **Critical.** `stop()` confirms the offset only for a verified, un-halted session.
  - **ADR realignment.** Definitive startup answers exit 78 again; outages and later answers halt Telegram only.
  - **Notice timing.** Halt notices are held until Discord is ready.
  - **Notice suppression.** A repeated Telegram halt reason is suppressed for 24 h.
  - **Restart and retry.** `start()` resets the verified identity, and the 429 retry re-checks halt/stop.
  - **Shutdown.** The loop's catch is silent while stopping.
  - **Test.** A table-driven outbound invariant test covers every Bot API method.
  - **Codex final delta P2-1.** The startup identity check carries the lifecycle abort signal, and `stop()` aborts and
    awaits it.
  - **Codex final delta P2-2.** Halt notices are released only on Discord READY, bounded and read-only. The 24 h
    suppression starts only on a delivered notice.
  - **CA final check (APPROVE WITH NITS).**
    - A definitive answer from the background startup retry exits 78 (ADR-0102 D5).
    - The restart-after-startup-stop test.
    - An abort is never classified as a refusal.
    - The webhook-409 exit-78 test row.
    - Halt reasons come from a closed list.
    - One guarded outbound wrapper, pinned by a source-scan test.
- **Not in TG-1.** Attachments, reactions, the operations-UI panel, CommonMark rendering on Telegram and live QA
  (TG-2/TG-3, Strict).

## Unreleased — BRF-1 morning brief with today's calendar (2026-10-08)

ADR-0117 D1–D4 (implementation note in DECISIONS.md). No migration, no new DI token, no port change;
`ConversationRuntimeDeps` stays 35.

- **Calendar section.** When a calendar is configured, the `BRIEF` reminder lists `오늘 일정` read through the existing
  `CALENDAR_READER`: today in `QUOKY_TIMEZONE`, all-day first, then timed by start, at most 10 with `- 외 N건`, titles
  and times only, in the schedule reply's line format and title guard. An unreadable or slow calendar (30 s bound)
  shows `오늘 일정: 불러오지 못했어요.`. With no calendar the section is omitted and the brief is unchanged.
- **Opt-in Jira section.** `QUOKY_BRIEF_JIRA_ENABLED` (default `false`) adds the owner's Jira items due or updated
  today, through the ADR-0100 `personal-work` named query: read-only, at most 5, key and title.
- **Wiring.** Core `DailyBriefSources` is the dispatch service's one optional `briefSources` dependency. The
  composition root builds it from optional injections of the existing `CALENDAR_READER` and `CONNECTOR_PROVIDERS`.
- No model call; the brief stays DM-only. The Discord golden fixture is unchanged.

## Unreleased — LRN-5 consent copy (2026-10-08)

ADR-0116 residual R4. No migration, no new DI token or port, no dependency change.

- With `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED=true` (and examples enabled), the "피드백 후보" listing, the
  "후보 N 예시로 저장" confirmation and the "예시 목록" listing each end with one line: "직접 고른 클라우드 모델을 쓸 때는
  이 예시가 대화와 함께 전송될 수 있어요." Memo-only confirmations are unchanged (memos are never sent). With the
  flag off every text is byte-identical.

## Unreleased — PLT-0 platform-neutral rendering (2026-10-08)

Personal v4 track PLT-0 (ADR-0114 D1; implementation note in DECISIONS.md). No migration, no new DI token, no
dependency change; `ConversationRuntimeDeps` is unchanged.

- **Core content model.** `MessageContent` (`domain/message-content.ts`) has:
  - untrusted text (guards `markup` / `mentions` / `handles`), link, conversation reference
    (`{ platform, direct, id?, label }`) and platform-note spans;
  - `clip`, `fit-lines` and `take-lines` budgets.

  `OutboundMessage.content?` and `OwnerNotification.content?` carry it, and `text` is the plain rendering.
  `ConversationContext.direct?` is set by the adapter. The port `MessageMarkup` (`ports/message-markup.port.ts`) is
  what each adapter implements; `application/message-rendering.ts` evaluates it.
- **Port changes.** `TurnHandlerSummarizeReply.fallbackText` and `.footer` are now `MessageBody`. An adapter that
  parses markup must render `content` (documented on `PlatformAdapter.sendMessage` and `NotificationSink.deliver`).
- **Discord.** `DISCORD_MARKUP` renders the exact bytes Core used to write. Every reply is sent with
  `allowedMentions.parse` empty, and a content/text mismatch is logged content-free.
- **Removed from Core.** `escapeDiscordText`, the memory and brief mention escapes, `<#id>`, `<url>`, and the help
  line that named Discord. A source scan guards against their return.
- **Not in Discord chat.** Conversation history keeps plain text, and the memory forget cascade still matches older
  escaped turns. The operations UI memory previews are plain.
- **Fix.** The work-surface lookup line ("내 업무" via `composeWorkSurface`) escapes connector titles and suppresses the
  link embed. Before, a raw Jira/GitHub title could carry markup or a mention. This is the only intended Discord byte
  change.
- **Evidence.** A golden fixture of 793 Discord texts, captured from the base renderers.

## Unreleased — PRV-1 OpenAI API provider for the chat tier and images (2026-10-08)

ADR-0115 (PRV-1). No migration, no new port or token, no Core change; `ConversationRuntimeDeps` stays 35. No new
third-party dependency (`node:fetch` only).

- New `packages/ai-openai-api`: `OpenAiApiProvider` (chat tier: `GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS`,
  `READONLY_LOOKUP`) and `OpenAiApiVisionProvider` (`IMAGE_UNDERSTANDING`), both `REMOTE`. Responses API at the pinned
  `https://api.openai.com`, no tool definitions, `store: false`, redirects refused, bounded timeout and response size,
  fail-closed output parsing, typed failures with fixed codes, readiness by one model-get call. The key is never in a
  log, the audit, an error or the result.
- Selection: `QUOKY_CHAT_PROVIDER=openai`, `QUOKY_IMAGE_UNDERSTANDING_PROVIDER=openai`, labels `openai:<model>` with a
  bounded allow-list, `모델 목록` / `모델 변경: openai[:<model>]` / `이미지 모델 변경: openai`, and the `/providers` options.
  Registered only when `QUOKY_OPENAI_API_KEY` and `QUOKY_OPENAI_MODEL` are set; eligible only while it is the effective
  choice; the image locality policy opens `REMOTE` for it only while it is the effective image choice. A not-ready
  choice falls back to Claude at selection time. Code, review, planning, tests and policy-sensitive chat keep their
  eligible sets byte-identical.
- Startup errors `OPENAI_API_KEY_INVALID`, `OPENAI_MODEL_INVALID`, `OPENAI_API_KEY_MISSING`, `OPENAI_MODEL_MISSING`;
  `.env.example` documents the two names.
- Review fixes: the key is held in a redacting holder (config inspection and serialisation show `[REDACTED]`);
  `incomplete` replies are marked as cut off at the output bound and fail closed otherwise (`INCOMPLETE`); startup
  readiness no longer probes a `REMOTE` provider outside the effective selection (no OpenAI call unless selected; the
  chat and image instances share one probe, cleared by an unavailable / rate-limit / auth / timeout execution failure so
  the next selection re-probes and can fall back to Claude); `sk-` keys are redacted from error diagnostics; context
  files are refused.

## Unreleased — LRN-5 learning-example egress realignment (2026-10-08)

ADR-0116 (Ratified 2026-10-08). No migration, no new port or DI token, no deps change; `ConversationRuntimeDeps` stays
35. ARCHITECTURE.md §5 rule 14 gains the ratified ADR-0116 D5 sentence (separate commit).

- New flag `QUOKY_LEARNING_EXAMPLES_REMOTE_ENABLED` (exact `true`/`false`, default `false`; effective only with
  `QUOKY_LEARNING_EXAMPLES_ENABLED=true`). Off: prompts are byte-identical to before. On: curated examples may also be
  composed for a `REMOTE` chat provider that is the owner's explicit selection (`모델 변경` in the conversation, the
  operations-UI default, or an explicitly set `QUOKY_CHAT_PROVIDER`), at most 2 per turn. The derived default
  (`QUOKY_CHAT_PROVIDER` unset, including `QUOKY_OLLAMA_ENABLED=false`) and Claude reached as the selection-time
  fallback get none. `LOCAL` providers are unchanged.
- Core: `ProviderPreference.ownerSelectedKey` (optional, opaque) and the optional `ProviderSelector.resolve`, which
  `CapabilityRouter` implements to return the provider with `OWNER_SELECTED` / `NOT_OWNER_SELECTED` from the same policy
  answer. The egress rule is one data-driven function, `isCuratedExampleEgressAllowed`
  (`core/application/feedback/curated-example-egress-policy.ts`), reading the declared locality and that source, never
  a provider id. Stored learning items stay `LOCAL_ONLY`; the credential guard at capture and at use, the forget
  cascade and the Stage 2B "no examples" rule are unchanged.
- Strict gates not run: the `.env.local` flag change on the owner host and the live round trip.

## Unreleased — UNC-1 connector-write network-fault fixes (2026-10-08)

From the UNC-1 live network-fault UAT (Docker fault proxy, real Slack writer; harness in `tools/uat/netfault/`). No
migration, no new port or token, no deps change; `ConversationRuntimeDeps` stays 35. The harness refuses to run unless
Slack `conversations.info` — run in a separate short-lived process — confirms the explicitly approved channel id is
`#quoky-test` (not a DM); the fault proxy closes every tunnel on each mode change; its image copies an allowlist only
(`/.dockerignore` drops every env-style file); `run.sh` validates its arguments before touching the filesystem and
accepts a run only with the case-specific outcome and tunnel pattern (`validate-result.mjs`).

- Pre-send failures are `NOT_SENT('UNAVAILABLE')`, not "may have been posted". Core gains only the neutral contract
  (`ConnectorWriteTransportGuard` / `ConnectorWriteTransportAttempt`, fail-safe default
  `failSafeConnectorWriteTransportGuard` = UNCERTAIN); the Slack post, Jira comment / transition and Google Calendar
  writers open one guard window around each write request (not around pre-reads or token refreshes). The composition
  root injects the platform-fetch guard (`apps/quoky/src/connector-write-transport.ts`). NOT_SENT needs BOTH
  invocation-wide no-send evidence — no `undici:client:sendHeaders` / `undici:request:bodySent` event for the target
  origin while the window was open (fetch re-dispatches a POST after HTTP 421; concurrent requests to the same origin
  poison each other, failing safe; a proxy CONNECT has the proxy's origin) — AND connection-stage evidence on the error
  (the object undici published on `undici:client:connectError`, `ENOTFOUND` / `EAI_AGAIN`, or a refused proxy tunnel).
  Everything else is UNCERTAIN. ADR-0112 gains a note: NOT_SENT means no request bytes were observed on any connection
  during the write. A source scan keeps Core free of `diagnostics_channel` and the HTTP client.
- NOT_SENT replies say plainly that nothing was sent: "Slack 게시를 보내지 못했어요: …. 아무것도 게시되지 않았어요."
  (Jira: "댓글은 달리지 않았어요." / "이슈 상태는 바뀌지 않았어요.", calendar: "캘린더는 바뀌지 않았어요.").
- Duplicate warning after UNCERTAIN: a new preview whose connector, operation, target and payload hash match an
  unresolved receipt of the same actor (UNCERTAIN, or PREPARED = dispatched) leads with "주의: 같은 내용의 이전 요청은
  결과를 확인하지 못했어요(<시각>). 이미 게시됐을 수 있으니 …". Approval still works; a matching SENT receipt keeps the
  "이미 보냈어요" reply. New receipt-repository method `findLatestUnresolved` (SQLite: `status IN ('UNCERTAIN',
  'PREPARED')`, no schema change).

## Unreleased — CODE-8 multi-repository allowlist for code work (2026-10-08)

ADR-0109 (Ratified 2026-10-06, all recommended defaults). No migration, no new port, no token change, no deps change;
`ConversationRuntimeDeps` stays 35.

- `QUOKY_GITHUB_REPOS`: comma-separated `owner/repo`, at most 10, validated at startup — a malformed, empty, URL-shaped,
  `.git`-suffixed or token-shaped entry is `GITHUB_REPOS_INVALID`, a case-insensitive duplicate `GITHUB_REPOS_DUPLICATE`,
  an 11th entry `GITHUB_REPOS_TOO_MANY`. The legacy `QUOKY_GITHUB_OWNER`/`QUOKY_GITHUB_REPO` pair (and its `CHUNSIK_*`
  fallback) is an allowlist of one and keeps its lenient "not configured" behaviour; setting both forms is
  `GITHUB_REPOS_WITH_LEGACY_PAIR`. Errors carry the code only; the bootstrap preflight prints a remediation hint.
- Per-project repository identity (D2): every remote step — push approval and execution, PR approval and creation, PR
  status, merge approval and execution, main sync, local and remote branch cleanup — resolves the registered project's
  identity from its workspace `origin` fetch **and** push URLs (`apps/quoky/src/workspace-repository-resolver.ts`, read
  under the ADR-0061 sanitized git environment). Only plain `https://github.com/<owner>/<repo>[.git]` URLs that all name
  the same allowlisted repository pass; otherwise the step is refused before any git remote call, hosting call or token
  mint with a fixed reply (`composeRepositoryNotAllowed`: not allowlisted / fetch and push name two repositories /
  not an HTTPS github.com repository) that says nothing ran and no token was issued. Two projects on one repository are
  allowed. An anchored PR identity must still match the freshly resolved one at merge and cleanup approval.
- Core: `repositoryHosting.resolveIdentity?(rootPath)` (optional member of the existing dep; absent keeps the static
  identity path unchanged) and the `WorkspaceRepositoryResolution` domain type.
- Token scoping (D3): `createGitHubAppTokenSources` mints every repository token with `tokenForRepository` for exactly
  the identity of the call, after an allowlist check (non-allowlisted → refused before any installation lookup or mint);
  the installation id is the explicit env id or resolved per repository. The hosting adapter's App token sources now
  receive the call's identity; the App-auth git decorator derives the identity from the operation's remote URLs (a
  non-`origin` remote must name `origin`'s repository) and refuses a non-allowlisted, ambiguous or rewritten remote
  before minting.
- Guards unchanged (D5): `PersonalGitGuard`, `PersonalHostingGuard`, `QUOKY_GIT_MERGE_ENABLED`, main/master refusal and
  the per-step CRITICAL approvals apply per repository as before.
- Docs: quickstart env table, project registration and push/PR notes, troubleshooting row; operator guide 0.3
  ("Only select repositories" = exactly the allowlist, D4); `.env.example`.
- Review fixes (Codex CHANGES_REQUIRED): the actual push remote (upstream included) is checked with `origin` before
  approval and at execution, in every auth mode (dev PAT and no-auth git now run through the same remote-bound
  decorator in ambient-credential mode, dropping inherited `GIT_CONFIG_*` / `GIT_CONFIG_PARAMETERS`); every remote git
  command runs against the validated canonical URL after a synchronous re-check right before the spawn, and an
  `insteadOf`/`pushInsteadOf` rule matching that URL is refused; an explicit `QUOKY_GITHUB_APP_INSTALLATION_ID` is
  verified (repository installation id and account owner, App-JWT lookups) before any mint; Core's refusal copy is
  provider-neutral with an app-supplied operator hint; the push approval binds the resolved repository
  (`pushRepositoryIdentity`) and every later step refuses with `TARGET_CHANGED` when it resolves to another repository.
- Review round 3: the approved repository is passed explicitly into the git provider's push, ls-remote and fetch
  (optional `approvedRepository` port parameter); the git layer builds the canonical URL from it alone and refuses with a
  typed `TARGET_CHANGED` when the workspace re-resolves elsewhere at the final pre-spawn check. Every remote git command
  runs with isolated config (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, no inherited config, helpers reset)
  and refuses a repository `remote.<canonical URL>.*` section or matching `insteadOf`/`pushInsteadOf`. Dev PAT mode now
  supplies the PAT through the one-shot askpass (the owner's credential helper is isolated away). Documented residual:
  a same-user `.git/config` edit between the final check and the spawn is out of scope (owner-only threat model).

## Unreleased — live QA session 3 defects: calendar context, Slack DM filtering, recall floor, read-only ops-UI lookups, labels (2026-10-08) — PR #148

- Calendar (D2, D10): a change or delete that names no day first uses this session's recent calendar context (the event
  just created or changed, or the last list shown, 30 minutes, per session and actor); with none it offers today and
  tomorrow, filtered by any time or title given. An undated reference always gets a numbered choice. A booking keeps the
  whole title ("QA 스윕 회의").
- Slack search (D3, D15): DMs and group DMs are dropped; a result whose conversation type is unknown is left out (fail
  closed). Results are labelled `#channel-name` (cached `conversations.info`); a text-less hit is titled "(내용 없음)".
- Recall (D5): a memory counts as an own-memory hit only when a question topic word appears in it, its raw
  `semanticScore` is at least 0.6 (new structured fields `retrievalMode`, `semanticScore`), or recall was lexical-only.
  Live QA session 4 found the 0.6 floor ineffective for short Korean texts (D5-R, open).
- Operations UI (D6, D7, ADR-0113 D4): the connector panel shows the effective write binding and allow-list counts; the
  approvals list and detail page share one kind label; the snapshot and the confirmation GET use strictly read-only
  lookups and never mutate approval or anchor state.
- Labels and copy (D8, D9, D13): one label per capability in the feedback stats; a shared Korean particle helper that
  handles digits ("#99를"); the "not read" facts give the actual reason, with `INVALID_IMAGE` distinct end to end.

## Unreleased — truthful execution-phrase replies; revoke and execute serialized (2026-10-08) — PR #147

- Bare `실행` / "go" / "run it" while a write is approved quotes the exact phrase for that write and keeps the grant; with
  nothing approved the reply is "이 대화에는 지금 실행할 승인된 작업이 없어요".
- A write phrase asked as a question or a negation (`댓글 실행해도 돼?`, `…하지 마`) gets a deterministic reply about the
  conversation's latest request of that kind in whatever state it is in (sent within 30 minutes, `UNCERTAIN` (never
  expires), `NOT_SENT`, rejected/cancelled/expired/superseded, or approved in another conversation). After a newer
  rejection, an older post is no longer reported as "이미 보냈어요" (live QA D1).
- A `거절`/`취소` after approval marks the approval REJECTED through `ApprovalDecisionService` revoke; execution validation,
  grant consumption and the EXECUTING transition share the approval → session locks, so exactly one of revoke and execute
  wins (D12).
- `PR 머지해줘` with no code chain gets the merge-disabled reply; `<item> 완료` gets the `완료 처리: N` hint when it matches
  one open to-do (D11). Every "nothing sent" phrase is scoped to its request. Golden routing baseline 300 → 335.

## Unreleased — backup set includes the vector store; on-demand backup (2026-10-08) — PR #146

Live-QA follow-ups from the 2026-10-07 restore drill.

- Every backup (daily, weekly, pre-migration, and the new manual kind) also snapshots the vector store
  (`QUOKY_VECTOR_PATH`) next to the DB copy as `quoky-<UTC>-<kind>.vectors/` (dir 700, files 600), with the same
  naming and retention. The snapshot copies each regular `<collection>.json` (atomically replaced by the provider, so
  each read is one complete version) and verifies the copy against a `.snapshot.json` manifest (file list, sizes,
  SHA-256, usable record counts). An absent store is an empty snapshot. A failed snapshot keeps the verified DB copy, is
  recorded as `vectors.outcome: FAILED` and logged (`backup.vectors.failed`), sends no notice and never refuses a start.
- `backup-status.json` gains `lastManual`, `retainedVectors`, a `vectors` record per run (outcome, counts) and
  `lastVerified.vectors`; the service and the manual process each keep the other's fields. The OPS-1 backup panel shows
  the vector snapshot of the last verified copy and the last manual backup.
- `ops/launchd/quokyctl.sh backup` (dry-run by default) / `backup --apply` / `backup --verify <copy>.db`: an on-demand,
  verified `manual` copy + vector snapshot while the service runs (no restart), and a read-only restore drill. A
  separate short-lived process (`apps/quoky/dist/tools/backup-now.js`) runs `VACUUM INTO` from a read-only connection
  (WAL: the service's ordinary commits continue; checkpoints may be delayed until the copy ends) with the same partial →
  verify → rename flow. Neither `quokyctl.sh backup` nor the tool reads `.env.local`: the launchd service publishes its
  effective, non-secret backup configuration at start (`<data dir>/ops/backup-config.json`, private-file writer), the
  tool reads it with the private-file checks and falls back to the defaults with a notice when it is missing, invalid
  or for another database. Every backup run (scheduled, pre-migration, manual) holds `backups/.backup-lock.db`, an
  OS-held SQLite exclusive lock (`locking_mode=EXCLUSIVE`, `BEGIN EXCLUSIVE`, `busy_timeout=0`) that the kernel releases
  when the holder dies; only SQLite opens the lock file, a second acquire in the holding process returns at once, and
  the backup directory must be a real, 700, owner-owned directory. A held lock means `BACKUP_IN_PROGRESS` (manual: exit
  3; daily: retried at the next poll; pre-migration: polls up to 10 minutes, then exit 78). The 5 newest manual copies
  are kept.
  `--verify` works with no live DB.
- Partial names are claimed exclusively (mode 600 from creation). Only the service prunes its own kinds' partials at any
  age; every other partial (including another manual run's) is pruned only once it is stale (15 minutes).
- `backup-status.json` (best-effort, advisory telemetry) is now written through the private-file writer (real 700
  directory, random `O_CREAT | O_EXCL | O_NOFOLLOW` temp file, fsync, rename); a symlinked backup directory, snapshot
  root or DB copy is refused. The restore runbook verifies first and copies with `cp -P` / `cp -RPp` after a
  real-directory check.
- Restore runbook (quickstart section 7, operator guide): restore the DB copy and its same-named vector snapshot
  together; for a copy without one, move `vectors/` aside and let semantic recall rebuild lazily (lexical ranking until
  re-embedded, at most 4 per turn; a vector is used only when its memory id and content hash match).
- `@quoky/vector-local`: `writeVerifiedVectorSnapshot`, `verifyVectorSnapshot`, `inspectVectorStore` (format helpers
  shared with the provider); `@quoky/storage-sqlite`: `verifySqliteBackupFile` (read-only re-check of a copy).

## Unreleased — Discord table rendering for model replies only (ADR-0111 amendment, 2026-10-08) — PR #145

- Core: `OutboundMessage.format?: 'model-reply'`, set by the runtime only on a provider's own answer (chat, summaries,
  analyses, image readings); withheld or guard-replaced notices and every deterministic reply stay unflagged.
- Discord: a flagged reply's simple Markdown tables become a bold header line plus `- col: value, …` lines, only when the
  reply contains no ``` / ~~~ anywhere and no `>` quote line (otherwise the whole reply is untouched); list items,
  indented lines and malformed tables are never converted. Unflagged text — previews, approvals, connector-write
  previews, diffs, reminders — is delivered byte-identical.

## Unreleased — Codex as an image-understanding option (ADR-0111 amendment, 2026-10-08) — PR #145

- `QUOKY_IMAGE_UNDERSTANDING_PROVIDER=codex`, `이미지 모델 변경: codex` / `/model image codex` and the `/providers` option
  `image:codex`: the Codex CLI reads attached images (cloud, OpenAI) with the chat tier's `QUOKY_CODEX_MODEL`.
- New `CodexCliVisionProvider` (`codex-vision-cli`, `REMOTE`, `IMAGE_UNDERSTANDING` only): the Codex chat isolation and
  fail-closed event-stream check (now shared helpers), each canonical image copied into a fresh empty temp cwd and passed
  as `--image`, prompt on stdin, fixed failure reasons, counts-and-hashes audit.
- The image locality policy opens `REMOTE` for `codex` exactly as for `claude` (only while it is the effective image
  choice); dispatch-time re-check, synchronous eligibility check and write fence unchanged.

## Unreleased — semantic recall warm model and provider readiness after boot (2026-10-08) — PR #144

- The Ollama embedding provider runs `ollama run --keepalive 30m` and loads the model in the background (fixed
  `warm-up` text, 30 s bound) on its first ready probe, after Ollama comes back, and after a timed-out call. A call cut
  off by the 3 s recall budget cancelled its own model load, so recall could fall back to lexical on every turn
  (`reason=TIMEOUT … latencyMs=3001`). The per-turn budget and per-call timeout are unchanged.
- Provider readiness: a "not ready" answer is re-probed by the next request that needs the provider once 30/60/120 s
  (cap) have passed (no polling timer), and the re-probe costs a turn at most 0.5 s; a provider that was not ready at
  boot becomes usable without a restart and logs `provider became ready` once. A probe in flight across an
  invalidation is discarded (per-provider generation), so it never overwrites a newer answer.
  Selecting one capability probes only providers that advertise it. `timed out waiting for server to start` from the
  Ollama CLI is classified `UNAVAILABLE`.

## Unreleased — runtime model switching live QA follow-ups (2026-10-07) — PR #143

- `모델 목록` and the `/providers` form list only chat-capable Ollama models (`ollama show` capabilities, cached per
  model and `ID`); an embedding-only model such as `nomic-embed-text` is left out and refused if named
  (`OLLAMA_MODEL_NOT_CHAT`). Without a readable `ollama show`, only names containing `embed` are left out.
- With image analysis explicitly `off`, an image reply says image analysis is off (in this conversation or by default)
  and how to turn it back on; nothing is sent. The derived `off` keeps the "not available" reply.
- Discord image intake trusts the downloaded signature over the declared MIME (aliases, `application/octet-stream`,
  another raster type or none with an image extension are candidates), re-downloads once when the body is not a valid
  image, and logs one content-free `attachment refused` line per refused file.
- Every image is structurally validated and canonicalized (PNG chunks + CRC + re-deflated data, JPEG segments, WebP
  RIFF chunks) before it is written; metadata and text chunks are dropped, trailing bytes and malformed files are
  refused, and only the canonical bytes reach a vision provider.

## Unreleased — runtime model switching: operations-UI default and `/model` per conversation (ADR-0092/ADR-0111 amendments, 2026-10-07) — PR #142

- Chat tier (chat, summaries, document analysis, read-only lookups) and image understanding switch without a restart.
  Precedence per tier: session override → operations-UI default (`<db dir>/ops/provider-selection.json`, 0600, no
  migration) → `QUOKY_CHAT_PROVIDER` / `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` → derived default. Code, review, planning,
  tests and policy-sensitive chat stay on Claude.
- Core: new `ProviderSelectionPolicy` port; `CapabilityRouter` applies its eligible keys/order as data (no provider-id
  branching, source-scanned); `ProviderSelector.select` takes an optional `{ sessionId }`; the image locality policy can
  be a per-turn resolver (REMOTE only while the effective image choice is `claude`); `SessionManager.updateMetadataEntry`
  (field-scoped, under the session write lock); provider-free `parseModelSelectionCommand`.
- Registration: Claude always; Codex when its CLI is present; Ollama chat when `OLLAMA_MODEL` is set and the CLI is
  present; Claude and Ollama vision when configured. Claude aliases (`sonnet`/`opus`/`haiku`) and local `ollama list`
  models run on bounded on-demand chat-tier-only instances.
- Chat: `모델 상태`, `모델 목록`, `모델 변경: codex|N`, `/model claude:opus`, `이미지 모델 변경: off`, `모델 기본값으로`
  (owner-only, this conversation only, handler `model-selection` at pre-classify 70).
- Operations UI: providers panel shows the effective defaults and sources; `/providers` changes or resets them (session,
  CSRF, one-time nonce, same-origin; owner DM `OPS_DECISION_RESULT`; `provider.selection.changed` audit line).
- Help: the two feedback lines are one line, so the help budget stays 14 lines. ARCHITECTURE.md §2 principle 1 widened
  (owner-approved).

## Unreleased — selectable chat provider: Claude, Codex or Ollama (ADR-0092 amendment, 2026-10-07) — PR #141

- `QUOKY_CHAT_PROVIDER` = `claude` | `codex` | `ollama` picks the chat-tier provider registered next to Claude. Unset
  derives from `QUOKY_OLLAMA_ENABLED` as before; a contradicting pair lets the selector win with the startup warning
  `CHAT_PROVIDER_OVERRIDES_OLLAMA_ENABLED`. New startup errors `CHAT_PROVIDER_INVALID`, `CODEX_MODEL_INVALID`.
- `CodexCliProvider` is real when selected: `GENERAL_CHAT`, `SUMMARIZATION`, `DOCUMENT_ANALYSIS`, `READONLY_LOOKUP`
  only (priority 100, `REMOTE`); code, review and policy-sensitive chat stay on Claude. Isolated, read-only, stdin-only
  `codex exec --json` in an empty temp cwd; readiness via `codex login status`; optional `QUOKY_CODEX_MODEL`.
- The ops UI provider panel shows the selector value and its source. Docs: quickstart section 4, operator guide 0.2/0.4a,
  `.env.example`.

## Unreleased — selectable image-understanding provider; Claude only on explicit selection (ADR-0111 amendment, 2026-10-07) — PR #140

- `QUOKY_IMAGE_UNDERSTANDING_PROVIDER` = `ollama` | `claude` | `off` (exact, else `IMAGE_UNDERSTANDING_PROVIDER_INVALID`;
  `codex` added in #145). Unset keeps the earlier behaviour (`ollama` when `QUOKY_OLLAMA_VISION_MODEL` is set, else
  `off`). For `claude` the model is `QUOKY_IMAGE_UNDERSTANDING_MODEL`, then `QUOKY_CLAUDE_MODEL`, then `sonnet`.
- New `ClaudeCliVisionProvider` (`REMOTE`, `IMAGE_UNDERSTANDING` only): chat isolation flags plus `--tools ""`, image as a
  base64 block over stream-json on stdin, byte-typed, 8 MiB / 3 images / 120 s, readiness `claude auth status --json`;
  image path and bytes never in argv, logs, errors or the audit.
- Core allows `REMOTE` image providers only while `claude` is selected (by capability and locality, never provider id).
  The reply credential check runs on every image turn and captions are credential-checked before egress. Residual: a
  secret visible inside an image cannot be detected before it is sent.

## Unreleased — live QA session 2 record (2026-10-07) — PR #139

- Docs only: `docs/uat/personal-v3-qa-record.md` session 2 (W6-L01..L11), W6-A2 UI approve PARTIAL PASS, updated
  pending lists in `CURRENT_STATE.md` and the operator guide.

## Unreleased — text attachments reach the chat prompt; hardened credential guards (2026-10-07) — PR #138

- Text attachments become `ContextBundle.currentAttachments` (current message only, never persisted or logged), rendered
  as an untrusted-data section, budgeted at 2,000 characters per message (head and tail; image turns too). Live QA
  W6-L07: the log had never reached the chat prompt.
- With every attachment refused and an empty message, a fixed reply with no provider call; otherwise the prompt carries
  a "this file was not read; never guess" fact.
- The credential guard runs on the exact outgoing text; a credential-like file name becomes `attachment-N.<ext>`; the
  shared detector also matches a view with format, ignorable and control characters stripped and NFKC applied until
  stable (zero-width, bidi, CR, NFD-jamo splits). On attachment turns the provider reply and every artifact field are
  checked first; a match withholds the whole reply.

## Unreleased — git concept questions are never captured by code-chain word checks (2026-10-07) — PR #137

- `git rebase와 merge 차이를 …` reaches chat even with a chain parked at `PR_CREATED` (W6-L06); explicit learning, memory,
  to-do and reminder commands are never hijacked by chain word checks (W6-L11, `담당자`). Git request detectors and
  companion replies need a request shape; Korean word boundaries allow particles. `EXECUTION_PHRASES` and every
  pending-approval intercept are unchanged. Golden routing 232 → 279.

## Unreleased — reactions on replies posted before the last restart are counted (2026-10-07) — PR #136

- An uncached partial target is admitted on owner and location only (no fetch, no content); core records the reaction
  only when the target id is one of the bot's own sent messages and the reactor is that turn's user (W6-L10).

## Unreleased — execution phrase in another conversation points to the waiting approval (2026-10-07) — PR #135

- An execution phrase with nothing approved in this session names an approved, unexpired write of that kind waiting in
  another conversation and where to send the phrase; no payload text, no provider call. "Already sent" applies only to a
  write approved in the same session and sent within 30 minutes, with time and target. The operations-UI decision DM
  says which conversation to send the phrase in (W6-L01).

## Quoky Personal v3 — waves 1-6 — 2026-10-07

Merged through PRs #116-#132 (2026-10-06/07). Wave 6 closes with INT-2 (offline v3 acceptance) and DOC-C (this
documentation closeout). Spec: ADR-0102..0113 (ratified 2026-10-06), the ADR-0106 amendment (archive), the ADR-0110
amendment (calendar writes) and the ADR-0096 D6 amendment (help 14 lines); plan `docs/plans/personal-v3-plan.md`; live QA
record `docs/uat/personal-v3-qa-record.md`. Setup: `docs/user/quickstart.md` and `docs/uat/operator-guide.md` Part 0.

**By wave**

| Wave | PR | Content |
|---|---|---|
| 1 | #116, #117, #118 | ADR-0102..0112 and ADR-0113 ratified; launchd always-on runtime pieces (SUB-1); internal-action claim guard and code-chain status replies (DET-1); chat hygiene and help-intent handler (LLM-1) |
| 2 | #119, #120, #121 | Memory commands (MEM-1); learning store, schema v14 (LRN-1); PR title/body bound by hash (CODE-7); verified backup and `OPS_NOTICE` (SUB-2); bounded network git timeouts (W2-L02); forget = archive with restore and history purge (ADR-0106 amendment, W2-L01) |
| 3 | #122, #123 | LOCAL-only curated examples (LRN-2); Google Calendar reader and consent helper (CAL-1); Discord attachment intake (MM-1); read-only operations UI (OPS-1); harness helpfulness checks; reminders release default `true`; truthful "기억에 없어요" (W3-L01) |
| 4 | #124-#127 | ADR-0110 calendar-writes amendment; connector write ports, schema v15 receipts (CWR-1); calendar schedule handler (CAL-2, W4-L01/L02 fixes); local image understanding (MM-2); UI reminder cancel and memory forget (OPS-2) |
| 5 | #128-#130 | Chat approval flow for Jira, Slack and calendar writes (CWR-2); offline learning report (LRN-3); help budget 14 lines; W5-L01..L04 copy fixes |
| 6 | #131, #132 | Operations UI sign-in Origin fix (`Referrer-Policy: same-origin`); UI approve/reject through a shared `ApprovalDecisionService` with serialized approval and session writes (OPS-2b); INT-2 and DOC-C |

**User-visible changes**

- Always-on service on the owner's Mac (`ops/launchd/quokyctl.sh install|status|restart|uninstall`, `--dry-run` or
  `--apply`), daily verified backups and an owner-DM health notice.
- A chat reply that claims a Quoky action that did not happen is replaced by a notice and the command to use; how-to
  questions get the matching help lines; own-memory questions with no recall get "그 내용은 기억에 없어요".
- Memory: `기억 목록`, `기억 N 보여줘`, `기억 N 수정: …`, `기억 N 잊어줘`, `보관함`, `기억 복원 N`, `기억 완전 삭제 N`
  (each change confirmed with `기억 확인 <코드>`).
- Learning: `피드백 후보`, `후보 N 메모: …`, `후보 N 예시로 저장`, `예시 목록`, `예시 N 수정: …`, `예시 N 삭제`; a 👎-rate
  trend in `피드백 요약`.
- Calendar: `오늘 일정`, `이번 주 일정`, `다음 회의 언제야?`, `내일 바빠?`; with writes on, `내일 오후 3시에 회의 잡아줘 …`,
  move and cancel, each through `승인` and `일정 추가/변경/삭제 실행`.
- Connector writes: `KEY-1에 댓글: …` → `승인` → `댓글 실행`; `KEY-1 진행 중으로 바꿔줘` → `승인` → `상태 변경 실행`;
  `#채널에 게시: …` → `승인` → `Slack 게시 실행`. Exact payload preview, one-time hash-bound CRITICAL approval, no retry of
  an uncertain send, duplicate-send guard.
- Attachments: text files as context; images only to a local vision model, otherwise a truthful "not analysed" reply.
- PR title = commit subject; deterministic PR body.
- Local operations UI (`http://127.0.0.1:47613/`, off by default): status panels, reminder cancel, memory forget,
  approve/reject with the chat confirmation code; results go to the owner DM.
- Schema migrations v14 (`learning_items`) and v15 (`connector_write_receipts`, no payload text), additive.

**Live QA fixes (details in the QA record):** W1-L01..L03 (help/how-to routing, memory claim), W2-L01 (forgotten text
still in history), W2-L02 (5 s push timeout), W3-L01 (invented personal fact), W4-L01/L02 (calendar phrasing),
W5-L01..L04 (write-flow copy), W6-L01 (operations UI sign-in Origin).

**Environment variables added in v3** (boolean flags are exact `true`/`false`; see `.env.example`)

| Variable | Default | Notes |
|---|---|---|
| `QUOKY_DISCORD_EXPECTED_BOT_ID` | unset | Required under the launchd launcher (startup identity check) |
| `QUOKY_BACKUP_ENABLED`, `QUOKY_BACKUP_DIR` | on under launchd / `<db dir>/backups` | Absolute directory only |
| `QUOKY_MEMORY_ARCHIVE_DAYS` | `7` | 0-365; `0` deletes at once; invalid is `MEMORY_ARCHIVE_DAYS_INVALID` |
| `QUOKY_LEARNING_EXAMPLES_ENABLED` | `false` | Examples reach `LOCAL` providers only |
| `QUOKY_OLLAMA_VISION_MODEL` | unset | Local vision model; invalid or cloud-served disables only image understanding |
| `QUOKY_CALENDAR_GOOGLE_CLIENT_ID`, `QUOKY_CALENDAR_GOOGLE_CLIENT_SECRET`, `QUOKY_CALENDAR_GOOGLE_TOKEN_FILE` / `QUOKY_CALENDAR_GOOGLE_REFRESH_TOKEN`, `QUOKY_CALENDAR_GOOGLE_CALENDAR_IDS` | unset; `primary` | Calendar is registered only when the group is complete |
| `QUOKY_CALENDAR_WRITE_ENABLED` | `false` | Primary calendar only; needs a `calendar.events` grant |
| `QUOKY_CONNECTOR_WRITES_ENABLED` | `false` | Jira and Slack writes |
| `QUOKY_CONNECTOR_WRITE_JIRA_PROJECTS` | empty | Project keys, at most 50 |
| `QUOKY_CONNECTOR_WRITE_SLACK_TOKEN`, `QUOKY_CONNECTOR_WRITE_SLACK_CHANNELS` | unset | Bot token with `chat:write`, separate from the read token; `name:ID` entries |
| `QUOKY_OPS_UI_ENABLED`, `QUOKY_OPS_UI_PORT` | `false`, `47613` | An invalid value disables only the UI |

Changed default: `QUOKY_REMINDERS_ENABLED` is now `true`. `OLLAMA_MODEL` keeps its code default (`llama3.1`); the owner's
service was switched to `granite3.3:8b` on 2026-10-07 as an operator change.

**Fixed after closeout review:** local-model replies were hard-wrapped mid-word by `ollama run`; Ollama now runs with `--nowordwrap` (PR #133).

**Not live-verified:** the 20-prompt Korean daily-chat set on granite3.3:8b (W6-M5 partial pass), UI approve/reject and UI cancel/forget, attachments and images,
learning notes/examples, a mid-send write failure, W5-L01..L04 re-run, reboot/daily backup/restore drill, Slack read
lookups. Not implemented: SUB-3, CODE-8, CODE-9 (P2, deferred), LLM-3 (MLX), LRN-4. See `CURRENT_STATE.md`.

## Quoky Personal v2 — waves 1-8 — 2026-10-03

Waves 1-7 are merged through PRs #105-#111 (2026-10-02/03). Wave 8 is INT-1 (offline integration acceptance) plus DOC-B (this
documentation closeout) and lands in the wave-8 PR. Spec: ADR-0096..0101 and the ADR-0098 amendment;
plan `docs/plans/personal-v2-execution-plan.md`; live QA record `docs/uat/personal-v2-qa-record.md`. Operator setup:
`docs/uat/operator-guide.md`. Phrases: `docs/user/quickstart.md`.

**By wave**

| Wave | PR | Content |
|---|---|---|
| 1 | #105 | ADR-0096..0101 ratified; turn-handler registry and inert v2 config (SEAM); strict credential guard superset (OVR-1); 5-file change-set apply (CODE-1) |
| 2 | #106 | Hash-bound override grants (OVR-2); chat response policy and sanitizer (QUAL-1); feedback store, schema v12 (QUAL-3); branch git ops and branch-name policy (CODE-2); read-only connector named queries (WORK-T1); single-file write containment (SEC-1) |
| 3 | #107 | Override flow on an anchor Task (OVR-3); WorkItem title and correlate (WORK-T2); reminder domain and KO/EN grammar (PRO-1); golden evaluation corpora (QUAL-2); multi-file change sets in the runtime (CODE-3) |
| 4 | #108 | `그래도 보내줘` override wired into the preview (OVR-4); `POLICY_SENSITIVE_CHAT` routing and action-claim guard (QUAL-6, ADR-0098 amendment); Claude CLI isolation; work-chat services (WORK-T3); reminders store, schema v13 (PRO-2); reminder services (PRO-3); owner-only Discord notification sink (PRO-4) |
| 5 | #109 | Reminder turn handler and tick driver (PRO-5); 👍/👎 reaction feedback and `피드백 요약` (QUAL-4); branch create/switch handler (CODE-4); docs closeout for waves 1-4 (DOC-A) |
| 6 | #110 | Work-chat to-do and lookup handlers with self-contained summaries (WORK-T4); opt-in local embedding recall (QUAL-5); personal-data question routing (QUAL-7, extension of the ADR-0098 amendment); late-reminder label and Korean feedback labels (UX-1) |
| 7 | #111 | Work chat composed in the app (WORK-T5); opt-in push to PR chain with merge off (CODE-5); override failure copy by actual transmission state; live-QA fixes (see below) |
| 8 | wave-8 PR | INT-1 offline integration acceptance and golden routing ratchet; DOC-B documentation |

**User-visible changes**

- Credential-guard override: when a code-change preview is refused because a target file looks like it assigns a
  credential, Quoky warns (file and line, one-time external send, 30-minute limit) and the owner can reply
  `그래도 보내줘` (also `그래도 보내`, `그래도 전송해줘`, `send anyway`) to send that file once. `승인` is not a grant.
  Never overridable: secret-looking filenames and token-shaped content. Each refused file in a set needs its own
  override; a reset, denial, expiry, changed file or newer request cancels it; no replay. Resolves QA-023. After a failed
  generation the reply says whether the file content was not sent, sent, or may have been sent.
- The credential file-content guard only got stricter (multiline and concatenated values, continuation lines, env
  defaults, literal wrappers, string prefixes, arrow bodies, Go/C#/PHP forms). The multiline residual is closed.
- Chat answer policy: Quoky no longer claims to perform external actions, refuses prompt-injection requests and
  answers in the user's language. Those requests, non-Korean/English messages and questions about the owner's own
  schedule, calendar, availability, inbox or balance are routed to Claude (the local model did not follow the policy
  or fabricated facts); a reply that still claims an unsupported action is replaced by a notice that nothing was done.
  This uses the Claude subscription for those turns.
- Reminders (`QUOKY_REMINDERS_ENABLED=true`): `N분 뒤에 …`, `내일 오전 9시에 … 알려줘`, daily recurrence, `알림 목록`,
  `알림 N 취소`. DM delivery by default, bounded 15-second tick, late delivery labelled, at-most-once delivery
  (`DELIVERY_UNCERTAIN` is never retried).
- Feedback: 👍/👎 reactions on bot replies (owner only) are recorded with no message text; `피드백 요약` shows 30-day
  counts with Korean labels.
- Work chat: `할 일 추가:`, `완료 처리:`, `할 일 취소:`, `할 일 연결:`, `내 할 일 보여줘`, and read-only Jira/GitHub/Slack/
  Confluence lookups with optional summaries. A to-do whose text has a time phrase stays a to-do (and says no reminder was
  set). A natural completion phrase only gets a hint of the exact command; a status question is answered from the
  to-do store.
- Code flow: up to 5 files per request (update existing; create new with explicit create wording); apply rolls back on
  failure; new files can be committed; `브랜치 만들어줘 feature/x` creates and `feature/x 브랜치로 전환해줘` switches a
  local branch. With `QUOKY_GIT_REMOTE_ENABLED=true`: `푸시해줘` (CRITICAL approval) then `푸시 실행`, `PR 만들어줘`
  (CRITICAL approval) then `PR 생성 실행`. The first push of a new branch goes to `HEAD:refs/heads/<branch>`; an upstream
  that targets `main`/`master` is refused. Merge stays off unless `QUOKY_GIT_MERGE_ENABLED=true`.
- Claude CLI runs are isolated from the owner's claude.ai connectors, settings and session history
  (`--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`).
- Schema migrations v12 (feedback tables, no text columns) and v13 (reminders), additive, applied automatically on
  start. A database newer than the code now fails startup (`SCHEMA_VERSION_AHEAD`).

**Live QA fixes (found by owner-attended QA on the dev bot; details in the QA record)**

- QA-V2-W7-01 (BLOCKER, security-relevant): the system git `credential.helper` (macOS `osxkeychain`) answered before
  `GIT_ASKPASS`. The App-token git child now resets credential helpers and drops inherited `GIT_CONFIG_*`; remote URLs
  are preflighted under the same sanitized environment (HTTPS github.com only, fetch/push URL checked per operation).
- QA-V2-002 Claude connector leakage (isolation flags), QA-V2-005 fabricated schedule answer (personal-data routing),
  QA-V2-006/007 (late label, Korean labels), QA-V2-W7-02..05 (push phrases after PR, to-do completion hint and status,
  reminder-less to-do hint).

**Environment variables** (exact `true`/`false`; an empty value is a startup error; see `.env.example`)

| Variable | Default | Status |
|---|---|---|
| `QUOKY_GIT_MERGE_ENABLED` | `false` | requires `QUOKY_GIT_REMOTE_ENABLED=true` (else `GIT_MERGE_REQUIRES_REMOTE`); merge still needs its own approval steps |
| `QUOKY_WORK_SUMMARY_ENABLED` | `true` | consumed by work-chat summaries |
| `QUOKY_REMINDERS_ENABLED` | `false` | consumed (handler, tick driver); the release default stays `false` until the reminders UAT |
| `QUOKY_REMINDERS_CHANNEL_DELIVERY` | `false` | DM only by default; `true` lets channel members read reminder text |
| `QUOKY_TIMEZONE` | `Asia/Seoul` | IANA zone; invalid is a startup error |
| `QUOKY_EMBEDDING_ENABLED` | `false` | consumed by recall; local Ollama embedding only |
| `QUOKY_EMBEDDING_MODEL` | `nomic-embed-text` | local model only; a name or tag containing `cloud` is refused |
| `QUOKY_EMBEDDING_TIMEOUT_MS` | `3000` | 100-30000 |

**Not live-verified:** connector lookups on real tenants, reminders channel delivery, the reminders release default,
merge-flag enablement and embedding recall on a live model. See `CURRENT_STATE.md` and the QA record.

## Quoky Personal v1 — Live UAT hotfixes — 2026-10-02

Found by the attended Live UAT (`docs/uat/first-release-uat-result-2026-10-02.md`).

**Fixed**
- Every live AI turn failed: the composition root captured `storage.taskRuns` before `storage.init()` (regression since R3).
- Claude CLI ran "Not logged in": `USER` is now forwarded to the child (macOS Keychain login); stdout auth errors map to the login hint.
- Code-change preview now sends the target file's current content (`contextFiles`) and treats an empty proposal as a failure.
- Memory: `기억해:` refuses passwords/keys/tokens (write gate + read-time exclusion); empty `기억해:` shows a usage hint.
- Code preview refuses files whose content or name looks like credentials; never sends them to the AI.
- With nothing pending, "승인/거절/취소" gets a deterministic reply (no fabricated approval).
- Korean risk label instead of internal English reasons; path-specific replies for relative registration and rejected targets;
  accurate push/commit copy; "커밋 실행" named after commit approval; `main`/`master` commit refused up front.
- Help/quickstart: prefer `도움말`/`새 대화` (Discord's slash picker intercepts `/help`); Ollama context/model-tag troubleshooting.

## Quoky Personal v1 — first release (waves 1-3) — 2026-10-02

First product release for daily single-owner use (ADR-0091..0094 + ADR-0073 amendment). Setup:
[docs/user/quickstart.md](docs/user/quickstart.md). Attended Live UAT (AC12; ROADMAP criterion 9): `docs/uat/first-release-uat-packet.md`
(NOT EXECUTED; requires separate Strict Product Owner approval).

**User-visible changes**

- Discord entry is owner-only: only `QUOKY_DISCORD_OWNER_IDS` users are served, in `QUOKY_DISCORD_CHANNEL_IDS` channels
  (and their threads) or owner DMs; no @mention needed; anyone else is silently ignored. Startup fails closed without
  owner ids. Adapter now requests the DM intent and Channel partial.
- Everyday chat prefers a ready local Ollama (daemon answering and `OLLAMA_MODEL` present; opt out with
  `QUOKY_OLLAMA_ENABLED=false`) and falls back to Claude; Claude CLI receives `--model` (`QUOKY_CLAUDE_MODEL`, default
  `sonnet`) and an adapter-owned capability-based `--effort`. Provider availability is cached ~30s; a distinct
  Korean "AI가 아직 설정되지 않았어요…" reply (`NO_PROVIDER_USER_MESSAGE`) when no provider is ready.
- Startup preflight: blank-token fail-fast, secret-free remediation hints for configuration errors, provider readiness
  lines, resolved database path, and the `started (Quoky Personal v1)` banner. Relative DB/vector paths resolve against the
  repository root.
- Durable memory (`기억해: ...`) is recalled for the same owner across channels, DMs and `새 대화` (ADR-0073 amendment).
- `도움말` / `/help` and `새 대화` / `/reset` work in every state; a pending approval expires after 30 minutes and
  otherwise captures turns with a reminder (ADR-0093). `새 대화` also drops the active project binding.
- Approval decisions are whole-token and negation-aware: `진행하지 마` never approves; questions and hedges re-prompt. Approve is the narrow case: an approve word plus any further content (`진행 상황 알려줘`, `ok but only src/a.ts`, `진행 싫어`) re-prompts and the approval stays pending; `진행 멈춰` cancels.
- With `QUOKY_GIT_REMOTE_ENABLED=false` the REST PR/merge/remote-branch-cleanup routes are also unreachable (no hosting manager is composed). A reset can no longer be undone by a turn that was still running (a closed Session stays closed). After a provider execution fails UNAVAILABLE its cached readiness is dropped so the next turn re-routes.
- Intent routing precision: a bare code/test keyword without a project or file path stays everyday chat; negated or
  descriptive test requests do not run tests. Apply-flow copy names the real next step (`패치 만들어줘`, `패치 적용해줘`,
  `테스트 실행해줘`).
- Remote git is off by default (`QUOKY_GIT_REMOTE_ENABLED=false`): push/remote read/main sync/branch cleanup are
  refused before any git process or credential; commits on `main`/`master` or a detached HEAD are always refused
  (ADR-0094).
- Long replies split without breaking Markdown code fences.
- `QUOKY_ACTOR_IDENTITY_MAPPINGS` entries whose Actor does not exist yet are skipped with a warning instead of
  failing startup.

**New environment variables**: `QUOKY_DISCORD_OWNER_IDS` (required), `QUOKY_DISCORD_CHANNEL_IDS`,
`QUOKY_OLLAMA_ENABLED` (default `true`), `QUOKY_CLAUDE_MODEL` (default `sonnet`), `QUOKY_GIT_REMOTE_ENABLED`
(default `false`), `QUOKY_CONTEXT_MAX_TOKENS` (default `6000`, max `200000`).

**Wave 3 (this entry)**: offline composed acceptance `apps/quoky/src/first-release-acceptance.test.ts`; README
"Getting started", `docs/user/quickstart.md`, `docs/uat/first-release-uat-packet.md`; corrected stale
missing-Actor wording in `docs/capabilities/work-surface.md`. No source behavior change.

## R3-B3-2C trust-root feasibility & deployment-binding architecture (docs only, read-only discovery) — 2026-09-29

- Add the ADR-0090 amendment "R3-B3-2C trust-root feasibility & deployment-binding architecture (read-only
  discovery)" to `DECISIONS.md`. Read-only repository/config/docs inspection (no containers run, no live
  runtime inspected, no cloud/provider API contacted) found: no deployment artifacts of any kind (no
  Dockerfile/compose, K8s/Helm/Terraform, `.github` CI, deploy/infra/ops dirs, ECS/Fargate/systemd) and no
  cloud workload identity / SPIFFE-SVID / IMDS / projected serviceaccount token / TPM/TEE/vTPM / external
  attestation integration in Core or adapters; containment runtime families are abstract tokens
  (`NONE`/`CONTAINER_NO_NETWORK`/`VM_NO_NIC`); the only substrate evidence is a local macOS host with
  OrbStack installed but network isolation unverified (prior 5C-EG probe).
- Decisions: `DEPLOYMENT_SUBSTRATE = UNRESOLVED`; `REAL_TRUST_ROOT = NO_FEASIBLE_REAL_TRUST_ROOT_YET` (no
  candidate is both available and independently trustworthy; OrbStack via Docker/orb CLI requires
  runtime-mutation authority and is not an independent root); `CHANNEL_A_REAL_SOURCE = UNAVAILABLE`;
  `CHANNEL_B_REAL_SOURCE = UNAVAILABLE` (no TEE/hardware-bound or independently-injected in-instance identity
  inaccessible to workload code, so R3-B3-2C implementation is NOT READY); A/B independence unsatisfiable
  today. No trust root was invented to force eligibility.
- Restate the control-plane separation invariant (Quoky must not hold mutation/admin authority over the
  control plane it treats as attested); record the observable fact matrix (every required production fact has
  an expected value but no credible observation source; app-owned imageDigest and app-readable model files
  insufficient; configured policy != observed enforcement; egress-allowlist-runner harness must not become a
  root of trust); record challenge-binding compatibility (native attestations that cannot carry a nonce must
  be wrapped so 2A anti-replay binding is not dropped); keep freshness `CALIBRATION_REQUIRED` with a
  measurement plan; disposition 2B carry-forwards across 2C and 2D.
- **2C IMPLEMENTATION ELIGIBILITY = NOT ELIGIBLE** (real root / Channel A / Channel B / deployment substrate
  unresolved; no partial read-only adapter sub-slice justified without a target substrate). Record deployment
  prerequisites P1..P7 (choose canonical substrate; provision independent Channel B identity; expose signed
  instance/image/runtime metadata; create verification-only root/CA bundle; define immutable model artifact
  identity; define externally observable egress posture; confirm A/B independence + control-plane
  separation), all infrastructure-owned except model/egress shapes. R3-B3-2D NOT ELIGIBLE; Live Gate NOT
  AUTHORIZED; R3-C2B-2 kept independent; R3-C-Rz NOT AUTHORIZED.
- Documentation only: no source, test, schema, runtime, container, provider, network, secret, or DB changes.
  One local architecture commit; no Push/PR/Merge. ADR-0090 remains Proposed; independent Claude Architecture
  Review required before any next step. PRODUCTION TRUST = FAIL CLOSED; USABLE PRODUCTION CAPABILITY =
  UNAVAILABLE.

## R3-B3-2B fail-closed trust/binding plumbing (local; delivery pending) — 2026-09-29

- Bind TEST trust issuance to exact process-local attestation set, challenge, verified containment binding,
  issued instance, run, and provider identities; freeze retained evidence and records. Structural and
  serialized copies cannot recover authority. Production trust and capability issuance still fail closed.
- Require FAKE execution to consume its issued capability once, pass dispatch commit, and consume an exact
  one-shot effect gate. Failed commits issue no gate and permit no retry. Keep dispatch commit as the only
  durable execution linearization point.
- Distinguish attestation provider mismatch from routing errors and reject self-declared production trust
  with a precise code. Update focused tests and preserve 2C/2D, Live Gate, and R3-C-Rz boundaries.

## R3-B3-2A attestation contracts (local; delivery pending) — 2026-09-29

- Add process-local issued, one-time challenges and deterministic attestation-set identity bound to the exact
  run, provider binding, and containment binding. Structural or serialized reconstruction does not restore
  issuance authority. Fixed Channel A/B roles and closed role-specific TEST source kinds reject swaps and
  mismatched challenge/set/binding facts.
- Add TEST-only simulated evidence with expected-versus-simulated-observed fields, signer/verifier labels,
  deterministic integrity identity, and audit-only source timestamp. Quoky's monotonic clock controls the
  challenge round trip and separate post-receipt validity; both production numeric bounds require calibration.
  The unavailable production verifier reports `UNAVAILABLE` rather than `TEST`.
- Production trust and capability issuance remain fail-closed. No real trust root, runtime inspection,
  Provider execution, production activation, or R3-B3-2B/C/D implementation. Delivery remains pending.

## R3-B3-2 remediation — challenge-bound attestation, mandatory independence, safe decomposition (docs only) — 2026-09-29

- Add the ADR-0090 amendment "R3-B3-2 remediation (challenge-bound attestation, mandatory independence, safe
  decomposition)" to `DECISIONS.md`, closing the accepted CHANGES_REQUIRED blockers B-1..B-4 against the
  reviewed R3-B3-2 architecture amendment. The reviewed commit
  `0c47756ca99f093ba4dc01c8a4d9b489761e245d` is preserved unamended; exactly one remediation commit is added
  atop it (lineage `2a57161…` → `0c47756…` → remediation). `REAL_TRUST_ROOT = NO_FEASIBLE_REAL_TRUST_ROOT_YET`;
  PRODUCTION TRUST = FAIL CLOSED; REAL PRODUCTION CONTAINED EXECUTION = UNREACHABLE.
- B-1 (freshness/clock): remove comparing an external verifier's monotonic timestamp with Quoky's monotonic
  clock (incomparable origins). Freshness is challenge-bound: Quoky issues a unique
  `ProductionAttestationChallenge` (nonce/taskRunId/executionId/containmentBindingDigest/providerBindingDigest/
  issuedAtLocalMonoMs) that BOTH Channel A and B must include and sign/bind; currentness is
  `afterMono - beforeMono <= MAX_PRODUCTION_ATTESTATION_ROUND_TRIP_MS` on Quoky's own clock; external
  timestamps are audit/signer-policy only. A+B form ONE `attestationSetId`; no cross-challenge pairing, lone
  refresh, role swap, or cross-run/provider reuse; overlap = same challenge + same bounded round-trip window.
  Restart: old challenge/attestation-set issuance invalid, new challenge + fresh A/B mandatory; a restarted
  process may only attest a NEW PRE_DISPATCH first run, never resume/re-mint a pre-restart run.
- B-2 (single-use/linearization): `dispatchCommit.commit(taskRunId, executionId)` remains the SOLE
  authoritative execution linearization point; the capability-consumed guard is only an in-process
  fail-closed guard (not a second CAS). Commit failure keeps the capability consumed with no reissue/retry
  (R3-C-Rz); crash leaves durable TaskRun state as source of truth with no invented reconciliation. Add a
  commit-gated `execute()` requirement: production `execute` needs a module-private `committedFor(runId,
  capabilityIssuanceId)` created only after successful commit, so a caller holding only the capability cannot
  execute before commit (2D invariant, not enabled in 2A/2B).
- B-3 (decomposition): replace with R3-B3-2A (attestation contracts only; network/runtime-free; no production
  provenance/trust/capability), R3-B3-2B (fail-closed trust/binding plumbing: non-forgeable
  `trustIssuanceRecord`, structural consumed guard, commit-gated seam, unavailable production seams;
  network/runtime-free), R3-B3-2C (real trust root + real Channel A/B adapters; runtime/read-only/STRICT),
  R3-B3-2D (production capability + module-owned effect), and a STRICT Live Gate. Usable PRODUCTION capability
  UNAVAILABLE until 2C/2D.
- B-4 (independence): remove all "where achievable" weakening. Mandatory invariant: no single
  key/root/component/credential/signing-authority/workload-accessible secret may create valid A AND valid B;
  both independently rooted; Quoky app code holds no signing authority for either channel; workload code holds
  none for both; if one root can forge both → FAIL CLOSED. Channel B root: none credible today → Channel B
  production evidence UNAVAILABLE → production FAIL CLOSED. Control-plane credential rule: Quoky must not hold
  runtime control-plane write/admin credentials (Docker socket, container-runtime admin, deployment mutation,
  signer private key); prefer verification-only public material; if Quoky can mutate the attested runtime that
  evidence cannot be an independent root.
- Expand the bounded evidence fields (challengeId/nonce, attestationSetId, verifierRole, closed
  evidenceSourceKind per role, run/binding/provider identity, instance/observed image-runtime-model-posture,
  signer provenance, integrity/signature reference, optional audit timestamp; no secrets). Correct
  expected-vs-observed (taskRun/execution = challenge-bound identity; provider facts = C2A authority;
  egress/network-isolation posture required-observed if policy depends on it; no required fact stays
  expected-only at enablement). Leave the freshness bound for calibration (A/B RTT p95/p99, combined p99,
  C2A/C2B/pre-commit/dispatch durations) before 2C/live. Enumerate the TOCTOU final synchronous revalidation
  before dispatch CAS → commit gate → effect. Production provenance derives from verified challenge + A + B +
  real-root result + process-local issued `trustIssuanceRecord`; `provenanceDigest` stays integrity, not
  authenticity; add `attestationSetId`. The module-owned effect adapter must itself be module-issued (no
  arbitrary caller adapter) → `PRODUCTION_EFFECT_UNAVAILABLE` until delivered. Keep A/B unavailable-vs-invalid,
  role mismatch, stale, `ATTESTATION_SET_MISMATCH`/`CHALLENGE_MISMATCH`/`CAPABILITY_ALREADY_CONSUMED`/
  `PRODUCTION_EFFECT_UNAVAILABLE` distinct (NEW marked). Promote carry-forwards (concrete
  `trustIssuanceRecord`, structural `singleUse`, issuer-bound verifier role/source, calibrated freshness,
  corrected capability error-code direction, issued-instance/observed-identity membership) to REQUIRED before
  usable production capability. Activation gate stays `TEST_LOCAL_CONTINUITY_FORBIDDEN` until all
  prerequisites + Live Gate PASS + explicit approval.
- Doc cleanup: correct the reviewed source-facts "durable provenance" wording to serializable metadata (not
  durable/persistent trust authority). R3-C-Rz remains NOT AUTHORIZED. Documentation only: no source, test,
  schema, runtime, container, provider, network, secret, or DB changes. One local remediation commit; no
  Push/PR/Merge. ADR-0090 remains Proposed; independent Claude exact-HEAD Architecture re-review required
  before any implementation (including 2A/2B).

## R3-B3-2 Real Production Attestation architecture (docs only) — 2026-09-29

- Add the ADR-0090 amendment "R3-B3-2 Real Production Attestation architecture (STRICT / live boundary)" to
  `DECISIONS.md`, designing the real production attestation that can eventually supply the independent trust
  facts R3-B3-1 deliberately lacks, without weakening containment identity/provenance, the C2A/C2B/C2C chain,
  PRE_DISPATCH → single dispatch CAS → single effect, or fail-closed behavior. Source-verified at exact main
  `2a57161859f73f3d4f978e825706a64f58db2c93`: all containment identity digests are expected/configured
  inputs (never observed); fixed verifier roles A=EXTERNAL_RUNTIME_INSTANCE_INSPECTION,
  B=IN_INSTANCE_SELF_CHECK exist; production trust/provenance/capability seams all fail closed;
  `trustIssuanceRecord` is loose and `singleUse` is type-only; C2C `dispatchCommit.commit` is the sole
  consumption linearization point; production activation rejects `localContinuity`
  (`TEST_LOCAL_CONTINUITY_FORBIDDEN`); and no real Docker/container/cgroup/proc/TPM/IMDS/attestation source
  exists in Core or adapters.
- REAL TRUST ROOT decision: `NO_FEASIBLE_REAL_TRUST_ROOT_YET` — no viable production trust root exists inside
  the current product. Chosen category (prerequisite, external): a future trusted-runtime-supplied,
  application-inaccessible container/instance identity plus a verification-only external attestation, owned by
  the contained-runtime deployment boundary (not Core) and verified by Quoky without holding signing secrets.
  Caller `trusted=true`, bare env strings, WeakSet issuance alone, application-derived config digests, and
  self-signed claims are explicitly rejected as roots.
- Define Channel A (external runtime/instance inspection) and Channel B (in-instance self-check) with a
  failure-domain independence invariant (distinct processes/evidence sources/signers, one component may not
  issue both roles, binding proves source kind — not merely distinct version/provenanceId); an
  expected-vs-observed fact table with per-fact comparison and mismatch codes; a new bounded
  `ProductionAttestationEvidence` family binding role + evidence-source-kind + exact run/instance identity +
  freshness to prevent cross-run/instance/provider replay and A/B swapping; mandatory freshness (monotonic
  `observedAt`, `expiresAt = observedAt + MAX_PRODUCTION_ATTESTATION_WINDOW_MS`, A/B overlap, recheck
  immediately before dispatch CAS) with the bound left for calibration (not invented now); the async/TOCTOU
  ordering (attestation prep → C2A/C2B validation → synchronous final revalidation → dispatch CAS → effect,
  no stale attestation crossing the CAS); production provenance derived only from a root-issued verifier +
  issued trust-issuance record (`provenanceDigest` stays determinism/integrity, not authenticity); exact
  binding to the VerifiedContainmentBinding object identity; structural single-use via a module-private
  consumed-capability WeakSet CAS separate from the dispatch CAS (`CAPABILITY_ALREADY_CONSUMED`); a real
  production capability issuer requiring all of the above; and a MODULE-OWNED contained-runtime effect
  adapter behind a Core port (issued, never injected; absent today → `PRODUCTION_EFFECT_UNAVAILABLE`).
- Keep one `PreparedContainmentExecution` abstraction (`requireCapabilityKind('PRODUCTION')`); keep the
  production activation gate closed (`TEST_LOCAL_CONTINUITY_FORBIDDEN`) until every prerequisite passes;
  define the fail-closed failure model mapping to existing codes where correct and marking NEW codes
  explicitly; process-local issuance does not survive restart; no post-`DISPATCH_COMMITTED` continuation.
  Disposition carry-forwards: loose `trustIssuanceRecord` and type-only `singleUse` become BLOCKING for
  production; unavailable-verifier TEST-stamp and the `issuedInstances` gap remain NON-BLOCKING. Recommend
  decomposition R3-B3-2A (evidence contracts + Channel A/B ports + fakes, network/runtime-free), R3-B3-2B
  (production provenance + issuer + structural single-use, network/runtime-free), R3-B3-2C (module-owned
  effect adapter), and an R3-B3-2 Live Gate (STRICT live attestation + UAT).
- R3-C2B-2 (production Provider-unavailability observation) is kept separate and unmodified; R3-C-Rz remains
  NOT AUTHORIZED. Architecture is not approved by docs alone — independent Claude Architecture Review is
  required before any implementation. Documentation only: no source, test, schema, runtime, container,
  provider, network, secret, or DB changes. One local architecture commit; no Push/PR/Merge. ADR-0090 remains
  Proposed; `REAL_TRUST_ROOT = NO_FEASIBLE_REAL_TRUST_ROOT_YET`; PRODUCTION TRUST CHECK = FAIL CLOSED; REAL
  PRODUCTION CONTAINED EXECUTION = UNREACHABLE.

## R3-B3-1 implementation and combined exact-HEAD review (local; delivery pending) — 2026-09-29

- Implemented network/runtime-free production-trust plumbing at
  `e91bdec9e43c9b149b130db89d8b54f9750b69fd`: fixed Channel A/B roles, a TEST-only simulated verifier,
  and an UNAVAILABLE production verifier seam. Production trust requirements still fail closed; there is no
  trust anchor or runnable PRODUCTION capability.
- Added one capability-kind requirement seam while preserving the production activation guard that rejects
  test local continuity. Provenance remains process-local plumbing; serialized metadata cannot restore trust.
- `R3_B3_1_COMBINED_EXACT_HEAD_REVIEW = PASS`. Independent review: focused 230 PASS. Implementation validation:
  full suite 178 files / 3787 PASS; typecheck PASS; build PASS; `git diff --check` PASS.
  Push/PR/Merge and R3-B3-2 remain pending or unauthorized, respectively. The two R3-B3 docs-only entries
  below record earlier architecture checkpoints.

## R3-B3-1 remediation — network/runtime-free trust plumbing; production trust FAIL CLOSED (docs only) — 2026-09-29

- Add the ADR-0090 amendment "R3-B3-1 remediation (OPTION 1: network/runtime-free trust plumbing; production
  trust FAIL CLOSED)" to `DECISIONS.md`, closing the accepted CHANGES_REQUIRED blockers B-1..B-4 against the
  reviewed R3-B3 architecture amendment. The reviewed commit `c846ebf555fa865582bdf734f4ca9b02956c8fa1` is
  preserved unamended; exactly one remediation commit is added atop it (lineage `6162e0c8…` → `c846ebf5…` →
  remediation). Primary decision: R3-B3-1 = OPTION 1 ONLY — network/runtime-free production-trust PLUMBING; it
  must not make real production trust reachable, must not issue a real production contained-execution
  capability, and must not turn a deterministic fake verifier into production trust. `TRUST_ANCHOR_ROOT =
  NONE`; `PRODUCTION TRUST CHECK = FAIL CLOSED`.
- B-1: remove the claim that process-local (WeakSet) authenticity is sufficient for production trust — it
  proves only "this process issued this object," not "this runtime is production-trusted";
  `requireProductionTrustedVerification` / `requireProductionPreparedProvenance` stay fail-closed (or
  satisfiable only by a future attestation capability R3-B3-1 cannot issue); no ordinary path obtains real
  PRODUCTION trust. B-2: the deterministic simulated verifier issues into a TEST/SIMULATED domain that
  production checks reject (`DeterministicFakeProductionVerifier → PRODUCTION` forbidden); the only issuable
  production-verifier seam is UNAVAILABLE/FAIL-CLOSED and the issuer must not accept a caller-supplied verify
  body. B-3: fixed dual-channel roles — Channel A `EXTERNAL_RUNTIME_INSTANCE_INSPECTION`, Channel B
  `IN_INSTANCE_SELF_CHECK`; a verifier is bound to exactly one role; distinct version/provenanceId necessary
  but not sufficient; production stays fail-closed since real failure-domain independence is unprovable now.
  B-4: no runnable `PRODUCTION` capability in R3-B3-1 — only the fail-closed production-capability issuer
  SEAM; the future capability is issued, never injected, and must be exact-binding + single-use.
- Distinguish expected facts (already carried by bindings/contracts) from observed facts (independently
  measured by future attestation); claim no independent runtime verification. Correct the provenance model:
  `VerifiedContainmentProvenance` is deterministic/process-local plumbing, not persisted durable trust /
  cryptographic authenticity / independent attestation; a serialized/deserialized object cannot recreate
  issued trust. C2C uses one capability-kind seam (`requireCapabilityKind`); production continuation
  activation still rejects the local FAKE seam (`TEST_LOCAL_CONTINUITY_FORBIDDEN`). Record attestation
  freshness as a future live-slice requirement (not invented now) and map conceptual failures to current
  codes. Define a future STRICT slice R3-B3-2 (Real Production Attestation) as the sole path to a usable
  production trust root and real contained execution.
- Doc cleanup performed with this remediation: correct R3-C2B-2 RB2-5 evidence-expiry to `validFrom =
  issuedAt`, `expiresAt = issuedAt + 5000` (issuance-based, not "5000 ms from observation"); correct two
  reviewed-amendment references to the live-verifier/attestation slice from §16 to the §15 live-execution
  boundary (§16 is the R3-C-Rz boundary); correct "durable provenance" wording so it does not imply persisted
  production trust.
- R3-C2B-2 (Kind B / reachability / C2B freshness / provider selection) unaffected; R3-C-Rz still NOT
  AUTHORIZED. Documentation only: no source, test, schema, runtime, provider, network, secret, or DB changes.
  One local remediation commit; no Push/PR/Merge. ADR-0090 remains Proposed; R3-B3 implementation and R3-C-Rz
  remain NOT AUTHORIZED; production contained execution and `PRODUCTION TRUST CHECK` remain FAIL CLOSED with
  `TRUST_ANCHOR_ROOT = NONE` until the separate R3-B3-2 real-attestation slice. Independent Architecture
  exact-HEAD re-review must pass before Push/PR/Merge.

## R3-B3 Production Trust architecture / task definition (docs only) — 2026-09-29

- Add the ADR-0090 amendment "R3-B3 architecture / task definition (Production Trust: Anchor, Verifier Issuer,
  Capability Issuer)" to `DECISIONS.md`, designing the smallest production-trust architecture to eventually
  make a REAL contained production execution capability issuable without weakening containment identity/
  provenance, the C2A/C2B/C2C chain, PRE_DISPATCH consumption, observation authenticity, or fail-closed
  behavior. Source-verified: the seam already exists in `continuation-prepared-containment.ts` — durable
  `ContainmentTrustDomain` (`TEST`|`PRODUCTION`), dual independent verification channels,
  `prepareVerifiedContainmentBinding` stamps `TEST` and rejects self-declared `PRODUCTION`,
  `requireProductionTrustedVerification` + prepared-provenance requirement always throw
  `PRODUCTION_TRUST_ANCHOR_UNAVAILABLE`, and `VerifiedContainmentBinding` already carries all the needed
  digests + durable `provenance`. Trust anchor = process-local ISSUED root (module-private WeakSet factory,
  production-composition-only, no persistence, restart invalidates); verifier issuer = anchor-authenticated
  (WeakSet), only an anchor-issued independent verifier may present `PRODUCTION`; verified facts = existing
  binding digests + `provenance.trustDomain === 'PRODUCTION'` (no new fields); capability issuer mints a
  `PRODUCTION`-kind `ContainedExecutionCapability` ONLY on an anchor-verified chain + exact verified facts
  (never from raw IDs/bare prepared/source enum/caller assertion) — the sole crossing of
  `PRODUCTION TRUST CHECK = FAIL CLOSED`. C2C integration: production trust verification inside the C2C
  coordinator's synchronous pre-commit checks before the dispatch CAS; real effect only after verification +
  durable commit; production composition replaces `assertFakeOnly` with a production-capability requirement
  (TEST keeps FAKE). FAKE rejected in production; C2B-2 observation authenticity separate/unaffected. Failure
  model (any anchor/verifier/provenance/runtime-identity/digest/binding/profile gap → DENY); process-local, no
  persistence/replay across taskRun/execution; secret ownership boundary identified only (no secret read);
  network/runtime-free with a deterministic fake verifier seam; live runtime verification is a separate STRICT
  slice. Decomposition R3-B3-1 (network-free trust plumbing; if a real attestation source is required,
  plumbing only + later STRICT live-verifier slice keeps production execution DENY). R3-C-Rz excluded.
  Documentation only: no source, test, schema, runtime, provider, network, secret, or DB changes. One local
  architecture commit; no Push/PR/Merge. ADR-0090 remains Proposed; R3-B3 implementation and R3-C-Rz remain
  NOT AUTHORIZED; production contained execution and `PRODUCTION TRUST CHECK` remain FAIL CLOSED.

## R3-C2B-2-1 Network-free typed observation producer (local, review pending) — 2026-09-29

- Add a closed provider-native diagnostic port, deterministic fake transport, fail-closed production
  placeholder, and process-local issued canonical producer. Only provider service and provider auth-service
  unavailability can issue C2B Kind B evidence; raw failures and all other results deny.
- Bind production producer acceptance to its issued identity, the C2B clock, and the frozen canonical
  binding registry. Read observation time after classification, enforce a 2000 ms probe bound, and retain
  issuance-based 5000 ms evidence validity and the 1000 ms issuance delay bound.
- Reject the test-only local FAKE effect seam in production continuation activation. Keep live diagnostics,
  production containment, and R3-C-Rz out of this slice.

## R3-C2B-2 Production Trusted-Unavailability Observation architecture remediation (docs only) — 2026-09-28

- Add "ADR-0090 amendment (remediation) — R3-C2B-2 corrected after Claude CHANGES_REQUIRED (B-1..B-5)" to
  `DECISIONS.md`. **B-1:** remove the endpoint/URL/host probe model (no canonical endpoint identity exists in
  descriptors/bindings/digests); canonical mechanism = PROVIDER-NATIVE TYPED DIAGNOSTIC through a NEW injected
  `CanonicalProviderReachabilityProbeTransport` port (bounded identity input; CLOSED typed result; no URL/host/
  command exposed); semantics fixed per adapter/binding version (no separate probe profile). **B-2:** one
  mechanism (provider-native read-only non-inference diagnostic; no generic HTTP/TCP, no `isAvailable()`, no
  inference/fallback); closed result family where only `PROVIDER_SERVICE_UNAVAILABLE` /
  `PROVIDER_AUTH_SERVICE_UNAVAILABLE` are Kind B-eligible; explicit raw-failure mapping (DNS/TCP/TLS/HTTP-5xx/
  local → DENY); `catch(...) => UNAVAILABLE` forbidden. **B-3:** auth eligibility = ONLY provider
  auth-SERVICE unavailable; missing/invalid/revoked/expired creds, local secret-read failure, not-logged-in,
  account-disabled, 401/403 → DENY; existing `AUTHENTICATION_UNAVAILABLE` re-documented as
  `PROVIDER_AUTH_SERVICE_UNAVAILABLE`. **B-4:** producer authenticity via module-private composition-sealed
  factory + WeakSet/WeakMap of issued production-producer handles
  (`requireIssuedProductionObservationProducer`); source flag alone never grants authority; process-local, no
  persistence/rehydration/cross-process, restart invalidates. **B-5:** `observedAtMonoMs` = monotonic time
  when the typed result is fully received AND classified (bracketed `beforeMono <= observedAtMonoMs <=
  afterMono`); ratified `MAX_PRODUCTION_OBSERVATION_PROBE_MS = 2000` (probe ≤ 2000ms else TIMEOUT→DENY;
  issuance ≤ 1000ms; evidence window ≤ 5000ms; no retry/fallback). Adds the network-free test seam
  (`DeterministicFakeReachabilityProbeTransport`), the STRICT live-probe boundary, and the production
  FAKE-effect structural guard (closes NB-1: production composition rejects a FAKE
  `PreparedContainmentExecution`). Evidence bindings unchanged (no endpoint field); C2A/C2C unchanged; R3-B3
  observation-authenticity ≠ production-execution-trust preserved; R3-C-Rz excluded. Decomposition R3-C2B-2-1
  (network-free); production end-to-end still gated on R3-C2B-2-1 + the separate R3-B3 production-containment
  slice. Documentation only: no source, test, schema, runtime, provider, network, secret, or DB changes. One
  remediation commit on parent `ff7b4ed2…` (reviewed commit not amended); no Push/PR/Merge. ADR-0090 remains
  Proposed; R3-C2B-2 and R3-C-Rz remain NOT AUTHORIZED; production Kind B end-to-end DENY; R3-B3 FAIL CLOSED.

## R3-C2B-2 Production Trusted-Unavailability Observation Producer architecture / task definition (docs only) — 2026-09-28

- Add the ADR-0090 amendment "R3-C2B-2 architecture / task definition (Production Trusted-Unavailability
  Observation Producer)" to `DECISIONS.md`, designing the production observation source that could make Kind B
  `TRUSTED_CURRENT_UNAVAILABILITY` reachable without weakening PRE_DISPATCH-only flow, exact bindings,
  freshness, the C2A/C2B chain, C2C validate→commit→effect ordering, or R3-B3 fail-closed. Source-verified:
  the seam is the existing `CurrentUnavailabilityObservationProducer` port; the C2B issuer owns the call and
  today accepts only `TEST_FAKE` (`CANONICAL_PROVIDER_REACHABILITY_PROBE` reserved); `AiProvider.isAvailable()`
  reflects LOCAL binary/process availability, not cloud reachability, so it is unsuitable. Canonical owner: a
  NEW adapter-layer `CanonicalProviderReachabilityObservationProducer` (`source =
  CANONICAL_PROVIDER_REACHABILITY_PROBE`) implementing the existing port — a narrow read-only reachability/
  auth probe of the exact cloud endpoint that never mints Kind B authority (C2B issuer remains sole minter).
  Semantics: definitive endpoint-unreachable / auth-unavailable / provider-native-down = Kind B eligible;
  UNKNOWN/timeout/ambiguous network/auth-secret failure → DENY; quality/capability/policy/LOCAL-only/
  prior-failure/ranking never Kind B. Trust: a production observation provenance root must authenticate the
  canonical producer instance before the issuer accepts the non-TEST_FAKE source; until then it is rejected
  (`SOURCE_NOT_ALLOWED`) and production Kind B stays DENY. Bindings/freshness preserved (providerId/taskId/
  executionId/capability/RoutingContextDigest/composite configurationDigest/endpoint/timestamps/issuer; window
  ≤ 5000ms, issuance delay ≤ 1000ms, monotonic-only, C2C final expiry authoritative). Network = adapter-owned,
  read-only, bounded-timeout, canonical health endpoint only, no arbitrary host/mutation/inference/
  disguised-effect/secret-leak; secret ownership boundary identified only (no secret read here). Replay/
  cross-run isolation preserved; restart invalidates. R3-B3 impact: observation authenticity is distinguished
  from production contained-execution trust (still FAIL CLOSED) — production Kind B evidence never auto-enables
  a real contained effect. Decomposition: R3-C2B-2-1 (producer plumbing + provenance root + issuer source
  acceptance; STRICT network/secret governance) plus a mandatory production-reachability gate requiring BOTH
  R3-C2B-2-1 AND the separate R3-B3 production-containment slice before any real end-to-end production effect.
  C2A/C2C unchanged; R3-C-Rz excluded. Documentation only: no source, test, schema, runtime, provider,
  network, secret, or DB changes. One local architecture commit; no Push/PR/Merge. ADR-0090 remains Proposed;
  R3-C2B-2 and R3-C-Rz remain NOT AUTHORIZED; production Kind B end-to-end remains DENY; R3-B3 stays FAIL
  CLOSED.

## R3-C2C-1 Network-free local continuity consumption (local, review pending) — 2026-09-28

- Move the receiver's early dispatch commit to the ordinary continuation gateway boundary after PRIMARY_ONLY
  planning. Keep write-before-effect and bounded pre-dispatch failure when commit does not succeed.
- Add the C2C coordinator and test-only app composition seam. C2A validation, canonical provider binding,
  containment identity, and Kind B final expiry precede the guarded dispatch CAS; only an issued FAKE
  `PreparedContainmentExecution` executes afterward. The local path has no generic gateway or fallback.
- Cover replay, binding and TaskRun mismatch, expiry edges, CAS loser, storage failure, and post-commit
  contained effect failure. Production trust stays fail closed; C2B-2 and R3-C-Rz remain outside scope.

## R3-C2C Local Continuity Consumption architecture remediation (docs only) — 2026-09-28

- Add "ADR-0090 amendment (remediation) — R3-C2C corrected after Claude CHANGES_REQUIRED (B-1..B-3)" to
  `DECISIONS.md`. **B-1:** finalized continuation flow — remove the receiver-level early
  `dispatchCommit.commit`; ordinary continuation branch commits at its exact ordinary Provider effect
  boundary (preserving I2-1 write-before-effect); `input.localContinuity` branch delegates to a new
  `LocalContinuityConsumptionCoordinator`; the future `apps/quoky` continuation-composition seam is the named
  creator/passer of the `localContinuity` input (apps pass it only in tests today). **B-2:** canonical effect
  callable = `PreparedContainmentExecution.execute` (FAKE capability only; `requireProductionContainedCapability`
  fails closed; C2C-1 NETWORK-FREE/TEST-ONLY); `ProviderRoutingGateway` NOT used for C2C; exact binding via
  `ProviderBindingRegistry`/`ExecutableProviderBinding` with pre-commit checks (providerId match, taskRun/
  execution identity match, `prepared.providerBindingDigest ===` registry binding digest); corrected the false
  containment claim — C2A binds capability/`RoutingContextDigest`/composite `configurationDigest`/evidence,
  containment binds providerId/providerBindingDigest/taskRun-execution/provenance, coordinator matches
  overlapping facts. **B-3:** fact-by-fact TOCTOU table (A immutable/frozen instances; B guarded CAS checks
  row+identity+STARTED+PRE_DISPATCH only; C re-read/revalidate immediately before commit incl. binding digest
  and Kind B clock read) with a strict no-await-before-commit rule, guarded CAS as linearization point,
  post-commit no PRE_DISPATCH re-validation, and commit-generic-exception → effect-not-started-certain +
  marker-state-by-DB-re-read (state machine K/L/M). Doc fix: R3-C2B-I2-1 → CLOSED + DELIVERED (PR #95, main
  `4e040913405585596b0a1f0c399a20a8b592a85a`). NB-4 `save()` decision retained with source proof; I1/I2
  supersession recorded; normal paths unchanged. Documentation only: no source, test, schema, runtime,
  provider, network, secret, or DB changes. One remediation commit on parent `b46e405f…` (reviewed commit not
  amended); no Push/PR/Merge. ADR-0090 remains Proposed; production Kind B DENY; C2C, C2B-2, R3-C-Rz remain
  NOT AUTHORIZED; R3-B3 fail closed.

## R3-C2C Local Continuity Consumption / Exact Effect Binding architecture / task definition (docs only) — 2026-09-28

- Add the ADR-0090 amendment "R3-C2C architecture / task definition (Local Continuity Consumption / Exact
  Effect Binding)" to `DECISIONS.md`, defining the canonical consumption boundary that turns an issued
  `BoundLocalContinuitySelection` into EXACTLY ONE authorized local-continuity Provider effect with the order
  **validate C2A → commit `DISPATCH_COMMITTED` → exact bound Provider effect** (closes I2-1 NB-1).
  Source-verified: `ContinuationReceiverExecutionService` currently commits dispatch before `receiver.receive`,
  so the later C2A validate sees `DISPATCH_COMMITTED` → `INVALID_RUN`. **Selected Option B:** a NEW narrow
  `LocalContinuityConsumptionCoordinator` owns validate→(Kind B expiry re-check)→commit→effect, consuming the
  canonical `LocalContinuityAdmissionCoordinator` admitted outcome; rejected A (overload
  `ContinuationProviderRoutingService`) and C (receiver restructuring). Ownership distinct: C2A validator,
  `ProviderDispatchCommitCoordinator` (sole CAS owner), `TaskRunRepository` (state), `ProviderRoutingGateway`
  (generic, not used for the single-attempt local effect unless a one-binding/zero-fallback plan is proven).
  TOCTOU closed by the guarded CAS on `PRE_DISPATCH` adjacent to validate (no token); Kind B
  `continuityEvidenceExpiresAtMonoMs` re-checked on the shared `MonotonicClock` immediately before commit;
  exact provider binding from the issued `SoleProviderSelection`; containment via `PreparedContainmentExecution`
  bound to the same provider/execution/capability/config; R3-B3 stays FAIL CLOSED so no real production
  local-Provider effect executes. Exactly one provider / one attempt / no fallback; commit failure → definite
  pre-dispatch failure; crash-after-commit or provider failure → `DISPATCH_COMMITTED`, no normal retry
  (R3-C-Rz only); concurrent consumers → one CAS winner. Early continuation commit moves to the C2C effect
  boundary preserving write-before-effect on every INCLUDED path. NB-4 generic `save()` insert carried forward
  as recommended hardening (not a hard prerequisite). Non-C2 conversation/code-generation/tools paths
  unchanged. Includes a state machine, future test contract, and the recommended R3-C2C-1 slice.
  Documentation only: no source, test, schema, runtime, provider, network, secret, or DB changes. One local
  architecture commit; no Push/PR/Merge. ADR-0090 remains Proposed; production Kind B remains DENY; C2C
  implementation, C2B-2, and R3-C-Rz remain NOT AUTHORIZED; R3-B3 fail closed.

## R3-C2B-I2-1 Canonical Prior-Dispatch Attempt Boundary (local, review pending) — 2026-09-28

- Add durable `ProviderDispatchState` to TaskRun JSON. Both start paths initialize `PRE_DISPATCH`; missing
  historical state fails closed as `LEGACY_UNKNOWN`, with provider-associated history read as committed.
- Add SQLite IMMEDIATE guarded, exactly-one-winner dispatch commit and the application
  `ProviderDispatchCommitCoordinator`. Commit before continuation receiver and conversation work-turn routed
  or direct Provider effects; preserve one commit across in-plan Stage2B fallback and deny re-entry.
- Require current `PRE_DISPATCH` for Kind A/B admission and C2A mint/validate, closing post-commit replay.
  Add fake-effect and SQLite regressions. Production Kind B still denies; C2B-2, C2C, R3-C-Rz remain
  unauthorized and R3-B3 production trust remains fail closed.

## R3-C2B-I2 Canonical Prior-Dispatch Attempt Boundary final B-1 remediation (docs only) — 2026-09-28

- Add "ADR-0090 amendment (remediation 2 — R3-C2B-I2 final B-1 closure)" to `DECISIONS.md`, closing B-1
  (B-2/B-3 remain CLOSED and unchanged). Finalizes every current Provider-effect path with no "classify
  later": **INCLUDED** = `ContinuationReceiverExecutionService`, `RuntimeProviderRoutingService` →
  `ProviderRoutingGateway` (`executionId = run.id`), and conversation-runtime work-turn Provider execution
  (routed path + TaskRun-bound direct fallback ≈L5207); **EXCLUDED (structural)** = code-generation-manager
  (`CodeGeneration` aggregate, no TaskRun), tools/validation-harness/diagnostics (non-TaskRun executionId),
  and the conversation-runtime "(E) Fast path" `provider.execute` (≈L2035, `!intent.requiresWork`, no Task/no
  TaskRun). Source-verified control flow: within one work turn (after `startRun`), routed and direct paths are
  MUTUALLY EXCLUSIVE (routed returns on ACCEPTED/FAILED; direct fallback runs only when routing is absent/
  non-GENERAL_CHAT), so exactly one Provider-effect path is reached and commits the marker once.
  `ProviderDispatchCommitCoordinator` remains the single write owner; `ProviderRoutingGateway` is generic and
  not the persistence owner. TaskRun initialization finalized: both `guardedStart` and `taskRuns.start`
  persist explicit `PRE_DISPATCH`. Reachability gate now enumerates all INCLUDED paths. Documentation only: no
  source, schema, test, runtime, provider, network, secret, or DB changes. One remediation commit on parent
  `2c2c2fe…` (prior commits not amended); no Push/PR/Merge. ADR-0090 remains Proposed; Kind B remains DENY;
  R3-C2B-I2, C2B-2, C2C, and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2B-I2 Canonical Prior-Dispatch Attempt Boundary architecture remediation (docs only) — 2026-09-28

- Add "ADR-0090 amendment (remediation) — R3-C2B-I2 corrected after Claude CHANGES_REQUIRED (B-1..B-3)" to
  `DECISIONS.md`, retaining Option C. **B-1:** single canonical write owner = a narrow application-layer
  `ProviderDispatchCommitCoordinator` (persistence source of truth stays `TaskRunRepository`/`task_runs`;
  `ProviderRoutingGateway` is not the owner); commit occurs immediately before the first
  `binding.provider.execute(...)` of the TaskRun-bound execution, DB transaction ends before the Provider
  call; one commit per TaskRun (bounded in-plan Stage2B fallback takes no second write). A source-inspected
  dispatch-path inventory classifies continuation-receiver (required), gateway (required only on the
  TaskRun-bound path via the coordinator), conversation-runtime/code-generation-manager (classify at
  implementation), and tools/harness non-TaskRun (excluded). **B-2:** one state model `ProviderDispatchState`
  = `PRE_DISPATCH | DISPATCH_COMMITTED | LEGACY_UNKNOWN`; new `guardedStart` runs persist explicit
  `PRE_DISPATCH`; missing legacy field → `LEGACY_UNKNOWN` (never `PRE_DISPATCH`) → Kind A/Kind B/C2A DENY;
  historical providerId/terminal-executed rows normalize to `DISPATCH_COMMITTED`, ambiguous STARTED →
  `LEGACY_UNKNOWN`; corrected migration note (task_runs is JSON, so no new SQL column is necessarily
  required). **B-3:** guarded `commitProviderDispatchIfPreDispatch(...)` SQLite IMMEDIATE CAS (same
  `.immediate()` style as `guardedStart`) with exactly-one-winner concurrency (loser does not execute),
  `ALREADY_DISPATCH_COMMITTED` on duplicate, `LEGACY_UNKNOWN` never normal-commits, transaction never held
  across the Provider call. Common Kind A + Kind B precondition (`PRE_DISPATCH` required); coordinator + C2A
  issue + C2A validate re-read `dispatchState` (replay prevention; marker presence = authority consumption,
  no second flag). Preferred single combined slice R3-C2B-I2-1 (else I2A+I2B with reachability CLOSED
  between). Documentation only: no source, schema, test, runtime, provider, network, secret, DB,
  aggregate/repository, or approval owner changes. One remediation commit on parent `5a904ddd…` (reviewed
  commit not amended); no Push/PR/Merge. ADR-0090 remains Proposed; Kind B remains DENY; R3-C2B-I2, C2B-2,
  C2C, and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2B-I2 Canonical Prior-Dispatch Attempt Boundary architecture / task definition (docs only) — 2026-09-28

- Add the ADR-0090 amendment "R3-C2B-I2 architecture / task definition (Canonical Prior-Dispatch Attempt
  Boundary)" to `DECISIONS.md`, closing the R3-C2B-I1 NB-1 carry-forward and unifying NB-5: ONE canonical,
  durable, fail-closed answer to "has any Provider dispatch already been committed for this TaskRun?"
  Source-verified: the real dispatch path (`ContinuationReceiverExecutionService` → `receiver.receive(...)`)
  writes `TaskRun.providerId`/status only AFTER the Provider effect, so providerId is post-effect and
  insufficient; `ProviderExecutionAudit` is in-memory, `ContinuationRoutingAudit` is best-effort post-dispatch
  metadata, `ExecutionReceipt` is COMMAND-only/terminal. **Selected Option C:** an explicit durable `TaskRun`
  dispatch-commitment field (owned by `TaskRunRepository`), transitioned exactly once before the Provider
  effect, monotonic, restart-durable, storage-derived. Rejected A (post-effect providerId), B (in-memory/
  best-effort audit), D (new aggregate duplicates TaskRun ownership), E (containment post-evidence is
  post-dispatch/local-only). Defines the write-before-effect contract, a common Kind A + Kind B pre-dispatch
  invariant (marker PRESENT → both DENY; valid C2B evidence does not override), C2A issue/validate marker
  re-checks (one-shot authority, replay prevention), crash/duplicate/uniqueness/restart/provider-scope/failure
  semantics, time = audit-only, a C2B-2 reachability gate (Kind B not production-reachable until the marker is
  implemented + enforced + reviewed + delivered), the C2C integration point (marker write belongs to the
  canonical dispatch owner, e.g. `ProviderRoutingGateway`), a future `TaskRun` schema/migration identified as
  architecture-reviewed implementation scope (not implemented), I2A/I2B decomposition, entry/exit criteria,
  and a future test matrix. Documentation only: no source, schema, test, runtime, provider, network, secret,
  DB, aggregate/repository, or approval owner changes. One local architecture commit; no Push/PR/Merge.
  ADR-0090 remains Proposed; Kind B remains DENY; R3-C2B-I2, C2B-2, C2C, and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2B-I1 Kind B admission integration (local implementation) — 2026-09-28

- Add the canonical admission coordinator, pure Kind B policy candidate, issuer-owned exact-set batch,
  bounded VALIDATED binding metadata, and final monotonic currentness check.
- Bind C2A authorities to explicit Kind A/Kind B evidence kinds; Kind B retains the validated minimum
  expiry and fails at or after it. Classify C2B failure separately from infrastructure failure.
- Keep TEST_FAKE in tests only. Production Kind B stays DENY before C2B-2; C2C, R3-C-Rz, and production
  trust remain unimplemented.

## R3-C2B-I Kind B Admission Integration architecture remediation (docs only) — 2026-09-28

- Add "ADR-0090 amendment (remediation) — R3-C2B-I corrected after Claude CHANGES_REQUIRED (B-1..B-3)" to
  `DECISIONS.md`, retaining Option B. Ownership clarified: `LocalContinuityAdmissionCoordinator` is the
  canonical application admission authority owner; `LocalContinuityAdmission` owns deterministic policy
  semantics. **B-1:** define a PURE Kind B policy path on `LocalContinuityAdmission`
  (`evaluateTrustedCurrentUnavailabilityPolicy(input)`) that takes no trust signal (no VALIDATED result/
  boolean/evidenceKind/authorities/caller provider set/token), re-runs deterministic prerequisites, reuses
  the exact PRIMARY_ONLY local-selection semantics (`assertExactSoleProviderSelection`), and returns a pure
  candidate or DENY — never authority. **B-2:** the coordinator accepts no provider list/authorities/
  validation result; it invokes the SAME canonical `TrustedCurrentUnavailabilityObservationIssuer` instance
  via a new batch API `issueCanonicalEligibleNetworkSet(taskRunId)` then `validate(...)`; the VALIDATED result
  exposes `expiresAtMonoMs = MIN(validated set)`. **B-3:** documents the actual async/await sequence, a final
  currentness check as the last security step, the invariant that no `await` occurs between the coordinator's
  admitted outcome and C2A minting, and a NEW Kind-B-only C2A expiry binding —
  `BoundLocalContinuitySelection` gains `continuityEvidenceKind = TRUSTED_CURRENT_UNAVAILABILITY` +
  `continuityEvidenceExpiresAtMonoMs` (validated min expiry) enforced by C2A `validate` (`now < expiry` else
  invalid); Kind A A1/A2 authority unchanged (no expiry); a shared canonical `MonotonicClock` domain is used.
  Option C stays REJECTED because Option B structurally removes any need for a trust token. Provenance reuses
  existing `LOCAL_CONTINUITY_EVIDENCE_KINDS` (no duplicate `STATIC_ADMIN_UNAVAILABILITY`). Production before
  C2B-2 stays deterministic Kind B DENY without breaking Kind A. Doc cleanup: `CURRENT_STATE.md` R3-C2B-1
  corrected to CLOSED + DELIVERED (PR #91 merged, main `0c7b4a8762b0a9ad892d3e5407e33e5300e01a1e`). Updated
  R3-C2B-I1 slice and test matrix. Documentation only: no source/test/schema/runtime/provider/network/secret/
  DB/aggregate/repository/approval owner changes. One remediation commit on parent `22f4e6f0…` (reviewed
  commit not amended); no Push/PR/Merge. Kind B remains DENY; integration, C2B-2, C2C, and R3-C-Rz remain NOT
  AUTHORIZED.

## R3-C2B-I Kind B Admission Integration architecture / task definition (docs only) — 2026-09-28

- Add the ADR-0090 amendment "R3-C2B-I architecture / task definition (Kind B Admission Integration)" to
  `DECISIONS.md`, defining the canonical path by which C2B-1 trusted current-unavailability evidence may
  eventually affect local-continuity admission without caller forgeability (source-verified against the merged
  C2B-1 issuer/validator, the C2A bound-authority issuer, and the pure `LocalContinuityAdmission`). **Selected
  Option B** (application coordinator): `LocalContinuityAdmission` remains the single semantic policy owner; a
  new narrow application-layer `LocalContinuityAdmissionCoordinator` (orchestration only) is the one admission
  entry, invoking `LocalContinuityAdmission.admit(...)` and — only when Kind-B-eligible — the SAME
  `TrustedCurrentUnavailabilityObservationIssuer` instance's `validate(...)`. Rejected A (storage/issuer
  inversion into the pure lower layer), C (duplicate WeakMap authority, no added safety), D (C2A as second
  policy owner + forgeability). Non-forgeability: the coordinator itself invokes validation; a plain
  `{status:'VALIDATED'}`/boolean/evidenceKind/observation array/provider IDs/snapshot is inert. Kind A A1/A2
  still admit without C2B. C2A retains all its bindings and mints only after the canonical combined outcome;
  Kind B changes only WHY admission is allowed. Synchronous, expiry-safe validation→admission→issuance (5s
  window revalidated; expired/config/provider-set/WRONG_ISSUER → DENY); non-durable decision; restart
  invalidates authority; raw observations never leave the coordinator. Production stays Kind B DENY before
  C2B-2 (no `TEST_FAKE` in production composition; `CANONICAL_PROVIDER_REACHABILITY_PROBE` unimplemented).
  Implementation slice R3-C2B-I1 is network-free. Includes non-forgeability contract, Kind A/B precedence,
  admission lifetime, expiry/race contract, test/production composition, C2B-2 seam, C2C boundary, R3-B3
  status, R3-C-Rz exclusion, entry/exit criteria, and a future test matrix. Documentation only: no source,
  test, schema, runtime, provider, network, secret, DB, aggregate/repository, or approval/security owner
  changes. One local architecture commit; no Push/PR/Merge. ADR-0090 remains Proposed; Kind B remains DENY;
  integration, C2B-2, C2C, and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2B-1 exact-set authority remediation (local) — 2026-09-28

- Remove caller-supplied registry and policy engine from observation aggregate validation. Re-derive
  provider membership, exact-set cardinality, and current composite configuration digest only from the
  issuer-owned canonical dependencies.
- Add regressions for fake caller engine/registry attempts to shrink `{a,b}` to `{a}` and for canonical
  registry/policy changes after issuance. Kind B admission remains DENY.

## R3-C2B-1 trusted current-unavailability evidence (local implementation) — 2026-09-28

- Add a network-free Core observation producer port, issuer-local immutable authority, bounded source/reason
  values, and exact enabled, compatible NETWORK provider-set aggregate validation.
- Enforce canonical first-run Task/TaskRun, routing context, Stage2B composite configuration, issuer-owned
  before/after monotonic timestamps, 5-second validity, 1-second observation delay, and backward-clock
  rejection. `VALIDATED` names evidence validation only.
- Keep `TEST_FAKE` test-local and absent from production composition. Kind B admission remains DENY;
  C2B-2, C2C, and R3-C-Rz remain unauthorized; R3-B3 production trust remains fail closed.

## R3-C2B architecture remediation (docs only) — 2026-09-28

- Add "ADR-0090 amendment (remediation) — R3-C2B corrected after Claude CHANGES_REQUIRED (B-1..B-4)" to
  `DECISIONS.md`, applying the exact Chief Architect decisions. **B-1:** the only controlling Kind B provider
  set is `RoutingPolicyEngine.staticEligibility(...).eligibleNetworkProviderIds` (enabled + policy-compatible
  + NETWORK); disabled/incompatible providers never enlarge it; exact provider-ID set equality (no missing/
  extra/duplicate) at validation; Kind A/B case matrix A–E. **B-2:** monotonic-ms currentness
  (`observedAtMonoMs`/`validFromMonoMs`/`expiresAtMonoMs`; `validFrom <= now < expiresAt`; now==validFrom
  valid, now==expiresAt expired), fixed `MAX_TRUSTED_UNAVAILABILITY_WINDOW_MS=5000` and
  `MAX_OBSERVATION_TO_ISSUANCE_DELAY_MS=1000`, fail-closed on non-finite/negative/backward-clock; wall-clock
  audit-only. **B-3:** issuer-owned injected `CurrentUnavailabilityObservationProducer` (callers pass no
  observation/flag/timestamp); C2B-1 network-free with a deterministic `TEST_FAKE` producer only (no real
  `isAvailable()`, no process spawn/network/secret); `CANONICAL_PROVIDER_REACHABILITY_PROBE` reserved for
  C2B-2; bounded `TrustedUnavailabilityReason` (ENDPOINT_UNREACHABLE / AUTHENTICATION_UNAVAILABLE /
  PROVIDER_HEALTH_UNAVAILABLE). **B-4:** C2B-1 is VALIDATOR-ONLY — does not modify
  `LocalContinuityAdmission.admit(...)` or the C2A issuer, so Kind B admission STILL = DENY; a VALIDATED C2B
  authority set is only sufficient evidence for a future separately reviewed Kind B integration slice. Adds
  `TrustedCurrentUnavailabilityValidationResult` (VALIDATED/INVALID(reason)), five-step precedence, authority
  shape, config/task/execution binding (Stage2B composite `configurationDigest` + `taskId`), and the
  `isAvailable()`-is-not-production-evidence note. Documentation cleanup: `CURRENT_STATE.md` R3-C2A corrected
  to CLOSED + DELIVERED (PR #89 merged, main `be9ba958…`); C2B carry-forward wording corrected to NB-1 closed,
  NB-2 closed, NB-3 partial (C2C owns planner/effect binding), NB-4 closed for C2B validation. Docs-only: no
  source/test/schema/runtime/provider/network/secret/DB changes. One remediation commit on parent
  `941194d39f…` (reviewed commit not amended); no Push/PR/Merge. Kind B remains DENY; C2B implementation,
  C2B-2, C2C, and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2B architecture / task definition (docs only) — 2026-09-28

- Add the ADR-0090 amendment "R3-C2B architecture / task definition (Trusted Current-Unavailability
  Observation Authority)" to `DECISIONS.md`, defining the smallest safe architecture for proving — at one
  exact execution/routing/configuration context — that the canonical cloud path is CURRENTLY unavailable via
  an observation source the caller/model cannot self-declare. Source-verified decisions: adapter-owned
  `AiProvider.isAvailable()` / the `ProviderRegistrySnapshot` availability field are observation DATA, not
  Kind B authority; a NEW canonical process-local issuer mints an immutable, issuer-instance-local
  `TrustedCurrentUnavailabilityObservation` (WeakMap pattern, distinct from C2A selection authority) binding
  `providerId`, `executionId===taskRunId`, `routingContextDigest`, composite `configurationDigest`,
  `capability`, bounded `observationSource`, and a monotonic-clock validity window (`MonotonicClock`
  authoritative; wall-clock audit-only); a bounded pre-dispatch `TrustedUnavailabilityReason` (no new
  `RoutingFailureCode`); canonical cloud set from `RoutingPolicyEngine.staticEligibility(...)` (never
  caller-selected IDs); multi-cloud requires trusted current-unavailability for EVERY relevant candidate (one
  available cloud → DENY); Stage2B remains the sole router; Kind B requires C2A first-run/no-prior-history and
  stays pre-dispatch; Kind A precedence preserved. Closes C2A carry-forwards NB-1..NB-4. Process restart
  invalidates authority; R3-B3 stays FAIL CLOSED. Decomposition C2B-1 (network-free authority/issuer/validator
  + fake producer) → C2B-2 (actual network/secret producer, separate STRICT approval). Includes a fail-closed
  matrix, entry/exit criteria, verification strategy, and deferred decisions. Documentation only: no code,
  runtime, provider, network, secret, DB/schema, aggregate/repository, approval/security owner, or new
  `RoutingFailureCode`. One local architecture commit; no Push/PR/Merge. ADR-0090 remains Proposed; Kind B
  remains DENY; C2B implementation, C2C, and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2A — Bound Local Continuity Authority — 2026-09-28

- Add process/issuer-local `BoundLocalContinuitySelectionIssuer` with internal R3-C1 admission,
  exact TaskRun/execution/workload/configuration binding, and first-run singleton STARTED history checks.
- Share the existing continuation context owner and domain-separated canonical hash; implement the exact
  ten-field RoutingContextDigest contract without changing existing containment digest identities.
- Enforce C2A authority/PRIMARY_ONLY plan checks in continuation orchestration before availability probes.
  Validated C2A requests still fail closed before dispatch because C2C preparation is not implemented.
- Add adversarial authority/replay/configuration/context tests and real SQLite first-continuation,
  concurrent STARTED exclusion, and terminal-run rerun denial tests (NB-R1/R2/R3).
- No runtime/provider/network activation, containment preparation, production trust, schema/migration,
  Kind B issuer, or R3-C-Rz. C2B/C2C remain not started; independent implementation review pending.

## R3-C2 architecture BR-1 final remediation (docs only) — 2026-09-28

- Add the "ADR-0090 amendment (remediation 2 — BR-1 final)" to `DECISIONS.md`, accepting BR-1 and closing
  non-blocking cleanups NB-1..NB-7 (facts confirmed by reading source). **BR-1:** the codebase does NOT
  enforce one `TaskRun` per `Task` — storage `guardedStart`, `TaskManager.guardedStartRun`, and
  `ContinuationExecutionAdmissionService` reject only a concurrent unresolved STARTED run and allocate
  `attempt = MAX(attempt)+1`, so after a terminal run a new `TaskRun` (attempt ≥ 2) may start; those
  components are therefore NOT a "one-run-per-Task" owner. **Owner-3 correction:** they own
  concurrent-STARTED exclusion + canonical `TaskRun` start + attempt ordinal only. **Final C2A decision:**
  local-continuity authority (`BoundLocalContinuitySelection`) is issued ONLY for the FIRST `TaskRun` —
  require `TaskRun.attempt === 1` AND `taskRuns.listByTask(taskId)` proving no prior `TaskRun` exists; both
  the R3-C1 declarative `attemptNumber===1` and the stored `TaskRun.attempt===1` are required and must
  agree. A same-`Task` re-run after a terminal run is retry/re-run semantics outside R3-C2A (belongs to
  R3-C-Rz, NOT AUTHORIZED); a genuinely new local-continuity request enters via a NEW canonical `Task`.
  Cleanups: NB-1 `RoutingContextDigest` exact contract (domain tag `quoky:r3-c2:routing-context:v1` over the
  ten `RoutingContext` fields, domain-separated hash, not the plain JSON digest helper); NB-2 locality/
  routing-class covered by the Stage2B composite `configurationDigest`, not `RoutingContextDigest`; NB-3
  `IntentResolver` exists but is not on the GENERAL_CHAT continuation path (authoritative source stays
  `Task.intent.capability` → `TaskRun.capability`); NB-4 `createContainmentCandidateBinding` still accepts a
  bare `SoleProviderSelection` (non-production under R3-B3; future C2 preparation accepts only
  `BoundLocalContinuitySelection`); NB-5 mark the superseded R3-C2 current-state wording; NB-6 explicit
  supersedes structure; NB-7 continuation path is GENERAL_CHAT/CHAT only (SUMMARIZATION etc. not auto-wired).
  Documentation only: no code, runtime, provider, network, DB/schema, aggregate/repository, approval/security
  owner, or new `RoutingFailureCode`. One additional remediation commit on parent `04c98671` (neither
  reviewed architecture commit amended). ADR-0090 remains Proposed; independent Architecture Review pending
  before Push/PR/Merge. R3-C1 remains CLOSED + DELIVERED; R3-C2 and R3-C-Rz remain NOT AUTHORIZED.

## R3-C2 architecture / entry remediation (docs only) — 2026-09-28

- Add the "ADR-0090 amendment (remediation)" to `DECISIONS.md`, correcting the R3-C2 architecture to ACTUAL
  code ownership per accepted CHANGES_REQUIRED blockers B-1..B-5 and cleanups N-1..N-7 (facts confirmed by
  reading source). **B-1** the existing R3-B1 `SoleProviderSelection` (public
  `assertExactSoleProviderSelection`; binds only `providerId`) is NOT sufficient authority — define a NEW
  process-local issued `BoundLocalContinuitySelection` binding admitted `providerId` + R3-C1 admission
  provenance + Stage2B composite `configurationDigest` + `taskRunId/executionId` + `RoutingContextDigest` +
  canonical `capability`, minted only after the issuer invokes canonical `LocalContinuityAdmission.admit(...)`
  (process-local, not restart-valid). **B-2** no `routingContextRef` exists — define `RoutingContextDigest`
  as a domain-separated `sha256Canonical` over all ten `RoutingContext` fields, issuer-re-derived from
  `continuationRoutingContext(...)`. **B-3** `TaskRun` exists only after `ContinuationExecutionAdmissionService`
  / `TaskManager.guardedStartRun`; `executionId === taskRunId === TaskRun.id`; exact START-first ordering.
  **B-4** name real enforcement owners — `ContinuationProviderRoutingService.execute`,
  `ProviderRoutingGateway.execute` (`MAX_PROVIDER_ATTEMPTS=2`/`MAX_ADDITIONAL_PROVIDER_HOPS=1`), and
  `ContinuationExecutionAdmissionService`/`guardedStartRun`; C2A implements attempt-1/zero-hop/PRIMARY_ONLY
  at those owners (circular pre-existence rule removed). **B-5** authoritative workload =
  stored `Task.intent.capability` → boundTaskFacts → `TaskRun.capability` (no `IntentResolver` step);
  caller/model labels ignored. Cleanups: N-1 correct `CURRENT_STATE.md` R3-C1 to CLOSED + DELIVERED (PR #87
  merged), N-2 bound config identity = Stage2B composite `configurationDigest` (not
  `ContinuationProviderRoutingConfiguration.configurationDigest`), N-3 C2B after C2A, N-4 runtime feasibility
  criteria, N-5 four-layer production-trust separation, N-6 C2A exit tests, N-7 `IntentClassifier`
  `GENERAL_CHAT` default recorded as a pre-production gate. The prior "R3-C2 architecture / entry definition"
  amendment is retained as history and superseded where it conflicts. Documentation only: no code, runtime,
  provider, network, DB/schema, aggregate/repository, approval/security owner, or new `RoutingFailureCode`.
  One additional remediation commit on parent `c55ff623` (reviewed commit not amended). ADR-0090 remains
  Proposed; independent Architecture Review pending before Push/PR/Merge. R3-C2 and R3-C-Rz remain NOT
  AUTHORIZED.

## R3-C2 architecture / entry definition (docs only) — 2026-09-27

- Add the ADR-0090 amendment "R3-C2 architecture / entry definition" to `DECISIONS.md`: the security/trust
  bridge between R3-C1 admission and future containment/runtime preparation. Closes the R3-C1
  carry-forwards as ratifiable contracts — CF-1 sole-selection issuance hardening (bind issuance to the
  admitted path via the existing R3-B1 WeakSet issuer; process-local, not restart-valid), CF-2 exact
  identity binding (reuse `TaskRun`/`executionId===taskRunId` + composite config digest + routing context;
  no new identity system/schema), CF-3 attempt-1/zero-hop enforcement owned by the existing
  Stage2B/continuation orchestration boundary (no duplicate retry), CF-4 authoritative workload owner =
  deterministic classifier/policy. Places the Kind B trusted-observation issuer in sub-slice C2B (still
  DENY, no durable authenticity), defines a runtime-family feasibility comparison contract WITHOUT
  selecting a family (C2C), preserves R3-B3 fail-closed production trust as a separate future slice,
  proposes the C2A/C2B/C2C split (C2A smallest first), and excludes R3-C-Rz. Documentation only: no
  runtime, provider, network, DB/schema, approval/security owner, or new `RoutingFailureCode`. ADR-0090
  remains Proposed; independent Architecture Review pending before Push/PR/Merge. R3-C2 and R3-C-Rz remain
  NOT AUTHORIZED.

## R3-C1 exact-HEAD review remediation — B-A: Kind A administrative-only — 2026-09-27

- Correct accepted blocker B-A: Kind A no longer equals "empty eligible NETWORK set" (which conflated
  ordinary policy incompatibility with continuity evidence). Refactor Stage2B `eligible()` into
  `enabled && policyCompatible(...)` and extend the read-only `RoutingPolicyEngine.staticEligibility(...)`
  projection with `configuredNetworkProviderIds`, `policyCompatibleNetworkProviderIdsIgnoringEnabled`, and
  `policyRequiresLocalLocality`. R3-C1 Kind A is now limited to A1 (no NETWORK provider configured, policy
  not LOCAL-only) or A2 (all policy-compatible clouds administratively disabled). Quality-floor / capability
  / tool / routing-class exclusions → `CLOUD_POLICY_INCOMPATIBLE_NOT_CONTINUITY`; LOCAL-only policy →
  `POLICY_REQUIRES_LOCAL_NORMAL_ROUTING`; any enabled compatible cloud → `NORMAL_CLOUD_PATH_STATICALLY_EXISTS`
  (all DENY, normal routing). The admitted decision carries the closed `kindACondition`. Availability
  invariance, composite-config binding, local-eligibility reuse, Kind B/C fail-closed, attempt accounting,
  DENY semantics, zero runtime, and zero production trust are preserved.
- The `eligible()` refactor is behavior-preserving (Stage2B/R3-B regressions pass). Added N1/N2/N3 and Kind
  A Case 0–4 tests plus new projection-field tests. No new `RoutingFailureCode`, DB schema, aggregate,
  approval/security owner, Kind B issuer, production trust/capability issuer, runtime family, or network
  path. R3-C2 and R3-C-Rz remain NOT AUTHORIZED. `pnpm typecheck` passes; the only full-suite failure is the
  unrelated env-sensitive `github-app-git-provider.test.ts` (`GIT_ASKPASS` set), left unmodified. Local
  commit only; Push/PR/Merge require review PASS.

## R3-C1 exact-HEAD review remediation (canonical cloud path + composite config) — 2026-09-27

- Remediate the R3-C1 admission contract against the `CHANGES_REQUIRED` verdict (one commit on top of
  reviewed `ab0db3a0`, not amended). B-1: remove caller-controlled `normalCloudProviderId` /
  `requiredCloudProviderIds` (probes P1/P2/P3 closed). B-2: Kind A now means "no statically eligible
  NETWORK/cloud provider for the matched policy", derived via a new Stage2B-owned read-only
  `RoutingPolicyEngine.staticEligibility(...)` projection that never consults availability/`isAvailable()`/
  `availabilityClass`/snapshot and never fabricates an AVAILABLE snapshot, does not rank/select/plan/invoke/
  mutate. B-3: bind admission to the composite (registry + policy) `configurationDigest` identical to
  `select` (probe P7 closed; registry-only/stale-policy refs rejected). Remove duplicated local-provider
  floor logic (reuse the same static projection). Rename Kind B/C entry points to
  `assert*Unsupported` (always throw). Make `deriveKindAStaticFacts` internal. Correct the earlier
  overclaim about `SoleProviderSelection` non-forgeability (it is a pre-existing R3-B1 public assertion).
- Add `StaticEligibilityProjection` to routing contracts and independent `staticEligibility` tests
  (availability-independent, no ranking/selection/plan). No new `RoutingFailureCode`, DB schema, aggregate,
  approval/security owner, Kind B issuer, production trust/capability issuer, runtime family, or network
  path. R3-C2 and R3-C-Rz remain NOT AUTHORIZED. Focused + Stage2B + R3-B1/B2/B3 regressions and typecheck
  pass; the only full-suite failure is the unrelated env-sensitive `github-app-git-provider.test.ts`
  (`GIT_ASKPASS` set in shell), left unmodified. Local commit only; Push/PR/Merge require review PASS.

## R3-C1 Local Continuity Eligibility & Static Trusted Admission — 2026-09-27

- Add Core Application `local-continuity-admission.ts`: a pure, runtime-independent admission contract for
  future contained local continuity. `WorkloadLocalFallbackPolicy` (deterministic, versioned,
  `Capability`-keyed; coding/architecture/document-comparison ineligible by default); internal Kind A
  static-fact derivation from the canonical `ProviderRegistry` (closed set: not-configured /
  administratively-disabled / required-config-absent), never from availability/`isAvailable()`/
  `availabilityClass`/quality-floor/caller-supplied evidence, bound to `configurationDigest`; Kind B DENY
  (no issuer) and Kind C DENY (unsupported, R3-C-Rz); independent capability + quality-floor check reusing
  `RoutingPolicyEngine`; exact PRIMARY_ONLY sole-selection handoff via the R3-B1
  `assertExactSoleProviderSelection` boundary; fixed attempt accounting (attempt 1, zero hops). DENY means
  local-continuity-not-admitted, not a whole-request STOP. Zero containment/runtime preparation; zero
  production trust; R3-B3 fail-closed boundary preserved. Exported through the `@quoky/core` application
  barrel (no test-only leakage). Closes ratified NB-1 (closed Kind A source) and NB-2 (DENY semantics).
- No new `RoutingFailureCode`, DB schema/migration, aggregate/repository, approval/security owner, runtime
  family, or runtime/provider/network path. Focused suite (32 tests) + Stage2B and R3-B1/B2/B3 regressions
  pass; full `packages/core` + `packages/storage-sqlite` suites pass (2138 tests); `pnpm typecheck` passes.
  R3-C2 and R3-C-Rz remain NOT AUTHORIZED. Local commit only; Push/PR/Merge require independent exact-HEAD
  review PASS.

## R3-C bounded task definition blocking remediation (docs only) — 2026-09-27

- Correct the ADR-0090 R3-C amendment in `DECISIONS.md` (docs-only, on a remediation branch; the reviewed
  commit `9e2ff6be5cef6cf44186001cf700500997ad180c` is not amended). B-1: Kind B
  `TRUSTED_CURRENT_UNAVAILABILITY` has no trusted issuer → contract-defined, issuer NOT IMPLEMENTED, ALWAYS
  DENY in R3-C1, with an explicit future issuer boundary and no persisted/rehydrated Kind B. B-2: Kind A
  `STATIC_INELIGIBILITY` is derived internally from canonical registry/config facts, never caller-supplied,
  never availability-derived; quality-floor exclusion is not outage evidence. B-3: exact attempt accounting
  (attempt 1, zero additional hops, no cloud attempt before or after). B-4: Kind C `PRIOR_ATTEMPT_FAILURE`
  unconditionally unsupported/DENY (belongs to R3-C-Rz). N-1..N-6 cleanup: explicit `REENTER_L0…`
  definition, draft `localFallbackAllowed=false` default, quota/rate/overload interim clarified as
  conceptual-only, full R3-C1 admission order, fail-closed case list with STOP/DEFER mapping. R3-C1 renamed
  "Local Continuity Eligibility & Static Trusted Admission Contract".
- Bring `CURRENT_STATE.md` to current canonical truth: R3-B2/R3-B3 projected as CLOSED + DELIVERED
  (historical audit detail retained), and the R3-C entry updated to the remediated static-only contract.
- ADR-0090 remains Proposed; independent Architecture Review pending before Push/PR/Merge. No product code,
  runtime, provider, network, DB/schema, approval/security owner, or new `RoutingFailureCode`.

## R3-C bounded task definition (docs only) — 2026-09-27

- Add the ADR-0090 amendment "R3-C bounded task definition (Local Continuity Eligibility & Trusted
  Admission)" to `DECISIONS.md`, closing carry-forwards N-1..N-6 enough that R3-C1 implementation scope is
  unambiguous. Documentation only: no runtime, provider, network, DB/schema, approval/security owner, new
  `RoutingFailureCode`, or runtime-family selection. Defines pre-dispatch `CloudUnavailabilityEvidence`,
  PRIMARY_ONLY separation, N-3 control re-entry invariant, N-4 draft-vs-execute mapping, N-5 failure-term
  mapping to the existing `routing-failure-matrix-v4`, N-6 Ollaya non-requirement, and an R3-C1/R3-C2/
  R3-C-Rz split. ADR-0090 remains Proposed; independent Architecture Review pending before Push/PR/Merge.

## R3-B2 blocking remediation — 2026-09-26

- Share one canonical v1 containment binding digest constructor between issuance and prepared-evidence
  persistence validation; reject cross-run ID rewriting and policy/runtime/model-mount identity tampering.
- Reject generic terminal transitions for current containment-bound STARTED rows inside the existing
  SQLite transaction, preserving secure terminalization as the sole terminal path.
- Add explicit in-memory digest-replay and completeRun/failRun bypass tests. Reviewed history is preserved;
  new independent exact-HEAD review required. Production provenance and R3-C+ remain deferred.

## R3-B2 secure terminalization and containment evidence — 2026-09-26

- Route continuation receiver terminal outcomes through current-row security-preserving TaskManager persistence.
- Preserve newer containment evidence across stale receiver snapshots; persisted post-attempt uncertainty
  vetoes terminalization and retains STARTED / UNRESOLVED.
- Bind verified preparation to the exact continuation run, policy and bounded runtime/model-mount identity;
  project to R3-A evidence with distinct Provider/containment digests and both verifier identities.
- Reject unissued profile/instance copies and add fake-only projection, exact-run and persistence integration
  coverage. No production runtime/capability issuer or live activation; independent review pending.

## R2 continuation receiver review remediation — 2026-09-26

- Reject enabled continuation mode through production config until R3 containment exists.
- Preserve uncertainty after Gateway invocation; keep validation corpus in Application facts, outside
  Provider contextFiles, with existing Runtime validation behavior preserved.
- Validate destination profile minimum prompt feasibility in the offline activation factory.
- Add startup, post-Provider escape, corpus visibility, multibyte/boundary profile, primary-only,
  missing validation profile, registration-order digest, and real ArtifactManager regressions.

## [Unreleased]

### Added — Production Continuation Receiver R1: Core contract / lifecycle semantics (local, awaiting review)

- Extended the Core `ContinuationReceiver` port with an immutable `supportedCapabilities` list that only
  narrows eligibility (the canonical Task stays the capability source). 6K snapshots and freezes the
  declaration before the first await; empty/duplicate/malformed declarations fail closed
  (`DENY / RECEIVER_PREFLIGHT / RECEIVER_UNAVAILABLE`) before any start. The public caller cannot supply a
  support list; `PUBLIC_REQUEST_CAPABILITY_OVERRIDE = NO`.
- Added a package-internal, non-authoritative `ContinuationExecutionConstraint` (absent from the public
  request DTO and transport surface) that drives an early capability check before `prepare` and an
  effect-time recheck over the Entry fresh `facts.task` snapshot — the exact object that becomes the
  guarded-start expected Task — closing the receiver-support capability TOCTOU at the existing SQLite
  transactional deep-equality invariant with no new expected field.
- Extracted the unchanged Family-A seven-capability allowlist into a single `isFamilyACapability`
  predicate shared by the Product policy and the constrained Entry revalidation; the Family-A recheck
  applies on the constrained path only. Generic `ContinuationExecutionEntryService.start` semantics are
  unchanged (no global Family-A specialization).
- The constrained Entry now returns immutable `boundTaskFacts { capability, intentType }` derived from the
  same guarded-start-bound Task snapshot, so the receiver observes canonical intent without any post-start
  Task re-read (`CANONICAL_INTENT_SOURCE = GUARDED_START_BOUND_TASK_SNAPSHOT`).
- Made `ContinuationReceiverOutcome` three-state (`SUCCEEDED` / `FAILED` / `UNRESOLVED`) with no new
  `TaskRunStatus`. Added a bounded, provider-agnostic `ContinuationRoutingAudit` DTO in the Core port layer
  (no raw prompt/output/error, path, secret, credential, environment, `descriptor.modelId` or unbounded
  metadata; explicit unknown/null, never a fabricated `attemptCount = 0`).
- `receiver UNRESOLVED` and any escaped `receiver.receive(...)` exception both resolve to
  `ATTEMPT_UNRESOLVED`: the exact run remains STARTED, `completeRun = 0`, `failRun = 0`, no persisted
  UNRESOLVED audit, and no retry/redispatch/replacement. Intentional `DELIVERED_TEST_CONTRACT_CHANGE`: the
  delivered `6K receiver throw → failRun` and `6L throw → persisted FAILED` tests were updated to
  `throw → ATTEMPT_UNRESOLVED`.
- Added 44 focused R1 tests: receiver support-declaration validation, bounded outcome/audit validation
  matrix, adversarial capability TOCTOU, Family-A constrained-only vs generic, and canonical intent
  binding. Amended ADR-0089 in `DECISIONS.md` with the ratified R1 semantics.
- No R2/R3 work: no provider routing, prompt composition, artifact persistence, production receiver
  binding, `QUOKY_CONTINUATION_RECEIVER_MODE`, external trigger or Provider execution. R2/R3 = NOT STARTED;
  `LIVE_CONTAINMENT_READY = NO`; `CONTINUATION_EXECUTION_ACTIVATION = DISABLED`.
- Validation on Node 18.20.5: focused continuation suite 14 files / 359 PASS (44 new); typecheck, build and
  diff check PASS (test-process `GIT_ASKPASS` unset). No production readiness claimed.

### Added — M3E-6L Offline Activation Acceptance (local, awaiting review)

- M3E-6K closed and delivered through PR #77 at `0b0c3be7c5d8d592b0739b4e8436bfa61731c185`.
- Added an isolated Nest acceptance suite reusing production lifecycle/entry/execution/profile factories,
  real Core owners, test-owned SQLite and a test-only fake CONTINUATION_RECEIVER binding. Added a minimal
  receiver execution composition candidate, deliberately absent from production AppModule.
- Proved real success/failure/throw terminalization of the exact frozen started run, actor/project and
  capability denial, no human wait, lost-plan denial, approval non-authority, profile/receiver preflight,
  pre-start failure shapes, unresolved STARTED non-redispatch and terminal-run delete protection.
- Recorded a 19-row ADR-0089 Family-A acceptance matrix (15 PASS, 4 bound to executed existing regressions,
  zero FAIL), including contention/no retry, CANCELED revival, ordinary conversation and raw-SQL carve-out.
- No new runtime semantics, Provider integration, transport, production binding, schema or Approval fields.
  Offline acceptance passes locally; independent review is pending. Activation remains DISABLED and strict
  live-execution authorization is NOT GRANTED; general post-wait contracts remain UNRESOLVED / DEFERRED.

- Validation on Node 18.20.5: focused 15 files / 881 PASS; final full suite 161 files / 3,292 PASS
  (test-process GIT_ASKPASS unset); typecheck, build, direct strict test typecheck and diff check PASS.

### Added — M3E-6K Receiver Seam and Exact-Run Terminalization (local, awaiting review)

- Added provider-agnostic ContinuationReceiver port and sibling ContinuationReceiverExecutionService.
  Receiver prerequisites are checked before existing 6J start; immutable input carries canonical handoff,
  exact destination profile, caller-owned snapshotted plan and the exact started run.
- Reused TaskManager.completeRun/failRun for exact-run terminalization, without Task terminalization,
  post-start run lookup or retry. Receiver throws/malformed outcomes use a fixed failure code; persistence
  failures propagate without fallback or fabricated terminal states. Process crashes may leave STARTED.
- Shared the existing strict request-key check with 6J, preserving its behavior and rejection of injected
  canonical facts/authority. No Provider, production receiver binding, external transport or activation.
- Added fake-receiver tests and focused real-6J/SQLite integration for success, controlled failure and
  exception persistence; preserved existing safety contracts and deferred general post-wait concerns.
- Validation on Node 18.20.5: focused 2 files / 30 tests passed; full suite 160 files / 3,272 tests passed
  with inherited GIT_ASKPASS removed only from the test process. Typecheck, build, direct new-test typechecks
  and diff checks passed. No failure-remediation rounds were needed.


### Added — M3E-6J Explicit Continuation Caller (local, awaiting review)

- Added ContinuationExecutionService using the existing immutable context contract/factory, canonical
  handoff consumption, exact binding/work/task reads, Product policy, lifecycle preparation and entry.
  Product denial precedes mutations; approval wait fails closed; entry runs at most once and returns its
  exact TaskRun with typed race/contended-storage failures preserved. No retry or run rediscovery.
- Wired the service and existing entry through explicit production factories. No external trigger transport,
  receiver, Provider or terminalization; activation remains disabled and M3E-6K is not started.
- Closed the 6I-b canonical relationship resolution and context-factory carry-forwards. Preserved the
  no-wait defense-in-depth checks, supported-and-declared step rule and deferred general post-wait questions.
- Added focused canonical-chain, caller-injection, async snapshot, policy-before-mutation, approval-wait,
  exact-run and no-retry tests, plus offline production-factory composition with real Core owners and SQLite.
- Validation on Node 18.20.5: focused 2 files / 48 tests passed; full suite 158 files / 3,242 tests passed
  with inherited GIT_ASKPASS removed from the test process only. Typecheck, build, direct typechecks of
  both new test files and diff checks passed. No remediation/revalidation rounds were needed.


### Added — M3E-6I-b Initial No-Wait Continuation Policy (local, awaiting review)

- Recorded Product-approved explicit trigger, exact request actor/project authorization and seven-capability
  allowlist; selected ratified ADR-0089 Family A (no human wait).
- Added caller-owned immutable context factory and pure Product policy using the shared live-plan proof,
  RiskPolicy and ApprovalPolicy. Fail closed on absent live plans, capability escalation and human approval
  requirements, regardless of an existing approved request. No approval acquisition or execution effects.
- Preserved general post-wait plan supply and operation-scoped Approval proof as unresolved/deferred.
  No schema/persistence changes; M3E-6J not started; receiver invocation unimplemented; activation disabled.
- Added direct Product Decision, actor/project, capability, human-wait, approval-bypass, live-plan and
  immutability/purity tests. Existing lifecycle, admission, entry and guarded-start ownership are unchanged.
- Validation on Node 18.20.5: focused/regression 14 files / 384 tests passed; typecheck and direct new-test
  typecheck passed. Full suite passed 156 files / 3,194 tests after removing inherited `GIT_ASKPASS` only
  from the test process (initial run: one unrelated environment-presence assertion failed). One revalidation.


### Changed — M3E-6I-a Shared Structural Live-Plan Predicate (local, awaiting review)

- Extracted the duplicated pure structural live-plan proof into one Core module,
  `application/continuation-live-plan-proof.ts`, now used by both `WorkHandoffContinuationService.prepare`
  and `ContinuationExecutionAdmissionService.evaluate`. A source audit confirmed three genuine duplications:
  the live-plan structural validation block, the plan-reference/integrity comparison nested in two
  differently-scoped approval checks, and the `text`/`timestamp` micro-helpers.
- Kept the shared proof pure and boolean-returning: no storage, ApprovalManager, TaskManager,
  AgentProfileRegistry, Provider, environment, configuration or mutable state, and no new failure taxonomy,
  decision object or authority value. Each caller maps a rejection into its existing bounded reason, so
  public error codes are unchanged.
- Did not flatten gate semantics. Approval-policy consistency derivation stays per-caller; `prepare` still
  owns the `requestedBy` requester requirement and the exact `ApprovalRequest.id` check; admission still does
  not require `requestedBy`; and the differing lifecycle expectations (admission requires RUNNING, preparation
  accepts PENDING/PLANNING/WAITING_APPROVAL) are preserved. No TaskRun creation, guarded start, receiver call
  or broadening of `ContinuationExecutionEntryService`.
- Preserved caller-owned live plans: nothing is persisted, cached or reconstructed from `Task.planId`, an
  `ExecutionPlanRef` or an `ApprovalRequest`. `Task.planId` participates only as a structural consistency
  check and never as authority.
- Added 52 focused tests: a table-driven one-field-at-a-time mutation matrix over every structural dimension,
  integrity and plan-ref comparison cases, order/history independence, purity assertions over the module
  boundary, and cross-consumer consistency proving no structural mismatch can be accepted by one consumer
  while rejected by the other, with no lifecycle transition or write on rejection. Existing prepare,
  admission, entry, guarded-start, persistence-safety and config suites pass unchanged as parity evidence.
- No new aggregate, repository, schema, migration, durable state, Approval model or ExecutionPlan repository.
  Post-wait live-plan source and operation-scoped Approval proof remain UNRESOLVED; `ApprovalRequest` still
  has no kind/purpose/operation field. This is the last ratified slice before the Product Decision gate, which
  is NEXT and NOT REACHED — trigger, authorized Actor/Project scope and receiver capability set were not
  chosen. Receiver invocation remains NOT IMPLEMENTED and continuation activation DISABLED. Local only: no
  Push/PR/Merge, no Runtime, Provider, network, Discord, secret read or shared-DB action.

### Added — M3E-6H Static AgentProfile Configuration (delivered, PR #73)

- Removed the hardcoded production `new AgentProfileRegistry([])` and replaced it with the ratified typed
  configuration surface. `QUOKY_AGENT_PROFILES` is parsed only in `apps/quoky/src/config.ts`, following the
  existing `QUOKY_ACTOR_IDENTITY_MAPPINGS` JSON convention, and the composition root freezes the validated
  list into one immutable `AgentProfileRegistry` snapshot. No env var is read in Core or any adapter.
- Accepted exactly the five existing domain fields (`id`, `displayName`, `role`, `purpose`, `instructions`)
  with no new Product semantics. Strict parsing fails closed on invalid JSON, non-array root, non-object or
  null entry, missing or non-string field, invalid id shape, duplicate id, any unknown key, blank or oversized
  text, more than 64 entries and a payload above 1 MiB. Unknown-key rejection refuses authority-shaped
  configuration — provider pins, API keys, credential or secret references, executable paths, commands, Tool
  allowlists, capabilities, permissions and approval flags — instead of silently ignoring it.
- Kept canonical bounded-text, control-character, identity and duplicate rules owned by
  `AgentProfileRegistry`; the config layer adds structure, duplicate detection and size bounds and reports the
  failing key with a bounded indexed code. Configuration errors never echo raw `instructions`, secret-shaped
  values or the payload, which a sentinel test asserts. Profile ids are never trimmed, lowercased or
  case-folded, and lookup still uses the single existing registry path with no alias or fuzzy matching.
- Preserved today's fail-closed startup: absent, blank or `[]` configuration yields an empty registry and an
  unknown profile lookup still throws. Asserted that the registry is one immutable startup snapshot —
  mutating the source array or objects afterwards cannot change it, resolved profiles and the registry are
  frozen, and no register/replace/remove/reload API exists.
- Documented the public `QUOKY_AGENT_PROFILES` contract in `.env.example` using domain fields only, with no
  secrets and no internal class names.
- Configuration availability is the only change: a configured profile selects no Provider and grants no
  capability, Tool authority, approval state or execution trigger, proven structurally. No new aggregate,
  repository, schema, durable state or runtime registration API; dependency direction preserved and
  AgentProfile remains configuration-only. Product trigger remains UNSELECTED, the Product Decision gate
  NOT REACHED, receiver invocation NOT IMPLEMENTED and continuation execution activation DISABLED.
  Local only: no Push/PR/Merge, no Runtime, Provider, network, Discord, secret read or shared-DB action.

### Added — M3E-6G TaskRun Persistence Safety (delivered, PR #72)

- Overrode the inherited generic delete on the SQLite TaskRun repository to refuse deletion of every
  continuation-bound TaskRun, including SUCCEEDED/FAILED/CANCELED terminal history. The refusal derives from
  the persisted row's own `task_id` and the canonical `continuation_bindings` entry inside one `IMMEDIATE`
  transaction, never from a caller flag, argument, convention or run status. Bound-run retention is
  load-bearing: `WorkHandoffContinuationService.resolveRun` returns exact historical provenance and ordinal
  allocation is `MAX(attempt)+1`.
- Preserved unbound TaskRun deletion and missing-id no-op semantics. Closed the repository-port delete
  bypass while explicitly claiming no immunity against arbitrary direct SQL. Asserted, rather than
  duplicated, the existing v11 `task_runs_immutable_start` protection against re-parenting a bound run.
- Made the SQLite lock wait explicit adapter configuration: `DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000` preserves
  the previously implicit driver default and optional `SqliteConfig.busyTimeoutMs` is validated as a bounded
  non-negative safe integer. The timeout stays storage-owned; no SQLite type reaches Core.
- Translated recognized driver lock contention before any successful commit into the typed
  `TASK_RUN_STORAGE_BUSY` outcome, kept distinct from the canonical `UNRESOLVED_STARTED_RUN` live-attempt
  conflict. Unknown infrastructure failures keep existing conventions and are not swallowed. Automatic
  Application retry is NO: the bounded driver wait inside one call is not retry, and a busy outcome commits
  zero TaskRuns and fabricates no attempt identity.
- Added 18 focused real-SQLite tests covering bound delete refusal per status, unbound/missing-id
  preservation, re-parenting evasion, ordinal monotonicity, the raw-SQL carve-out, a six-child-process
  delete-versus-guardedStart race with zero successful deletes and zero replacement attempts, real lock
  contention mapping, contention-versus-live-attempt distinction, and `STARTED → CANCELED` with
  `CANCELED → STARTED` revival denied. No `cancelRun` and no receiver cancellation path were added.
- No new aggregate, repository, schema, migration, durable state or TaskRun status; dependency direction and
  TaskRun repository ownership unchanged. AgentProfile configuration, Product trigger, post-wait live-plan
  contract, operation-scoped Approval changes, production caller and receiver invocation remain out of scope
  and NOT IMPLEMENTED; continuation execution activation remains DISABLED. Local only: no Push/PR/Merge, no
  Runtime, Provider, network, Discord or shared-DB action.

### Added — M3E-6F Continuation Activation Readiness Architecture (ADR-0089 Ratified, local)

- Ratified ADR-0089 by Chief Architect decision after independent Architecture Review
  PASS_WITH_NON_BLOCKING_FINDINGS. Activation readiness remains NO. ADR-0087/0088 are not reopened.
- Ratified prohibition of repository deletion for every continuation-bound TaskRun including terminal
  history, strengthened with verified evidence: `WorkHandoffContinuationService.resolveRun` returns exact
  historical bound-run provenance, and ordinal identity is `MAX(attempt)+1`, so deleting the highest
  attempt permits ordinal reuse. Raw-SQL immunity is NOT claimed; unbound-Task test cleanup is unaffected.
- Ratified explicit bounded lock wait plus typed storage-contention outcome, kept distinct from
  `UNRESOLVED_STARTED_RUN`; the SQLite adapter owns driver translation and Core depends on no driver types.
  Automatic Application retry is NO.
- Ratified static AgentProfile input through existing typed application configuration with no new
  repository: composition-time, immutable, non-secret, non-authoritative; not an Actor, Provider, Tool
  authority or standing execution permission. No Provider pinning, credentials, paths or Tool allowlists.
- Ratified the narrow Core `ContinuationExecutionService` as both continuation coordinator and receiver
  invocation owner, one invocation on the exact returned TaskRun with `TaskManager.completeRun`/`failRun`
  terminalization. Ambiguous outcomes stay ambiguous STARTED; no fabricated outcome, replacement run,
  restart recovery or invented `cancelRun`. `WorkHandoffContinuationService` stays preparation;
  `ExecutionOrchestrator` stays stateless intra-task composition; `ConversationRuntime` is not the owner.
- Recorded the shared post-wait caller-context problem as one M3E-6I-b concern: no authoritative post-wait
  live-plan source exists today, no supply contract is defined, persistence is NOT PROVEN, reconstruction
  from `Task.planId`/`ExecutionPlanRef`/`ApprovalRequest` is prohibited, and three resolution families are
  recorded without selection. Operation-scoped Approval proof is required with no new Approval model, field
  or schema; if existing contracts cannot prove scope, activation stays disabled pending a reviewed amendment.
- Carried `CONTINUATION_TRIGGER = UNSELECTED / PRODUCT_DECISION_REQUIRED` and
  `AUTHORIZED_ACTOR_PROJECT_SCOPE = PRODUCT_DECISION_REQUIRED` (relational consistency is not
  authorization); ratification with the trigger unselected is sound because every acceptable trigger invokes
  the same coordinator contract. CANCELED coverage and revival denial are activation requirements.
- Corrected the ratified slice order to M3E-6G, M3E-6H, M3E-6I-a (independently actionable) → Product
  Decision gate → M3E-6I-b → M3E-6J → M3E-6K → M3E-6L, and updated the activation matrix so live-plan
  supply and operation-scope proof are post-gate only. M3E-6E delivery remains recorded as PR #70 at
  `c603f0923d20b463907b471f127f5f870225a4ac`.
- No prerequisite is implemented: delete protection, busy contract, profile configuration surface and
  receiver invocation remain NOT IMPLEMENTED and activation DISABLED. Docs-only: no Product code, DB,
  configuration, receiver, runtime, Provider, network or cleanup execution. Runtime start, Provider
  invocation, network execution, Live UAT and Production activation remain separate strict approvals not
  granted by ratification, merge, configured profiles or offline acceptance.

### Added — M3E-6E Guarded Atomic TaskRun Start (delivered, PR #70)

- Implemented ADR-0088's sibling `TaskRunRepository.guardedStart` and TaskManager delegation. Core
  `ContinuationExecutionEntryService` retains exactly the snapshots read by fresh admission, derives
  expected refs from the caller-owned live plan, then returns the exact committed TaskRun. Approval/Risk
  policy stays in Core; no plan persistence/reconstruction, Approval acquisition or Task transition.
- SQLite verifies canonical handoff, binding, ACTIVE work, RUNNING task, Actor/Project relationships,
  exact APPROVED request/ref/integrity and absence of unresolved STARTED in one IMMEDIATE transaction.
  Its single commit starts the real attempt. Concurrent calls yield at most one winner; ordinal MAX is
  allocation only, never rediscovery. No schema, table, index or durable-state addition.
- Closed ordinary-start bypass using persisted binding presence and save bypass for novel bound rows;
  rejected terminal → STARTED revival while preserving completeRun/failRun updates. Raw SQL fixtures
  remain outside adapter-contract protection; one historical fixture now explicitly uses raw SQL.
- Verified 33 focused tests (including six real child processes: one winner/five bounded conflicts),
  646 relevant regressions and typecheck under Node 18.20.5. No Product Runtime or external execution.
- M3E-6D is delivered through PR #69 at `bab2e197151f9682298697be0cf5b18cb8f1e79b`. M3E-6E is delivered
  through PR #70 at `c603f0923d20b463907b471f127f5f870225a4ac`; production continuation trigger,
  AgentProfile configuration surface and receiver
  invocation remain NOT IMPLEMENTED, activation DISABLED. No automatic post-start recovery is added.
  Duplicated live-plan predicates and the non-atomic pending-Approval acquisition window remain tracked.

### Added — M3E-6D Continuation Task Lifecycle Wiring (local, awaiting review)

- Added `WorkHandoffContinuationService.prepare` as the production Application lifecycle caller over
  exact admitted handoff/task identity. Existing `TaskManager.transition` alone walks PLANNING and,
  where required, WAITING_APPROVAL before RUNNING. No transition graph or lifecycle ownership change.
- Composed existing binding, Task and Approval owners in `apps/quoky`; lazy binding-port delegation
  respects storage initialization order. Explicit preparation is reachable through the DI entry with valid
  configured profiles; no new transport trigger or automatic dispatch, and no default agent invented.
- Reused ApprovalManager acquisition and exact decision reads with the original caller-owned live plan.
  Approval-pending reentry waits, missing live plan fails closed, and incompatible risk facts cannot
  silently auto-approve. Running reentry is a no-op; terminal, mismatched binding, inactive work and
  Actor/Project mismatch deny without Task mutation. No persisted/reconstructed plan or new Approval model.
- Added real-owner lifecycle tests, production Nest composition coverage and disposable SQLite persistence
  checks, including zero run side effects and separate admission revalidation after RUNNING. Relevant
  ConversationRuntime, TaskManager, Approval and continuation regressions remain covered.
- ADR-0088 remains Ratified. Guarded start is NOT IMPLEMENTED, receiver invocation NOT IMPLEMENTED,
  continuation execution activation DISABLED. No TaskRun creation/start, schema change or product runtime
  execution. Lifecycle reads/transitions remain non-atomic; future guarded start must independently
  revalidate effect-time authority. Local implementation awaits independent review; no delivery claim.

### Added — M3E-6C Effect-Time Guarded Continuation Start Architecture

- Ratified ADR-0088 by Chief Architect decision following independent Architecture Review
  PASS_WITH_NON_BLOCKING_FINDINGS at `d43c0b51fc5f869aa70a516c61df1d6ff017f330`;
  ADR_0088_READY_FOR_CA_RATIFICATION = YES. Option B and existing TaskRun ownership are preserved.
- Carried forward continuation Task RUNNING owner wiring as a required activation prerequisite, and
  clarified that approval acquisition and guarded-start Approval revalidation are distinct gates. Accepted
  the persistence-level expected-facts read surface and explicitly retained the direct-SQL/fixture limitation.
  Guarded-start implementation is NOT STARTED; lifecycle wiring and receiver invocation are NOT IMPLEMENTED;
  continuation execution activation remains DISABLED. This closeout is documentation-only and local.

- Proposed ADR-0088 defining where a STARTED TaskRun becomes truthful as a real execution attempt: the single
  commit of a guarded start transaction is the linearization point. Architecture and documentation only; no
  Product code, schema or migration change, and no receiver invocation.
- Selected Option B — a sibling guarded-start operation on the existing `TaskRunRepository` port — keeping
  `TaskManager`/`TaskRunRepository` as the canonical TaskRun start owner, with Core supplying bounded expected
  canonical facts that the adapter verifies atomically. No new aggregate, repository, schema, durable state,
  queue, worker, lease or lock.
- Classified effect-time facts as atomically guarded, freshly read, immutable provenance, or caller-owned
  non-persisted, and specified at-most-one concurrent start winner, bounded failure reasons, and bypass
  closure that refuses new STARTED runs for continuation-bound Tasks while preserving terminal
  complete/fail updates.
- Recorded the audited lifecycle gap: continuation binding admits at Task PENDING, admission requires RUNNING,
  and no production owner performs that transition. Surfaced as an activation prerequisite rather than
  invented. Approval proof requirements are unchanged.
- Synchronized M3E-6B delivery state: delivered through PR #67 at merge commit
  `c0c91f341cb5f300628b86506c84e329d4f14eac`, replacing the stale "awaiting review and delivery" wording.

### Added — M3E-6B Read-only Continuation Execution Admission Evaluation

- Implemented an unwired Core Application evaluator over canonical read ports, returning frozen ephemeral
  eligibility or bounded denial. It never creates/starts/saves a TaskRun, changes lifecycle, or invokes execution.
- Defined unresolved STARTED as the bound Task's persisted run status STARTED, without timestamp heuristics
  or latest-run authority. Checks binding/work/task/profile relationships and exact conditional approval scope.
- Added focused eligibility, denial, approval-integrity, run-history, restart/repeated-read and zero-mutation
  tests. Atomic guarded start and insertion bypass closure remain future activation prerequisites.
- ADR-0087 remains Ratified and was delivered through PR #66. This evaluation implementation is local only;
  receiving-agent execution, continuation attempt start, schema changes and runtime wiring are not included.

### Architecture — M3E-6A Continuation Execution Admission

- Ratified ADR-0087 by Chief Architect decision following independent exact-HEAD Architecture Review
  PASS_WITH_NON_BLOCKING_FINDINGS at `90a67de840df71db2872b2a15e49c0efd117e93f`;
  ADR_0087_READY_FOR_CA_RATIFICATION = YES. The substantive architecture remains unchanged.
- Carried forward the exact canonical unresolved STARTED predicate and guarded-start bypass closure across
  generic taskRuns.save(), legacy callers and other insertion paths as implementation requirements, not
  ADR blockers. Existing TaskManager / TaskRun ownership remains; M3E-6 implementation is NOT STARTED.

- Proposed ADR-0087 for independent Chief Architect review: Core Application composition over existing
  owners, exact TaskRun.id binding, effect-time revalidation and fail-closed restart/replay; no new
  aggregate, repository, schema, admission state machine or receipt. M3E-6 implementation is NOT STARTED.
- Recorded the current atomic-start and Approval limitations, and the existing-owner guard hardening
  needed before future receiving-agent activation. Admission assessment does not invoke or reserve execution.
- Clarified the ADR-0086/PR #61 historical checkpoint nesting below without changing its delivery history.

### Maintenance — Quoky Platform external rename

- Renamed the GitHub repository `chunsik-bot` → `quoky-platform` and the local workspace directory
  `chunsik-bot-2` → `quoky-platform`, aligning external identity with the already-delivered source identity.
  The rename preserved history, issues and pull requests; no repository was recreated and no Git history was
  rewritten. `origin` now points at `jonghyungJeon-private/quoky-platform`.
- Updated the only active tracked absolute-path reference, the egress allowlist runner working directory, and
  the two disposable-workspace guards that assert a test repo is not the physical product repository.
  Historical ADR, plan, review and checkpoint records keep their original names and paths.
- No Product behavior, domain, execution, approval or schema change; persisted `data/chunsik.db`,
  `.chunsik/context.md`, `.chunsik/task.md` and `.chunsik-tmp` compatibility paths are untouched.

### Maintenance — Pre-M3E6 housekeeping

- Commented out GitHub owner/repo canonical examples to preserve legacy alias fallback without changing runtime precedence.

- Commented out six optional canonical connector variables in `.env.example` so omitted QUOKY keys do not
  shadow legacy CHUNSIK aliases. Runtime nullish precedence and configuration code are unchanged.
- Aligned the current ACTIVE_MILESTONE pointer in AGENTS.md and Development Mode from M2 to M3, as confirmed
  by Current State, Roadmap and the ratified M3 rebaseline. Historical M2 records and approval boundaries remain unchanged.

### Changed — Quoky Platform Product Identity

- Migrated active workspace packages to `@quoky/*`, composition root to `apps/quoky`, and root package to
  `quoky-platform`; renamed current Product symbols without changing domain/execution semantics.
- Added canonical QUOKY environment names with legacy CHUNSIK aliases and explicit canonical precedence.
  Existing database, context and temporary-path contracts remain unchanged; no data/schema migration.
- Modernized README and synchronized M3E-5 delivery through PR #60 at
  `bef459aaf3a77549dd44760a21ea839073b0cb46` (ADR-0085 Ratified, schema v11).
- ADR-0086 is Ratified following independent PASS_WITH_NON_BLOCKING_FINDINGS (0 blocking findings)
  and Chief Architect approval of implementation `34f911174429385ca3b954df2cc0ddc7888a3230`.
  At that local implementation/ratification checkpoint, no remediation was required before delivery;
  source delivery, external repository rename, runtime activation and Execution Admission implementation
  had not occurred in that Sprint.
- Subsequent source delivery: PR #61 (merge commit `9014a6190a167a1414197faeae2ad21164d930df`).
  The separately authorized external rename is recorded above; neither event implements Execution Admission
  or activates runtime.

### Added — M3E-5 Atomic TaskRun Start and Attempt Allocation

- Made the canonical TaskRun start boundary atomic: a storage-neutral `TaskRunRepository.start()` replaces the
  former `listByTask().length + 1` allocation, so storage owns concurrent ordinal allocation while Core gains no
  SQLite dependency. TaskRun remains the canonical execution-attempt identity and `attempt` an ordinal within one
  Task; no ExecutionAttempt aggregate, receipt kind, retry engine, lease, scheduler or Agent runtime is added.
- Added SQLite v11 enforcement of `(taskId, attempt)` uniqueness and immutable start identity. A start requires a
  canonical Task already RUNNING; stale, missing or non-RUNNING Task snapshots are rejected with no partial write.
  Existing `completeRun`/`failRun` update semantics and CAP-013/Approval/Provider ownership remain unchanged.
- Added disposable SQLite atomic-start, cross-connection allocation, fail-closed and migration v11 forward/rollback
  coverage. No continuation auto-run wiring, Provider/Tool execution or execution authority is introduced.
- Ratified ADR-0085 for independently reviewed implementation `ff12ffa73e68ffc810b4a7d9698c219a378cc382`
  (PASS_WITH_NON_BLOCKING_FINDINGS, 0 blocking findings); synchronized canonical M3E-4 delivery through
  merged PR #59 (`285f3663beff5334419e8ddf967855b440df8a5e`). The architecture contract is unchanged.

### Added — M3E-4 Handoff Continuation Admission and TaskRun Binding

- Added unwired continuation admission to an existing canonical Task, with atomic state revalidation and an
  immutable one-to-one handoff/task binding. Exact TaskRun provenance uses the existing taskId relationship;
  no TaskRun is created or started and no execution authority is granted.
- Added SQLite v10 binding persistence, idempotent replay/conflict handling and disposable restart/stale-state
  coverage. CAP-013 receipt producers, WorkHandoff/WorkItem ownership and runtime wiring remain unchanged.
- Ratified ADR-0084 for independently reviewed implementation `825e97e89745eb5942090299ab3cafe5612edc5d`
  (PASS_WITH_NON_BLOCKING_FINDINGS, 0 blocking findings); synchronized canonical M3D/M3E foundation statuses,
  including M3E-3 delivery via PR #58. The architecture contract and Product implementation are unchanged.

### Added — M3E-3 WorkHandoff Consumption Decision

- Ratified ADR-0083 for implementation `5ef1c26d065b20bb14684d1f272264af13fabc26` following independent
  Claude review PASS and Chief Architect ratification, as confirmed by the Product Owner's close-out instruction;
  the architecture contract and Product behavior are unchanged. The documentation close-out awaits independent
  exact-HEAD review before separately authorized publication, PR and merge.

- Added an unwired read-only Core service that loads canonical handoff/work/profile relationships and returns
  immutable continuation eligibility or terminal NO_ACTION, with bounded typed failures and no execution authority.
- Added unit failure/lifecycle coverage and extended real SQLite v9 local E2E through produce, reopen, consume,
  and terminal lifecycle evaluation. Creation ownership, migrations and production wiring remain unchanged.

### Added — M3A-2 CAP-011 WorkItem Persistence Foundation

- Added the narrow ADR-0075 `WorkItem` aggregate and `WorkManager` application boundary, owning only durable work
  identity, canonical Actor ownership, optional Project reference, ResourceRef correlation, high-level lifecycle,
  and `conversation`/`connector` origin. Lifecycle transitions load the canonical persisted WorkItem by id and
  change only status and `updatedAt`, preventing stale caller state from replacing ownership or correlations.
- Added the Core repository contract, SQLite repository, and forward-only additive migration v7 for `work_items`,
  with reload/round-trip, multi-WorkItem-per-Actor, ResourceRef, optional-Project, lifecycle, origin, and not-found
  coverage. Conversation Runtime retains no persistent work ownership and its dependency count remains 31.

### Added — M3A-1.1 Actor Identity Provisioning

- Added a validated non-secret `QUOKY_ACTOR_IDENTITY_MAPPINGS` contract and an app-private startup provisioner that
  locates existing Discord Actors and additively persists explicit Jira/GitHub `ExternalIdentity` mappings through
  the existing repository path without creating Actors or changing Core contracts, storage schema, or migrations.
- Added offline coverage for Jira-only, GitHub-only, merged Work Surface reachability, omitted-identity preservation,
  idempotence, same-platform and cross-Actor conflicts, missing Actors, and connector availability failures while
  keeping `ConversationRuntimeDeps` at 31.

### Added — M3A-1 Read-only Personal Work Surface

- Added the infrastructure-neutral `ResourceRef` value object and a rebuildable `WorkSurfaceQuery` whose intended
  behavior, once external identities exist, combines current-Actor Jira and GitHub personal work with deterministic
  ordering and explicit partial/unavailable status. Merged, Jira-only, and GitHub-only surfaces are exercised in
  this slice through injected identities and fakes; M3A-1 adds no live Actor Jira/GitHub identity-provisioning path.
- Added a read-only GitHub `ConnectorProvider` adapter using the existing composition-root auth infrastructure,
  while leaving GitHub PR lifecycle and all writes on `RepositoryHostingProvider`.
- Added a natural read-only “show me what I need to work on” conversation path. It performs no AI/provider write,
  connector write, WorkItem persistence, schema change, or migration; `ConversationRuntimeDeps` stays at 31.

## [1.0.0] - 2026-08-25

### Changed — Release Consistency Reconciliation

- Reconciled the current release-validation summary to Node `v22.22.1`, `pnpm typecheck` PASS, and `pnpm test`
  PASS (`119` files / `2653` tests) while preserving earlier-gate figures as historical evidence.
- Recorded repository evidence that private root/workspace package metadata remains independently versioned at
  `0.1.0`, and distinguished the historical Live UAT execution SHA, its accepted final `v1.0.0` disposition, and
  the current final local release HEAD.

### Added and Fixed — Post-Gate Release Acceptance and Reliability

- Added a deterministic release acceptance suite covering the intended Version 1 behavior without expanding the
  ratified product architecture or introducing speculative implementation scope.
- Hardened recent-response grounding validation so immediate continuity is anchored, only relevant follow-up
  responses require grounding, relevance checks are stricter, and a leading recency hard anchor is not incorrectly
  treated as supporting evidence.
- Corrected ContextBuilder scope by reverting the acceptance-only scope broadening and preserving the established
  conversation-context boundary.
- Added explicit release acceptance coverage disclosing the remaining durable-recall scope gap rather than implying
  broader recall support than Version 1 provides.
- Fixed the immediately-previous-user-turn recency grounding defect by keeping the current chat turn authoritative
  when stale rendered context contains a conflicting user turn (`cda25f9`).

### Changed — Production Readiness / Release Gate Preparation

- Recorded the completed M2 / `QUIRKYBOT_DEV_V1` source-integration assessment, current local-to-`origin/main`
  divergence, refreshed `118`-file / `2634`-test validation evidence, carryover classification, and the proposed
  separately approved Push / PR / Merge / Release sequence.
- Kept Production Runtime readiness explicitly blocked on production-grade 5C-EG while treating XR and 5C-EG as
  non-blocking for source integration of the default-off, completed local-first Personal Edition scope.

### Changed — M2 Closure

- Marked M2 `COMPLETE_AND_ACCEPTED / CLOSED` for its currently ratified scope after acceptance of ContextBuilder,
  PromptComposer, provider routing, read-only connector wiring, durable recall, and explicit-command durable writes.
- Kept vector/semantic search, a Codex adapter, deeper memory tiers, and schema/index optimization outside the closed
  M2 scope pending a separately selected milestone direction.

### Added — M2 Durable Memory Write Activation

- Activated durable writes only for explicit `기억해:`, `기억해줘:`, and case-insensitive `remember:` commands through
  the required `MemoryWriter` dependency, after pending-flow interception and before ordinary classification.
- Preserved ADR-0073 and the ratified activation architecture: ordinary chat, Assistant `SHORT_TERM` recording, and
  Provider/LLM extraction do not trigger durable promotion, and existing `MemoryManager`/repository ownership remains
  unchanged.

### Changed — UAT Nested Reference Defect Classification

- Added a focused three-turn provider-boundary regression proving that ContextBuilder excludes only the current
  inbound memory, PromptComposer preserves the earlier User/Assistant roles and order, and the Ollama CLI input
  ends with the nested subtype question as the sole active User turn.
- Classified feedback `786b50ad` as provider/model semantic quality rather than ContextBuilder history loss because
  the selected `파스타` Assistant turn reaches the provider intact; no phrase-specific handling was added.

### Fixed — UAT Workspace Binding Regression Coverage

- Documented that command execution uses the current channel/thread Session's registered active Project rather than
  the runtime process cwd, and that UAT must idempotently re-register the intended repository in that same context
  before command scenarios to replace stale disposable-workspace bindings.
- Added focused coverage that valid active Projects preserve their registered `rootPath` through workspace
  resolution, missing registered roots fail as workspace unavailable, and the resolved command workspace uses the
  registered Project path without an absolute-path fallback.

### Added — M2 Connector Composition-Root Wiring

- Registered the Jira, Slack, and Confluence read-only connector adapters in the composition root at commit
  `ce750f5`; each adapter is configuration-gated and is registered only when its required environment configuration
  is complete.

### Added — M2 Confluence Read-Only Connector Adapter

- Added `ConfluenceConnectorProvider` implementing the ADR-0072 `ConnectorProvider` boundary for the Confluence
  Cloud REST API in `@chunsik/connector-confluence` at commit `6bf3595`; the adapter is read-only, fake-fetch tested,
  and registered by the composition root when its required configuration is present.

### Added — M2 Slack Read-Only Connector Adapter

- Added `SlackConnectorProvider` implementing the ADR-0072 `ConnectorProvider` boundary for the Slack Web API in
  `@chunsik/connector-slack` at commit `536a97e`; the adapter is read-only, fake-fetch tested, and registered by the
  composition root when its required configuration is present.

### Added — M2 Jira Read-Only Connector Adapter

- Added `JiraConnectorProvider` implementing the ADR-0072 `ConnectorProvider` boundary for Jira Cloud REST in
  `@chunsik/connector-jira` at commit `5365556`; the adapter is read-only, fake-fetch tested, and registered by the
  composition root when its required configuration is present.

### Added — M2 ContextBuilder Bounded Compression

- Added opt-in deterministic tail compression for token-budgeted ContextBuilder entries. Lowest-scored entries are
  truncated first to preserve higher-value content, with a configurable per-entry character floor and unchanged
  chronological output, role, provenance, and epistemic labels.
- Preserved the existing selection behavior when compression is omitted and added focused coverage for over/under
  budget handling, floors, provenance/order, empty history, and single-entry history.

### Changed — QUIRKYBOT_DEV_V1 Live UAT Acceptance

- Recorded bounded Live UAT `PASS` at exact verified HEAD `715c407a52eee36a7717d1b4b6695b1469bb0a76`, accepted the
  resolved immediately-previous-user-turn recency grounding defect, and marked the DEV_V1 acceptance criteria
  `MET` with milestone state `MILESTONE_REACHED`.

### Changed — Autonomous Development Governance

- Enabled `AUTONOMOUS_DEV_MODE` for the `QUIRKYBOT_DEV_V1` milestone and delegated bounded LOW/MEDIUM-risk local
  task creation and implementation approval to the Architect AI, with Codex as Builder and Claude as independent
  Reviewer.
- Retained FAST DELIVERY batching through tests, build, documentation, local commit, and at most two scope-local
  remediation rounds without one-off human approval for each Architect-generated task.
- Preserved Human-only gates for Push/PR/Merge, Runtime, application Provider/network execution, Discord, secrets,
  DB/migrations, actual Workspace/Patch Apply, destructive operations, Live UAT, production, and release gates.
- Marked ratified Stage 2C Slice 3C implementation as eligible for Architect scheduling; no application code was
  implemented by this governance change.

### Added — Stage 2C · Slice 3C ExecutionPlan Integrity Binding Architecture

- Ratified ADR-0068 and `EXECUTION_PLAN_REF_TYPED_INTEGRITY_EXTENSION`: a generic optional
  `ExecutionPlanIntegrityRef` propagates exact plan integrity through Planning, ExecutionPlan, ApprovalRef, Patch,
  and Workspace boundaries without changing plan-scoped Approval semantics or adding persistence.
- Rejected content-addressing `ExecutionPlan.id`; identical plans from distinct approval attempts must retain
  distinct correlation identities. Full typed integrity equality is required whenever integrity is present, while
  refs that both omit it preserve legacy behavior.
- Bound Stage 2C application plans to SHA-256 of the exact application subject and proposed change, required the
  proposed change before plan creation, and classified `target === expected` as `VERIFIED_NOOP` with no plan,
  approval, patch, or workspace write.
- Recorded architecture status only: Slice 3C implementation remains `NOT_STARTED`; no Core, Patch, Workspace,
  Runtime, Provider, persistence, or application behavior changed.

### Added — Stage 2C · Slice 3B Profile Configuration Application Gate

- Added an app-private, offline deterministic gate that revalidates ratified suitability profiles, recomputes exact
  current/target production routing identities, and derives a canonical SHA-256 before-to-after application subject.
- Restricted application to the exact ratified provider/model profile without changing unrelated descriptors,
  policy, enabled state, validation, or deadline configuration; exact Stage 2B egress scope cannot expand.
- Added bounded 24-hour explicit expiry, `APPLY_REQUIRED` versus `VERIFIED_NOOP` idempotency, stale third-state
  rejection, bounded fail-closed errors, and `SELF_CONSISTENT_UNSIGNED`/`executionMutation = NONE` projection.
- Kept candidate generation separate from ExecutionPlan/Patch creation, Approval, filesystem/configuration apply,
  Registry/Runtime mutation, Provider construction/execution, persistence, process, and network behavior.

### Changed — Stage 2C · Slice 2 Contract Review Remediation

- Ratified `ff1a356` as a fail-closed correction within the existing projection/profile v1 contract: observed hard
  safety disqualifications remain `INELIGIBLE` when scorecard evidence is missing. This narrows eligibility without
  introducing a new profile schema or broader eligibility semantics.
- Clarified that suitability `APPROVED` validates candidate identity plus an independently supplied offline binding;
  it does not authenticate operator authority, prove an ApprovalManager decision, or verify uniqueness, expiry,
  revocation, Runtime activation approval, or production authorization.
- Marked Runtime profile application `NOT_YET_ELIGIBLE` pending Architecture Review of authenticated approval
  authority and lifecycle semantics. Candidate digest consistency also remains distinct from cryptographically
  authenticated benchmark provenance.
- Added negative coverage for non-approved decisions, missing exact approval keys, and approval reuse across two
  distinct valid candidates.

### Added — Stage 2C · Slice 2 Static Suitability Profile Ratification

- Added app-private offline ratification from an exact `ELIGIBLE` Slice 1 candidate plus an independently supplied,
  exact approval binding to an immutable approved static Provider profile with a deterministic approved digest.
- Bound approval identity and authority to the candidate, benchmark evidence, descriptor configuration,
  Provider/model identity, and projection/ratification versions; stale, mismatched, malformed, ineligible,
  unproven, or unsupported-version inputs reject fail-closed.
- Kept ratification independent of `ApprovalManager` and free of Registry, policy, production configuration,
  persistence, Runtime, Provider, process, or network mutation. The approved descriptor remains disabled.

### Added — Stage 2C · Slice 1 Model Suitability Evidence Projection

- Added an app-private offline projector from bounded Stage 2A benchmark report/decision evidence to an
  existing-Core-compatible candidate static Provider profile with deterministic evidence/profile digests.
- Added fail-closed `ELIGIBLE`, `INELIGIBLE`, and `UNPROVEN` semantics, hard disqualification for safety,
  containment, multi-entry echo, and download evidence, and rejection for malformed or stale identity/binding data.
- Kept candidate application behind `RATIFICATION_REQUIRED`: projection performs no Registry, policy, Runtime,
  Provider, process, network, or persistence mutation, and the projected descriptor remains disabled.

### Changed — Stage 2B Offline Completion Closeout

- Closed Stage 2B offline architecture, contract, and implementation scope as
  `COMPLETE_AND_ACCEPTED` with `STAGE_2B_OFFLINE_BLOCKERS = NONE`.
- Recorded ADR-0065/ADR-0066 ratification, accepted offline F0-XR-FCI containment, and F0-XR-FP completion with
  stable filesystem-provenance carryover.
- Accepted 5C-EG-F′ with `NO_FEASIBLE_ARCHITECTURE_YET`, closed the 5C-EG feasibility loop, and moved concrete
  enforcement to blocked carryover; I1/I2/V/E remain ineligible.
- Kept XR-AX, live Provider activation, and live Runtime/Discord/DB UAT blocked. Offline completion does not claim
  external-egress denial, filesystem provenance, live activation readiness, or production readiness.

### Added — Stage 2B · Slice 5C-I Dormant Production Activation Boundary

- Added exact, case-sensitive `QUOKY_PROVIDER_ROUTING_MODE` parsing with a safe `legacy` default and fail-closed
  invalid values.
- Added an app-private, versioned exact-scope egress-enforcement contract and ordered activation factory. Legacy
  mode constructs nothing; enabled mode remains blocked before production routing Provider construction until a
  concrete 5C-EG verifier exists.
- Wired the optional collaborator into `ConversationRuntime` without changing the existing `AI_PROVIDERS` path or
  Core. No Provider, Runtime, Discord, network, or database execution was performed.

### Fixed — Stage 2B · Slice 5B-2B-E1 Entrypoint Contract Remediation

- Hardened the app-private generation entrypoint with one explicit projection key set, monotonic lifecycle
  evidence, uniform single-attempt writer failure handling, strict E0-aligned parsing, and injectable PRE/POST
  preflight composition. The current executable identity remains `REBOUND_CANDIDATE_NOT_APPROVED`; its observed
  SHA is evidence only and is not approved as a production default.
- Model-download prevention and external-egress denial remain **NOT VERIFIED**. Actual preflight, inventory,
  Provider generation, and Push remain zero/not approved.

### Added — Stage 2B · Slice 5B-2B-I Primary-Only Provider Generation Validation

- Added an app-private one-provider Registry/Policy/Planner/Gateway harness for exact
  `ollama-cli:llama3.1:8b`, yielding one immutable primary attempt with zero fallback, escalation, or retry.
- Added an opt-in Ollama validation profile with an absolute executable, explicit loopback host, parent-free
  runner-owned HOME/TMPDIR environment, bounded pull-marker observation, fixed prompt identity, 128-byte normalized
  output contract, and bounded structured projection. Existing provider defaults remain unchanged.
- Added explicit verified-denial versus precheck/observe/postcheck risk-accepted acquisition controls. The latter
  does not prove download prevention or external-egress denial. Tests use fake Provider/preflight/process seams;
  actual Ollama generation, inventory, localhost/network, Runtime, Discord, and DB execution remain deferred.
- Hardened validation evidence so terminal failures preserve observed invocation/download/timeout/overflow facts,
  a second invocation is counted but never delegated, and overflow is a structured opt-in runner signal. The
  adapter and runner independently validate exact IPv4 loopback hosts; legacy runner/provider behavior is unchanged.
- Restricted output projection to the exact success token. Mismatches expose only bounded byte count and SHA-256,
  and invalid model-acquisition controls project null without echoing rejected input.

### Added — Stage 2B · Slice 5B-2A-E0 Honest Egress and Execution Composition

- Replaced the boolean egress attestation with explicit `OS_DENIED_VERIFIED` and
  `CONFIG_RESTRICTED_RISK_ACCEPTED` controls plus a separately projected isolation-verification fact. The
  risk-accepted mode restricts binary, argv, environment, and endpoint configuration but does not technically
  deny or prove denial of external egress.
- Added an app-private strict invocation parser, concrete read-only filesystem and runner-owned sandbox adapters,
  injected spawn composition, and deterministic PASS/FAIL/BLOCKED/configuration/unexpected-failure reporting
  without wiring the preflight into `app.module.ts`. Invalid invocations remain
  `ENTRYPOINT_CONFIGURATION_ERROR`/`INVALID_INVOCATION` with exit 4; post-parse failures are separately bounded as
  `ENTRYPOINT_UNEXPECTED_FAILURE`/`UNEXPECTED_ENTRYPOINT_FAILURE` with exit 5. Each invocation attempts at most one
  projection, and all five statuses use the same bounded key set, including `inventoryObserved`.
- Actual executable/version and installed inventory remain **NOT VERIFIED**. Ollama process, local daemon/network,
  model inventory, and Provider generation were **NOT EXECUTED**; execution remains separately gated by 5B-2A-E.

### Added — Stage 2B · Slice 5B-2A-I Bounded Ollama Inventory Preflight

- Added app-private typed preflight, executable-identity, command-policy, parser, process, and result contracts for
  exact Ollama `--version` and `list` checks behind injectable filesystem/process seams.
- Added absolute-realpath executable validation, strict loopback/environment policy, bounded UTF-8/terminal parsing,
  exact required-model matching, positive argv allowlisting, download-marker observation, and fail-closed immutable
  non-persistent results.
- Hardened the runner-owned exact child environment and hard settlement deadline. The network class remains null until loopback
  endpoint/environment validation; afterward it classifies only that approved configuration, not observed
  connectivity, containment success, command success, or external-egress denial.
- Actual executable/version and installed inventory remain **NOT VERIFIED**. Ollama process, local daemon, external
  network, model inventory, and Provider generation were **NOT EXECUTED**; execution remains separately gated by
  Slice 5B-2A-E.

### Added — Stage 2B · Slice 5B-1 Provider Identity and Static Routing Configuration

- Added additive explicit instance identity to `OllamaCliProvider` while preserving the legacy default
  `ollama-cli` identity and existing `AI_PROVIDERS` composition.
- Added an unwired composition-root typed configuration for the `llama3.1:8b` balanced primary and
  `granite3.3:8b` semantic candidate, including immutable descriptors, executable bindings, GENERAL_CHAT-only
  policy, validation/deadline selection, and pure construction validation.
- Bound each descriptor to the ratified Stage 2A facts through the canonical
  `stage2b-provider-provenance-v1` SHA-256 payload. Raw scorecards and Golden Corpus data are not imported at
  Runtime.
- Actual Provider readiness/model installation are **NOT VERIFIED**. Provider execution is deferred to separately
  approved Slice 5B-2; Runtime activation and Runtime/Discord/DB UAT remain deferred to Slice 5C.

### Added — Stage 2B · Slice 5A Offline Runtime Integration Seam

- Added the Core `RuntimeProviderRoutingService` collaborator for TaskRun-backed `GENERAL_CHAT` work turns. It
  deterministically maps bounded Runtime facts, probes each configured executable Provider at most once into an
  immutable availability snapshot, then composes the existing Registry → Policy → Planner → Gateway chain.
- Added fail-closed `ConversationRuntime` integration with no legacy-selector fallback after the seam is selected.
  Accepted output persists bounded artifacts and completes the existing TaskRun/Task lifecycle; human-review and
  failure terminal categories reuse `NEEDS_REVIEW` or `FAILED` without a new aggregate or status.
- Added bounded `routingAudit` TaskRun metadata for accepted and non-accepted outcomes, plus additive failed-run
  metadata persistence. A non-accepted run receives no representative `providerId`, and user-facing terminal
  wording exposes no Provider/model identity, prompt, raw output/error, reasoning, or configuration digest.
- Kept Code Generation, Project Analysis, no-work chat, and all other Capabilities on their legacy paths. Production
  app wiring, actual descriptors/policies/bindings, external Provider execution, Runtime/Discord, network, secret,
  and database work remain deferred.

### Added — Stage 2B · Slice 4 Deterministic Routing Selection Simulation

- Added an independent provider-free selection subtree to the private routing validation package. Strict static
  fixtures run the real immutable Provider Registry and `RoutingPolicyEngine`, then stop at
  `ProviderSelectionDecision` without constructing an Execution Plan, Gateway, validator, or Provider binding.
- Added a Harness-owned canonical selection projection containing bounded decision facts, `matchedPolicyId`, and
  only the configured ranking dimensions/directions, with independent schema/compiler/digest versions and pinned
  fixture/corpus SHA-256 identities.
- Added exact double replay plus a fixed ordering metamorphic replay for policy match/absence, eligibility,
  disabled/unavailable filtering, no-eligible termination, configured preference/ranking, stable ordering, and a
  combined Authority × Safety × Ranking golden scenario. Provider execution remains zero.
- Removed the unexercised unordered-array metamorphic axis. The current Golden corpus exercises Provider
  registration-order permutation; policy declaration-order permutation remains implemented but is not independently
  exercised by its single-policy fixtures, while policy-order independence remains owned by Core normalization.

### Fixed — Stage 2B · Slice 3C Coverage Integrity

- Partitioned every routing failure contract into active golden coverage, a bounded explicit active waiver, or
  producer-pending status. New active codes now fail validation until assigned to exactly one active coverage path.
- Added the immutable `SEMANTIC_VALIDATION_UNRESOLVED` golden fixture and advanced the fixture/corpus digests without
  changing the Harness digest version, fixture schema, replay model, or production dependency graph.

### Added — Stage 2B · Slice 3C Deterministic Validation Harness

- Added the private `@chunsik/provider-routing-validation` workspace package, excluded from the production build
  reference graph and consumed by no app, Runtime, adapter, or production package.
- Added strict versioned JSON fixtures with an explicit static registry, immutable per-fixture digests, a retained
  corpus manifest, and a Harness-owned digest version independent from the Core failure matrix.
- Added scripted in-memory `AiProvider` implementations and a scripted monotonic clock to replay the real Core
  Planner → Gateway → Validator path without policy reevaluation, filesystem discovery, network, or external
  Provider execution.
- Added exact golden comparison through a Harness-owned canonical audit projection and fresh-graph double replay,
  covering accepted, fallback, escalation, safety, deadline, attempt/transition, binding-provenance, and
  failure-matrix contracts.

### Fixed — Stage 2B · Slice 3B Review Remediation

- Advanced the failure matrix to v4: Gateway-produced `SEMANTIC_VALIDATION_UNRESOLVED` is active while
  `STRUCTURAL_VALIDATION_UNRESOLVED` remains producer-pending.
- Restored Gateway regression coverage for unknown Provider exceptions, missing bindings, registry identity
  mismatches, and forged plan version/digest mismatches.
- Revalidate binding provenance immediately before every attempt, including the optional second hop, so a binding
  changed after primary dispatch fails through the existing bounded binding contract without another invocation.
- Added direct failure-classifier tests while retaining Gateway-level integration coverage.

### Added — Stage 2B · Slice 3B Bounded Two-Attempt Orchestration

- Added a pure bounded execution state reducer, explicit seven-transition upper bound, and zero-attempt deadline
  exits from primary, fallback, and escalation READY states.
- Added versioned Gateway deadline policy and injected monotonic clock ownership. Provider timeout is the smaller
  of an optional caller timeout and remaining Provider budget; validation shares the same non-resetting deadline.
- Added validation-gated operational fallback or semantic escalation as one mutually exclusive additional hop.
  Retry, same-provider retry, runtime policy reevaluation, and safety branching remain prohibited.
- Replaced raw Provider results with bounded terminal results and audit v2. Six terminal statuses and first-class
  `humanReviewRequired` are retained; audit is capped at two attempts and seven transitions and includes deadline
  policy identity without prompt, raw output/error, credentials, or environment.
- Advanced the failure matrix to v3 for contextual deadline attempt consumption, required caller-owned execution
  identity, and retired contradictory Slice 2 single-attempt compatibility fields from the execution plan.
- Covered orchestration with fake Providers and an injected fake clock only. Runtime/app/adapter wiring, hard
  cancellation, actual Provider execution, network, Discord, persistence, and database changes remain excluded.

### Added — Stage 2B · Slice 3A Response Validation Planning

- Added the immutable `LOW_RISK_FAST_PATH`, `GENERAL_CHAT`, and `AUTHORITY_SENSITIVE` validation-profile registry,
  deterministic profile digests, and fail-fast unknown-profile handling. Placeholder structured/code/tool profiles
  remain unregistered.
- Added the independent pure synchronous Runtime response validator with bounded non-empty/output-limit, prompt
  leak, multi-entry echo, secret-exposure, and authority-scope rules. Validation results contain only bounded
  dispositions, reason codes, response identity/size, and contract versions; the bounded output projection strips
  provider raw/audit data plus artifact metadata and storage URIs.
- Added a versioned configuration/operational/validation/safety failure matrix with safety fail-closed behavior,
  explicit fallback/escalation permissions, and producer-pending ownership. Review remediation advances the matrix
  to v2 with terminal semantic/structural-unresolved and deadline-exhausted reservations; no producer or transition
  is implemented in Slice 3A.
- Evolved `ProviderExecutionPlan` into a provenance-bound declarative Strategy B plan: primary, optional operational
  fallback, optional strictly stronger semantic escalation, maximum attempts `2`, maximum additional hops `1`,
  deadline class, deterministic decision/configuration/plan digests, and optional caller-owned execution identity.
  Candidate identities are unique and fixed from the ranked eligible set; runtime policy reevaluation and
  same-provider retry remain prohibited.
- Preserved the Slice 2 execution boundary: the Gateway validates the extended provenance but continues to invoke
  only the primary once. It does not perform response validation, fallback, escalation, retry, deadline calculation,
  Runtime wiring, or external Provider execution.

### Fixed — Stage 2B · Slice 2 Binding Provenance

- Bound executable registrations to an immutable `ProviderRegistrySnapshot`; unknown/disabled descriptors,
  duplicates, executable-id mismatches, and adapter/model mismatches now fail before invocation.
- Added a deterministic, deep-frozen binding identity whose canonical SHA-256 input is Provider, adapter, model,
  binding version, and descriptor profile version. Runtime availability, timestamps, execution data, latency,
  environment, secrets, and raw errors remain excluded.
- Required Plan construction to validate Decision eligibility, descriptor availability, registry/policy/combined
  configuration identities, and executable binding provenance. The Gateway rechecks current registry and binding
  identity and returns bounded zero-attempt failures for stale, missing, malformed, or mismatched provenance.
- Preserved the single-attempt boundary: valid, classified-failure, and unknown-exception paths invoke exactly once;
  configuration failures invoke zero times; retry, fallback, escalation, Runtime wiring, and external Provider
  execution remain absent.

### Added — Stage 2B · Single-Attempt Provider Gateway (ADR-0064 Slice 2)

- Added an immutable `ProviderExecutionPlan` between selection and execution. It carries the selected Provider,
  one-element execution order, fixed attempt budget, capability, validation-profile identity, and routing
  configuration provenance while explicitly disabling deadline, fallback, and escalation policy.
- Added an immutable executable-binding registry that validates binding identity without probing availability or
  invoking Providers.
- Added an isolated `ProviderRoutingGateway` that resolves and invokes exactly one selected `AiProvider` once and
  emits a bounded success/failure audit. It performs no retry, fallback, escalation, timeout policy, response
  validation, alternate-provider execution, or raw prompt/response/error capture.
- Covered the boundary with fake Providers only. No Runtime, Code Generation, app, adapter, persistence, database,
  model activation, or actual external Provider execution was added.

### Added — Stage 2B · Provider Selection Foundation (ADR-0064)

- Ratified Provider Routing as a Core Application policy service rather than a Capability or Provider-adapter
  concern. Added bounded `RoutingContext`, static Capability/Operational Profiles, branded configuration ids,
  explainable `ProviderSelectionDecision`, and bounded terminal reason codes.
- Added a validated descriptor-only Provider Registry with immutable snapshots, stable provider ordering,
  lookup/enabled enumeration, transient availability snapshots, and canonical SHA-256 configuration identity.
  Timestamp, environment, availability, and object insertion order do not affect the registry digest.
- Added typed declarative policy evaluation: deterministic predicate selection, eligibility/exclusion before
  ranking, configured lexicographic routing-class/reliability/latency/cost comparison, and stable provider-id
  tie-breaking. Stage 2A raw scores, Golden Corpus, concrete model tags, and executable providers are absent from
  Core policy logic.
- Slice 1 is calculation-only: no Provider invocation, Runtime or CodeGeneration integration, fallback,
  escalation, retry, deadline, response validation, TaskRun audit, storage migration, or model activation.

### Changed — Stage 2A · Completion and Stage 2B Planning

- Closed Stage 2A with `STAGE_2A = PASS`: Evaluator v4, Golden Corpus, deterministic Replay,
  post-push Binding, Provider Benchmark Framework, Decision Engine, and Provider Ranking are ratified
  as the completed Provider Evaluation Infrastructure deliverables.
- Completed Evaluator v4 promotion as the production-default semantic checker while preserving the
  immutable v3 historical replay contract and A1+A3 Golden Corpus evidence.
- Ratified the synchronized-main static/probe/run/run-all v4 bindings without changing historical
  bindings or authorizing a new Provider execution.
- Completed the evidence-based Provider ranking: `llama3.1:8b` is the balanced primary candidate,
  `granite3.3:8b` is the semantic candidate, `llama3.2:3b` is latency-only, and `mistral:7b` is
  deprioritized. Prompt root cause remains **NOT ESTABLISHED**.
- Opened Stage 2B as a planning-only Production Routing track. Dual routing, traffic policy, timeout,
  retry, escalation, and operational policy remain unratified and unimplemented.

### Changed — Stage 2A · Semantic Checker v4 Promotion

- Promoted the fully ratified semantic checker v4 to the default evaluator contract
  (`stage2a-semantic-checker-v4`) for new semantic Harness and Provider Benchmark invocations. Evaluator
  selection is explicit: production wiring injects v4, while historical replay injects v3.
- Preserved the immutable v3 Golden Corpus baseline and the original v4-candidate transition identity used by
  the ratified 25/25 overlay. Provider-free replay remains deterministic across 224 records / 896 check
  instances with Critical Recall 5/5 (100%) and no confirmed false positives or false negatives.
- Added the evaluator router and v4 implementation to the static source/dist binding path. The checker version
  is now part of every static and execution binding input/output; existing bindings remain historical and any
  new offline binding is only a candidate until separately ratified.

### Changed — Stage 2A · Provider Benchmark Pool Decoupling

- Decoupled Pool Configuration from benchmark calculation: strict schema-v1 JSON configurations now define
  model membership/role/tier, while budgets, exact-set membership, per-model scenario coverage, and campaign
  completion work with arbitrary pool sizes. The reviewed legacy 10-model pool remains the omitted-config
  default; the production 18GiB four-model pool is available through an explicit absolute `--config` path.
- Added canonical configuration digests and campaign fingerprints over repository HEAD, Pool digest, phase,
  schedule/Prompt/Fixture/Checker/benchmark contracts, static code binding, and approved executable identity.
  Fingerprints exclude human `campaignId`; mixed campaigns fail closed. Existing raw evidence is never assigned
  a guessed identity and remains `UNKNOWN_LEGACY`, provisional, and ineligible for final Champion publication.
- Separated objective Engine output (coverage, scorecards, failure distribution, completion, Provider Matrix)
  from Stage 2A decisions (advancement, eligibility, tie handling, acceptance, Champions). Existing weights,
  thresholds, tie policy, schedules, semantic Harness, Prompt, Provider, and Core boundaries are unchanged.

### Added — Stage 2A · Provider Benchmark Framework (Plan v2.1)

- Added an offline-only Stage A1/A2 benchmark planner and evidence aggregator around the existing bound
  `provider:semantic` harness. It freezes the approved 3-reference/7-challenger configuration pool, weighted
  A1 scenario schedule, A2 finalist schedule, and exact generation/child-process budgets.
- Added the frozen failure taxonomy and Provider Scorecard: semantic macro/worst-scenario performance,
  authority, continuity, target preservation, instruction following, latency, output stability, variance,
  eligibility gates, overall score, advancement ranking, and Semantic/Latency/Overall champions.
- Added a machine-readable Provider Matrix and deterministic summary CLI (`pnpm provider:benchmark`). The
  command consumes existing JSON evidence only; it never invokes or downloads a Provider and does not modify
  Prompt, Evaluator, Scenario, Binding, Acceptance, or Harness contracts.
- Validation: focused benchmark/semantic suites **285 tests PASS**; full Node 22 suite **68 files / 1674 tests
  PASS**; `pnpm typecheck` and `pnpm build` PASS. The default Node 18 full suite remains blocked by the existing
  `better-sqlite3` ABI mismatch, while the focused benchmark suites pass there.

### Added — Sprint 4b · GitHub App Authentication (dev/PAT → GitHub App; ADR-0061)

- **Auth-model pivot implemented** (ADR-0061, ratified 2026-07-07). Repository auth for both surfaces —
  RepositoryHosting REST (CAP-010) and local `git push`/`clone` (CAP-002) — now uses **short-lived GitHub App
  installation access tokens minted at execution time** from an adapter-local App private key, instead of a
  hand-injected PAT. **Zero `@chunsik/core` contract change; no new capability.**
- **New package `@quoky/github-app-auth`** (new `@quoky` scope, coexisting with `@chunsik/*`). `GitHubAppAuth`
  signs an App JWT (RS256 via built-in `node:crypto`), resolves `installation_id`
  (`GET /repos/{owner}/{repo}/installation`; 404 → not installed), and mints/caches installation tokens
  (`POST …/access_tokens`) with an in-memory refresh buffer + per-execution down-scoping (repository ids +
  minimal `contents`/`pull_requests` write). Built-in `fetch` only — no octokit/gh/curl/SDK. The private key and
  minted tokens are adapter-local: never logged/returned/persisted; `AppAuthError` is sanitized (401/403 →
  "authorization failed").
- **RepositoryHosting adapter auth swap** — `GitHubHostingConfig.token` → `auth` (`{ kind:'github-app';
  tokenSource } | { kind:'pat'; token }`); the Bearer value is resolved per request via `currentToken()`.
  Everything else in `GitHubRepositoryHostingProvider` (base URL, bounded fetch, sanitized errors, mutation/read
  sets, path safety) is unchanged.
- **Composition-root `GitHubAppGitProvider` decorator** wraps an **unchanged** `LocalGitProvider`. Local ops
  delegate directly; the three remote-touching ops (`pushApprovedCommit` / `getRemoteRefCommit` /
  `syncMainFastForward`) mint a token **first**, then run through a **one-shot `GIT_ASKPASS`** whose token lives
  ONLY in the child process env — never in argv, a remote URL, `.git/config`, logs, anchors, approval reasons,
  Discord, or evidence. The per-invocation temp helper (unique dir, mode 0700, no token literal) is removed in a
  `finally`; `process.env` is never mutated (concurrency-safe). A credential/mint failure before the inner git
  run maps to Blocked ("not synced"); a typed `GitMainSync*` error from the inner provider is preserved.
- **Config + fail-safe** — new env `QUOKY_GITHUB_APP_ID` / `QUOKY_GITHUB_APP_PRIVATE_KEY(_PATH)` /
  `QUOKY_GITHUB_APP_INSTALLATION_ID`; owner/repo prefer `QUOKY_GITHUB_OWNER`/`QUOKY_GITHUB_REPO`, falling back to
  legacy `CHUNSIK_GITHUB_OWNER`/`CHUNSIK_GITHUB_REPO`; `QUOKY_RUNTIME_ENV` gates the **dev-only** PAT fallback
  (legacy `CHUNSIK_GITHUB_TOKEN`). In a non-dev runtime, PAT-only and App+PAT are rejected (→ not configured,
  fail-safe). Not-configured / not-installed / mint-failure fail safe without crashing unrelated flows.
- **RC2 invariants preserved** — the `GitProvider` and `RepositoryHostingProvider` ports, `LocalGitProvider`,
  `RepositoryInfo`/`RepositoryIdentity`, `RepositoryHostingManager`, `GitManager`, and `ConversationRuntime` are
  **unchanged**. Naming per the CA correction: new artifacts use Quoky; existing `@chunsik/*`/`CHUNSIK_*`/classes
  are kept (bulk migration deferred to Sprint 4c).
- **CA review hardening (PR #39 REQUEST CHANGES → addressed):**
  - **HTTPS github.com remote preflight (RC1)** — before any App-auth remote git op, `GitHubAppGitProvider` reads
    the configured remote URL (credential-free local `git remote get-url`) and requires an HTTPS github.com remote;
    **scp-like SSH (`git@github.com:…`), `ssh://`, non-GitHub HTTPS, credential-embedding, and unreadable remotes
    are Blocked before any git spawn** — preventing an ambient SSH/keychain/OAuth/PAT fallback. The remote URL is
    read transiently and never stored in `RepositoryInfo`/`RepositoryIdentity`/an anchor/a reason.
  - **Numeric `repository_ids` down-scoping (RC2)** — `GitHubAppAuth.resolveRepositoryId` (name-scoped bootstrap
    token → `GET /repos/{owner}/{repo}` → numeric id, cached) + `tokenForRepository` mint the token with
    `repository_ids: [id]` + minimal permissions. A repo not accessible to the installation throws pre-mutation
    (no broad-token fallback).
  - **Remote-git credential-failure taxonomy (RC3)** — a new typed `GitPushBlockedError` (pre-mutation: token mint
    / askpass creation / HTTPS preflight) routes to the runtime's Blocked "not-pushed" reply
    (`composePushExecutionUnavailable`); `getRemoteRefCommit` failures throw (manager → Blocked); `syncMain`
    pre-mutation → `GitMainSyncBlockedError`; an inner `GitMainSync{Blocked,Unverified}Error` is preserved
    (at/after-mutation ambiguity stays Unverified). `GitProvider`/`RepositoryHostingProvider` ports and
    `LocalGitProvider` remain unchanged.
  - **Stronger tests (RC4)** — an injectable recording `spawn` verifies the token is in the child env only (never
    in argv), the askpass file has no token literal, and blocked/SSH/unreadable remotes never spawn git or invoke
    the inner op; plus the numeric-`repository_ids` flow and the push-Blocked → not-pushed runtime mapping.
- **Tests** — App-auth token minting + repo-id resolution/down-scoping + sanitized failures, the adapter auth
  swap, git-credential isolation + HTTPS preflight matrix, the push-Blocked taxonomy, config precedence +
  runtime-mode derivation. Suite: **49 files / 1098 tests** green on Node 22; `pnpm typecheck` exit 0.
- **Not in this sprint** — no GitHub App created, no secrets configured, no UAT run, no GitHub API mutation, no
  broad naming migration, no Sprint 4c. UAT re-entry (GitHub App model) remains separately CA-gated.

### Added — Sprint 2m · Test Result Detail UX (CommandExecution facts → useful reply)

- **Test/typecheck replies now carry detail, not just pass/fail** (ADR-0034). `CommandExecution`
  already held `command`, `args`, `exitCode`, `stdout`, `stderr`, `durationMs`; this sprint reuses
  those facts — no new read path, no command-surface change.
- **`TestResultDetail`** (new Application-layer DTO in `response-composer.ts`, not domain, not
  persisted) carries the display-relevant facts; `ConversationRuntime.frameTestResult` assembles it
  from the `CommandExecution` it already reads, with a three-way branch: `SUCCEEDED`/`FAILED` (ran)
  → detail result; `TIMED_OUT` (killed) → distinct timeout reply; no `CommandExecution` (never ran)
  → unchanged `composeCommandUnavailable`.
- **`ResponseComposer.composeTestResult`** signature changed to take a `TestResultDetail` (command,
  exit code, duration, and a safe output excerpt) instead of bare `passed`/`kind`. New
  **`composeTestTimedOut`**: never phrases a timeout as a test failure, never shows an exit code
  (none exists), never claims a "configured timeout" value — only the actual elapsed duration.
- **Deterministic output summarization** (no AI call): prefers `stdout`, falls back to `stderr` only
  if `stdout` is empty (single stream, never merged); keeps the **tail** — last 20 lines, then capped
  at 1200 chars; a truncation notice is shown when either bound cut it or the command-runner
  adapter's own `…[truncated]` marker is present. When `stdout` is shown but `stderr` was also
  non-empty, the reply says so — stdout-preference never hides that stderr output existed.
- **No second masking pass.** `maskCommandOutput` (ADR-0028) already redacts + caps at the adapter
  boundary; summarization is a length transform only over already-safe text. Wording never claims a
  completeness/security guarantee about the log.
- **Message-length defended:** excerpt capped at 1200 chars, full rendered reply capped at 1900
  chars (headroom under Discord's 2000-char limit).
- **Out of scope (CA-confirmed):** command-surface expansion · AI-generated summary · retry ·
  patch/write · new aggregate/repository/migration/capability/port · Core/Orchestrator contract change.
- Tests (+16, `response-composer.test.ts` new + `conversation-runtime.test.ts` updated): success/
  failure detail content; short/long/huge-line/adapter-marker truncation cases; stdout-preferred +
  omitted-stream notice; stderr fallback; no-output case; message-length bound; timeout wording
  constraints; runtime three-way branch (ran/timed-out/never-ran). **Validation runtime: Node 22** —
  `pnpm typecheck` PASS; `pnpm test` 38 files / **270 tests** PASS. Plan:
  `docs/plans/sprint-2m-test-result-detail-ux-plan.md`.

### Added — Sprint 2l · Live Test Execution (first reachable execution Product slice)

- **The execution pipeline is now reachable from a real user message** (ADR-0033). "테스트 돌려줘" /
  "typecheck 돌려줘" runs the allow-listed test command in the active project and reports the result
  naturally: `IntentClassifier → IntentResolver → ConversationRuntime → ExecutionOrchestrator →
  CommandExecution → ResponseComposer`. **Reuse only** — no new capability/aggregate/repository/
  migration; no Core or `ExecutionOrchestrator` contract change.
- **`IntentClassifier`** gains deterministic **`RUN_TESTS`** recognition → `IntentType.RUN_TESTS` +
  `Capability.TEST_EXECUTION` (both **reused**) + a normalized `raw.kind: 'test' | 'typecheck'` (the
  classifier judges intent only, never a command).
- **`IntentResolver`** owns the **fixed command mapping**: `typecheck → pnpm typecheck`, else
  `pnpm test`. **Only those two commands are ever produced** — user text is never turned into a
  command; the `CommandExecution` allow-list re-checks it. Adds `isExecution(intent)`.
- **`ConversationRuntime`** resolves the active project's workspace via the existing
  `WorkspaceManager.open` (no active project → `composeNeedsProject`, no run; open failure →
  `composeWorkspaceUnavailable`), then runs the execution and **frames the test result** by reading
  the produced `CommandExecution` (`CommandExecutionManager.get`).
- **Test-failure framing (Product UX):** a command that **ran** with exit ≠ 0 is reported as a
  **test-failure result** (not a bot/system error); a command that **could not run** (timeout /
  allow-list refusal / workspace-open / spawn) is a system-failure reply.
- **Risk:** `pnpm test`/`pnpm typecheck` are bounded, allow-listed project commands — lower-risk than
  patch/write/deploy, **but not guaranteed non-mutating** (package scripts may run arbitrary
  project-defined logic). Risk **MEDIUM**; **no approval halt** this sprint. `RiskPolicy`/
  `ApprovalManager` unchanged.
- **`ResponseComposer`** gains `composeTestResult` / `composeNeedsProject` /
  `composeWorkspaceUnavailable` / `composeCommandUnavailable`; the runtime builds no reply text itself.
- **Out of scope (CA-confirmed):** code change · patch/write · AI code-gen live · Agent Runtime ·
  retry/reflection · Discord UI · telemetry · free-form/AI-generated/shell commands.
- Tests (+10, fake/integration): "테스트 돌려줘"→RUN_TESTS/TEST_EXECUTION; kind→command mapping;
  user command ignored; no-active-project (no run); workspace-open failure; run invoked with the
  resolved workspaceRef+fixed command; pass→result; fail(exit≠0)→result (not system error);
  timeout→system failure. **Validation runtime: Node 22** — `pnpm typecheck` PASS; `pnpm test` 37
  files / **255 tests** PASS. Plan: `docs/plans/sprint-2l-live-test-execution-plan.md`.

### Added — Sprint 2k · Conversation Runtime (Application Layer — the conversation entry; first Product Construction)

- **춘식봇's conversation entry point** (ADR-0032). Turns one user message into one natural assistant
  response by **composing** existing Application/Capability services. **Not** a new execution engine,
  capability, or aggregate. No Core-contract change, **no new aggregate/repository/migration**.
- **`ConversationRuntime.handle(message): Promise<TurnResult>`** owns the **full** flow (chat ·
  project-analysis · register · execution · approval-resume · failure/cancel), branching internally.
  `ChunsikCore` is now a **thin facade** that delegates to it and performs platform delivery
  (`Platform Adapter → ChunsikCore → ConversationRuntime → OutboundMessage → deliver`) — one entry,
  no parallel paths.
- **Transient runtime model (no new aggregate):** `RuntimeTurnStatus = RESPONDED | AWAITING_APPROVAL
  | DENIED | FAILED | CANCELLED`; `TurnResult` carries the status + `OutboundMessage` + `sessionId`
  (+ optional `ExecutionOutcome`). No `Turn`/`Conversation`/`Message` aggregate, no table, no repo.
- **Stateless approval halt → resume routing.** Approval-awaiting state is **derived** from existing
  aggregates — fixed correlation source `Session.activeTaskId → Task.planId →
  approvals.findByExecutionPlan → PENDING` (ADR-0032). The runtime persists nothing and writes **no
  snapshot to `Session`**. Decision interpretation runs **only** when a pending approval exists:
  approve {승인/진행/좋아/yes/y/ok} → `ApprovalManager.decide` + `ExecutionOrchestrator.resume`; deny
  {거절/아니/no/n} → DENIED (no resume); cancel {취소/중단/그만} → CANCELLED (no resume); ambiguous →
  re-send the approval notice (no resume). The orchestrator contract is unchanged.
- **`StatelessApprovalFlow`** (production `ApprovalFlow`) anchors the in-flight `{request, prior}` on
  the in-focus `Task.metadata` (+ `Session.activeTaskId`, `Task.planId`) and reconstructs it on the
  next turn, so resume is genuinely functional (no orchestrator-contract change). The approve path
  **reconstructs before `decide`** — a decision is never recorded unless the execution can be resumed.
- **`ResponseComposer.composeExecutionResult(...)` + `composeApprovalRequired(...)`** added; the
  runtime never builds reply text itself (all user-facing text goes through `ResponseComposer`).
- **Short-term memory only** (record user/assistant turns; read history; `ContextBuilder` context).
  No long-term/vector/working memory, no memory repo/schema change.
- `ExecutionOrchestrator` + `IntentResolver` (Sprint 2j) are now wired into the composition root via
  the runtime (previously standalone).
- **Out of scope (CA-confirmed):** Agent Runtime · Tool Calling · Retry/loop/reflection · Workflow
  Engine · Background Task · Discord UI (buttons) · Telemetry · any new memory subsystem.
- Tests (+12, fake managers): chat→RESPONDED; execution low-risk→COMPLETED; high-risk→AWAITING_APPROVAL
  (anchored); next-turn approve→decide+resume; deny→DENIED (no resume); cancel→CANCELLED (no resume);
  ambiguous→clarify (no resume); approve with unreconstructable state→no decide, re-ask; fresh
  AWAITING_APPROVAL text via ResponseComposer; runtime persists no state; no Session snapshot; and a
  **production-like `StatelessApprovalFlow`** proving halt→approve→`orchestrator.resume()` end-to-end.
  **Validation runtime: Node 22** — `pnpm typecheck` PASS; `pnpm test` 37 files / **245 tests** PASS.
  Plan: `docs/plans/sprint-2k-conversation-runtime-plan.md`.

### Added — Sprint 2j · Execution Orchestrator (Application Layer — capability composition)

- **Phase 2 begins: the first Application-layer composition** (ADR-0031). Phase 1 (Capability Layer,
  CAP-001…009) is closed. **Not a new capability** — it composes the completed capabilities into one
  safe execution flow: `Intent Resolver → Execution Orchestrator → Capability Managers`. No
  Core-contract change, **no new aggregate/repository/migration**.
- **`ExecutionOrchestrator`** (`run`/`resume`) — composes Planning → AI Code Generation → Workspace
  diff → Approval → Patch → Workspace Write → Command Execution by **threading Refs**; calls each
  manager's public method only. **Capability managers stay mutually unaware**; only the orchestrator
  composes them. Provider selection stays with `ProviderSelector`.
- **Capability Selection** (`selectStages`) — the orchestrator's first responsibility: maps a
  request's `requiredCapabilities` to an **ordered subset** of stages (dynamic, not a fixed
  pipeline). Analyze-only → `[PLANNING]`; run-tests → `[PLANNING, APPROVAL, COMMAND_EXECUTION]`;
  code-change → the full chain.
- **Stateless / owns no aggregate** — `ExecutionPlan` is the correlation root (every downstream
  aggregate carries `executionPlanRef`); the orchestrator persists nothing and returns a transient
  `ExecutionOutcome` read-model (`COMPLETED | AWAITING_APPROVAL | DENIED | STOPPED_ON_FAILURE |
  CANCELLED`).
- **`ExecutionContext`** — a transient, per-invocation Application-layer context (not an aggregate,
  never persisted): `executionPlanRef`, `workspaceRef`, `projectId`, `requestedBy`, `selectedStages`,
  `logger`, `cancelToken?`.
- **Approval halt + resume** — halts at PENDING (`AWAITING_APPROVAL`); **never calls `decide`**.
  `resume(request, prior, cancelToken?)` re-reads the approval and, if APPROVED, reconstructs the
  proposal/diff from refs and continues; PENDING ⇒ re-halt; REJECTED ⇒ `DENIED`. Resume wiring is
  deferred.
- **Cancellation Contract** — cooperative `cancelToken` checked at each stage boundary (and during
  the approval wait): on signal, stop without calling the next capability → `CANCELLED`. **No
  compensation/rollback**; `CANCELLED` is Application-state only (no capability aggregate touched).
- **Failure rule** — a failed/thrown stage ⇒ `STOPPED_ON_FAILURE`; the next capability is not
  called. **No retry** (future Agent Runtime).
- **`IntentResolver`** — maps an execution-capability `Intent` to an `ExecutionRequest`, else `null`
  (chat/analysis stay on the existing fast path). Kept distinct from `IntentClassifier`.
- **Not implemented (CA-confirmed):** Workflow Engine · Conversation Runtime · Agent Runtime · Retry
  · Event Bus · Parallel Execution · Telemetry · Memory · Discord Integration. Not yet wired into
  `ChunsikCore`/composition root (standalone services; wiring is the future Conversation Runtime).
- Tests (+23): Capability Selection per intent; happy code-change/run-tests/analyze-only chains;
  HIGH-risk halt (Patch not called); resume APPROVED/REJECTED/PENDING; failure + thrown-error stops;
  cancellation between stages + during the approval wait; IntentResolver mapping — all with **fake
  managers**. Vitest 36 files / **233 tests**. Plan: `docs/plans/sprint-2j-execution-orchestrator-plan.md`.

### Added — Sprint 2i · CAP-009 Ollama AI Code Generation Provider (second adapter; suggest-only)

- **A second `AiProvider` for AI Code Generation (CAP-008) — not a new capability** (ADR-0030).
  Proof the AI Layer contract is provider-agnostic: Ollama authors a `CodeProposal` with **no Core
  change** — no new aggregate, manager, port, repository, or migration. The AI still only *proposes*.
- **`OllamaCliProvider.execute(AiRequest)` + `isAvailable()`** implemented behind the existing
  `AiProvider` port. **Suggest-only is honest for Ollama:** `ollama run <model>` is single-shot text
  generation (no tools/exec/file access/agent loop), so it satisfies the propose-only boundary by
  construction — unlike Codex (no deterministic suggest-only mode → stays NotImplemented/unavailable).
- **Invocation:** `ollama run <model>`, prompt on **stdin** (never argv), in a **neutral cwd**
  (`tmpdir()` — a local model never needs the repo and must not ingest it). Output masked.
- **Failure taxonomy (ADR-0015):** `TIMEOUT` / `UNAVAILABLE` (spawn failure) / `EXECUTION_FAILED`
  (non-zero) / `EMPTY_OUTPUT`. No `AUTH_REQUIRED` (Ollama is local/auth-free).
- **Selection:** advertises `CODE_IMPLEMENTATION` at **priority 40** (below Claude's 50) — Claude is
  preferred for code when available; Ollama is the local/offline fallback. Data-driven via
  `ProviderSelector`; Core never names `'ollama-cli'`.
- **Wiring:** `OllamaCliProvider` added to `AI_PROVIDERS` from the existing `OLLAMA_CLI_BIN`/
  `OLLAMA_MODEL` config. **`isAvailable()`-gated** — an environment without `ollama` is unaffected.
- **Runtime note (intentional):** Ollama's pre-existing `GENERAL_CHAT`/`SUMMARIZATION` priority (100
  > Claude 50) means that **where `ollama` is available, the live chat path now prefers Ollama**
  (local-first; Claude fallback). Pre-existing priorities left unchanged.
- **Unchanged:** `parseCodeProposal`, `CodeGenerationManager`, aggregates, `PromptRenderer`,
  `ProviderSelector`, migrations, and Codex (still NotImplemented).
- Tests (+10): `OllamaCliProvider` success → `MARKDOWN_REPORT`, `ollama run <model>` argv + stdin
  prompt + neutral cwd (workspace ignored) + no agent/exec flag, full failure taxonomy,
  `isAvailable` true/false, `CODE_IMPLEMENTATION` priority = 40 < Claude; Claude/chat regression
  green — Vitest 34 files / **210 tests**. Doc: `docs/capabilities/code-generation.md` (ADR-0030).

### Added — Sprint 2h · CAP-008 AI Code Generation Capability (Codex; propose, never apply)

- **First AI Layer capability.** Asks a code-capable `AiProvider` (Codex first) to author a code
  **proposal** for an `ExecutionPlan`. **The AI proposes; it does not decide, approve, apply, or
  execute** — never a source of truth.
- **Two owned aggregates (AI owns both):** `CodeGeneration` (run; `PENDING|GENERATING|SUCCEEDED|
  FAILED`, holds a `CodeProposalRef`) and `CodeProposal` (output; `ProposedChange[]` + providerId
  + usage? + artifacts?). AI never owns any downstream aggregate (AI-Layer Ownership Rule, ADR-0029).
- **`CodeGenerationManager.generate`** — `PromptComposer` → `PromptSpec` → **`PromptRenderer`** →
  **`AiRequest`** → (**`ProviderSelector`**) → `AiProvider.execute` → `parseCodeProposal` → persist.
  Exactly ONE generation per call (no retry). Failures classified (ADR-0015) and recorded as FAILED.
- **`AiProvider` port narrowed to `AiRequest`** (no `PromptSpec`): rendering moved from the CLI
  adapter (`renderPromptSpec`, deleted) to the core `PromptRenderer`; `ClaudeCliProvider` + the
  chat path updated. **`ProviderSelector`** extracts selection from `CapabilityRouter` (now its impl;
  `route`→`select`).
- **`CodexCliProvider.execute()` deferred — NotImplemented** (implementation-review MB-1): the
  Codex CLI has no deterministic suggest-only / no-tool / no-exec mode (`codex exec --sandbox
  read-only` is read-only *agent* execution, not proposal-only), so shipping it would cross the
  CAP-008 boundary. It is treated as unavailable (never selected); real Codex execution awaits a
  verified suggest-only contract (future PR). The capability runs on any suggest-only `AiProvider`.
- **No Workspace bypass** (implementation-review MB-2): the AI Code Generation `AiRequest` carries
  **no workspace cwd** — context flows only via `contextFiles`/`prompt`, so a provider cannot
  read/traverse the repo itself and bypass CAP-001 Workspace Read. `workspaceRef` is recorded on
  the aggregate (read-only reference) but never handed to the provider. Core stays
  HTTP/`child_process`-free.
- **Provider-agnostic proposal parsing** (`parseCodeProposal`): one fenced ```json envelope →
  `ProposedChange[]`; malformed → FAILED. Identical for Codex and Ollama (CAP-009 parity).
- **Persistence:** `CodeGenerationRepository`/`CodeProposalRepository` + Sqlite + **migration v6**
  (`code_generations`, `code_proposals`).
- **Not implemented (CA Non-blocking):** `generationHash`, `providerVersion`/`modelVersion`,
  Proposal Lifecycle, Prompt Version, Provider Cost, Token Usage, Provider Capability, Failure-
  Taxonomy extension; tool-calling, conversation state, generation retry, streaming.
- Tests (+21): `parseCodeProposal`, `PromptRenderer`, `CodeGenerationManager` (success/parse-fail/
  provider-error/identity-of-AiRequest/no-workspace-bypass/history), `CodexCliProvider`
  (execute+isAvailable → NotImplemented / unavailable), Sqlite code-gen/proposal round-trip,
  migration v6 — Vitest 34 files / 200 tests. Capability doc `docs/capabilities/code-generation.md`.

### Added — Sprint 2g · CAP-007 Command Execution Capability (run, gated)

- **`CommandExecution`** aggregate (Command-Execution-owned) — the **Execution History** of
  running one command: `{ executionPlanRef, approvalRef?, workspaceRef, workspaceChangeRef?,
  command, args, commandHash, status, exitCode?, stdout, stderr, durationMs, riskLevel }`.
  `CommandExecutionStatus = PENDING|RUNNING|SUCCEEDED|FAILED|TIMED_OUT`. The last aggregate of
  the Execution Ledger (`… → WorkspaceChange → CommandExecution`).
- **Command identity (CAP-007 review, MB-1):** `commandHash` = deterministic content hash of
  `command` + `args` (pure `contentHash`, no `node:crypto`) — basis for audit / duplicate
  detection / resume / a future retry.
- **`CommandExecutionManager.run`** — three deterministic gates BEFORE the runner: **(1)
  allow-list** (`pnpm`/`npm`/`node` only, exact match, fails closed — MB-3); **(2) risk**
  (`RiskPolicy.assessCommand`; CRITICAL/destructive → refused regardless of approval — MB-2);
  **(3) approval (Ref only)** (HIGH → APPROVED + plan-scope match; LOW/MEDIUM → none — MB-2).
  Then runs and records (SUCCEEDED/FAILED/TIMED_OUT).
- **`CommandRunner`** port + **`LocalCommandRunner`** adapter (new `@chunsik/command-local`;
  `node:child_process` argv-array `spawnSync`, **`shell:false`, required timeout, cwd =
  workspace root, minimal env by default, masked + size-capped output**). **Core stays
  `child_process`-free.**
- **Execution-security (CAP-007 implementation review):** (a) **minimal child env** — the
  runner never passes the full parent `process.env` to a child by default (only PATH/HOME;
  explicit env overrides); (b) **dangerous-arg-aware allow-list** — eval-style `node` flags
  (`-e`/`--eval`/`-p`/`--print`, incl. `=value`/short clusters) are refused so a command-name
  allow-list cannot be bypassed into arbitrary code execution.
- **`runCommand` relocated** off `WorkspaceProvider` → the `CommandRunner` port (mirrors the
  CAP-002 `gitStatus` move). Workspace ≠ Command Execution.
- **Persistence:** `CommandExecutionRepository` (`findByExecutionPlan`/`findByWorkspaceChange`)
  + `SqliteCommandExecutionRepository` + **SQLite migration v5** (`command_executions`) via the
  ADR-0020 runner. References plan/approval/workspace/change — mutates none (Aggregate Ownership).
- **Not in scope (CA-confirmed):** retry (Execution Orchestrator), streaming output,
  background/long-lived processes, ExitCode-as-VO, AI command generation, orchestrator/Discord
  wiring (ADR-0028).
- Tests (+33): CommandExecutionManager (allow-list, dangerous-arg/eval-flag refusal, CRITICAL
  refusal, HIGH-approval + plan-scope, MEDIUM no-approval, status mapping, identity, no-mutation),
  LocalCommandRunner (argv-array, minimal-env/no-parent-env-leak, masking/cap incl. ReDoS-safe,
  real node exec, timeout), SqliteCommandExecutionRepository, migration v5 — Vitest 30 files /
  179 tests. Capability doc `docs/capabilities/command-execution.md`.

### Added — Sprint 2f · CAP-006 Workspace Write Capability (apply, never generate)

- **`WorkspaceChange`** aggregate (Workspace-Write-owned) — the **Execution History** of
  applying a `PatchSet`: `{ patchRef, patchHash, executionPlanRef, approvalRef, workspaceRef,
  status, results: FileChangeResult[] }`. `WorkspaceChangeStatus = PENDING|APPLYING|APPLIED|
  PARTIALLY_APPLIED|FAILED`; `FileChangeResult = { path, operation, status, message, durationMs }`.
- **Patch revision contract (CAP-006 review):** `WorkspaceChange.patchHash` persists the
  applied PatchSet's content revision; the same revision re-run is idempotent, a different
  revision for the same PatchSet id is refused (no cross-revision reuse).
- **`WorkspaceWriteManager.apply`** — approval gate (Ref only: APPROVED + plan-scope match;
  no `ApprovalManager` query), **status-based idempotency** (one change per PatchSet; APPLIED
  → no-op), **best-effort** apply (every op attempted, all results recorded), final status derived.
- **`WorkspaceWriter`** port + **`LocalWorkspaceWriter`** adapter (`node:fs` + jsdiff
  `applyPatch`; **atomic unit = file** via temp-write+rename / unlink; sandboxed; binary →
  skipped; conflict → failed). **No git, no child_process, no commit** (Repository-Independent).
- **Persistence:** `WorkspaceChangeRepository` + `SqliteWorkspaceChangeRepository` + **SQLite
  migration v4** (`workspace_changes`) via the ADR-0020 runner. References the immutable
  `PatchSet`/`ExecutionPlan`/`ApprovalRequest` — mutates none of them (Aggregate Ownership).
- **Not in scope (CA-confirmed):** Rollback (future capability), Resume (records only), git
  recovery, command execution, AI integration, orchestrator/Discord wiring (ADR-0027).
- Tests (+15): WorkspaceWriteManager (approval+plan-scope, idempotency, best-effort
  partial/all-fail, no-PatchSet-mutation), LocalWorkspaceWriter (add/update/delete/conflict/
  binary/sandbox over real fs+jsdiff), SqliteWorkspaceChangeRepository, migration v4 — Vitest
  27 files / 144 tests. Capability doc `docs/capabilities/workspace-write.md`.

### Added — Sprint 2e · CAP-005 Patch Capability (generate, never apply)

- **`PatchSet`** aggregate (Patch-owned, **immutable**) of `PatchOperation`s
  (`{ path, operation: add/update/delete, diff, metadata? }`), with `PatchRef` and
  `PatchStatus` (**`GENERATED` only**). References `ExecutionPlanRef` + `ApprovalRef`; never
  mutates them (Aggregate Ownership Rule).
- **`PatchManager.generate`** — deterministic; **requires an APPROVED `ApprovalRef` scoped to
  the same ExecutionPlan** (`ApprovalRef` is now plan-scoped: `{ id, status, executionPlanRef }`;
  referential integrity — an approval from a different plan is rejected) — no `ApprovalManager`
  query; merges `changes: ProposedChange[]` with their `diff: WorkspaceDiff` (supplied
  independently) into operations; persists a `GENERATED` `PatchSet`.
- **Patch generates, never applies** (Workspace Write, CAP-006, applies) — a permanent
  architectural separation (ADR-0026). No file/git writes; no I/O beyond persistence.
- **Persistence:** `PatchRepository` port (`findByExecutionPlan`) + `SqlitePatchRepository`
  + **SQLite migration v3** (`patches` table) via the ADR-0020 runner.
- **Not in scope:** patch application, file writes, git apply/commit, workspace mutation,
  execution, rollback, AI integration, command execution, orchestrator/Discord wiring.
- Tests (+9): PatchManager (generation, modify→update mapping, APPROVED-ref enforcement,
  diff-mismatch, binary metadata, persistence, no-Ref-mutation), SqlitePatchRepository,
  migration v3 — Vitest 24 files / 127 tests. Capability doc `docs/capabilities/patch.md`.

### Added — Sprint 2d · CAP-004 Approval Capability (first persisted aggregate)

- **`ApprovalRequest`** aggregate (Approval-owned), ExecutionPlan-based: references
  `executionPlanRef`, with `ApprovalStatus` (PENDING/APPROVED/REJECTED), `ApprovalRef`,
  and `ApprovalDecision`. **Approval never mutates `ExecutionPlan`** (Aggregate Ownership
  Rule, ADR-0025); approval state lives only on `ApprovalRequest`.
- **`ApprovalPolicy`** (deterministic; reuses `RiskPolicy`) + **`ApprovalManager`**
  (`requestFor`/`decide`/`get`/`isApproved`; auto-approves when no approval is required).
- **Persistence (first V2 aggregate):** `ApprovalRepository` port (`findByExecutionPlan`) +
  `SqliteApprovalRepository`, created by **SQLite migration v2** (`approvals` table) via the
  ADR-0020 runner. The generic `approvals` stub repository is removed.
- **Aggregate Ownership Rule** recorded in ADR-0025: each capability owns exactly one
  aggregate; only the owner mutates it; others reference/read/consume.
- **Not in scope:** ExecutionPlan mutation, Discord approval UI, orchestrator wiring,
  role-based authorization, expiry enforcement, Patch/Workspace Write (ADR-0025).
- Tests (+11): ApprovalPolicy, ApprovalManager (incl. a no-ExecutionPlan-mutation test),
  SqliteApprovalRepository round-trip, migration v2 — Vitest 22 files / 118 tests.
  Capability doc `docs/capabilities/approval.md`.

### Added — Sprint 2c · CAP-003 Planning Capability (deterministic ExecutionPlan)

- New cross-capability execution contract **`ExecutionPlan`** (+ `ExecutionStep`,
  `EstimatedChanges`, `ExecutionPlanRef`, `PlanningRequest`, `ExecutionStatus`) — the
  blueprint consumed by Approval → Patch → Workspace Write. See `docs/execution-plan.md`.
- **`ExecutionPlanner`** port (`EXECUTION_PLANNER`) with the v2 strategy
  **`DeterministicPlanner`** (pure, deterministic, **AI-free**; reuses `RiskPolicy` for
  `overallRisk`/`approvalRequired`). Thin **`PlanningManager`** delegates to the port and
  imports no other capability manager (context arrives via `PlanningRequest`).
- **Decisions (ADR-0024):** deterministic only (AI may assist later, never the source of
  truth); distinct from the v1 `Plan`; **no persistence** (in-memory; begins at Approval);
  **no orchestrator wiring**; Planning precedes Approval in the roadmap.
- Tests (+11): DeterministicPlanner (determinism, risk/approval, steps, artifacts, scope,
  empty request), PlanningManager (delegation, empty-goal guard, planRef), ExecutionPlan
  domain — Vitest 19 files / 107 tests. Capability doc `docs/capabilities/planning.md`.

### Added — Sprint 2b · CAP-002 Git Capability (read-only)

- New **`GitProvider`** port (+ `GIT_PROVIDER` token), **`@chunsik/git-local`** adapter
  (`LocalGitProvider`), and **`GitManager`** core service: read-only `isRepository`,
  `info` (`RepositoryInfo`: branch/HEAD/detached), `status` (`GitStatus`).
- Git runs **adapter-only** via argument-array `spawn` (no shell string, no `shell:true`),
  with a timeout, cwd = repository root, and **sanitized stderr**. **Core stays
  `child_process`-free** and provider-agnostic. Composes with Workspace via `rootPath`.
- **Git ≠ Workspace:** the `gitStatus` stub is removed from `WorkspaceProvider`; `GitStatus`
  moves to `domain/git.ts`; `WorkspaceManager.ensureSafe/status` → `GitManager`.
- **Not in scope:** no commit/checkout/branch/merge/reset/stash/push/pull/fetch/tag, no
  worktree, **no remote-URL exposure** (credential safety), no Approval/Patch (ADR-0023).
- Tests (+15): non-repo, detached HEAD, dirty/clean, untracked/staged, argument-array spawn,
  timeout/spawn-failure, no-remote-URL, porcelain/stderr parsers — Vitest 16 files / 96 tests.

### Added — Sprint 2a · CAP-001 Workspace Capability (read-only)

- Read-only Workspace foundation (ADR-0022): `resolve`/`readFile`/`listFiles`/`diff` on the
  `workspace-local` adapter; `node:fs` only; diff = current file → proposed content
  (pre-approval seam). `WorkspacePolicy`, `WorkspaceDiff.estimatedChangedLines`. Core
  dependency-free (jsdiff is adapter-only). Capability docs under `docs/capabilities/`.

### Added — Sprint 1g (gated project analysis)

- New `PROJECT_ANALYSIS` intent + capability: a structure/analysis question
  ("이 프로젝트가 어떤 구조인지 설명해줘") classifies deterministically (analysis verb ×
  project/structure noun, either order; KO + EN) and runs as a LOW-risk Task.
- `ProjectAnalyzer.prepare(session)` guards an active, resolvable project (else a
  friendly "register first"), then performs a **read-only, size-limited** readout via
  `WorkspaceProvider.readProjectFiles`: an **allow-list of project metadata files**
  (package.json, pnpm-workspace.yaml, README.md, ARCHITECTURE.md, DECISIONS.md,
  tsconfig*.json), 8 KB/file cap (`truncated` flagged), a 2-level tree
  (root + apps/ + packages/), excluding node_modules/dist/build/.git/coverage.
- **Secrets are never read** (`.env*` and secret/token/key/credential/password names
  are skipped unconditionally); no shell/git commands run during analysis.
- `PromptComposer.compose(task, bundle, readout?)` renders the readout as a read-only
  section and instructs the model to summarize only from the shown files/tree.
  The analysis result is persisted as a `TOOL` memory (`kind: 'analysis'`) for reuse.
- Re-registering the same local path is now idempotent (one `Project` per normalized
  rootPath; the session is rebound).
- **Not in scope (ADR-0019 non-goals):** repository indexing, vector search, semantic
  code search — repository-wide indexing remains deferred.
- Tests: ProjectAnalyzer guard, intent classification (KO/EN, both orders),
  readProjectFiles (allow-list / secret-skip / 8 KB cap / 2-level tree) — Vitest
  12 files / 62 tests. Live smoke: a structure question answered from real
  ARCHITECTURE.md/DECISIONS.md/package.json (7 ports, package→port map, tech stack).
  ADR-0019 (Gated Project Analysis).

### Added — Sprint 1f (local project registration)

- Natural-language project registration: "이 프로젝트 등록해줘: /path" →
  `REGISTER_PROJECT` intent → `ProjectManager` (deterministic command). Read-only
  scan via `WorkspaceProvider.scanProject` (name, git branch / 'unknown', package
  manager, top-level file tree excluding node_modules/dist/build/.git/coverage).
- Persists a `Project` (SQLite `projects`) + a PROJECT memory summary scoped by
  `projectId`; binds `session.activeProjectId`. Non-existent path → friendly failure.
- `ContextBuilder` includes the active project's PROJECT memory; `PromptComposer`
  renders it and instructs the model to answer from the provided context (no file/tool
  access). Workspace prep gated to filesystem capabilities (chat doesn't resolve a workspace).
- ADR-0017 addendum: SHORT_TERM memory capped at 30/session (oldest pruned); the
  current inbound message is excluded from recent context. ADR-0018 (registration policy).
- Tests: project registration, scanProject (invalid/non-git/exclusion), memory pruning,
  context exclusion/project (Vitest 10 files / 51 tests). Live smoke: register + a
  follow-up that explained the structure from the injected project memory.

### Added — Sprint 1e (short-term conversation memory)

- Inbound user messages and assistant responses are stored as SHORT_TERM memory,
  scoped by `sessionId` (role in metadata; no provider id stored).
- `ContextBuilder` includes the recent N=10 same-session turns (simply truncated at
  400 chars); `PromptComposer` renders them into the conversation/context layer, so a
  follow-up can reference the previous turn.
- SQLite `memories.session_id` column (+ defensive migration); session-scoped retrieval.
- Chunk numbering `(i/N)` for multi-message replies; partial-send-failure notice
  ("답변 일부를 전송하지 못했어요.") via `deliverWithNotice` (one attempt, no resend).
- ADR-0017 (conversation memory policy). Tests: memory persistence + session recall +
  delivery numbering/notice (Vitest 8 files / 41 tests). Live smoke: a 2-turn chat where
  the follow-up shortened the prior answer.

### Added — Sprint 1d (harden Discord response delivery)

- Long responses are chunked under Discord's 2000-char limit (`DISCORD_SAFE_LIMIT`
  = 1900; newline/space boundaries, hard-cut for over-long tokens) and sent
  sequentially in order.
- Send-failure handling: stop on first chunk failure (partial delivery reported +
  masked log), no resend (no duplicates); rate-limit backoff delegated to discord.js.
- Typing indicator refreshes every ~8s during long runs (cleared on reply / safety
  cap), fixing the gap where "is typing…" expired after ~10s on ~50–70s runs.
- `ResponseComposer` trims output + non-empty fallback. File-attachment for very
  long responses is a documented seam only (deferred). ADR-0016.
- Tests: `delivery.test.ts` (chunking boundaries/hard-cut/ordered send/stop-on-
  failure). Vitest 7 files / 32 tests. Live smoke: 5351-char answer → 3 chunks.

### Added — Sprint 1c (harden CLI provider failure handling)

- Provider-agnostic failure taxonomy `AiFailureKind` (UNAVAILABLE, AUTH_REQUIRED,
  TIMEOUT, EXECUTION_FAILED, EMPTY_OUTPUT) and `AiProviderError(kind, message)`.
- `ClaudeCliProvider.execute` classifies failures (timeout / spawn-failure /
  auth-stderr / non-zero / empty stdout); stderr is secret-masked.
- Core maps the kind → a friendly Discord reply (`describeAiFailure` +
  `ResponseComposer.composeError`); the user is always answered.
- `TaskRun` records FAILED + `error` summary + `durationMs` (minimal usage tracking).
- ADR-0015: accept global `~/.claude` context in v1 (neutral cwd retained, no
  `--bare`); failure taxonomy, masking, and usage minimalism.
- Tests: failure-kind classification, `maskSecrets`, `describeAiFailure`
  (Vitest 6 files / 24 tests). Simulated failure smoke over all five kinds.

### Added — Sprint 1b-2 (Claude CLI execution)

- Real `ClaudeCliProvider.execute` / `isAvailable`: runs `claude -p` with the prompt
  on **stdin**, in a **neutral cwd**, with a **timeout**, capturing stdout/stderr
  (no `--bare`, OAuth CLI auth, no API path) — per ADR-0014.
- `renderPromptSpec` (provider-side `PromptSpec` → CLI text) and an injectable
  `CliRunner` (`defaultCliRunner`) + `maskSecrets` for redacting CLI output.
- Claude's response is stored as a `MARKDOWN_REPORT` artifact and replied to Discord;
  non-zero exit / timeout → `TaskRun` FAILED.
- `AI_PROVIDERS` now `[ClaudeCliProvider]` (placeholder retained but unused).
- Minimal Vitest suite (5 files / 15 tests): RiskPolicy, PromptComposer,
  ContextBuilder, CapabilityRouter, ClaudeCliProvider command construction.
  Test files excluded from the `tsc` build.

### Added — Sprint 1b-1 (core task pipeline)

- Discord inbound is now handled by `ChunsikCore.handleInboundMessage` (replacing
  the temporary echo): resolve Actor → open Session → classify → create Task →
  plan → ContextBuilder → PromptComposer → CapabilityRouter → provider → Artifact
  → reply.
- Minimal deterministic `IntentClassifier` (→ GENERAL_CHAT, requiresWork) and
  `Planner` (single step, risk via RiskPolicy).
- New domain contracts `PromptSpec` and `ContextBundle`; `ContextBuilder` (trivial)
  and `PromptComposer` (minimal, layered) application services (ADR-0014).
- `AiExecutionRequest.promptSpec?` added (additive); provider renders it.
- SQLite persistence implemented for `tasks`, `taskRuns`, `artifacts`, `memories`.
- `PlaceholderAiProvider` (app, Sprint 1b-1 only) returns a deterministic response
  via the router — **no AI call yet**; Sprint 1b-2 swaps in the Claude CLI.
- Component test: one inbound message flows Actor→Session→Task→TaskRun→Artifact→SQLite.

### Added — Sprint 1a (walking skeleton)

- Domain: `Actor` + `ExternalIdentity` (ADR-0009), `Session` + `SessionStatus`
  (ADR-0001). Reserved `MemoryScope.sessionId` and `Task.actorId`/`sessionId`.
- `StorageProvider` extended with `actors` + `sessions` repositories.
- Core services: `ActorManager`, `SessionManager`.
- `SqliteStorageProvider` (better-sqlite3) implementing the `actors`/`sessions`
  repositories; remaining repositories stay stubbed.
- `DiscordPlatformAdapter` (discord.js): inbound normalization, send, typing.
- Composition root wires a temporary echo flow: resolve Actor → open/touch
  Session → echo reply. (Sprint 1b replaces it with `ChunsikCore`.)
- `LocalQueueProvider`/`LocalVectorProvider` lifecycle methods made no-ops so the
  app boots; their real operations remain unimplemented.
- Walking-skeleton observability: a thin `Logger` seam (`@chunsik/core`) with a
  console-backed `ConsoleLogger` in the app; `[discord]`/`[chunsik]` namespaced,
  structured, no secrets/content logged. Replaceable by a future LoggerProvider.

### Added — Sprint 0 (repository operating system)

- Hexagonal **pnpm monorepo** scaffold: framework-agnostic core (domain, 7 ports,
  application services), one package per concrete provider (skeletons), and a
  NestJS composition root wiring ports → providers via injection tokens.
- AI-native documentation: `ARCHITECTURE.md` (constitution), `DECISIONS.md`
  (ADR-0001…0011), `AGENTS.md` (agent operating manual), `CLAUDE.md` (pointer).
- Repository operating model (ADR-0012, ADR-0013): role-based collaboration model,
  `ROADMAP.md`, `CURRENT_STATE.md`, `CHANGELOG.md`,
  `docs/templates/ADR_TEMPLATE.md`, and Conventional Commits as the repo standard.

### Notes

- No business logic implemented — clean architecture boundaries only.
- `pnpm typecheck` passes; Core cannot resolve adapter packages (boundary enforced).
