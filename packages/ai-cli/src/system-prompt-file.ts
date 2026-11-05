import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Content-addressed files for `claude --append-system-prompt-file`. The stable, owner-content-free instruction prefix of
 * a request (`AiRequest.systemPrompt`) is written once per distinct text to `<private dir>/<sha256-hex>.txt` (mode 0600)
 * and reused by every later call, so the CLI sees the same system prompt bytes each time and can serve them from its
 * prompt cache. The directory is created once per store with `mkdtemp` under the OS temp dir (mode 0700) and removed at
 * process exit (best effort). The text never reaches argv, only the path does.
 */
export class SystemPromptFileStore {
  private dir: string | undefined;
  private exitHooked = false;

  constructor(private readonly baseDir: () => string = tmpdir) {}

  /** The private directory (created on first use). */
  directory(): string {
    if (this.dir === undefined) {
      const created = mkdtempSync(join(this.baseDir(), 'quoky-sysprompt-'));
      chmodSync(created, 0o700);
      this.dir = created;
      if (!this.exitHooked) {
        this.exitHooked = true;
        process.once('exit', () => this.dispose());
      }
    }
    return this.dir;
  }

  /** The file holding exactly `text`; written atomically (tmp + rename) only when absent or of the wrong size. */
  pathFor(text: string): string {
    const bytes = Buffer.from(text, 'utf8');
    const target = join(this.directory(), `${createHash('sha256').update(bytes).digest('hex')}.txt`);
    if (existsSync(target) && statSync(target).size === bytes.length) return target;
    const temp = `${target}.${process.pid}.${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8)}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
    return target;
  }

  /** Removes the directory and forgets it (a later call makes a fresh one). */
  dispose(): void {
    const dir = this.dir;
    this.dir = undefined;
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

/** The process-wide store the Claude CLI provider uses unless one is injected. */
export const defaultSystemPromptFiles = new SystemPromptFileStore();
