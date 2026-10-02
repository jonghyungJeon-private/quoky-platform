import type { ProposedChange } from '../domain';

/**
 * Provider-agnostic parser for an AI code proposal (CAP-008, ADR-0029). Defined ONCE
 * in core so EVERY provider (Codex, Ollama, …) parses identically — the basis for
 * Codex/Ollama parity. The expected output (authored by `PromptComposer`) is a single
 * fenced ```json block containing `{ "changes": [{ path, newContent?, delete? }] }`.
 *
 * Throws on malformed/empty output so the manager records a FAILED generation rather
 * than persisting a bogus proposal (the AI is not a source of truth).
 */
export function parseCodeProposal(text: string): ProposedChange[] {
  const json = extractJsonBlock(text);
  if (!json) throw new Error('no JSON proposal block found in AI output');

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`AI proposal is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const changes = (parsed as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) throw new Error('AI proposal is missing a "changes" array');
  // QA-012: an empty proposal is NOT a successful generation — the manager records FAILED/EMPTY_OUTPUT
  // so the user is told truthfully that no change proposal was produced (never a zero-change "success").
  if (changes.length === 0) throw new Error('AI proposal has an empty "changes" array');

  return changes.map((raw, i) => toProposedChange(raw, i));
}

/** Extract the contents of the first ```json fenced block, or a bare JSON object. */
function extractJsonBlock(text: string): string | undefined {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenced && fenced[1]) return fenced[1].trim();
  const generic = /```\s*([\s\S]*?)```/.exec(text);
  if (generic && generic[1] && generic[1].trim().startsWith('{')) return generic[1].trim();
  const bare = text.trim();
  return bare.startsWith('{') ? bare : undefined;
}

function toProposedChange(raw: unknown, index: number): ProposedChange {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`change[${index}] is not an object`);
  }
  const obj = raw as { path?: unknown; newContent?: unknown; delete?: unknown };
  if (typeof obj.path !== 'string' || obj.path.length === 0) {
    throw new Error(`change[${index}] is missing a string "path"`);
  }
  const wantDelete = obj.delete === true;
  if (wantDelete) {
    return { path: obj.path, delete: true };
  }
  if (typeof obj.newContent !== 'string') {
    throw new Error(`change[${index}] (${obj.path}) is missing string "newContent"`);
  }
  return { path: obj.path, newContent: obj.newContent };
}
