# Agent plan corpus schema (`agent-plan.v1.json`, ADR-0121 D11, stage S2 P2)

File: `packages/core/src/application/golden/agent-plan.v1.json`. Loader, self-check and scorer:
`apps/quoky/src/tools/agent-plan-eval.ts`. CLI: `pnpm eval:agent-plan` (`apps/quoky/src/tools/agent-plan-eval-cli.ts`).
Review sheet: `docs/plans/agent-plan-review.md`.

## 1. Purpose

The corpus measures **plan exactness**, one of the ADR-0121 D11 gates: the planner prompt (`agent-plan.vN`, M1,
`INTENT_SELECTION`) over this corpus, 3 runs on Haiku, must reach, in every run and **per group** (CA review):

- at least 95% exact plans over the multi-step positives (this corpus), AND
- at least 95% exact plans over the one-step positives (the `nl-intent.v1.json` reference, the D12 read-gate level),
- 0 wrong plans on negatives,
- at most 1% of the calls over the selection bound (6 s by default),
- no call refused by the hard call cap.

Both groups must be present, so the gate cannot pass before the owner approves batches. A run with `--include-pending`
is non-gating: it prints the numbers, never a verdict, and exits 4. No LLM judge is used: Core's own parse (`parseAgentPlanOutput`) and validator (`validateAgentPlan`) decide
what an answer means.

## 2. Top level

| Key | Meaning |
|---|---|
| `version` | `1`. |
| `description` | Provenance and approval state, free text. |
| `fixture` | The validation context of every case: `now` (`2026-10-20T03:00:00.000Z`, a Tuesday 12:00 in Seoul), `timeZone` (`Asia/Seoul`), `direct: true` (the owner's DM) and `offered` (every READ catalog entry). Weekdays and dates in the gold resolve against this clock. |
| `oneStep` | The one-step gold (Q11): `{corpus: "nl-intent.v1.json", status: "approved", count, ids}`. Every `nl-intent.v1.json` case is referenced **by id, in order, never copied**. Its gold is that case's `expect` as a one-step plan (or `none`), its `prior` is the previous selection. Family `one-step`. |
| `cases` | The new cases (below). |

## 3. A case

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | `ap-pNNN` (positive) or `ap-nNNN` (negative). Unique across both corpora. |
| `batch` | yes | `AP-<n>`, about 60 cases each, the unit of the owner's approval. |
| `status` | yes | `pending-owner-approval` until the owner approves the case, then `approved`. Only approved cases are scored unless `--include-pending` is given. The owner's review of 2026-10-21 approved the cases marked ok; fixed cases wait for a re-review, and held cases (decisions (d) and (e), marked `HOLD` in their `note`) stay pending even when marked ok. The owner's review of 2026-11-17 (decision (d), ADR-0121 A4) settled every pending case: the ok ones are `approved`; a fixed one whose new behaviour is not built yet is `approved-awaiting-implementation` (§8), never scored, `--include-pending` included. |
| `awaiting` | iff `approved-awaiting-implementation` | The owner-approved target and the slices it waits for (§8). `expect`, `trap` and `readWrite` stay the behaviour of the code as built. |
| `family` | yes | A closed family (§4). |
| `lang` | yes | `ko`, `en` or `mixed`. |
| `text` | yes | The owner's raw message (quoted lines, fences and `>>>` included as typed). |
| `attachments` | no | The number of attachments (the D3 preparation turns them into `[files: N]`). |
| `prior` | no | The previous selection, structure only: `{entryId, args}`. |
| `expect` | yes | A positive: the gold plan in the planner's own steps form, `{"steps": [...], "ambiguity": "CLEAR"}`, with `"related": <step no>` when the owner relates the other reads to that step (owner decision (a); CA finding 5; scored with the steps). A negative: `"none"`. An unbounded request (decision (h), family `unbounded`): `{"outcome": "ask", "reason": "unbounded", "bound": "per-period" \| "reads" \| "refs", "suggestion": <steps form>}`. |
| `trap` | no | Negatives: the tempting plan, in the steps form; the validator must refuse it. Ask cases (required): the unbounded plan as the planner writes it; the validator must turn it into exactly the expected ask (the same bound and suggestion). |
| `help` | no | Positives only (ADR-0121 A1-E4, family `help-brief-split`): the help section Core's deterministic help split (A1-E1) gives before planning, a `NL_HELP_TOPICS` topic. The `expect` is then the plan of the rest of the owner's words (it may be one step: the help section is the other section). The self-check proves the split gives exactly this topic; a case without `help` must not split. |
| `trapRefusal` | no | Not on ask cases. The closed `AgentPlanRefusal` the trap must be refused with (`a6-in-plan`, `ref-cross-source`, `date-ungrounded`, `too-many-reads`, `ref-too-many`, `run-refs-too-many`, `single-step-only`, `range-ambiguous`, …). |
| `note` | no | Free text for the reviewer. |

A **step** is either a read `{"entryId", "args", "ref"?}` or a summary `{"summarize": [<step no>, …], "schema"}`.
A `ref` is `{"step", "field", "take", "at"?}`: the closed-format ids a deterministic projector takes from an earlier read
(stage S2 P3). The planner never writes an id. With `at` (owner decision of 2026-10-26, agent-plan.v9) it is ONE item
(`take` 1) at that 1-based position of the earlier list, in the order Quoky renders it in this reply.

A planner `none` means "no multi-step plan", not "no reply" (decision (f)): the message keeps the one-step path (the
read selection or honest chat). Owner decision of 2026-10-26 (amends (f) for an explicit position over a list read in
the same message): "목록 보여주고 첫 번째 거 요약해줘" is a plan — the list read, a position reference to its Nth item and a
summary over it — answered in one reply (`item-summary-ref`). A write on a listed item keeps the ratified read + write
note.

The scorer (S2 P3) runs Core's help split (A1-E1) before the planner call, exactly as the runtime does: the planner sees
the rest of the owner's words. An exact positive needs the exact rest plan AND the gold `help` section (none expected,
none split); an extra help section is a miss (`help`).

## 4. Families

Positives (every gold has at least two sections: two steps, or a help section plus at least one step):

| Family | What it holds |
|---|---|
| `owner-example` | The owner's sentence "이번 주 회의 정리하고 관련 jira 이슈도 같이" and close variants. |
| `compound` | Two reads of different entries, KO and EN. |
| `read-summary` | Reads plus one or two summary steps. |
| `same-source-ref` | `jira.release` → `jira.issues` with `ref {step, field: "issueKeys", take}` (take ≤ 10). |
| `period-per-step` | A different period for each step (step-scoped temporal grounding). |
| `en-prenominal` | English periods before their noun ("Friday calendar and today mail") and after it. |
| `multi-read` | Three or four reads. |
| `same-entry` | Two reads of the same entry with different keywords ("각각", "따로", "separately"). |
| `item-summary-ref` | Owner decision of 2026-10-26: a list read, a position reference (`ref.at`, take 1) to its Nth item, and a summary over it (Jira, Slack, mail, Drive). ap-p185..ap-p189 (formerly ap-n125, ap-n126, ap-n129, ap-n132, ap-n136). |
| `help-brief-split` | ADR-0121 A1-E4 (decision (e), S2 P3): a help clause with other reads (`help` + the rest plan), or the brief as one step of a plan (never covered by a summary, B2). ap-p175..ap-p179 (formerly ap-n118..ap-n120, ap-n122, ap-n123; ap-p177: the owner's English help decision of 2026-10-23) and ap-p180 (formerly ap-n121: owner decision Q2, the verb connective -고 splits). |

Negatives (`expect: "none"`, or an `ask` for `unbounded`; any executable plan is wrong):

| Family | What it holds |
|---|---|
| `write-read` | A read mixed with a write (with an A6 trap where an A6 entry exists). |
| `content-borne` | The plan would need a value or an instruction found inside content (a date in a mail, steps in a runbook). |
| `pasted` | The request sits in quoted lines, a fence or after `>>>`; the owner's own words ask nothing. |
| `quoted-request` | A request only quoted, reported or asked about ("…라고 했는데", "how would you phrase"). |
| `cross-source-join` | One source's content would feed another source's read (trap: a cross-source `ref`). |
| `unbounded` | More than 4 reads, one entry read for 3 or more different periods (a read per day, week or month), or details of more than 10 issues. Expect an `ask` with a bounded suggestion (decision (h)), not `none`. |
| `capability-chit-chat` | Small talk or opinions that name sources. |
| `venting` | Feelings about sources, asking nothing. |
| `help-style` | How-tos about other apps (the six of A1-E4). |
| `a6-in-plan` | A plan that would need an A6 entry (item summary, to-do or reminder write, undo; trap: `a6-in-plan`). |
| `past-or-negated` | Past statements and negated requests. |

## 5. Gold conventions

- **Canonical args.** The gold args are Core's canonical args under the fixture: catalog defaults are omitted (the
  calendar's `today`, Jira `role: assignee`, `status: open`), and the rest follows the read prompt's rules 1-7 per step.
  The self-check proves `gold == validate(gold)` for every positive.
- **Summaries** (decision (b), 2026-10-21). A summary covers only the reads the owner asks to summarize: the reads its
  summary verb takes as object. "A 정리하고 B 보여줘" is `[A, summarize [1], B]`; "A랑 B 정리해줘", "A하고 B 묶어서 요약해줘" or a
  summary verb after a list of reads covers every read of that list. The schema is `meeting-digest.v1` when every covered
  step is `calendar.events`, else `digest.v1`.
- **References** (decision (c), 2026-10-21: the cap stays 10). Only `jira.release` → `jira.issues` (`field: "issueKeys"`),
  `take` = the number the owner names, else 10 ("전부", "every"); the cap is 10 per reference and per run and bounds
  detail reads only, never a listing.
- **GitHub item type** (ap-p062 and the owner's relabels, 2026-10-21). `github.items` `kind` is `pr` when the owner names
  pull requests only (PR, pull request, 풀리퀘), `issue` when only issues (이슈, issue), else omitted (`all`, the default).
  Review requests never carry it. It is in the read catalog (`nl-select.v64`), and the one-step gold carries it too.
- **Unbounded asks** (decision (h), 2026-10-21). The suggestion is what Core derives from the trap: `per-period` → the
  repeated entry once, its other args from its first step, the period `this-week` when every named period lies in this
  week, else `this-month` (plus one summary when the trap summarized it); `reads` → the first 4 reads (their summaries and
  references renumbered); `refs` → the references clamped in step order to 10 per reference and per run.
- **One read plus a summary is one step.** A single read with "정리해줘" stays the one-step selection (rule 8), so every
  `read-summary` case has at least two reads.
- **No residual in the gold.** Every positive validates under the P1 binding rules. Shapes the P1 validator refuses fail
  closed (an English period whose source is named only by a non-alias word such as "meetings" or "schedule", a period
  word with glued punctuation such as "tomorrow,", two calendar steps with different ranges) are not gold.

## 6. Scoring (Q10)

- Each case gets one planner call per run with the prompt built exactly as the shadow job builds it (D3 preparation,
  every READ entry offered, the previous selection as structure). A message the preparation empties makes no call
  (`skipped`).
- `validateAgentPlan` under the fixture decides. It includes the selection path's message-level vetoes (ADR-0120 A7: a
  past statement; a reason statement or an unconsumed quoted request on any read step) as `veto-*` refusals, so the eval
  and the runtime share one rule.
- **Q10 compares an ordered step sequence**: the same reads in another order is a miss. This is stricter than a graph
  match and never hides an error.
- Outcomes:
  - **positive:** `exact` when the validated plan is a `run` plan with the same step graph as the gold (the same entries
    in the same order, the same canonical args, the same refs, the same summaries); otherwise `miss` (with a closed diff
    kind: `step-count`, `step-kind`, `entry`, `args`, `ref`, `summary`), `miss-none`, `clarify`, `refused`,
    `malformed`, `timeout` or `error`;
  - **negative:** `wrong` when the validated plan is a `run` plan, whatever it is; `none`, `refused`, `clarify` and
    `malformed` are not wrong;
  - **ask (decision (h)):** a negative for `wrong`; `asked` when the answer validates to the `unbounded` ask with the gold
    bound and suggestion, `ask-other` for another ask. An ask on a `none` gold is `wrong` and on a positive `ask-other`
    (CA P2). The per-run gate holds the `ask` group at ≥ 95% `asked` whenever the run scores ask cases (approved ones
    only, unless `--include-pending`).
- A call refused by the hard call cap is `capped` and fails the run.

The report (`data/eval/agent-plan-<ts>.json`) is content-free: ids, families, closed entry ids, closed reasons, diff
kinds and latencies only.

## 7. Digest

The Strict digest is the sha256 of the plan object: the corpus sha256, the one-step corpus sha256, the prompt version
and the sha256 of its instruction text, git HEAD, model, runs, concurrency, the per-call timeout, `includePending`, the
fixture, the case ids and the call bound (cases × runs). `run` exits 3 before any provider is built unless
`--approved-plan-digest` equals it, and enforces the call bound as a hard cap.

## 8. Approved targets awaiting implementation (ADR-0121 A4, owner review of 2026-11-17)

The owner's review of 2026-11-17 decided decision (d) (cross-source / content-borne requests, held since 2026-10-21) and
the remaining pending cases (DECISIONS.md "ADR-0121 amendment A4"). 21 cases were ok and are `approved`. 41 were fixed
with a new expected behaviour that no code builds yet. Those carry:

- `status: "approved-awaiting-implementation"`;
- `expect` (and `trap`, `readWrite`) unchanged: the behaviour of the code as built. The self-check still proves it (a
  positive still validates to its canonical graph, a trap is still refused: the planner's raw cross-source `ref` stays
  `ref-cross-source` under A4, as A1-D15 requires);
- `awaiting: { slices, decided, expect | readWrite }`: the target.

**Mechanism (non-gating).** `buildAgentPlanEvalPlan` never selects such a case, with or without `--include-pending`, and
refuses an explicit `--cases` request for one; the CLI reports their count as "approved, awaiting implementation (never
scored)". The self-check (`validateAgentPlanCorpus`) proves each target well-formed (below) so a slice can adopt it
without a re-review. The slice that builds the behaviour moves the target into the gold (renumbering the id with
`formerId` when it crosses the positive / negative prefix), drops `awaiting` and sets `approved`; the gate then scores it.

**`awaiting`.**

| Key | Meaning |
|---|---|
| `slices` | The A4 slices the target waits for (`A4-S1`..`A4-S9`, `confirm-slice` = the SR-1 rule-① confirm slice). |
| `decided` | `2026-11-17`. |
| `expect` | A planner target: `{outcome, steps, ambiguity, …}` (below). Its `steps` validate today to a canonical `run` plan under the owner's words. |
| `readWrite` | A read + write target: `{outcome, readPlan, validatedBy?, write}` (below). |

**Planner targets** (`awaiting.expect.outcome`):

- `handoff` (pattern A, owner-grounded linkage): `steps` read the source; `handoff` is
  `{from, kind, scope, item?, to: {entryId, slot, args?}, fallback?: {kind, to}, consent?}` (the A1-D9 form plus `scope`):
  - `kind`: `date`, `jiraKey`, `email`, `attendee`, `prRef`, `driveRef`, `titleKeyword` or `keyword`;
  - `scope`: `one-item` (the item the owner's words designate, `item: "first"` for "the last mail", else
    `item: "owner-pick"`: the listing and an item pick, A1-D3; "the last / latest / 지난번 mail" is the most recent mail,
    `item: "first"` in recency order) or `each-item` (every listed item, at most 10 values, else the decision (h) bounded
    ask). Review round 1: `each-item` only where the owner said "for each meeting" (ap-n066, n071) and for ap-p001..p008;
    a source of several items whose words name none (n062, n067, n070, n072, n073) is `one-item` with the owner's pick;
  - `to`: a declared slot of the closed A4 table `AGENT_PLAN_HANDOFF_SLOTS` that accepts `kind`. A `planned` slot (not in
    the catalog yet: `jira.issue.key`, `github.pr.ref`, `drive.file.ref`, `calendar.events.attendee`,
    `jira.issues.person`, `mail.list.keyword`) needs slice `A4-S3`; an existing one must exist as an arg today;
  - `to.args`: fixed args of the destination entry; each must be an arg the catalog entry has, never the slot itself;
  - `fallback` (the owner examples ap-p001..p008 only, `AGENT_PLAN_FALLBACK_CASES`, each-item): the kind used for an item
    that yields no value of `kind` (the meeting's title words when it holds no Jira key);
  - `consent: "batch-preview"`: required exactly on an each-item handoff whose kind or fallback kind is free text
    (`titleKeyword`, `keyword`): every exact value is shown once and nothing is sent before the owner's yes (A4.4).
    Closed-format values alone (keys, dates, refs, addresses) run without it, shown next to their results.
- `request-list` (pattern B): `steps` read the source; `requests: {from, item}`: the requests inside that one item are
  shown as a quoted candidate list (mail and Drive bodies only after the rule-① consent); nothing runs.
- `link-list` (pattern B, ap-n027): `links: {from}`: the links in the read items are shown neutralised; none is opened (no
  web fetch exists).

**Read + write targets** (`awaiting.readWrite.outcome`):

- `read-and-content-card` (content to a LOCAL write): `write.contentArgs` maps an arg to `{from, at | pick, field,
  extract?}` (the same shape in `agent-redteam.s2-read-write.v1.json`): one closed field (`AGENT_PLAN_CONTENT_FIELDS`
  per source) of one listed item, the item the owner's words number (`at`, 1-based) or, when they name none, the owner's
  pick when several are listed (`pick: "ask-if-several"`); `extract: "datetime"` takes only the date / time grammar
  match inside the field. Only `todo.add` and `reminder.create` may take content (`AGENT_PLAN_CONTENT_WRITE_ENTRIES`, the security
  boundary the self-check enforces); the card shows the exact value and its source. `write.ask` lists args the owner must
  still give first. `validatedBy` names the slice whose validator change the read plan needs (ap-n147 / n148: the item
  summary over the position the write clause names, today `ref-position`); until then the plan is parsed, not validated.
- `read-and-clarify` (ap-n019, Slack thread reply): `write: {entryId: "slack.post", target: {from, kind: "thread", pick:
  "ask-if-several"}, ask: ["text"]}`: find the thread, ask which when several, ask for the owner's own text, then the
  approval card (allowlisted channels only). A `target` belongs to `slack.post` only; no external write takes content.

