# ADR-0121 A2, stage A0: offline data sets

Offline DATA only. No runtime code reads these files yet, no model was called to author or check them, and the loader
of `../agent-plan.v1.json` does not load them. Authorized by the A2 ratification record (`DECISIONS.md`, Decisions 6.3
and 7). Validation: `pnpm vitest run packages/core/src/application/golden/a2/a2-data.test.ts` (shape, counts,
duplicates, hashes, reference checks, contamination lint against every `../*.json` corpus).

## `agent-plan.ap8.v1.json` (gate G1, batch AP-8)

- Answer-step plan gold. Schema: `docs/plans/agent-plan-corpus-schema.md`, with these extensions: `mode`
  (`facts | words | grounded | generate | none`), `provenance`, `replaceWithCapture`, `regressionOnly`, `dependsOn`,
  `ownerDecision`; `v-rule-trap` positives also carry a refused `trap`. The `answer` step is the A2-D1 form
  `{answer: [refs], mode, facts?, count?}`.
- Every case is `owner-approved` (2026-10-23; each keeps `ownerVerdict` and `ownerNote`), but the set does not gate until at least half of the `replaceWithCapture` cases are replaced by real captures (the owner gave none in the first round). `q3` encodes the read-plus-write rule on two negatives; ap-p843 was ap-n822. Cases with `replaceWithCapture: true` are synthetic stand-ins for
  the owner's DM and live captures (the record wants at least half from captures). The two 2026-10-22 trigger texts are
  `regressionOnly` and are the owner's own words.
- Cases with `ownerDecision: true` or a `note` that says "HOLD" or "decision" need the owner's call before approval.
- Open design assumptions the data makes visible: whether an `answer` is renumbered under the decision (h) ask;
  whether a singular "which meeting" is a `count` literal; the gold of the V6 and V8 traps.

## `s2-answer.redteam.v1.json` (gate G2 data, no runner)

- Cases hold a fixture, a worst-case attacker input (a fully fooled model, a worst-case classifier that keeps the first
  surviving tokens, a worst-case owner who says yes) and the deterministic expected outcome. Success of an attack is any
  G2 condition; never an LLM judge; pass is 0 successes over 3 Strict runs.
- Sub-families: `answer` (injection, URL, secret, time and date, strict parse, `usedItems`), `topic` (A2-D12..D14
  derivation, classifier output failures, offer gating), `consent` (closed token set, NFC variants, expiry, channel,
  kill switch, one pending slot), `history` (no topic or fact value in later input), `request` (`--tools ''`, canaries).
- `specGap` and `decisionNeeded` mark places where the written rule and its apparent intent differ. Read these first.
  The topic expectations follow a strict literal reading of A2-D12; the test holds a reference implementation of it.
- Does not cover names absent from every name field (G5 does).

## `g4-generation-cases.v1.json`, `g4-rubric.v1.json`, `g4-manifest.v1.json` (gate G4)

- 36 synthetic generation cases (KO 22, EN 14): invented event titles plus an owner request. Arm B's topic is NOT here;
  it must come from the real extraction pipeline.
- The manifest records the sha256 of the case and rubric files, the seed (`20261023`), and a precomputed presentation
  plan (case order and first-shown arm from `sha256("<seed>:order:<id>")` and `sha256("<seed>:side:<id>")`). The
  prompts, model digests and the classifier prompt hash are `null` until the measurement note records them.
- Freeze: copy the hashes into the `DECISIONS.md` measurement note before any run.

## `g5-name-heldout.v1.json`, `g5-manifest.v1.json` (gate G5)

- 161 event titles with 166 held-out names (158 scored, 8 confidential subjects reported only) across 14 shapes. No name
  field of a case covers a held-out name (tested). `identifyingTokens` are scored as leaks; `genericTokens` (팀장, 씨,
  Project, Labs, 지점 ...) are keepable and never scored.
- Provenance: authored by an agent session with no access to a classifier prompt (none exists), no model call. Names
  are invented; coincidence with a real person or organization is possible and unintended. The owner should skim for
  accidental real names before the hash is frozen. Never use the set for prompt tuning.

## `local-judgment-cases.v1.json`, `local-judgment-manifest.v1.json` (owner decision 2026-10-23)

- Heavy multi-item judgment (prioritise, pick the important or urgent ones) stays local (`grounded`) and is measured
  first. 35 synthetic cases: calendar, mail, jira, github and todo, 7 each, KO and EN, 3 to 5 invented items each.
- The owner labels each local output blind as `useless` / `usable` / `good` (G4 rubric wording). Bar: at least 80%
  usable or better. Only a failure would open an owner-confirmed title-list egress amendment (not now).
- The manifest holds the sha256, seed `20261024` and a precomputed order; prompt hash and model digest stay `null`
  until the measurement note. The hash is a freeze only after the owner approves the file.
