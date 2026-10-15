# Selector few-shot retrieval (RAG) plan: lint first, offline experiment second, runtime only on a pass (2026-10-16)

- **Status:** **Proposed** (Chief Architect, docs only). Implements ADR-0123 (`DECISIONS.md`, Proposed). Nothing here
  is authorized until the Product Owner ratifies ADR-0123, except RAG-0 if the owner approves it on its own (ADR-0123
  owner decision 2). Every model run below, local embeddings included, is Strict and needs the owner's yes on an
  approved plan digest.
- **Base:** `origin/main` `145fb00` (ADR-0122 P2 merged). The A6 action prompt is `nl-select.v31` on `main` and
  `nl-select.v35` on the unmerged A6 gate branch; the experiment runs on whatever `main` carries when it starts and
  records the version.
- **Track id:** RAG (RAG-0 … RAG-3). Lives beside the NL track of `docs/plans/personal-v5-plan.md`.

## 0. 종형님께 (요약)

- **무엇을 하나:** 의도 판단(selector) 프롬프트의 예시를 고정 목록 대신 "질문과 비슷한 예시 3개"로 골라 넣으면 D12 점수가
  덜 흔들리는지 **먼저 오프라인으로 측정**합니다. 효과가 증명될 때만, 기본값 꺼짐 플래그 뒤에서 실제 서비스에 붙입니다.
- **Vector DB:** 새로 설치하지 않습니다. 이미 있는 로컬 JSON 벡터 저장소(`LocalVectorProvider`)를 씁니다. 필요한 규모가
  1만 개 이하라서 속도 문제가 없고, 새 프로그램·포트·네이티브 라이브러리·외부 통신이 0입니다. 규모가 커지면 별도 SQLite
  파일의 sqlite-vec로 옮깁니다(그때 다시 ADR).
- **임베딩:** 로컬 Ollama `nomic-embed-text`만 씁니다. 모델 digest로 고정하고, 모델이 바뀌면 다시 임베딩합니다. 클라우드
  임베딩은 이번 결정 범위가 아닙니다.
- **가장 먼저 할 일(RAG-0):** 모델 호출 없이, 현재 프롬프트 예시가 채점용 gold 문장을 베꼈는지 검사하는 테스트. 임시 측정에서
  읽기 프롬프트 예시 3개가 gold와 **완전히 같은 문장**이었습니다(`오후만`, `목요일 거는?`, `그거 요약해줘`).
- **안전:** 예시 풀은 종형님이 승인한 문장만, gold와 겹치면 자동 거부. 가져온 예시는 힌트일 뿐이고 검증·근거 확인·승인·되돌리기는
  그대로입니다. Jira/Confluence 지식 검색(RAG)은 범위 밖(별도 ADR).

## 1. Steps

| Step | What | Model calls | Approval | Size |
|---|---|---|---|---|
| **RAG-0** | Contamination lint, n-gram half, with a ratchet over today's findings (ADR-0123 D5) | none | standing delegation (test + docs) once the owner says yes to decision 2 | S |
| **RAG-1** | Pool v1 (≥ 150 entries, owner-approved batches), the embedding audit and τ calibration, C6 probe | local embeddings only | Strict: C6 probe (owner pulls the model, digest pinned); one embed-audit run | M |
| **RAG-2** | Pre-registered four-arm experiment (A0 / A0-swap / A1 / A2, 5 runs each on the held-out 70%, after one dev smoke run) and the decision record | selector (Claude CLI) + local embeddings | Strict: one plan-digest approval for the whole set | M |
| **RAG-3** | Runtime retrieval behind `QUOKY_NL_EXAMPLE_RETRIEVAL=off|shadow|on` (default `off`) | — | only after an RAG-2 pass; its own ADR-0120 amendment and Chief Architect review | M |

Order and dependencies: RAG-0 → RAG-1 → RAG-2 → (pass) RAG-3. RAG-0 is useful on its own and does not wait for the rest.
Stop after RAG-2 on any ADR-0123 D6 stop condition; the fallback is prompt and corpus discipline, with RAG-0 kept.

### RAG-0 — contamination lint (no model)

- **Files.**
  - `packages/core/src/application/nl-routing/example-contamination.ts`: pure functions. `normalize` (NFC, lower case,
    whitespace), `shapeTokens` (the v35 test's tokenizer: punctuation as tokens; a token with a digit, `/` or `~` → `#`),
    `charNgrams(n = 3)`, `jaccard`, `containment` (`|A ∩ B| / min(|A|, |B|)` on character 3-grams),
    `nearestGold(text, gold) → { id, tokenJ, charJ, contain }`, `isShortText` (≤ 3 characters without whitespace), and
    `NEAR_COPY = { token: 0.6, char3: 0.6, contain3: 0.8 }`. No I/O, no dependency.
  - `packages/core/src/application/nl-routing/example-contamination.test.ts`: renders `buildSelectionPrompt` for the
    read prompt (all read entries) and the A6 prompt (all read + action entries, `referenceContext: 'none'`), extracts
    every `Message:` line, and compares each with every case of `nl-intent.v1.json`, `nl-action.v1.json`,
    `nl-action.seed.v1.json` and `nl-action.exec-time.v1.json`. Fails on a finding not in the known list and on a
    known entry that no longer occurs (so the list only shrinks). Includes the calibration case (the measure flags the
    examples removed in v33–v35). Also: short texts (exact match is a finding; every short example listed for manual
    review), the `(previous, context, text)` pair against gold cases with a previous selection or fixture, and the
    expected output (same `entryId` plus a verbatim span arg value of ≥ 4 characters from a gold case is a finding)
    (ADR-0123 D5).
  - `packages/core/src/application/nl-routing/example-contamination.known.v1.json`: today's findings
    `{ example, goldId, tokenJ, charJ, contain, kind: exact|near|pair|output }` and the short-text review list
    `{ example, reviewer, reason }`.
  - When the A6 gate branch merges, its v35 overlap test can call the shared helper instead of its own copy.
- **Expected first result** (scratch measurement 2026-10-16 over the source literals; the real test decides): 3 exact
  copies (`오후만` = `uat5r2-10`, `목요일 거는?` = `uat5r4-16`, `그거 요약해줘` = `uat5r6-07`) and 6–7 more pairs at token
  Jaccard ≥ 0.6 (for example `드라이브에서 폴더 공유하는 법 알려줘` vs `neg-014`, `오늘까지 마감인 지라 일 있어?` vs
  `uat5ca-03`).
- **AC.** `pnpm typecheck`, the new test and the existing golden tests pass; no prompt byte changes.

### RAG-1 — pool, embedding audit, calibration

- **Files.**
  - `apps/quoky/src/tools/selector-rag/selector-pool.v1.json`: `{ version, description, approvedBatches[], entries[] }`;
    entry = `{ id, text, previous?, context?, output, needs[], source: drafted|owner, approvedBatch, language }`.
  - `apps/quoky/src/tools/selector-rag/pool.ts`: load, schema check (closed `entryId` and args through Core's catalog
    types), credential guard, identifier rule (no Jira keys, real channel names, people's names, emails, internal URLs; placeholders only), n-gram lint against gold via the RAG-0 helper, coverage report (per entry ≥ 5, negatives ≥
    20%), pool digest.
  - `apps/quoky/src/tools/selector-rag/embed-audit.ts`: embeds pool and gold through `OllamaCliEmbeddingProvider` in the
    pinned space into a store under `data/eval/selector-rag/store/` (its own `LocalVectorProvider` directory), computes
    max cosine per pool entry against gold, and τ calibration (τ = minimum positive cosine minus 0.02, plus negative pairs and the reported false-positive rate).
  - `apps/quoky/src/tools/selector-rag/selector-pool.audit.v1.json` (committed): pool digest, gold digest, space id
    (`nomic-embed-text@<digest12>`), Ollama runtime version, prefix policy, τ, calibration set and scores, flagged pairs (must be empty).
  - `apps/quoky/src/tools/selector-rag/pool.test.ts`: pool schema and coverage, n-gram lint with zero findings, and
    "the audit record's digests equal the committed pool and gold" (a stale audit fails the suite).
  - CLI: `apps/quoky/src/tools/selector-rag-cli.ts`, script `eval:rag` in the root `package.json`.
    `pnpm eval:rag -- --mode lint` (offline), `--mode embed-audit --approved-plan-digest <sha256>` (Strict, local model).
- **Pool authoring.** The agent drafts batches of ~50 paraphrases per round without reading the gold files; the lint
  rejects near-copies before the owner sees them; the owner approves each batch (ADR-0123 owner decision 4). Approval is
  never delegated to the drafting agent or session. No `learning_items` row or LRN export becomes a pool entry (D4).
- **AC.** ≥ 150 entries, coverage met, 0 n-gram findings, 0 embedding findings at the calibrated τ, audit record fresh.

### RAG-2 — the experiment

- **Files.**
  - `packages/core/src/application/nl-routing/selection-prompt.ts`: optional `retrievedExamples` on
    `NlSelectionPromptInput`, rendered after the static `Examples:` block under a fixed header; absent = byte-identical.
    Tests: the v30 golden and A6 goldens unchanged; a prefix test; a new
    `golden/nl-select.retrieved-block.v1.json` pinning the block for a fixed pool slice.
  - `apps/quoky/src/tools/selector-rag/retrieve.ts`: `retrieveTopK` (cosine top-k, ≤ 1 per `entryId`, `needs` ⊆ offered and `entryId` offered by the prompt mode,
    no duplicate of a static example, deterministic tie-break by id) and `retrieveRandomK` (seeded, same filters), both
    over a pool subsample `(seed r, 80%)`.
  - `apps/quoky/src/tools/selector-rag/selector-rag-eval.ts`: wraps the existing `nl-action-eval.ts` /
    `nl-intent-eval.ts` scoring (no new scorer): for each case, embeds the prepared text (A1, A2 use the same embedding
    so latency is comparable), builds the prompt for the arm, runs the selector through the existing Claude CLI path,
    scores exact `{ entry, args, target }`, and records retrieval-only latency separately. Plan digest binds: arm list,
    runs, seeds, k, τ, τ_low, the dev / held-out split, pool digest, gold digest, space id, prompt versions, selector
    model and effort.
  - `apps/quoky/src/tools/selector-rag/split.ts`: the stratified 30 / 70 dev / held-out split by a seeded hash of the
    case id, and the similarity strata (`< 0.70`, `0.70–τ_low`, `τ_low–τ`) from the audit; the validity check of the
    low-similarity stratum (≥ 50% of held-out, ≥ 10 per entry) runs here, before any selector run.
  - `apps/quoky/src/tools/selector-rag/analysis.ts`: per-entry minimum across runs and the floor `S_X`, paired bootstrap
    over cases (10,000 seeded resamples) for error-rate differences, McNemar on per-case majority correctness, and the
    five pre-registered criteria of ADR-0123 D6, per stratum.
  - Modes: `pnpm eval:rag -- --mode plan` (offline: prints plan and digest), `--mode run --approved-plan-digest <sha>`
    (Strict; `--split dev|heldout`, dev = one A0 + A1 smoke run), `--mode compare` (offline: reads the held-out records and
    prints the pass / stop verdict of ADR-0123 D6, per similarity stratum).
  - Output: `data/eval/selector-rag/<arm>-run<r>-<ts>.json` and one `compare-<ts>.json`; a decision record appended to
    `DECISIONS.md` as an ADR-0123 note (numbers only, no owner text).
- **Arms.** A0 static; A0-swap (mandatory) = the static prompt whose example section is a frozen random draw from the
  pool with the static set's per-entry counts, one draw per run; A1 static + top-3 retrieved; A2 static + random-3.
  Each 5 runs over the held-out 70% of the D12 gate (A6 action corpus + read regression). The known contaminated cases (3 exact copies, 6–7 ratcheted near-copies) are excluded from pass / stop scoring and reported separately. Arms are interleaved within each run / session. Tuning happens only on dev
  and is recorded in `DECISIONS.md` before the held-out runs; a second held-out set is confirmatory only (ADR-0123 D6).

## 2. Cost and latency estimate

| Item | Estimate | Basis |
|---|---|---|
| Cases | ~1,418 in all (A6 action 544 incl. seed + read 874): dev ≈ 425, held-out ≈ 993 | current corpus files, 30 / 70 split |
| Selector calls | held-out 4 arms × 5 runs × 993 ≈ 19,900, plus the dev smoke 2 × 425 ≈ 850: ≈ 20,700 | D6 |
| Wall time | ≈ 2 h at concurrency 4 (dev smoke ≈ 5 min, held-out ≈ 2 h): two sessions | recorded selector p50 ≈ 1.35 s, p95 ≈ 2.1 s |
| Prompt size | ~23k characters (~6k tokens) with the full catalog; retrieved block +120–200 tokens (+2–3%) | `nl-select.v30.prompts.json` largest case |
| Input tokens | ≈ 130M over all runs, most of it the repeated static prefix (kept cacheable by placing the block after the static examples) | above |
| Traffic (ADR-0121 D8) | Ledger budget 21,500 Claude CLI calls (≈ 20,700 + reserve); rate cap 4 concurrent, ≤ 1 call/s sustained; stated in the plan digest; the harness stops at the budget | MSIT minimal-traffic rule |
| Money | Runs on the owner's Claude CLI login like every D12 gate; the CLI-reported cost is stored in each record. No price is quoted here | existing eval path |
| Embeddings | ~1,600 audit + ~1,400 query embeddings per set, local, a few minutes warm; 0 bytes egress | ADR-0098 D8 |
| Store | pool ≤ 2,000 × 768 Float32 ≈ 6 MB in memory; top-k brute force < 10 ms | `LocalVectorProvider` |
| Runtime added latency (RAG-3) | warm: embedding 50–150 ms + query < 10 ms → p95 target ≤ 300 ms; cold model swap 1–2 s → fail-open to the static prompt at a 300 ms timeout | memo, QA-V2-CL-04 |

## 3. Governance

- RAG-0: Simple test + docs change under standing delegation, after the owner's yes to ADR-0123 decision 2. `pnpm
  typecheck` and the focused tests.
- RAG-1 / RAG-2: ADR-0123 ratified first. Strict items: the C6 probe (owner pulls `nomic-embed-text`), each embed-audit
  run, and the selector run set, each under an approved plan digest. Pool batches need the owner's approval.
- RAG-3: only after a recorded RAG-2 pass, a new ADR-0120 amendment (D3, D12, A6-D7) and ADR-0098 D8 budget note,
  Chief Architect review before merge, `shadow` before `on`, Live UAT per the usual flow.
- No new dependency, process, port or egress host in any step. Any deviation stops the step and returns to the owner.

## 4. Risks

See ADR-0123 "Residual risks". Plan-specific: the A6 gate branch may change the prompt during RAG-1; RAG-2 then
re-freezes on the merged version and re-runs the audit (cheap) before asking for the plan-digest approval.
