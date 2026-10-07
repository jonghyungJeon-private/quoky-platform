import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether a CLI can be started on this host (ADR-0092 amendment, runtime switching): a filesystem lookup only — it
 * spawns nothing, so composing the providers stays side-effect free. A bare name is looked up on `PATH`; a path is
 * checked directly. Only an executable regular file counts.
 */
export function isCliPresent(bin: string, envPath: string | undefined = process.env.PATH): boolean {
  if (bin.length === 0 || /[\0\n\r]/.test(bin)) return false;
  const candidates = bin.includes('/') ? [bin] : (envPath ?? '').split(path.delimiter).filter((dir) => dir.length > 0).map((dir) => path.join(dir, bin));
  return candidates.some((candidate) => {
    try {
      if (!statSync(candidate).isFile()) return false;
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
