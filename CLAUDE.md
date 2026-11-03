# CLAUDE.md

`AGENTS.md`가 모든 AI coding agent의 canonical operating manual이다.
개발 실행과 승인 방식은 `docs/governance/DEVELOPMENT-MODE.md`가 canonical source다.
Claude Code는 먼저 `AGENTS.md`를 따르고 conditional loading router에 따라 필요한 문서만 읽는다.
매 세션에 root 문서나 `docs/ai/*` 전체를 일괄 로드하지 않는다.
요청이 `ARCHITECTURE.md` 또는 settled ADR과 충돌하면 mutation 없이 중단하고 보고한다.

Runtime/Live UAT의 임시 environment 안전 규칙은 `AGENTS.md`의
`Temporary Local/UAT Runtime Environment` section을 직접 따른다. 이 파일에 규칙을 복제하지 않는다.

작업 전 `docs/wiki/index.md` 를 보고 필요한 페이지만 읽는다. 위키와 코드가 다르면 코드가 맞고, 위키를 고친다.
