import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { containsCredentialFileContent, containsCredentialMaterial } from '@quoky/core';
import { canonicalizeImage } from './image-canonical';
import type { ImageCheckCode } from './image-canonical';
import type {
  InboundAttachment,
  InboundAttachmentUnsupportedReason,
  InboundImageMimeType,
} from '@quoky/core';

/**
 * ADR-0111 D2/D3 bounded attachment intake for the Discord adapter. Platform-neutral on its output side
 * ({@link InboundAttachment}); the only Discord knowledge here is the CDN host allowlist. The caller runs it only for a
 * message that already passed the ADR-0091 owner and location gate.
 *
 * - Bounds are checked from the platform metadata BEFORE any download and enforced again while streaming.
 * - Text is held in memory only, decoded as strict UTF-8, refused when the ADR-0097 credential guard matches, and
 *   handed on as UNTRUSTED readout.
 * - An image is written to a runner-owned temporary directory under a random name (never the uploaded name) and
 *   handed on as an opaque `imageRef`; {@link AttachmentIntakeResult.release} deletes it after the turn and
 *   {@link AttachmentIntake.sweep} removes intake files older than {@link ATTACHMENT_SWEEP_AGE_MS}.
 * - Temp layout (Codex P1): the temp root must be a real directory (never a symlink) owned by this uid with mode
 *   0700 (a looser mode on our own directory is repaired; anything else is refused before any traversal). Each
 *   process writes into its own `mkdtemp` subdirectory `proc-XXXXXX` as `intake-<uuid>.<ext>`. The sweep never
 *   follows a symlink: it lstat-checks every entry and deletes only regular files owned by this uid whose name is
 *   an intake name, inside `proc-*` subdirectories (or legacy `<uuid>.<ext>` files directly in the root).
 * - Nothing here logs, persists or embeds attachment content.
 */

/** At most this many attachments per message are considered; the rest are `TOO_MANY` and never downloaded. */
export const ATTACHMENT_MAX_COUNT = 3;
/** UTF-8 text file bound (256 KiB). */
export const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;
/** Image bound (8 MiB). */
export const IMAGE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** A temp file older than this is swept even if its turn never released it. */
export const ATTACHMENT_SWEEP_AGE_MS = 10 * 60_000;
/** One download's wall-clock bound. */
export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 20_000;
/** Downloads come only from the platform's own CDN over https; redirects are refused. */
export const ATTACHMENT_CDN_HOSTS: readonly string[] = ['cdn.discordapp.com', 'media.discordapp.net'];
/** The current uid (`undefined` on platforms without POSIX ids). */
function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}
/**
 * Default runner-owned temporary root, per user (created 0700; refused when not a plain directory owned by us). Under
 * launchd `os.tmpdir()` may be the shared `/tmp`, so the root itself is validated before every use.
 */
export const DEFAULT_ATTACHMENT_TEMP_ROOT = path.join(os.tmpdir(), `quoky-attachments-${currentUid() ?? 'user'}`);
/** Prefix of each process's private `mkdtemp` subdirectory under the temp root. */
const PROCESS_DIR_PREFIX = 'proc-';
const PROCESS_DIR_PATTERN = /^proc-[A-Za-z0-9]{6}$/u;
/** Intake-written files: `intake-<uuid>.<ext>` (current) or `<uuid>.<ext>` (legacy, directly in the root). */
const INTAKE_FILE_PATTERN = /^intake-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/u;
const LEGACY_INTAKE_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/u;
/** Opens a directory without following a symlink in its last component (best available flags per platform). */
const OPEN_DIRECTORY_NOFOLLOW =
  fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

const TEXT_EXTENSIONS = new Set(['.log', '.md', '.json']);
/**
 * Declared image MIME types (and common aliases) taken in as an image. The declared type is only a hint: the
 * downloaded bytes' signature decides the type that is handed on ({@link sniffImageMimeType}).
 */
const IMAGE_MIME_ALIASES: Readonly<Record<string, InboundImageMimeType>> = {
  'image/png': 'image/png',
  'image/x-png': 'image/png',
  'image/apng': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};
/** Declared types that say nothing about the content; with an image extension the bytes decide. */
const GENERIC_BINARY_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
/** Never an image candidate, whatever the extension (SVG is markup, not a raster image). */
const NON_RASTER_IMAGE_MIME_TYPES = new Set(['image/svg+xml']);
/** One re-download when the first body has no image signature (a CDN object still being processed). */
export const IMAGE_SIGNATURE_RETRY_DELAY_MS = 1_000;
const IMAGE_EXTENSIONS: Readonly<Record<string, InboundImageMimeType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const IMAGE_FILE_EXTENSIONS: Readonly<Record<InboundImageMimeType, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
const MAX_NAME_LENGTH = 120;

/** What the adapter reads from one native attachment (metadata only; no content). */
export interface AttachmentSource {
  readonly name: string | null | undefined;
  readonly contentType: string | null | undefined;
  readonly size: number;
  readonly url: string;
}

export type AttachmentClassification =
  | { readonly kind: 'text' }
  | { readonly kind: 'image'; readonly mimeType: InboundImageMimeType }
  | { readonly kind: 'unsupported'; readonly reason: InboundAttachmentUnsupportedReason };

export interface AttachmentIntakeOptions {
  /** Test seam; production uses the platform fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Test seam for the image re-download delay ({@link IMAGE_SIGNATURE_RETRY_DELAY_MS}). */
  readonly imageRetryDelayMs?: number;
  /** Runner-owned temp directory; defaults to {@link DEFAULT_ATTACHMENT_TEMP_ROOT}. */
  readonly tempRoot?: string;
  readonly downloadTimeoutMs?: number;
  /** Test seam for the sweep clock. */
  readonly nowMs?: () => number;
  /** Test seam for the owning uid (defaults to `process.getuid()`); a foreign-owned root is refused. */
  readonly uid?: number;
}

/**
 * Why one attachment was refused, for one content-free log line (live QA: a valid PNG was refused and nothing said
 * why). Classes and buckets only: never a file name, URL, header value or content.
 */
export interface AttachmentRefusalDiagnostic {
  /** Upload position (0-based). */
  readonly index: number;
  readonly reason: InboundAttachmentUnsupportedReason;
  /** The step that refused it. */
  readonly detail: AttachmentRefusalDetail;
  /** The platform-declared MIME as a class ({@link mimeClass}). */
  readonly declaredMime: string;
  readonly extension: 'image' | 'text' | 'other' | 'none';
  /** The platform-declared size, bucketed ({@link sizeBucket}). */
  readonly declaredSize: string;
  /** Which allowlisted CDN host the URL names (`other` = not allowlisted). */
  readonly host: 'cdn' | 'media' | 'other';
  readonly httpStatus?: number;
  /** The download response's `Content-Type` as a class. */
  readonly responseMime?: string;
  /** The downloaded body size, bucketed. */
  readonly downloadedSize?: string;
  /** What the downloaded bytes look like. */
  readonly signature?: 'png' | 'jpeg' | 'webp' | 'gif' | 'empty' | 'other';
  /** Downloads attempted. */
  readonly attempts?: number;
  /** Why structural image validation refused the bytes (`INVALID_IMAGE`). */
  readonly imageCheck?: ImageCheckCode;
}

export type AttachmentRefusalDetail =
  | 'COUNT_BOUND'
  | 'DECLARED_TYPE'
  | 'DECLARED_SIZE'
  | 'NOT_CDN_URL'
  | 'HTTP_STATUS'
  | 'REDIRECT'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'CONTENT_LENGTH_BOUND'
  | 'STREAM_BOUND'
  | 'SIGNATURE_MISMATCH'
  | 'NOT_UTF8'
  | 'CREDENTIAL_SHAPED'
  | 'INVALID_IMAGE'
  | 'TOO_MUCH_TEXT'
  | 'TEMP_WRITE_FAILED';

export interface AttachmentIntakeResult {
  readonly attachments: readonly InboundAttachment[];
  /** One entry per refused attachment, in upload order (content-free; for logs only). */
  readonly diagnostics: readonly AttachmentRefusalDiagnostic[];
  /** Deletes every temp file this intake created. Idempotent; never throws. */
  release(): Promise<void>;
}

/**
 * Invisible and direction-changing characters removed from a display name: C0/C1 controls, the Arabic letter mark,
 * zero-width space/non-joiner/joiner, LRM/RLM, the line/paragraph separators, the bidi embeddings and overrides
 * (LRE..RLO), the word joiner and invisible operators, the bidi isolates (LRI..PDI) and the BOM / zero-width no-break
 * space. Written as escapes so no invisible character sits in the source.
 */
const INVISIBLE_NAME_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

/** Strips control, zero-width and bidi characters and bounds the length; never empty. */
export function sanitizeAttachmentName(name: string | null | undefined): string {
  const cleaned = (name ?? '').replace(INVISIBLE_NAME_CHARACTERS, '').trim();
  const bounded = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
  return bounded.length > 0 ? bounded : 'attachment';
}

function baseMimeType(contentType: string | null | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Metadata-only classification (ADR-0111 D2): type first, then the size bound for that type. Never downloads.
 * Text: `text/*` or a `.log`/`.md`/`.json` name. Image candidate: a png/jpeg/webp MIME (or a common alias such as
 * `image/x-png`, `image/jpg`), or a `.png`/`.jpg`/`.jpeg`/`.webp` name whose declared MIME is absent, generic
 * (`application/octet-stream`) or another raster `image/*` type. A candidate is only a candidate: the downloaded
 * bytes' signature decides whether it is an image and which type it is.
 */
export function classifyAttachment(source: AttachmentSource): AttachmentClassification {
  const mime = baseMimeType(source.contentType);
  const ext = path.extname(source.name ?? '').toLowerCase();
  const size = Number.isFinite(source.size) && source.size >= 0 ? source.size : 0;
  let imageMime: InboundImageMimeType | undefined = IMAGE_MIME_ALIASES[mime];
  if (
    imageMime === undefined &&
    (GENERIC_BINARY_MIME_TYPES.has(mime) || (mime.startsWith('image/') && !NON_RASTER_IMAGE_MIME_TYPES.has(mime)))
  ) {
    imageMime = IMAGE_EXTENSIONS[ext];
  }
  if (imageMime) {
    return size > IMAGE_ATTACHMENT_MAX_BYTES
      ? { kind: 'unsupported', reason: 'TOO_LARGE' }
      : { kind: 'image', mimeType: imageMime };
  }
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
    return size > TEXT_ATTACHMENT_MAX_BYTES ? { kind: 'unsupported', reason: 'TOO_LARGE' } : { kind: 'text' };
  }
  return { kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' };
}

/** True only for an https URL on the platform CDN (no credentials in the URL). */
export function isPlatformCdnUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.port === '' || parsed.port === '443') &&
      ATTACHMENT_CDN_HOSTS.includes(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Content-free facts of one download attempt, for {@link AttachmentRefusalDiagnostic}. */
interface DownloadFacts {
  readonly httpStatus?: number;
  readonly responseMime?: string;
}

type DownloadOutcome =
  | ({ readonly ok: true; readonly bytes: Buffer } & DownloadFacts)
  | ({
      readonly ok: false;
      readonly reason: 'TOO_LARGE' | 'DOWNLOAD_FAILED';
      readonly detail: Extract<
        AttachmentRefusalDetail,
        'NOT_CDN_URL' | 'HTTP_STATUS' | 'REDIRECT' | 'TIMEOUT' | 'NETWORK' | 'CONTENT_LENGTH_BOUND' | 'STREAM_BOUND'
      >;
    } & DownloadFacts);

/**
 * Streams at most `maxBytes` from the platform CDN; aborts as soon as the bound is passed. A redirect is never
 * followed (manual mode: any 3xx is refused as `REDIRECT`), so the bytes always come from the allowlisted URL.
 */
async function downloadBounded(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<DownloadOutcome> {
  if (!isPlatformCdnUrl(url)) return { ok: false, reason: 'DOWNLOAD_FAILED', detail: 'NOT_CDN_URL' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  let facts: DownloadFacts = {};
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
    facts = { httpStatus: response.status, responseMime: mimeClass(response.headers.get('content-type')) };
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'DOWNLOAD_FAILED', detail: 'REDIRECT', ...facts };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'DOWNLOAD_FAILED', detail: 'HTTP_STATUS', ...facts };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'TOO_LARGE', detail: 'CONTENT_LENGTH_BOUND', ...facts };
    }
    if (!response.body) return { ok: true, bytes: Buffer.alloc(0), ...facts };
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        controller.abort();
        return { ok: false, reason: 'TOO_LARGE', detail: 'STREAM_BOUND', ...facts };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true, bytes: Buffer.concat(chunks, total), ...facts };
  } catch {
    return { ok: false, reason: 'DOWNLOAD_FAILED', detail: timedOut ? 'TIMEOUT' : 'NETWORK', ...facts };
  } finally {
    clearTimeout(timer);
  }
}

/** Strict UTF-8 (BOM stripped); `undefined` for invalid UTF-8 or binary-looking content (a NUL byte). */
function decodeUtf8Text(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * The same strict guard learning excerpts use (ADR-0097 / ADR-0107 D1): chat-style and file-style detectors. It runs
 * synchronously on up to 256 KiB of untrusted text; the file guard is bounded-time (a shape it cannot scan in linear
 * time, such as a long base64 run before `=`, is refused as credential-shaped instead of scanned).
 */
function isCredentialShaped(text: string): boolean {
  return containsCredentialMaterial(text) || containsCredentialFileContent(text);
}

/** Printable-ASCII runs of at least this many bytes are screened by the credential guard. */
const PRINTABLE_RUN_MIN = 8;
/**
 * Hard budget of printable text collected from one canonical image; the whole collected text is scanned in ONE pass
 * (no windows, so no detector match can be split). More is refused as `TOO_MUCH_TEXT` (fail closed), never skipped.
 * Measured locally: incompressible (noise) PNGs of 6 / 8 MiB yield 13 / 17 KiB; noise JPEGs of 3.3 / 11 MiB 9 / 1 KiB.
 */
export const IMAGE_TEXT_BUDGET_CHARS = 256 * 1024;

/** The printable-ASCII runs of ALL of `bytes` (like `strings`), newline-joined; `undefined` past the budget. */
export function printableRuns(bytes: Buffer, budget = IMAGE_TEXT_BUDGET_CHARS): string | undefined {
  const runs: string[] = [];
  let total = 0;
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const byte = i < bytes.length ? (bytes[i] as number) : 0;
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable && start < 0) start = i;
    if (!printable && start >= 0) {
      if (i - start >= PRINTABLE_RUN_MIN) {
        total += i - start + 1;
        if (total > budget) return undefined;
        runs.push(bytes.toString('latin1', start, i));
      }
      start = -1;
    }
  }
  return runs.join('\n');
}

/**
 * Best-effort defense in depth over the canonical image (threat model in DECISIONS, ADR-0111 live QA follow-ups): every
 * printable run of the whole file, joined and scanned once by both credential detectors. `TOO_MUCH_TEXT` past the
 * budget.
 */
export function screenImageText(bytes: Buffer): 'CLEAN' | 'CREDENTIAL_SHAPED' | 'TOO_MUCH_TEXT' {
  const text = printableRuns(bytes);
  if (text === undefined) return 'TOO_MUCH_TEXT';
  return isCredentialShaped(text) ? 'CREDENTIAL_SHAPED' : 'CLEAN';
}

/** Magic-byte check so a mislabeled upload is never handed on as an image. */
function matchesImageSignature(bytes: Buffer, mimeType: InboundImageMimeType): boolean {
  switch (mimeType) {
    case 'image/png':
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/webp':
      return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
  }
}

/**
 * The image type the bytes ARE (png/jpeg/webp), whatever the platform declared; `undefined` for anything else. The
 * declared type is only a hint (a PNG declared as `image/jpeg`, or re-encoded by the platform, is still a PNG).
 */
export function sniffImageMimeType(bytes: Buffer): InboundImageMimeType | undefined {
  return (['image/png', 'image/jpeg', 'image/webp'] as const).find((mime) => matchesImageSignature(bytes, mime));
}

function signatureClass(bytes: Buffer): NonNullable<AttachmentRefusalDiagnostic['signature']> {
  if (bytes.length === 0) return 'empty';
  const sniffed = sniffImageMimeType(bytes);
  if (sniffed === 'image/png') return 'png';
  if (sniffed === 'image/jpeg') return 'jpeg';
  if (sniffed === 'image/webp') return 'webp';
  return bytes.length >= 6 && bytes.toString('latin1', 0, 4) === 'GIF8' ? 'gif' : 'other';
}

/** MIME types logged as themselves; anything else is logged as its top-level class (`image/other`, `other`). */
const LOGGED_MIME_TYPES = new Set([
  'image/png',
  'image/x-png',
  'image/apng',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/svg+xml',
  'text/plain',
  'text/markdown',
  'text/html',
  'application/json',
  'application/octet-stream',
  'binary/octet-stream',
]);
const MIME_TOP_LEVELS = new Set(['image', 'text', 'application', 'audio', 'video']);

/** A declared or response MIME as a bounded class: a known type, `<top>/other`, `other`, or `none`. */
export function mimeClass(contentType: string | null | undefined): string {
  const mime = baseMimeType(contentType);
  if (mime === '') return 'none';
  if (LOGGED_MIME_TYPES.has(mime)) return mime;
  const top = mime.split('/')[0] ?? '';
  return MIME_TOP_LEVELS.has(top) ? `${top}/other` : 'other';
}

const SIZE_BUCKETS: ReadonlyArray<readonly [number, string]> = [
  [0, '0'],
  [1024, '<1KiB'],
  [4 * 1024, '<4KiB'],
  [16 * 1024, '<16KiB'],
  [64 * 1024, '<64KiB'],
  [TEXT_ATTACHMENT_MAX_BYTES, '<256KiB'],
  [1024 * 1024, '<1MiB'],
  [IMAGE_ATTACHMENT_MAX_BYTES, '<8MiB'],
];

/** A byte count as a coarse bucket (`0`, `<1KiB`, … `<8MiB`, `>=8MiB`). */
export function sizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  for (const [bound, label] of SIZE_BUCKETS) if (bound > 0 && bytes < bound) return label;
  return '>=8MiB';
}

function hostClass(url: string): AttachmentRefusalDiagnostic['host'] {
  if (!isPlatformCdnUrl(url)) return 'other';
  return new URL(url).hostname.toLowerCase() === 'media.discordapp.net' ? 'media' : 'cdn';
}

function extensionClass(name: string | null | undefined): AttachmentRefusalDiagnostic['extension'] {
  const ext = path.extname(name ?? '').toLowerCase();
  if (ext === '') return 'none';
  if (IMAGE_EXTENSIONS[ext] !== undefined) return 'image';
  return TEXT_EXTENSIONS.has(ext) || ext === '.txt' ? 'text' : 'other';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Internal: why one attachment was refused (the bytes are inspected for a signature class only, never logged). */
interface IntakeRefusal extends DownloadFacts {
  readonly detail: AttachmentRefusalDetail;
  readonly downloaded?: Buffer;
  readonly attempts?: number;
  readonly imageCheck?: ImageCheckCode;
}

interface IntakeOutcome {
  readonly attachment: InboundAttachment;
  readonly refusal?: IntakeRefusal;
}

function downloadFacts(download: DownloadFacts): DownloadFacts {
  return {
    ...(download.httpStatus !== undefined ? { httpStatus: download.httpStatus } : {}),
    ...(download.responseMime !== undefined ? { responseMime: download.responseMime } : {}),
  };
}

/**
 * Bounded intake over one runner-owned temporary directory. One instance per adapter; {@link dispose} on stop.
 */
export class AttachmentIntake {
  readonly tempRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly downloadTimeoutMs: number;
  private readonly imageRetryDelayMs: number;
  private readonly nowMs: () => number;
  private readonly uid: number | undefined;
  /** Temp files created and not yet released (deleted on {@link dispose}). */
  private readonly liveFiles = new Set<string>();
  /** This process's private `mkdtemp` subdirectory (created on the first image write). */
  private processDir?: string;
  private processDirPending?: Promise<string | undefined>;

  constructor(options: AttachmentIntakeOptions = {}) {
    this.tempRoot = options.tempRoot ?? DEFAULT_ATTACHMENT_TEMP_ROOT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? ATTACHMENT_DOWNLOAD_TIMEOUT_MS;
    this.imageRetryDelayMs = options.imageRetryDelayMs ?? IMAGE_SIGNATURE_RETRY_DELAY_MS;
    this.nowMs = options.nowMs ?? Date.now;
    this.uid = options.uid ?? currentUid();
  }

  /** Takes in at most {@link ATTACHMENT_MAX_COUNT} attachments (concurrently), results in upload order. Never throws. */
  async intake(sources: readonly AttachmentSource[]): Promise<AttachmentIntakeResult> {
    const created: string[] = [];
    // The (at most ATTACHMENT_MAX_COUNT) downloads run concurrently, so a slow file does not delay the others and the
    // whole intake is bounded by one download timeout instead of the sum (plus one image re-download). Results keep
    // upload order.
    const outcomes: IntakeOutcome[] = await Promise.all(
      sources.map((source, index): IntakeOutcome | Promise<IntakeOutcome> => {
        const name = sanitizeAttachmentName(source.name);
        const mime = baseMimeType(source.contentType);
        const base = {
          name,
          ...(mime ? { mimeType: mime } : {}),
          sizeBytes: Number.isFinite(source.size) && source.size >= 0 ? source.size : 0,
        };
        if (index >= ATTACHMENT_MAX_COUNT) {
          return { attachment: { ...base, kind: 'unsupported', reason: 'TOO_MANY' }, refusal: { detail: 'COUNT_BOUND' } };
        }
        return this.intakeOne(source, base, created);
      }),
    );
    const attachments = outcomes.map((outcome) => outcome.attachment);
    const diagnostics: AttachmentRefusalDiagnostic[] = [];
    outcomes.forEach((outcome, index) => {
      const { attachment, refusal } = outcome;
      if (attachment.kind !== 'unsupported' || refusal === undefined) return;
      const source = sources[index] as AttachmentSource;
      diagnostics.push({
        index,
        reason: attachment.reason,
        detail: refusal.detail,
        declaredMime: mimeClass(source.contentType),
        extension: extensionClass(source.name),
        declaredSize: sizeBucket(attachment.sizeBytes),
        host: hostClass(source.url),
        ...(refusal.httpStatus !== undefined ? { httpStatus: refusal.httpStatus } : {}),
        ...(refusal.responseMime !== undefined ? { responseMime: refusal.responseMime } : {}),
        ...(refusal.downloaded !== undefined
          ? { downloadedSize: sizeBucket(refusal.downloaded.length), signature: signatureClass(refusal.downloaded) }
          : {}),
        ...(refusal.attempts !== undefined ? { attempts: refusal.attempts } : {}),
        ...(refusal.imageCheck !== undefined ? { imageCheck: refusal.imageCheck } : {}),
      });
    });
    let released = false;
    return {
      attachments,
      diagnostics,
      release: async () => {
        if (released) return;
        released = true;
        await Promise.all(created.map((file) => this.removeFile(file)));
      },
    };
  }

  private async intakeOne(
    source: AttachmentSource,
    base: { readonly name: string; readonly mimeType?: string; readonly sizeBytes: number },
    created: string[],
  ): Promise<IntakeOutcome> {
    const refuse = (
      reason: InboundAttachmentUnsupportedReason,
      refusal: IntakeRefusal,
    ): IntakeOutcome => ({ attachment: { ...base, kind: 'unsupported', reason }, refusal });
    const classification = classifyAttachment(source);
    if (classification.kind === 'unsupported') {
      return refuse(classification.reason, { detail: classification.reason === 'TOO_LARGE' ? 'DECLARED_SIZE' : 'DECLARED_TYPE' });
    }
    if (classification.kind === 'text') {
      const download = await downloadBounded(this.fetchImpl, source.url, TEXT_ATTACHMENT_MAX_BYTES, this.downloadTimeoutMs);
      if (!download.ok) return refuse(download.reason, { ...downloadFacts(download), detail: download.detail, attempts: 1 });
      const text = decodeUtf8Text(download.bytes);
      if (text === undefined) return refuse('NOT_UTF8_TEXT', { ...downloadFacts(download), detail: 'NOT_UTF8', attempts: 1 });
      // Content-free: the credential refusal never carries the bytes into the diagnostic.
      if (isCredentialShaped(text)) return refuse('CREDENTIAL_SHAPED', { detail: 'CREDENTIAL_SHAPED', attempts: 1 });
      return { attachment: { ...base, kind: 'text', text, trust: 'UNTRUSTED' } };
    }
    // The declared type only made this an image candidate; the bytes decide (a PNG the platform declared or re-encoded
    // differently is still a PNG). The bytes must then pass full structural validation and are CANONICALIZED (Codex P1
    // on df66418): only the rebuilt image — no metadata, text chunks or trailing bytes — is written, and only it can
    // ever reach a vision provider. A body that is not a valid image is downloaded once more after a short delay, in
    // case the CDN object was not final yet; a second miss is refused.
    let attempts = 0;
    let download: DownloadOutcome;
    let sniffed: InboundImageMimeType | undefined;
    let canonical: ReturnType<typeof canonicalizeImage> | undefined;
    do {
      if (attempts > 0) await delay(this.imageRetryDelayMs);
      attempts += 1;
      download = await downloadBounded(this.fetchImpl, source.url, IMAGE_ATTACHMENT_MAX_BYTES, this.downloadTimeoutMs);
      if (!download.ok) return refuse(download.reason, { ...downloadFacts(download), detail: download.detail, attempts });
      sniffed = sniffImageMimeType(download.bytes);
      canonical = sniffed === undefined ? undefined : canonicalizeImage(download.bytes, sniffed);
    } while ((canonical === undefined || !canonical.ok) && attempts < 2);
    if (sniffed === undefined || canonical === undefined) {
      return refuse('UNSUPPORTED_TYPE', {
        ...downloadFacts(download),
        detail: 'SIGNATURE_MISMATCH',
        downloaded: download.bytes,
        attempts,
      });
    }
    if (!canonical.ok) {
      return refuse('UNSUPPORTED_TYPE', {
        ...downloadFacts(download),
        detail: 'INVALID_IMAGE',
        downloaded: download.bytes,
        attempts,
        imageCheck: canonical.code,
      });
    }
    // Defense in depth: credential-shaped text in any printable run of the canonical bytes (e.g. placed inside a
    // JPEG/WebP bitstream) is refused like a credential-shaped text file. Text drawn in the pixels is the residual.
    const screen = screenImageText(canonical.bytes);
    if (screen !== 'CLEAN') return refuse('CREDENTIAL_SHAPED', { detail: screen, attempts });
    const file = await this.writeTempFile(canonical.bytes, IMAGE_FILE_EXTENSIONS[sniffed]);
    if (!file) return refuse('DOWNLOAD_FAILED', { detail: 'TEMP_WRITE_FAILED', attempts });
    created.push(file);
    return { attachment: { ...base, kind: 'image', mimeType: sniffed, imageRef: file, trust: 'UNTRUSTED' } };
  }

  /**
   * Writes under a random intake name (never the uploaded one) in this process's private subdirectory, 0600,
   * exclusive create (never through an existing path or symlink). `undefined` on any failure.
   */
  private async writeTempFile(bytes: Buffer, extension: string): Promise<string | undefined> {
    const dir = await this.ensureProcessDir();
    if (!dir) return undefined;
    const file = path.join(dir, `intake-${randomUUID()}${extension}`);
    // Tracked before the write starts, so a stop() racing the write still deletes it.
    this.liveFiles.add(file);
    try {
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      return file;
    } catch {
      await this.removeFile(file);
      return undefined;
    }
  }

  /** Concurrent writers of one intake share a single resolution, so they never create two subdirectories. */
  private ensureProcessDir(): Promise<string | undefined> {
    if (this.processDirPending) return this.processDirPending;
    const pending: Promise<string | undefined> = this.resolveProcessDir().finally(() => {
      if (this.processDirPending === pending) this.processDirPending = undefined;
    });
    this.processDirPending = pending;
    return pending;
  }

  private async resolveProcessDir(): Promise<string | undefined> {
    if (!(await this.ensurePrivateRoot({ create: true }))) return undefined;
    if (this.processDir) {
      const state = await this.inspectOwnedDirectory(this.processDir);
      if (state === 'ok') return this.processDir;
      if (state === 'invalid') return undefined;
      // 'missing' (e.g. swept while idle): a fresh private subdirectory is created below.
    }
    try {
      // mkdtemp creates the directory 0700 under an unpredictable name.
      const dir = await fs.mkdtemp(path.join(this.tempRoot, PROCESS_DIR_PREFIX));
      if ((await this.inspectOwnedDirectory(dir)) !== 'ok') return undefined;
      this.processDir = dir;
      return dir;
    } catch {
      return undefined;
    }
  }

  /**
   * Validates the temp root BEFORE any traversal or write: it must be a real directory (a symlink is refused), owned
   * by this uid, and private. A looser mode on our own directory is repaired to 0700 through a no-follow handle (and
   * re-checked); a foreign owner, a symlink or a non-directory is refused. With `create`, a missing root is created
   * 0700 (non-recursive: the parent must already exist).
   */
  private async ensurePrivateRoot(options: { readonly create: boolean }): Promise<boolean> {
    if (options.create) {
      try {
        await fs.mkdir(this.tempRoot, { mode: 0o700 });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      }
    }
    try {
      const link = await fs.lstat(this.tempRoot);
      if (link.isSymbolicLink() || !link.isDirectory()) return false;
    } catch {
      return false;
    }
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(this.tempRoot, OPEN_DIRECTORY_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isDirectory()) return false;
      if (this.uid !== undefined && stat.uid !== this.uid) return false;
      if ((stat.mode & 0o077) !== 0) {
        await handle.chmod(0o700);
        if (((await handle.stat()).mode & 0o077) !== 0) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  /** `ok` only for a real (non-symlink) directory owned by this uid with no group/other access. */
  private async inspectOwnedDirectory(dir: string): Promise<'ok' | 'missing' | 'invalid'> {
    try {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return 'invalid';
      if (this.uid !== undefined && stat.uid !== this.uid) return 'invalid';
      return (stat.mode & 0o077) === 0 ? 'ok' : 'invalid';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
    }
  }

  private async removeFile(file: string): Promise<void> {
    this.liveFiles.delete(file);
    await fs.rm(file, { force: true }).catch(() => undefined);
  }

  /**
   * Removes intake files older than {@link ATTACHMENT_SWEEP_AGE_MS}. Never throws, never follows a symlink: the root
   * is validated first (a symlinked, foreign-owned or otherwise unsafe root is not traversed at all), and only
   * lstat-checked regular files owned by this uid with an intake name are deleted — inside `proc-*` subdirectories
   * (themselves real directories owned by this uid), plus legacy `<uuid>.<ext>` files directly in the root. Another
   * process's emptied, stale subdirectory is removed (rmdir only; a non-empty one stays). Returns the files deleted.
   */
  async sweep(): Promise<number> {
    if (!(await this.ensurePrivateRoot({ create: false }))) return 0;
    const cutoff = this.nowMs() - ATTACHMENT_SWEEP_AGE_MS;
    let removed = 0;
    let entries: string[];
    try {
      entries = await fs.readdir(this.tempRoot);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const entryPath = path.join(this.tempRoot, entry);
      if (LEGACY_INTAKE_FILE_PATTERN.test(entry)) {
        if (await this.removeStaleIntakeFile(entryPath, cutoff)) removed += 1;
        continue;
      }
      if (!PROCESS_DIR_PATTERN.test(entry)) continue;
      let dirStat;
      try {
        dirStat = await fs.lstat(entryPath);
      } catch {
        continue;
      }
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
      if (this.uid !== undefined && dirStat.uid !== this.uid) continue;
      let files: string[];
      try {
        files = await fs.readdir(entryPath);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!INTAKE_FILE_PATTERN.test(name)) continue;
        if (await this.removeStaleIntakeFile(path.join(entryPath, name), cutoff)) removed += 1;
      }
      // An earlier (or another) process's stale subdirectory goes once empty; ours is kept for the next write.
      if (entryPath !== this.processDir && dirStat.mtimeMs <= cutoff) {
        await fs.rmdir(entryPath).catch(() => undefined);
      }
    }
    return removed;
  }

  /** Deletes `file` only when it is (by lstat) a regular file owned by this uid and older than `cutoff`. */
  private async removeStaleIntakeFile(file: string, cutoff: number): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (this.uid !== undefined && stat.uid !== this.uid) return false;
      if (stat.mtimeMs > cutoff) return false;
      // unlink removes the entry itself (it never follows a symlink).
      await fs.unlink(file);
      this.liveFiles.delete(file);
      return true;
    } catch {
      // best-effort: a file that vanished or cannot be read is left to the next sweep
      return false;
    }
  }

  /** Deletes every temp file this instance still holds (adapter stop). Never throws. */
  async dispose(): Promise<void> {
    await Promise.all([...this.liveFiles].map((file) => this.removeFile(file)));
    // This process's private subdirectory goes too (rmdir only: never anything it does not own or still holds).
    const dir = this.processDir;
    this.processDir = undefined;
    if (dir) await fs.rmdir(dir).catch(() => undefined);
  }
}

const REASON_COPY: Readonly<Record<InboundAttachmentUnsupportedReason, string>> = {
  UNSUPPORTED_TYPE: '지원하지 않는 형식이에요. 텍스트 파일(.txt·.log·.md·.json 등)과 PNG·JPEG·WebP 이미지만 받아요.',
  TOO_LARGE: '너무 커서 받지 않았어요. 텍스트 파일은 256KiB, 이미지는 8MiB까지예요.',
  TOO_MANY: '한 메시지의 첨부는 3개까지만 읽어요.',
  CREDENTIAL_SHAPED: '비밀번호·토큰 같은 자격 증명으로 보이는 내용이 있어 읽지 않고 버렸어요.',
  NOT_UTF8_TEXT: 'UTF-8 텍스트로 읽을 수 없는 파일이에요.',
  DOWNLOAD_FAILED: '파일을 내려받지 못했어요.',
};

/** A file name made safe to show inside an inline code span. */
function displayName(name: string): string {
  return name.replace(/`/gu, "'");
}

/**
 * The truthful, deterministic intake note (ADR-0111 D2/D3): names each attachment that was not taken in and why.
 * `undefined` when every attachment was taken in. It never echoes file content.
 */
export function renderAttachmentIntakeNote(attachments: readonly InboundAttachment[]): string | undefined {
  const refused = attachments.filter((a) => a.kind === 'unsupported');
  if (refused.length === 0) return undefined;
  return [
    '첨부 파일 중 읽지 않은 것이 있어요.',
    ...refused.map((a) => `- \`${displayName(a.name)}\` — ${REASON_COPY[a.reason]}`),
  ].join('\n');
}

/** Content-free counts for logs: how many attachments of each kind and refusal reason. */
export function summarizeAttachmentIntake(attachments: readonly InboundAttachment[]): Record<string, number> {
  const summary: Record<string, number> = { attachmentCount: attachments.length, text: 0, image: 0, unsupported: 0 };
  for (const a of attachments) summary[a.kind] = (summary[a.kind] ?? 0) + 1;
  return summary;
}
