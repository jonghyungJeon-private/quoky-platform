import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiFailureKind, AiProviderError } from '@quoky/core';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const FILE_NAME = /^[0-9a-f]{64}\.txt$/;
/** Files of the directory older than this are removed at the first use of a process (growth bound, documented in DECISIONS). */
export const SYSTEM_PROMPT_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

const failure = (): AiProviderError => new AiProviderError(AiFailureKind.EXECUTION_FAILED, 'claude CLI could not prepare its system prompt file');

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/**
 * Content-addressed files for `claude --append-system-prompt-file`. The stable, owner-content-free instruction prefix of
 * a request (`AiRequest.systemPrompt`) is written once per distinct text to `<tmpdir>/quoky-sysprompt-<uid>/<sha256>.txt`
 * (mode 0600) and reused by every later call, so the CLI sees the same system prompt bytes and can serve them from its
 * prompt cache. Private-file convention (as `writePrivateFileAtomic`): the directory is one per uid, 0700, `lstat`-checked on
 * every use (a real directory, owned by this uid, exactly 0700, else fail closed); a file is reused only after `lstat`
 * (regular, not a symlink, owned by this uid, 0600) AND a byte comparison with the expected text; otherwise it is rewritten
 * through a temp file opened `O_CREAT | O_EXCL | O_NOFOLLOW` (0600) and renamed over. Several processes may share the
 * directory: content addressing plus rename is race-safe, and an ENOENT / EEXIST race retries once. Every filesystem
 * failure is an `AiProviderError(EXECUTION_FAILED)`. At the first use per process, files older than 7 days that match the
 * name pattern, are regular and owned by this uid are deleted. The text never reaches argv, only the path does.
 */
export class SystemPromptFileStore {
  private swept = false;
  private readonly uid: number | undefined;

  constructor(
    private readonly baseDir: () => string = tmpdir,
    private readonly now: () => number = Date.now,
    uid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined,
  ) {
    this.uid = uid;
  }

  /** The private per-uid directory, created when absent and verified on every call. */
  directory(): string {
    try {
      return this.ensureDirectory();
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw failure();
    }
  }

  /** The file holding exactly `text`, written atomically when absent or not trustworthy. */
  pathFor(text: string): string {
    const bytes = Buffer.from(text, 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        return this.pathOnce(bytes);
      } catch (error) {
        if (error instanceof AiProviderError) throw error;
        // A vanished directory or a lost rename race: recreate and retry once.
        if (attempt === 0 && (codeOf(error) === 'ENOENT' || codeOf(error) === 'EEXIST')) continue;
        throw failure();
      }
    }
  }

  private ensureDirectory(): string {
    const dir = join(this.baseDir(), `quoky-sysprompt-${this.uid ?? 'nouid'}`);
    let info;
    try {
      info = lstatSync(dir);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      try {
        mkdirSync(dir, { mode: 0o700 });
        chmodSync(dir, 0o700);
      } catch (made) {
        if (codeOf(made) !== 'EEXIST') throw made;
      }
      info = lstatSync(dir);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (this.uid !== undefined && info.uid !== this.uid) || (info.mode & 0o777) !== 0o700) throw failure();
    if (!this.swept) {
      this.swept = true;
      this.sweep(dir);
    }
    return dir;
  }

  private trusted(file: string, bytes: Buffer): boolean {
    let info;
    try {
      info = lstatSync(file);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return false;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || (this.uid !== undefined && info.uid !== this.uid) || (info.mode & 0o777) !== 0o600 || info.size !== bytes.length) return false;
    const fd = openSync(file, fsConstants.O_RDONLY | O_NOFOLLOW);
    let content: Buffer;
    try {
      content = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!content.equals(bytes)) return false;
    if (this.now() - info.mtimeMs > TOUCH_AFTER_MS) {
      try {
        const at = new Date(this.now());
        utimesSync(file, at, at);
      } catch {
        // best effort: the sweep only affects a file in use once, and the next call rewrites it
      }
    }
    return true;
  }

  private pathOnce(bytes: Buffer): string {
    const dir = this.ensureDirectory();
    const hash = createHash('sha256').update(bytes).digest('hex');
    const target = join(dir, `${hash}.txt`);
    if (this.trusted(target, bytes)) return target;
    const tmp = join(dir, `.${hash}.tmp-${randomBytes(12).toString('hex')}`);
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, target);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw error;
    }
    return target;
  }

  private sweep(dir: string): void {
    try {
      const cutoff = this.now() - SYSTEM_PROMPT_FILE_MAX_AGE_MS;
      for (const name of readdirSync(dir)) {
        if (!FILE_NAME.test(name)) continue;
        try {
          const file = join(dir, name);
          const info = lstatSync(file);
          if (info.isFile() && !info.isSymbolicLink() && (this.uid === undefined || info.uid === this.uid) && info.mtimeMs < cutoff) unlinkSync(file);
        } catch {
          // another process may have removed or replaced it
        }
      }
    } catch {
      // the sweep is best effort
    }
  }
}

/** The process-wide store the Claude CLI provider uses unless one is injected. */
export const defaultSystemPromptFiles = new SystemPromptFileStore();
