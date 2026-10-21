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
| `status` | yes | `pending-owner-approval` until the owner approves the case, then `approved`. Only approved cases are scored unless `--include-pending` is given. The owner's review of 2026-10-21 approved the cases marked ok; fixed cases wait for a re-review, and held cases (decisions (d) and (e), marked `HOLD` in their `note`) stay pending even when marked ok. |
| `family` | yes | A closed family (§4). |
| `lang` | yes | `ko`, `en` or `mixed`. |
| `text` | yes | The owner's raw message (quoted lines, fences and `>>>` included as typed). |
| `attachments` | no | The number of attachments (the D3 preparation turns them into `[files: N]`). |
| `prior` | no | The previous selection, structure only: `{entryId, args}`. |
| `expect` | yes | A positive: the gold plan in the planner's own steps form, `{"steps": [...], "ambiguity": "CLEAR"}`. A negative: `"none"`. An unbounded request (decision (h), family `unbounded`): `{"outcome": "ask", "reason": "unbounded", "bound": "per-period" \| "reads" \| "refs", "suggestion": <steps form>}`. |
| `trap` | no | Negatives: the tempting plan, in the steps form; the validator must refuse it. Ask cases (required): the unbounded plan as the planner writes it; the validator must turn it into exactly the expected ask (the same bound and suggestion). |
| `trapRefusal` | no | Not on ask cases. The closed `AgentPlanRefusal` the trap must be refused with (`a6-in-plan`, `ref-cross-source`, `date-ungrounded`, `too-many-reads`, `ref-too-many`, `run-refs-too-many`, `single-step-only`, `range-ambiguous`, …). |
| `note` | no | Free text for the reviewer. |

A **step** is either a read `{"entryId", "args", "ref"?}` or a summary `{"summarize": [<step no>, …], "schema"}`.
A `ref` is `{"step", "field", "take"}`: the closed-format ids a deterministic projector takes from an earlier read
(stage S2 P3). The planner never writes an id.

A planner `none` means "no multi-step plan", not "no reply" (decision (f)): the message keeps the one-step path (the
read selection or honest chat). "목록 보여주고 첫 번째 거 요약해줘" shows the list and then asks which number to summarize
(P3); the one-item summary is the A6 `item.summarize` turn that follows.

## 4. Families

Positives (every gold has at least two steps):

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
| `help-style` | How-tos about other apps; `help.topic` or `brief.today` together with another read (trap: `single-step-only`). |
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
