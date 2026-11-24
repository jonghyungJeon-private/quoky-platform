# CLAUDE.md

@AGENTS.md

위 `AGENTS.md`가 모든 AI coding agent의 canonical operating manual이다(ADR-0011: CLAUDE.md는 얇은 pointer). 규칙은 여기 복제하지 않는다.
개발 실행과 승인 방식은 `docs/governance/DEVELOPMENT-MODE.md`가 canonical source다.
매 세션에 root 문서나 `docs/ai/*` 전체를 일괄 로드하지 않는다. AGENTS.md의 Conditional Loading을 따른다.
요청이 `ARCHITECTURE.md` 또는 settled ADR과 충돌하면 mutation 없이 중단하고 보고한다.

Runtime/Live UAT의 임시 environment 안전 규칙은 `AGENTS.md`의
`Temporary Local/UAT Runtime Environment` section을 직접 따른다. 이 파일에 규칙을 복제하지 않는다.
