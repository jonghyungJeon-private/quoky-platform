import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';
import { containsCredentialFileContent, containsCredentialMaterial } from '@quoky/core';
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
const IMAGE_MIME_TYPES = new Set<InboundImageMimeType>(['image/png', 'image/jpeg', 'image/webp']);
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
  /** Runner-owned temp directory; defaults to {@link DEFAULT_ATTACHMENT_TEMP_ROOT}. */
  readonly tempRoot?: string;
  readonly downloadTimeoutMs?: number;
  /** Test seam for the sweep clock. */
  readonly nowMs?: () => number;
  /** Test seam for the owning uid (defaults to `process.getuid()`); a foreign-owned root is refused. */
  readonly uid?: number;
}

export interface AttachmentIntakeResult {
  readonly attachments: readonly InboundAttachment[];
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
 * Text: `text/*` or a `.log`/`.md`/`.json` name. Image: png/jpeg/webp by MIME (or by extension when no MIME is given).
 */
export function classifyAttachment(source: AttachmentSource): AttachmentClassification {
  const mime = baseMimeType(source.contentType);
  const ext = path.extname(source.name ?? '').toLowerCase();
  const size = Number.isFinite(source.size) && source.size >= 0 ? source.size : 0;
  let imageMime: InboundImageMimeType | undefined;
  if (IMAGE_MIME_TYPES.has(mime as InboundImageMimeType)) imageMime = mime as InboundImageMimeType;
  else if (mime === '') imageMime = IMAGE_EXTENSIONS[ext];
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

type DownloadOutcome =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'TOO_LARGE' | 'DOWNLOAD_FAILED' };

/** Streams at most `maxBytes` from the platform CDN; aborts as soon as the bound is passed. */
async function downloadBounded(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<DownloadOutcome> {
  if (!isPlatformCdnUrl(url)) return { ok: false, reason: 'DOWNLOAD_FAILED' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'DOWNLOAD_FAILED' };
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'TOO_LARGE' };
    }
    if (!response.body) return { ok: true, bytes: Buffer.alloc(0) };
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
        return { ok: false, reason: 'TOO_LARGE' };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true, bytes: Buffer.concat(chunks, total) };
  } catch {
    return { ok: false, reason: 'DOWNLOAD_FAILED' };
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
 * Bounded intake over one runner-owned temporary directory. One instance per adapter; {@link dispose} on stop.
 */
export class AttachmentIntake {
  readonly tempRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly downloadTimeoutMs: number;
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
    this.nowMs = options.nowMs ?? Date.now;
    this.uid = options.uid ?? currentUid();
  }

  /** Takes in at most {@link ATTACHMENT_MAX_COUNT} attachments (concurrently), results in upload order. Never throws. */
  async intake(sources: readonly AttachmentSource[]): Promise<AttachmentIntakeResult> {
    const created: string[] = [];
    // The (at most ATTACHMENT_MAX_COUNT) downloads run concurrently, so a slow file does not delay the others and the
    // whole intake is bounded by one download timeout instead of the sum. Results keep upload order.
    const attachments: InboundAttachment[] = await Promise.all(
      sources.map((source, index): InboundAttachment | Promise<InboundAttachment> => {
        const name = sanitizeAttachmentName(source.name);
        const mime = baseMimeType(source.contentType);
        const base = {
          name,
          ...(mime ? { mimeType: mime } : {}),
          sizeBytes: Number.isFinite(source.size) && source.size >= 0 ? source.size : 0,
        };
        if (index >= ATTACHMENT_MAX_COUNT) return { ...base, kind: 'unsupported', reason: 'TOO_MANY' };
        return this.intakeOne(source, base, created);
      }),
    );
    let released = false;
    return {
      attachments,
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
  ): Promise<InboundAttachment> {
    const classification = classifyAttachment(source);
    if (classification.kind === 'unsupported') return { ...base, kind: 'unsupported', reason: classification.reason };
    if (classification.kind === 'text') {
      const download = await downloadBounded(this.fetchImpl, source.url, TEXT_ATTACHMENT_MAX_BYTES, this.downloadTimeoutMs);
      if (!download.ok) return { ...base, kind: 'unsupported', reason: download.reason };
      const text = decodeUtf8Text(download.bytes);
      if (text === undefined) return { ...base, kind: 'unsupported', reason: 'NOT_UTF8_TEXT' };
      if (isCredentialShaped(text)) return { ...base, kind: 'unsupported', reason: 'CREDENTIAL_SHAPED' };
      return { ...base, kind: 'text', text, trust: 'UNTRUSTED' };
    }
    const download = await downloadBounded(this.fetchImpl, source.url, IMAGE_ATTACHMENT_MAX_BYTES, this.downloadTimeoutMs);
    if (!download.ok) return { ...base, kind: 'unsupported', reason: download.reason };
    if (!matchesImageSignature(download.bytes, classification.mimeType)) {
      return { ...base, kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' };
    }
    const file = await this.writeTempFile(download.bytes, IMAGE_FILE_EXTENSIONS[classification.mimeType]);
    if (!file) return { ...base, kind: 'unsupported', reason: 'DOWNLOAD_FAILED' };
    created.push(file);
    return { ...base, kind: 'image', mimeType: classification.mimeType, imageRef: file, trust: 'UNTRUSTED' };
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
