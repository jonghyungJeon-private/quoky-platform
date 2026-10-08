import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { containsCredentialFileContent, containsCredentialMaterial } from '@quoky/core';
import type { InboundAttachment, InboundAttachmentUnsupportedReason, InboundImageMimeType } from '@quoky/core';
import { TelegramApiError, TelegramFailureCode } from './bot-api';
import { canonicalizeImage } from './image-canonical';
import type { ImageCheckCode } from './image-canonical';

/**
 * ADR-0114 D8 / ADR-0111 D2/D3 bounded attachment intake for the Telegram adapter (TG-2). The output is the same
 * platform-neutral {@link InboundAttachment} model the Discord adapter produces, with the same bounds, classification,
 * credential guard and #143 canonical image intake:
 *
 * - **Bounds** (ADR-0111, unchanged): at most {@link ATTACHMENT_MAX_COUNT} attachments per turn; UTF-8 text
 *   ≤ {@link TEXT_ATTACHMENT_MAX_BYTES}; png/jpeg/webp images ≤ {@link IMAGE_ATTACHMENT_MAX_BYTES}.
 * - **Order of checks.** Type and size from the UPDATE metadata first (no Bot API call for a refusal), then `getFile`
 *   (its `file_size` is checked again before any byte is fetched), then the download, which is bounded while streaming.
 * - **Where the bytes come from.** Only through {@link TelegramFileGateway}, which the adapter implements with its
 *   guarded `outbound()` path: the pinned host, nothing before the identity is verified, after a halt or after a stop.
 *   The download URL carries the bot token; it never reaches this module (the gateway takes the `file_path` only).
 * - **Text** is held in memory only, decoded as strict UTF-8, refused when the ADR-0097 credential guard matches, and
 *   handed on as UNTRUSTED readout.
 * - **Images** go through the #143 canonical intake: the bytes' signature decides the type, `canonicalizeImage`
 *   validates and rebuilds them, the credential guard screens every printable run of the canonical bytes, and only the
 *   canonical bytes are written, under a random name, into a runner-owned private temporary directory. The image is
 *   handed on as an opaque `imageRef`; {@link AttachmentIntakeResult.release} deletes it after the turn and
 *   {@link TelegramAttachmentIntake.sweep} removes intake files older than {@link ATTACHMENT_SWEEP_AGE_MS}.
 *
 * `image-canonical.ts` is a byte-identical copy of the Discord adapter's (adapters share no code across packages; the
 * composition root's parity test pins the copy and runs one fixture set through both intakes). The temporary-directory
 * rules below are the Discord intake's (Codex P1 there), in this adapter's own root.
 *
 * Nothing here logs, persists or embeds attachment content, a file id, a `file_path` or a URL.
 */

/** At most this many attachments per turn are considered; the rest are `TOO_MANY` and never fetched. */
export const ATTACHMENT_MAX_COUNT = 3;
/** UTF-8 text file bound (256 KiB). */
export const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024;
/** Image bound (8 MiB). */
export const IMAGE_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** A temp file older than this is swept even if its turn never released it. */
export const ATTACHMENT_SWEEP_AGE_MS = 10 * 60_000;
/** One `getFile` + download wall-clock bound (each). */
export const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 20_000;

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/** Default runner-owned temporary root, per user (created 0700; refused when not a plain directory owned by us). */
export const DEFAULT_TELEGRAM_ATTACHMENT_TEMP_ROOT = path.join(os.tmpdir(), `quoky-telegram-attachments-${currentUid() ?? 'user'}`);
const PROCESS_DIR_PREFIX = 'proc-';
const PROCESS_DIR_PATTERN = /^proc-[A-Za-z0-9]{6}$/u;
const INTAKE_FILE_PATTERN = /^intake-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/u;
const OPEN_DIRECTORY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

const TEXT_EXTENSIONS = new Set(['.log', '.md', '.json']);
const IMAGE_MIME_ALIASES: Readonly<Record<string, InboundImageMimeType>> = {
  'image/png': 'image/png',
  'image/x-png': 'image/png',
  'image/apng': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/webp': 'image/webp',
};
const GENERIC_BINARY_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const NON_RASTER_IMAGE_MIME_TYPES = new Set(['image/svg+xml']);
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

/**
 * One attachment of an admitted Telegram message, as read from the update (metadata only; nothing fetched).
 * - `file`: a `photo` (its chosen size) or a `document`; fetched only after admission and only within the bounds.
 * - `unsupported-media`: a sticker, voice note, audio, video, video note or animation; never fetched, named in the reply.
 */
export type TelegramAttachmentSource =
  | {
      readonly kind: 'file';
      readonly fileId: string;
      readonly name: string | undefined;
      readonly contentType: string | undefined;
      /** The update's `file_size`, when Telegram gave one. */
      readonly size: number | undefined;
    }
  | {
      readonly kind: 'unsupported-media';
      readonly name: string | undefined;
      readonly contentType: string | undefined;
      readonly size: number | undefined;
    };

/**
 * The adapter's guarded file access. `getFile` resolves the Bot API `File` object (or throws); `download` resolves at most
 * `maxBytes` bytes of the file at `filePath` (or throws a {@link TelegramApiError}, `RESPONSE_TOO_LARGE` past the bound).
 * Both refuse, making no call, when the adapter is not verified, halted or stopped.
 */
export interface TelegramFileGateway {
  getFile(fileId: string): Promise<unknown>;
  download(filePath: string, maxBytes: number): Promise<Buffer>;
}

export type AttachmentClassification =
  | { readonly kind: 'text' }
  | { readonly kind: 'image'; readonly mimeType: InboundImageMimeType }
  | { readonly kind: 'unsupported'; readonly reason: InboundAttachmentUnsupportedReason };

export interface TelegramAttachmentIntakeOptions {
  /** Runner-owned temp directory; defaults to {@link DEFAULT_TELEGRAM_ATTACHMENT_TEMP_ROOT}. */
  readonly tempRoot?: string;
  /** Test seam for the sweep clock. */
  readonly nowMs?: () => number;
  /** Test seam for the owning uid (defaults to `process.getuid()`); a foreign-owned root is refused. */
  readonly uid?: number;
}

/** Why one attachment was refused, for one content-free log line: classes and buckets only. */
export interface AttachmentRefusalDiagnostic {
  readonly index: number;
  readonly reason: InboundAttachmentUnsupportedReason;
  readonly detail: AttachmentRefusalDetail;
  readonly declaredMime: string;
  readonly extension: 'image' | 'text' | 'other' | 'none';
  readonly declaredSize: string;
  readonly httpStatus?: number;
  /** The Bot API failure code of `getFile` or the download, when one failed. */
  readonly failure?: string;
  readonly downloadedSize?: string;
  readonly signature?: 'png' | 'jpeg' | 'webp' | 'gif' | 'empty' | 'other';
  readonly imageCheck?: ImageCheckCode;
}

export type AttachmentRefusalDetail =
  | 'COUNT_BOUND'
  /** The poll batch spent its intake budget: the file was not fetched (the turn is still handed over, in order). */
  | 'BATCH_BUDGET'
  | 'MEDIA_TYPE'
  | 'DECLARED_TYPE'
  | 'DECLARED_SIZE'
  | 'GET_FILE_FAILED'
  | 'GET_FILE_SIZE'
  | 'NO_FILE_PATH'
  | 'DOWNLOAD_FAILED'
  | 'STREAM_BOUND'
  | 'SIGNATURE_MISMATCH'
  | 'NOT_UTF8'
  | 'CREDENTIAL_SHAPED'
  | 'INVALID_IMAGE'
  | 'TOO_MUCH_TEXT'
  | 'TEMP_WRITE_FAILED';

export interface AttachmentIntakeResult {
  readonly attachments: readonly InboundAttachment[];
  /** One entry per refused attachment, in message order (content-free; for logs only). */
  readonly diagnostics: readonly AttachmentRefusalDiagnostic[];
  /** Deletes every temp file this intake created. Idempotent; never throws. */
  release(): Promise<void>;
}

/** Control, zero-width and bidi characters removed from a display name (the Discord intake's set). */
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

function knownSize(size: number | undefined): number | undefined {
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
}

/**
 * Metadata-only classification (ADR-0111 D2), the Discord intake's rules: type first, then the size bound for that type.
 * Text: `text/*` or a `.log`/`.md`/`.json` name. Image candidate: a png/jpeg/webp MIME (or a common alias), or an image
 * extension whose declared MIME is absent, generic or another raster `image/*` type; the bytes decide. A size Telegram
 * did not give is checked at `getFile` and while streaming instead.
 */
export function classifyAttachment(source: { readonly name: string | undefined; readonly contentType: string | undefined; readonly size: number | undefined }): AttachmentClassification {
  const mime = baseMimeType(source.contentType);
  const ext = path.extname(source.name ?? '').toLowerCase();
  const size = knownSize(source.size) ?? 0;
  let imageMime: InboundImageMimeType | undefined = IMAGE_MIME_ALIASES[mime];
  if (
    imageMime === undefined &&
    (GENERIC_BINARY_MIME_TYPES.has(mime) || (mime.startsWith('image/') && !NON_RASTER_IMAGE_MIME_TYPES.has(mime)))
  ) {
    imageMime = IMAGE_EXTENSIONS[ext];
  }
  if (imageMime) {
    return size > IMAGE_ATTACHMENT_MAX_BYTES ? { kind: 'unsupported', reason: 'TOO_LARGE' } : { kind: 'image', mimeType: imageMime };
  }
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
    return size > TEXT_ATTACHMENT_MAX_BYTES ? { kind: 'unsupported', reason: 'TOO_LARGE' } : { kind: 'text' };
  }
  return { kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' };
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

/** The strict guard learning excerpts and the Discord intake use (ADR-0097 / ADR-0107 D1). */
function isCredentialShaped(text: string): boolean {
  return containsCredentialMaterial(text) || containsCredentialFileContent(text);
}

const PRINTABLE_RUN_MIN = 8;
/** The Discord intake's one-pass image text budget (#143 follow-up): more is refused, never skipped. */
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

/** Every printable run of the canonical image, joined and scanned once by both credential detectors. */
export function screenImageText(bytes: Buffer): 'CLEAN' | 'CREDENTIAL_SHAPED' | 'TOO_MUCH_TEXT' {
  const text = printableRuns(bytes);
  if (text === undefined) return 'TOO_MUCH_TEXT';
  return isCredentialShaped(text) ? 'CREDENTIAL_SHAPED' : 'CLEAN';
}

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

/** The image type the bytes ARE (png/jpeg/webp), whatever was declared; `undefined` for anything else. */
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

/** A declared MIME as a bounded class: a known type, `<top>/other`, `other`, or `none`. */
export function mimeClass(contentType: string | null | undefined): string {
  const mime = baseMimeType(contentType);
  if (mime === '') return 'none';
  if (LOGGED_MIME_TYPES.has(mime)) return mime;
  const top = mime.split('/')[0] ?? '';
  return MIME_TOP_LEVELS.has(top) ? `${top}/other` : 'other';
}

const SIZE_BUCKETS: ReadonlyArray<readonly [number, string]> = [
  [1024, '<1KiB'],
  [4 * 1024, '<4KiB'],
  [16 * 1024, '<16KiB'],
  [64 * 1024, '<64KiB'],
  [TEXT_ATTACHMENT_MAX_BYTES, '<256KiB'],
  [1024 * 1024, '<1MiB'],
  [IMAGE_ATTACHMENT_MAX_BYTES, '<8MiB'],
];

/** A byte count as a coarse bucket (`0`, `<1KiB`, … `<8MiB`, `>=8MiB`); `unknown` when Telegram gave none. */
export function sizeBucket(bytes: number | undefined): string {
  if (bytes === undefined) return 'unknown';
  if (!Number.isFinite(bytes) || bytes <= 0) return '0';
  for (const [bound, label] of SIZE_BUCKETS) if (bytes < bound) return label;
  return '>=8MiB';
}

function extensionClass(name: string | null | undefined): AttachmentRefusalDiagnostic['extension'] {
  const ext = path.extname(name ?? '').toLowerCase();
  if (ext === '') return 'none';
  if (IMAGE_EXTENSIONS[ext] !== undefined) return 'image';
  return TEXT_EXTENSIONS.has(ext) || ext === '.txt' ? 'text' : 'other';
}

interface IntakeRefusal {
  readonly detail: AttachmentRefusalDetail;
  readonly httpStatus?: number;
  readonly failure?: string;
  readonly downloaded?: Buffer;
  readonly imageCheck?: ImageCheckCode;
}

interface IntakeOutcome {
  readonly attachment: InboundAttachment;
  readonly refusal?: IntakeRefusal;
}

type Fetched = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly reason: InboundAttachmentUnsupportedReason; readonly refusal: IntakeRefusal };

/** The content-free facts of a failed Bot API call (fixed code and HTTP status only). */
function failureFacts(err: unknown): Pick<IntakeRefusal, 'failure' | 'httpStatus'> {
  if (err instanceof TelegramApiError) {
    return { failure: err.code, ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}) };
  }
  return { failure: err instanceof Error && err.name === 'OutboundRefused' ? 'NOT_CONNECTED' : 'UNEXPECTED' };
}

/**
 * Bounded intake over one runner-owned temporary directory. One instance per adapter; {@link dispose} on stop.
 */
export class TelegramAttachmentIntake {
  readonly tempRoot: string;
  private readonly nowMs: () => number;
  private readonly uid: number | undefined;
  private readonly liveFiles = new Set<string>();
  private processDir?: string;
  private processDirPending?: Promise<string | undefined>;
  /**
   * Set by {@link dispose} (adapter stop), cleared by {@link reopen} (start). While closed nothing new is written, and a
   * write already in flight is deleted as soon as it lands (Codex P2: no temp file survives a stop).
   */
  private closed = false;

  constructor(
    private readonly gateway: TelegramFileGateway,
    options: TelegramAttachmentIntakeOptions = {},
  ) {
    this.tempRoot = options.tempRoot ?? DEFAULT_TELEGRAM_ATTACHMENT_TEMP_ROOT;
    this.nowMs = options.nowMs ?? Date.now;
    this.uid = options.uid ?? currentUid();
  }

  /**
   * Takes in at most {@link ATTACHMENT_MAX_COUNT} attachments (concurrently), results in message order. Never throws.
   * With `fetch: false` (the poll batch spent its intake budget) nothing is fetched: the metadata checks still name a
   * too-large or unsupported file, and every other file is `DOWNLOAD_FAILED` (`BATCH_BUDGET`).
   */
  async intake(sources: readonly TelegramAttachmentSource[], options: { readonly fetch?: boolean } = {}): Promise<AttachmentIntakeResult> {
    const created: string[] = [];
    const outcomes: IntakeOutcome[] = await Promise.all(
      sources.map((source, index): IntakeOutcome | Promise<IntakeOutcome> => {
        const mime = baseMimeType(source.contentType);
        const base = {
          name: sanitizeAttachmentName(source.name),
          ...(mime ? { mimeType: mime } : {}),
          sizeBytes: knownSize(source.size) ?? 0,
        };
        if (index >= ATTACHMENT_MAX_COUNT) {
          return { attachment: { ...base, kind: 'unsupported', reason: 'TOO_MANY' }, refusal: { detail: 'COUNT_BOUND' } };
        }
        if (source.kind === 'unsupported-media') {
          return { attachment: { ...base, kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' }, refusal: { detail: 'MEDIA_TYPE' } };
        }
        if (options.fetch === false) {
          const classification = classifyAttachment(source);
          return classification.kind === 'unsupported'
            ? {
                attachment: { ...base, kind: 'unsupported', reason: classification.reason },
                refusal: { detail: classification.reason === 'TOO_LARGE' ? 'DECLARED_SIZE' : 'DECLARED_TYPE' },
              }
            : { attachment: { ...base, kind: 'unsupported', reason: 'DOWNLOAD_FAILED' }, refusal: { detail: 'BATCH_BUDGET' } };
        }
        return this.intakeOne(source, base, created).catch(
          (): IntakeOutcome => ({ attachment: { ...base, kind: 'unsupported', reason: 'DOWNLOAD_FAILED' }, refusal: { detail: 'DOWNLOAD_FAILED', failure: 'UNEXPECTED' } }),
        );
      }),
    );
    const attachments = outcomes.map((outcome) => outcome.attachment);
    const diagnostics: AttachmentRefusalDiagnostic[] = [];
    outcomes.forEach((outcome, index) => {
      const { attachment, refusal } = outcome;
      if (attachment.kind !== 'unsupported' || refusal === undefined) return;
      const source = sources[index] as TelegramAttachmentSource;
      diagnostics.push({
        index,
        reason: attachment.reason,
        detail: refusal.detail,
        declaredMime: mimeClass(source.contentType),
        extension: extensionClass(source.name),
        declaredSize: sizeBucket(knownSize(source.size)),
        ...(refusal.httpStatus !== undefined ? { httpStatus: refusal.httpStatus } : {}),
        ...(refusal.failure !== undefined ? { failure: refusal.failure } : {}),
        ...(refusal.downloaded !== undefined
          ? { downloadedSize: sizeBucket(refusal.downloaded.length), signature: signatureClass(refusal.downloaded) }
          : {}),
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

  /**
   * `getFile` (its `file_size` checked against `maxBytes` before anything is fetched), then the bounded download. Only a
   * fixed failure code and an HTTP status survive a failure; the `file_path` is never kept.
   */
  private async fetchBounded(fileId: string, maxBytes: number): Promise<Fetched> {
    let file: unknown;
    try {
      file = await this.gateway.getFile(fileId);
    } catch (err) {
      return { ok: false, reason: 'DOWNLOAD_FAILED', refusal: { detail: 'GET_FILE_FAILED', ...failureFacts(err) } };
    }
    const { file_size: size, file_path: filePath } = (file ?? {}) as { file_size?: unknown; file_path?: unknown };
    if (typeof size === 'number' && size > maxBytes) return { ok: false, reason: 'TOO_LARGE', refusal: { detail: 'GET_FILE_SIZE' } };
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { ok: false, reason: 'DOWNLOAD_FAILED', refusal: { detail: 'NO_FILE_PATH' } };
    }
    try {
      return { ok: true, bytes: await this.gateway.download(filePath, maxBytes) };
    } catch (err) {
      if (err instanceof TelegramApiError && err.code === TelegramFailureCode.RESPONSE_TOO_LARGE) {
        return { ok: false, reason: 'TOO_LARGE', refusal: { detail: 'STREAM_BOUND', ...failureFacts(err) } };
      }
      return { ok: false, reason: 'DOWNLOAD_FAILED', refusal: { detail: 'DOWNLOAD_FAILED', ...failureFacts(err) } };
    }
  }

  private async intakeOne(
    source: Extract<TelegramAttachmentSource, { kind: 'file' }>,
    base: { readonly name: string; readonly mimeType?: string; readonly sizeBytes: number },
    created: string[],
  ): Promise<IntakeOutcome> {
    const refuse = (reason: InboundAttachmentUnsupportedReason, refusal: IntakeRefusal): IntakeOutcome => ({
      attachment: { ...base, kind: 'unsupported', reason },
      refusal,
    });
    // Metadata first: a refused type or size makes no Bot API call at all.
    const classification = classifyAttachment(source);
    if (classification.kind === 'unsupported') {
      return refuse(classification.reason, { detail: classification.reason === 'TOO_LARGE' ? 'DECLARED_SIZE' : 'DECLARED_TYPE' });
    }
    if (classification.kind === 'text') {
      const fetched = await this.fetchBounded(source.fileId, TEXT_ATTACHMENT_MAX_BYTES);
      if (!fetched.ok) return refuse(fetched.reason, fetched.refusal);
      const text = decodeUtf8Text(fetched.bytes);
      if (text === undefined) return refuse('NOT_UTF8_TEXT', { detail: 'NOT_UTF8' });
      // Content-free: the credential refusal never carries the bytes into the diagnostic.
      if (isCredentialShaped(text)) return refuse('CREDENTIAL_SHAPED', { detail: 'CREDENTIAL_SHAPED' });
      return { attachment: { ...base, kind: 'text', text, trust: 'UNTRUSTED' } };
    }
    // #143 canonical image intake: the bytes decide the type; only the rebuilt canonical image is written and can ever
    // reach a vision provider. A Telegram file is final when getFile answers, so there is no re-download.
    const fetched = await this.fetchBounded(source.fileId, IMAGE_ATTACHMENT_MAX_BYTES);
    if (!fetched.ok) return refuse(fetched.reason, fetched.refusal);
    const sniffed = sniffImageMimeType(fetched.bytes);
    if (sniffed === undefined) return refuse('UNSUPPORTED_TYPE', { detail: 'SIGNATURE_MISMATCH', downloaded: fetched.bytes });
    const canonical = canonicalizeImage(fetched.bytes, sniffed);
    if (!canonical.ok) {
      return refuse('INVALID_IMAGE', { detail: 'INVALID_IMAGE', downloaded: fetched.bytes, imageCheck: canonical.code });
    }
    const screen = screenImageText(canonical.bytes);
    if (screen !== 'CLEAN') return refuse('CREDENTIAL_SHAPED', { detail: screen });
    const file = await this.writeTempFile(canonical.bytes, IMAGE_FILE_EXTENSIONS[sniffed]);
    if (!file) return refuse('DOWNLOAD_FAILED', { detail: 'TEMP_WRITE_FAILED' });
    created.push(file);
    return { attachment: { ...base, kind: 'image', mimeType: sniffed, imageRef: file, trust: 'UNTRUSTED' } };
  }

  /** Random intake name in this process's private subdirectory, 0600, exclusive create. `undefined` on any failure. */
  private async writeTempFile(bytes: Buffer, extension: string): Promise<string | undefined> {
    if (this.closed) return undefined;
    const dir = await this.ensureProcessDir();
    if (!dir || this.closed) return undefined;
    const file = path.join(dir, `intake-${randomUUID()}${extension}`);
    this.liveFiles.add(file);
    try {
      await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      if (this.closed) {
        await this.removeFile(file);
        return undefined;
      }
      return file;
    } catch {
      await this.removeFile(file);
      return undefined;
    }
  }

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
    }
    try {
      const dir = await fs.mkdtemp(path.join(this.tempRoot, PROCESS_DIR_PREFIX));
      if ((await this.inspectOwnedDirectory(dir)) !== 'ok') return undefined;
      this.processDir = dir;
      return dir;
    } catch {
      return undefined;
    }
  }

  /** The temp root must be a real directory (never a symlink) owned by this uid, mode 0700 (a looser own mode is repaired). */
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
   * Removes intake files older than {@link ATTACHMENT_SWEEP_AGE_MS}. Never throws, never follows a symlink: an unsafe
   * root is not traversed; only lstat-checked regular files owned by this uid with an intake name inside `proc-*`
   * subdirectories are deleted, and another process's emptied stale subdirectory is removed. Returns the files deleted.
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
      if (!PROCESS_DIR_PATTERN.test(entry)) continue;
      const entryPath = path.join(this.tempRoot, entry);
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
      if (entryPath !== this.processDir && dirStat.mtimeMs <= cutoff) {
        await fs.rmdir(entryPath).catch(() => undefined);
      }
    }
    return removed;
  }

  private async removeStaleIntakeFile(file: string, cutoff: number): Promise<boolean> {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (this.uid !== undefined && stat.uid !== this.uid) return false;
      if (stat.mtimeMs > cutoff) return false;
      await fs.unlink(file);
      this.liveFiles.delete(file);
      return true;
    } catch {
      return false;
    }
  }

  /** Allows writes again after {@link dispose} (adapter restart). */
  reopen(): void {
    this.closed = false;
  }

  /** Deletes every temp file this instance still holds and refuses new ones until {@link reopen} (adapter stop). */
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.liveFiles].map((file) => this.removeFile(file)));
    const dir = this.processDir;
    this.processDir = undefined;
    if (dir) await fs.rmdir(dir).catch(() => undefined);
  }
}

/** The Discord intake's reason copy (one shared wording for both platforms). */
const REASON_COPY: Readonly<Record<InboundAttachmentUnsupportedReason, string>> = {
  UNSUPPORTED_TYPE: '지원하지 않는 형식이에요. 텍스트 파일(.txt·.log·.md·.json 등)과 PNG·JPEG·WebP 이미지만 받아요.',
  TOO_LARGE: '너무 커서 받지 않았어요. 텍스트 파일은 256KiB, 이미지는 8MiB까지예요.',
  TOO_MANY: '한 메시지의 첨부는 3개까지만 읽어요.',
  CREDENTIAL_SHAPED: '비밀번호·토큰 같은 자격 증명으로 보이는 내용이 있어 읽지 않고 버렸어요.',
  NOT_UTF8_TEXT: 'UTF-8 텍스트로 읽을 수 없는 파일이에요.',
  INVALID_IMAGE: '이미지 파일이 손상됐거나 형식이 올바르지 않아 열 수 없었어요. PNG·JPEG·WebP는 지원하니 정상적인 파일로 다시 보내 주세요.',
  DOWNLOAD_FAILED: '파일을 내려받지 못했어요.',
};

/**
 * The truthful, deterministic intake note (ADR-0111 D2/D3): names each attachment that was not taken in and why, as
 * plain text (Telegram sends with no parse mode, so the name is shown verbatim and parses as nothing). `undefined` when
 * every attachment was taken in. It never echoes file content.
 */
export function renderAttachmentIntakeNote(attachments: readonly InboundAttachment[]): string | undefined {
  const refused = attachments.filter((a) => a.kind === 'unsupported');
  if (refused.length === 0) return undefined;
  return ['첨부 파일 중 읽지 않은 것이 있어요.', ...refused.map((a) => `- "${a.name}" — ${REASON_COPY[a.reason]}`)].join('\n');
}

/** Content-free counts for logs: how many attachments of each kind. */
export function summarizeAttachmentIntake(attachments: readonly InboundAttachment[]): Record<string, number> {
  const summary: Record<string, number> = { attachmentCount: attachments.length, text: 0, image: 0, unsupported: 0 };
  for (const a of attachments) summary[a.kind] = (summary[a.kind] ?? 0) + 1;
  return summary;
}
