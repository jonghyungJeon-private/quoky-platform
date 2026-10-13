/**
 * SQL of the two lookups schema v16 indexes (ADR-0119). Package-internal (not re-exported from `index.ts`): the
 * repository runs these exact strings and `migration-v16.test.ts` proves with `EXPLAIN QUERY PLAN` that each one is
 * served by its index, so a later edit that stops matching the index expressions fails a test.
 */

const ACTIVE_SESSION_ORDER = `ORDER BY json_extract(data, '$.lastActivityAt') DESC LIMIT 1`;

/** ADR-0119 D2, over `idx_sessions_platform_context`: params (platform, channelId). */
export const ACTIVE_SESSION_WITHOUT_THREAD_SQL = `SELECT data FROM sessions
  WHERE platform = ? AND channel_id = ? AND thread_id IS NULL AND status = 'ACTIVE' ${ACTIVE_SESSION_ORDER}`;

/** ADR-0119 D2, over `idx_sessions_platform_context`: params (platform, channelId, threadId). */
export const ACTIVE_SESSION_IN_THREAD_SQL = `SELECT data FROM sessions
  WHERE platform = ? AND channel_id = ? AND thread_id = ? AND status = 'ACTIVE' ${ACTIVE_SESSION_ORDER}`;

/**
 * ADR-0115 D8 as amended by ADR-0119 D1, over the partial expression index `idx_task_runs_usage_finished`: params
 * (fromInclusive, toExclusive). The expressions and the `usage IS NOT NULL` term are exactly the index's; there is no
 * ORDER BY (a sort would hold every row).
 */
export const USAGE_FINISHED_BETWEEN_SQL = `SELECT json_extract(data, '$.usage') AS usage,
    json_extract(data, '$.finishedAt') AS finishedAt FROM task_runs
  WHERE json_extract(data, '$.usage') IS NOT NULL
    AND json_extract(data, '$.finishedAt') >= ? AND json_extract(data, '$.finishedAt') < ?`;
