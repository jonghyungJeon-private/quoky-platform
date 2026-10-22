import type { ConnectorProvider, ConnectorQuery } from '../../ports';
import { plainTextOf } from '../message-rendering';
import type { NlArgs } from '../nl-routing/catalog';
import { lookupJiraRelease } from './jira-release-lookup';
import { releaseCommandForSelection } from './work-chat-selection';

/**
 * Owner answer 1 of 2026-10-22 ("프로젝트 목록 스냅샷으로 채점"): the owner-visible outcome of one validated `jira.release`
 * selection against a given Jira world (a connector), computed by the SAME path the lookup handler runs
 * (`releaseCommandForSelection` → `lookupJiraRelease`, read-only). Two arg sets are equivalent exactly when their keys are
 * equal: the same reply (the same resolved project and release, the same confirmation question, the same list or the same
 * not-found text), the same confirmation, the same item query, and every other arg (scope, count) identical. An outcome
 * reached before any release was read compares the args exactly (they were not all used). No rule of its own: it only
 * runs Core.
 */
export async function jiraReleaseOutcomeKey(input: {
  readonly args: NlArgs;
  /** The owner's own non-quoted words of the turn (links are read from it, as at runtime). */
  readonly groundingText: string;
  readonly connector: ConnectorProvider;
  readonly siteHost?: string;
  /** The owner's Jira identity (`scope: mine`). */
  readonly identity?: string;
  /** The conversation is a channel without the `jira-project` grant. */
  readonly inChannel?: boolean;
  readonly language?: 'ko' | 'en';
}): Promise<string> {
  const command = releaseCommandForSelection({ args: input.args, language: input.language ?? 'ko' }, input.groundingText, { inChannel: input.inChannel === true });
  const queries: ConnectorQuery[] = [];
  const recording: ConnectorProvider = {
    source: input.connector.source,
    readOnly: input.connector.readOnly,
    isAvailable: () => input.connector.isAvailable(),
    query: (query) => {
      queries.push(query);
      return input.connector.query(query);
    },
  };
  const result = await lookupJiraRelease({
    connector: recording,
    command,
    ...(command.inChannel === true ? { inChannel: true } : {}),
    ...(input.identity !== undefined ? { identity: input.identity } : {}),
    ...(input.siteHost !== undefined ? { siteHost: input.siteHost } : {}),
    ...(command.confirmNear === true ? { confirmNear: true } : {}),
  });
  const { project: _project, release: _release, ...rest } = input.args;
  const confirm = result.kind === 'body' ? result.confirm : undefined;
  // CA review (CRITICAL): an outcome that stopped before any release was read (no `releases` / `release-items` query and
  // no confirmation: a project not found, a DM-only refusal before any read) has not used every arg, so it proves nothing
  // about the args it never reached: the key then carries the args themselves (exact comparison).
  const consumed = confirm !== undefined || queries.some((query) => query.query === 'releases' || query.query === 'release-items');
  return JSON.stringify({
    reply: result.kind === 'body' ? plainTextOf(result.body) : `failure:${result.reason}`,
    confirm: confirm ?? null,
    items: queries.filter((query) => query.query === 'release-items').map((query) => query.params ?? {}),
    rest: Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    exact: consumed ? null : Object.entries(input.args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
}
