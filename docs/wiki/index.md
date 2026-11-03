# LLM Wiki index

Read only the pages you need. If the wiki and the code disagree, the code is right — fix the wiki.

Scope: slow-changing knowledge only (architecture, decisions and reasons, pitfalls, ops). No function signatures. Pilot: one module map, an ADR summary, pitfalls, ops.

| Page | What it covers |
|---|---|
| `module-conversation-runtime.md` | `packages/core/src/application/conversation-runtime/`: file responsibilities, exports, the layer chain, who imports it |
| `pitfalls.md` | Recurring bugs and gotchas (Node/ABI, test memory, union-merge docs, rebase, dotenv, codex/macOS tools), each with source |
| `ops.md` | Deploy / restart / smoke in brief, pointing to quoky-ship section 6 |
| `adr-0001-0030.md` | ADR 0001-0030: v1 foundations, v2 capabilities (Session, Prompt, Approval, Patch, Write, Command, Codex) |
| `adr-0031-0062.md` | ADR 0031-0062: runtime, code-change flow, git/PR/merge chain, GitHub App |
| `adr-0063-0090.md` | ADR 0063-0090: provider routing, governance, memory/work/tools (M2/M3), rename, continuation |
| `adr-0091-0113.md` | ADR 0091-0113: Personal v1-v3 (entry, git safety, handlers, connectors, ops UI) |
| `adr-0114-0124.md` | ADR 0114-0124: Telegram, API providers, Google reads, NL selection, bounded agent, grants, chunking |

ADR pages point to `DECISIONS.md` headings (`## ADR-NNNN`); `DECISIONS.md` is very large, so grep for the heading and read only that range. Not covered yet: other modules, `ARCHITECTURE.md` rules (read that file directly), current sprint state (`CURRENT_STATE.md`).

Maintenance: update only the pages for modules a PR changed (quoky-ship section 6, last step). Do not create a page for a module that has none.

Sources: `AGENTS.md` (loading router), `.claude/skills/quoky-ship/SKILL.md`, the pages above.
