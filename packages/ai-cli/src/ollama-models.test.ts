import { describe, expect, it } from 'vitest';
import type { CliRunner } from './cli-runner';
import { MAX_LISTED_OLLAMA_MODELS, listLocalOllamaModels, parseOllamaListModelNames, sameOllamaModel } from './ollama-models';

const TABLE = [
  'NAME                      ID              SIZE      MODIFIED',
  'granite3.3:8b             fd429f23b909    4.9 GB    2 days ago',
  'llama3.1:latest           46e0c10c039e    4.9 GB    3 weeks ago',
  'gpt-oss:120b-cloud        -               -         5 days ago',
  'granite3.3:8b             fd429f23b909    4.9 GB    2 days ago',
  '$(rm -rf)                 x               1 GB      now',
  '',
].join('\n');

describe('ollama model inventory (ADR-0092 amendment, runtime switching)', () => {
  it('lists the NAME column, local models only, well-formed, de-duplicated, in table order', () => {
    expect(parseOllamaListModelNames(TABLE)).toEqual(['granite3.3:8b', 'llama3.1:latest']);
    expect(parseOllamaListModelNames('NAME ID SIZE MODIFIED\n')).toEqual([]);
  });

  it('is bounded', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `m${i}:latest  id  1 GB  now`);
    expect(parseOllamaListModelNames(['NAME', ...rows].join('\n'))).toHaveLength(MAX_LISTED_OLLAMA_MODELS);
  });

  it('runs one bounded `ollama list` with the colour-free environment and maps failures to UNAVAILABLE', async () => {
    const calls: Array<{ bin: string; args: readonly string[]; timeoutMs: number }> = [];
    const ok: CliRunner = async (bin, args, options) => {
      calls.push({ bin, args, timeoutMs: options.timeoutMs });
      return { code: 0, stdout: TABLE, stderr: '', timedOut: false };
    };
    expect(await listLocalOllamaModels('/opt/ollama', ok)).toEqual({ status: 'OK', models: ['granite3.3:8b', 'llama3.1:latest'] });
    expect(calls).toEqual([{ bin: '/opt/ollama', args: ['list'], timeoutMs: 5_000 }]);
    const down: CliRunner = async () => ({ code: 1, stdout: '', stderr: 'could not connect to ollama app', timedOut: false });
    expect(await listLocalOllamaModels('ollama', down)).toEqual({ status: 'UNAVAILABLE' });
    const hung: CliRunner = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
    expect(await listLocalOllamaModels('ollama', hung)).toEqual({ status: 'UNAVAILABLE' });
    const missing: CliRunner = async () => {
      throw new Error('ENOENT');
    };
    expect(await listLocalOllamaModels('ollama', missing)).toEqual({ status: 'UNAVAILABLE' });
  });

  it('compares names like the readiness probe (untagged = :latest)', () => {
    expect(sameOllamaModel('llama3.1', 'llama3.1:latest')).toBe(true);
    expect(sameOllamaModel('granite3.3:8b', 'granite3.3:2b')).toBe(false);
  });
});
