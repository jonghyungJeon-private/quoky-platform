# AGENTS.md - AI Coding Agent Operating Manual

이 문서는 Claude Code와 Codex를 포함한 모든 Implementation Agent의 canonical 공통 규칙이다.
Repository 문서가 source of truth이며 prompt나 이전 Agent의 self-report는 사실로 간주하지 않는다.
개발 실행과 승인 방식의 canonical source는 `docs/governance/DEVELOPMENT-MODE.md`다.

## Project Invariants

- Quoky은 local-first, provider-independent AI platform이다. Discord와 model은 교체 가능한 구현이다.
- 의존 방향은 `apps -> adapters -> core`뿐이다. Core는 workspace package에 의존하지 않는다.
- Core는 concrete provider, NestJS, Discord, SQLite, CLI, adapter를 import하지 않는다.
- Adapter는 `@quoky/core`와 자기 구현 library만 사용하며 다른 adapter에 의존하지 않는다.
- `apps/quoky`만 concrete class와 port token을 연결하는 composition root다.
- 새 provider는 기존 port를 구현하는 별도 adapter package로 추가하고 composition root에서 wiring한다.
- 새 port의 interface와 DI token은 `packages/core/src/ports`에 둔다.
- Platform/storage/driver type은 port signature나 Core type을 통과할 수 없다.
- Architecture 변경은 승인된 ADR이 먼저 필요하다. `ARCHITECTURE.md`와 충돌하면 중단한다.

## Provider, Prompt, Context

- Core는 `AiProvider`에만 의존하며 provider `id`로 분기하거나 특정 CLI를 가정하지 않는다.
- Provider 선택은 `capabilities`, `priority`, `isAvailable()` 데이터로 결정한다.
- 선택된 provider는 `TaskRun.providerId`의 audit 정보이며 사용자에게 기본 노출하지 않는다.
- Provider별 prompt shaping과 CLI rendering은 adapter가 담당한다. AI HTTP API adapter는 chat tier와 image understanding에만 허용한다(ADR-0115).
  Owner가 선택할 때만 켜지고 tool definition을 보내지 않으며, code/review/planning/test/embedding/policy capability는 Claude CLI에 남는다.
- Quoky Memory가 source of truth이며 stateless CLI에는 generated context file로만 전달한다.
- `MemoryManager`는 CRUD/scope, `ContextBuilder`는 retrieve/rank/compress/budget,
  `PromptComposer`는 prompt layering, workspace는 context-file materialization을 소유한다.
- `Session`에 context/memory snapshot을 저장하지 않는다. Prompt template은 `prompts/` runtime asset이다.

## Conditional Loading

`docs/ai/*`와 상세 문서를 기본적으로 모두 읽지 않는다.

| Task type | Additional documents |
|---|---|
| Simple code implementation | relevant code only |
| Architecture/domain change | `ARCHITECTURE.md` + `DECISIONS.md` |
| Current sprint decision | `CURRENT_STATE.md` + relevant `ROADMAP.md` section |
| New session/model switch | `docs/ai/SESSION_STATE.md` + `docs/ai/HANDOFF.md` |
| Implementation/commit/PR review | `docs/ai/REVIEW_CHECKLIST.md` |
| Prompt examples | `docs/ai/PROMPTS.md` (human-requested only) |

Architecture 또는 settled decision과 충돌할 가능성이 있으면 반드시 root 문서를 읽는다.

## Development Governance

- `AUTONOMOUS_DEV_MODE = ENABLED`, `ACTIVE_MILESTONE = M3`이다. Product Owner는
  active milestone에 필요한 LOW/MEDIUM-risk local development task 생성과 implementation approval을
  Architect AI에 standing delegation한다. Architect-generated bounded task는 별도 one-off human 승인 없이
  승인된 local scope가 된다.
- 기본은 `FAST DELIVERY MODE`다. Product Owner 또는 delegated Architect AI의 Sprint/Task 실행 승인은 범위 안의
  구현, 리팩터링, 테스트 작성·수정, focused test, typecheck, build, 자체 수정·재검증,
  문서 갱신, local commit을 함께 허용한다.
- 같은 범위의 검증 실패는 최대 2회 수정 루프까지 별도 packet/승인 없이 해결한다.
- 일반 개발에 execution packet, packet SHA, evidence 전용 Markdown, 단계별 재승인을 만들지 않는다.
- Architecture 경계 변경은 구현·검증 후 merge 전에 독립 Chief Architect Review를 받는다.
- Ratified architecture 안에서 active milestone에 필요한 LOW/MEDIUM-risk 구현은 Architect AI가 승인할 수 있다.
  구현 미착수, human-authored Sprint 부재, 추가 one-off approval 부재만으로 `HUMAN_REQUIRED`를 반환하지 않는다.
- Push, PR, Merge, Runtime start/stop/restart, Discord action, Quoky application AI Provider/network 실행,
  non-DB runtime data mutation, Workspace Apply, Live UAT, release/production gate,
  Production/shared DB mutation·migration apply, destructive filesystem 작업, secret 접근은 `STRICT GOVERNANCE MODE`로
  Human의 별도 승인을 받는다.
- `AUTONOMOUS_DEV_DB = APPROVED`다. Active milestone에 필요한 local/dev SQLite create/open, WAL/journal 초기화,
  schema·migration 구현과 local/dev apply, `user_version`, seed/fixture, bounded UAT persistence, DB test,
  disposable/test DB reset/recreate, bounded local data migration은 standing delegation에 포함된다. 현재
  `data/chunsik.db`는 `QUOKY_RUNTIME_ENV=dev`, configured target 일치, Production/shared target 부재가 입증될 때만
  delegated development/UAT DB다. Production/shared DB, non-disposable destructive data loss, shared/live
  backup/restore, Production migration apply, DB credential/secret mutation은 계속 별도 Human 승인이 필요하다.
- `HUMAN_APPROVAL_REQUIRED`는 `HUMAN_MUST_PERSONALLY_EXECUTE`를 의미하지 않는다. Strict 작업은 Product Owner의
  exact-scope 승인이 필수이고 다른 capability/revision/milestone으로 승계되지 않지만, 승인 후 trusted Quoky
  control-plane/UAT operator가 승인된 정확한 작업을 실행할 수 있다. 승인되지 않았거나 범위 밖인 작업은 금지한다.
- Kiro Architect는 architecture, milestone gap 분석, bounded task 발행을 담당하며 Strict 작업을 직접 실행하지
  않는다. 이미 exact-scope 승인된 향후 Quoky UAT operator 실행에 Human keyboard action이 필요하다는 이유만으로
  `HUMAN_REQUIRED`를 반환하지 않는다.
- DEV_V1 acceptance criteria가 충족되면 Architect는 `MILESTONE_REACHED`로 멈추고 Product Owner에게
  UAT/debugging 제어를 반환한다.
- 구체적 blocker가 없으면 승인된 Sprint 범위를 끝까지 수행한다.
- 분류, 승인 묶음, retry, blocker, verification, 보고 형식의 상세 규칙은
  `docs/governance/DEVELOPMENT-MODE.md`를 따른다.

Command 실행 전 `RiskPolicy.assessCommand`를 적용한다. Approval gate는 planning이 아니라
external/destructive action을 감싼다.

## Temporary Local/UAT Runtime Environment

- 이 section은 local test와 attended Live UAT를 위한 임시 안전장치이며 production/deployment 실행 계약이 아니다.
- 해당 local Quoky application runtime의 configuration source는 repository root의 `.env.local`이다.
- `apps/quoky`의 dotenv loader는 `override: false`이므로 inherited process environment가 `.env.local`보다
  우선한다. Runtime Start 전에 `.env.local`에 선언된 variable 이름과 현재 process environment의 이름을
  비교하고, 중복된 runtime-owned variable이 있으면 그대로 시작하지 않는다. Secret 값은 출력하지 않는다.
- 중복 variable은 해당 실행 명령에서 `env -u <NAME>`으로 제거해 `.env.local` loader가 값을 설정하도록 한다.
  특히 `DISCORD_BOT_TOKEN`과 `DISCORD_GUILD_ID`는 반드시 제거하거나 부재를 직접 확인한다.
- `.env`를 source하거나 기존 login-shell Discord configuration에 의존해 Quoky을 시작하지 않는다.
- Discord Runtime Start 후 readiness를 선언하기 전에 실제 bot identity, guild, channel이 `.env.local`의
  대상과 일치하는지 read-only로 검증한다. 불일치하거나 검증할 수 없으면 Discord Action/Live UAT 없이
  Runtime을 중지하고 blocker를 보고한다.
- 전용 runtime launcher 또는 영구 environment-selection 계약이 승인·구현·검증되면 이 임시 section과
  `CLAUDE.md`의 대응 section을 함께 제거한다. Cleanup/문서 제거는 별도 승인을 받는다.

## Before Mutation

직접 확인한다.

- current branch와 HEAD
- relevant base/origin state
- `git status --short`
- approved scope와 보호 대상

예상 SHA 불일치 또는 승인되지 않은 dirty-tree 충돌이면 mutation 없이 중단한다.
요청과 직접 관련된 파일만 읽고 수정하며 범위 확대가 필요하면 `NEEDS_SCOPE_EXPANSION`을 보고한다.

## Engineering Rules

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`를 약화하지 않는다.
- 승인된 Sprint/Task 범위에서 코드 변경 완료 전 `pnpm typecheck`와 Risk에 맞는 test를 실행한다.
  문서-only 변경은 근거를 기록하고 제품 Build/Test를 생략할 수 있다.
- Deterministic plumbing은 test하고, 미구현 model cognition은 `NotImplementedError`로 유지한다.
- 시간과 ID는 shared `clock`/`id` utility를 사용한다.
- `Resource` input과 `Artifact` output을 합치지 않는다.
- Provider를 `Session`/`Task`/`Actor`에 pin하지 않는다.
- God-interface와 deferred Workflow/agent runtime/dynamic plugin loader를 조기 구현하지 않는다.
- 기존 style을 따르고 commit은 Conventional Commits 형식을 사용한다.

## Verification And Reporting

SHA, changed files, diff, tests, typecheck, clean/mutation state를 추측하지 않고 직접 확인한다.
테스트는 실제 명령과 결과만 보고한다. 코드와 문서의 사실 불일치는 보고하되 Architecture 규칙은 root 문서를 따른다.

완료 보고에는 다음을 짧게 포함한다.

```text
CURRENT MAIN
COMPLETED
VALIDATION
CHANGED FILES
SAFETY
APPROVAL BOUNDARY
NEXT STEP
```

Mutation이 없음을 branch/HEAD/status/diff 등으로 직접 확인한 경우에만 공식 문구를 그대로 사용한다:
"변경이 적용되지 않았음이 확인되었습니다."
직접 확인할 수 없으면 공식 문구를 그대로 사용한다: "변경 적용 여부를 확인할 수 없습니다."
변경을 수행한 경우에는 두 문구를 사용하지 않고 실제 변경을 보고한다.

## Architecture And Collaboration

- Boundary가 불명확하면 Core를 작게, adapter를 단순하게 유지하고 그래도 불명확하면 질문한다.
- `[RESERVE]` seam은 최소 interface/field만 만들고 `DECISIONS.md`에 기록한다.
- Product Owner가 architecture/product 최종 결정을 하고 Chief Architect가 architecture와 ADR을 관리한다.
- Architecture 변경은 `docs/templates/ADR_TEMPLATE.md`를 사용해 제안하며 Product Owner가 ratify한다.
- Reviewer와 implementer는 동일할 수 없다. 독립 Architecture/Implementation Review를 유지한다.
- Sprint Definition of Done은 `CURRENT_STATE.md`와 `CHANGELOG.md`를 갱신한다.
