/**
 * ADR-0125 constants of the local-client surface. Plain values only (no Core import), so the HTTP-side modules that
 * share them stay inside the D6 import boundary.
 */

/** The platform id this adapter puts on every `ConversationContext` it builds (opaque to Core, D6). */
export const LOCAL_CLIENT_PLATFORM = 'local-client';
/** The one conversation channel of the surface: a direct conversation with the owner (D4). */
export const LOCAL_CLIENT_CHANNEL_ID = 'local-client-dm';
export const SOCKET_FILE_NAME = 'local-client.sock';
export const TOKEN_FILE_NAME = 'local-client.token';

/** macOS `sun_path` is 104 bytes including the NUL (D2). */
export const MAX_SOCKET_PATH_BYTES = 103;

/** D3 bounds. */
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TEXT_CHARS = 4_000;
export const MAX_TURNS_PER_MINUTE = 30;
export const MAX_EVENT_STREAMS = 2;
export const MAX_HEADER_BYTES = 8 * 1024;
export const HEARTBEAT_MS = 25_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const SOCKET_PROBE_TIMEOUT_MS = 1_000;

/** D4 rings: event replay (200 events or 10 minutes) and clientMessageId dedupe (500 entries or 10 minutes). */
export const EVENT_RING_MAX = 200;
export const EVENT_RING_MS = 10 * 60_000;
export const DEDUPE_RING_MAX = 500;
export const DEDUPE_RING_MS = 10 * 60_000;
/** A stream whose unsent buffer passes this is dropped (a slow client never grows memory without bound). */
export const MAX_STREAM_BACKLOG_BYTES = 1024 * 1024;

/** `clientMessageId`, `threadId`, `replyToEventId`: opaque, checked on the raw value (D4). */
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** `Last-Event-ID`: `<epoch>-<seq>`. */
export const EVENT_ID = /^([A-Za-z0-9_-]{1,32})-([0-9]{1,15})$/;

/** Why the adapter is off (codes only; they reach the log and the OPS-UI panel, never a path or a value). */
export type LocalClientDisableReason =
  | 'NO_INSTANCE_LOCK'
  | 'DB_NOT_FILE_BACKED'
  | 'OWNER_NOT_CONFIGURED'
  | 'OWNER_NOT_DISCORD_OWNER'
  | 'OWNER_UNRESOLVED'
  | 'SOCKET_PATH_TOO_LONG'
  | 'DATA_DIR_UNSAFE'
  | 'SOCKET_PATH_OCCUPIED'
  | 'SOCKET_LIVE'
  | 'SOCKET_PROBE_FAILED'
  | 'SOCKET_STALE_UNLINK_FAILED'
  | 'SOCKET_BIND_FAILED'
  | 'SOCKET_VERIFY_FAILED'
  | 'TOKEN_FILE_FAILED'
  | 'TOKEN_ROTATION_FAILED'
  | 'INBOUND_GATE_CLOSED';
