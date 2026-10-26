# Eval judge (owner-calibrated pre-screen)

`quoky-eval-judge` (`.claude/agents/quoky-eval-judge.md`) pre-screens owner evaluations of Quoky judgment answers. It applies
`docs/eval/owner-rubric.md`, which is distilled only from the owner's own blind labels and notes, and returns strict JSON per
case: a label per answer (`useless | usable | good`, confidence, reasons citing rubric rules), a pairwise preference, and
`lowConfidence`.

## How it is used

1. Build a blind file as in the judgment eval (`blind.json`: owner request, synthetic items, answers A/B; the arm map stays in
   `key.json`, which the judge never sees). Eval/synthetic data only: never real calendar, mail, Jira or people.
2. Run the judge on every case (the subagent, or `tools/eval-judge/calibrate.mjs`, which calls `claude -p` tool-less with the
   agent body as the system prompt and the agent's model).
3. The owner reviews only: cases with `lowConfidence: true`, and cases where the judge disagrees with any label the owner has
   already given. Everything else is a pre-screened label.
4. The owner stays final. Where a ratified gate says "owner blind labels" (for example an A/B arm decision or a release
   gate), the judge output is a pre-screen and a review queue, never the gate's evidence. The judge never decides
   owner-only gates.

## Calibration result (2026-10-26, rubric v1, model opus)

- Data: judgment blind eval 2026-10-23/26, 35 synthetic cases × 2 answers, owner labels copied to
  `~/Library/Application Support/Quoky/eval-archive/judgment-eval-20261023/owner-labels.json` (26 non-empty notes).
- Split fixed before the rubric was drafted: `sha256("quoky-eval-judge-holdout-20261026" + id)` order, first 18 held out
  (`judge-split.json` in the same folder). Held-out notes were not used for the rubric.
  - Held-out: lj-001 004 008 009 010 013 015 016 018 019 022 024 029 030 031 033 034 035
    (owner labels: good 19, usable 11, useless 6; preference B 11, A 6, same 1).
  - Calibration: lj-002 003 005 006 007 011 012 014 017 020 021 023 025 026 027 028 032.
- Calibration half (in-sample, 1 run each): draft rubric exact 88.2% / usable+ 91.2% / preference 100%; after tuning on
  calibration cases only, 97.1% / 97.1% / 100%.
- **Held-out, 3 runs** (36 answer labels and 18 preferences per run):

| Run | Exact label | Usable+ (binary) | Preference | Cohen's κ (3-class) | κ (usable+) | κ (pref) | Low-confidence cases |
|---|---|---|---|---|---|---|---|
| 0 | 91.7% | 97.2% | 94.4% | 0.863 | 0.893 | 0.885 | 2/18 |
| 1 | 94.4% | 97.2% | 94.4% | 0.908 | 0.893 | 0.885 | 6/18 |
| 2 | 91.7% | 97.2% | 94.4% | 0.863 | 0.893 | 0.885 | 2/18 |
| Mean | 92.6% | 97.2% | 94.4% | 0.878 | 0.893 | 0.885 | 18.5% |

- Stability: labels identical in all 3 runs for 97.2% of answers (pairwise 98.1%); preference identical in all runs 100%.
- Low-confidence routing: 8 of 108 answer judgments disagreed with the owner; 6 of those 8 were in cases flagged
  `lowConfidence`. Exact agreement on unflagged cases was 96.9-100%.
- Bar (≥85% usable+ and preference): **met** (97.2% and 94.4%). The held-out set is small (18 cases), so treat the numbers
  as a first estimate, not a tight bound.

### Failure patterns on the held-out half

- **Implicit second part of the request (lj-004 A).** "순서대로 어떻게 준비하면 좋을지 짜줘": the answer gave the order but no
  real preparation plan. The owner said useless ("준비에 대해서 짜준 내용이 맞는지 의심스러워"); the judge said usable in all
  3 runs and flagged it only once. The judge treats R1 as satisfied when the visible shape (an order) is there.
- **Bare IDs on an otherwise complete answer (lj-019 B).** The owner gave good while noting titles would be nicer; the judge
  applied R5 strictly and said usable in 2 of 3 runs (flagged low each time). R5 is a preference, not a cap, for the owner.
- **`same` preference (lj-024).** The owner rated both answers good and chose `same` ("A, B를 적절히 섞으면"); the judge rated
  the single-pick answer usable and preferred B in all runs (flagged low). The judge almost never says `same`.

## Re-calibration

Re-calibrate whenever new owner labels arrive (a new blind eval, new notes, or the owner correcting a judge label):

1. Copy the labels into the eval archive next to the blind file (never only in a session scratchpad).
2. Fix a new held-out split with a new seed before reading the new notes. Keep it at least half the new cases.
3. Update `docs/eval/owner-rubric.md` from calibration-half notes only, citing case ids, and mirror the change in the rubric
   block of `.claude/agents/quoky-eval-judge.md`.
4. Run `node tools/eval-judge/calibrate.mjs --set heldOut --runs 3` (check the Claude usage window first) and record the
   table above. If usable+ or preference drops below 85%, the judge goes back to "owner labels everything" until fixed.
