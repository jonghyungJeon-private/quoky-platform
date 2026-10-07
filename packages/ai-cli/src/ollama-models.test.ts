import { describe, expect, it } from 'vitest';
import type { CliRunner } from './cli-runner';
import {
  MAX_LISTED_OLLAMA_MODELS,
  OllamaChatModelInventory,
  listLocalOllamaModels,
  parseOllamaListEntries,
  parseOllamaListModelNames,
  parseOllamaShowCapabilities,
  sameOllamaModel,
} from './ollama-models';

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

// Captured from `ollama show` on Ollama 0.35 (license text shortened).
const SHOW_EMBED = [
  '  Model',
  '    architecture        nomic-bert    ',
  '    parameters          137M          ',
  '    embedding length    768           ',
  '',
  '  Capabilities',
  '    embedding    ',
  '',
  '  Parameters',
  '    num_ctx    8192    ',
  '',
].join('\n');
const SHOW_CHAT_THINKING = [
  '  Model',
  '    architecture        qwen3     ',
  '',
  '  Capabilities',
  '    completion     ',
  '    tools          ',
  '    thinking       ',
  '        levels     true    ',
  '        default    true    ',
  '',
  '  Parameters',
  '    temperature       0.6               ',
  '',
].join('\n');
const SHOW_VISION = ['  Model', '    architecture        gemma3    ', '', '  Capabilities', '    completion    ', '    vision        ', ''].join('\n');

const INVENTORY_TABLE = [
  'NAME                       ID              SIZE      MODIFIED',
  'granite3.3:8b              fd429f23b909    4.9 GB    2 months ago',
  'nomic-embed-text:latest    0a109f422b47    274 MB    6 months ago',
  'gemma3:4b                  a2af6cc3eb7f    3.3 GB    6 months ago',
  'qwen3:4b                   359d7dd4bcda    2.5 GB    6 months ago',
  '',
].join('\n');

describe('ollama chat-capable inventory (live QA: an embedding-only model is not a chat choice)', () => {
  it('reads the capabilities section, ignoring nested detail lines and other sections', () => {
    expect(parseOllamaShowCapabilities(SHOW_EMBED)).toEqual(['embedding']);
    expect(parseOllamaShowCapabilities(SHOW_CHAT_THINKING)).toEqual(['completion', 'tools', 'thinking']);
    expect(parseOllamaShowCapabilities(SHOW_VISION)).toEqual(['completion', 'vision']);
    expect(parseOllamaShowCapabilities('  Model\n    architecture  llama\n')).toBeUndefined();
  });

  it('parses the ID column with the name rules of the list parser', () => {
    expect(parseOllamaListEntries(TABLE)).toEqual([
      { name: 'granite3.3:8b', id: 'fd429f23b909' },
      { name: 'llama3.1:latest', id: '46e0c10c039e' },
    ]);
  });

  function runnerFor(show: Record<string, string | 'FAIL'>, table = INVENTORY_TABLE) {
    const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
    const runner: CliRunner = async (_bin, args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs });
      if (args[0] === 'list') return { code: 0, stdout: table, stderr: '', timedOut: false };
      const out = show[args[1] ?? ''];
      if (out === undefined || out === 'FAIL') return { code: 1, stdout: '', stderr: 'Error: model not found', timedOut: false };
      return { code: 0, stdout: out, stderr: '', timedOut: false };
    };
    return { runner, calls };
  }

  it('excludes a model without `completion` and reports it as non-chat', async () => {
    const { runner } = runnerFor({
      'granite3.3:8b': SHOW_CHAT_THINKING,
      'nomic-embed-text:latest': SHOW_EMBED,
      'gemma3:4b': SHOW_VISION,
      'qwen3:4b': SHOW_CHAT_THINKING,
    });
    expect(await new OllamaChatModelInventory({ runner }).list()).toEqual({
      status: 'OK',
      models: ['granite3.3:8b', 'gemma3:4b', 'qwen3:4b'],
      nonChat: ['nomic-embed-text:latest'],
    });
  });

  it('caches a definite answer per name and ID: a second list costs one `ollama list`; a re-pull is checked again', async () => {
    const show = { 'granite3.3:8b': SHOW_CHAT_THINKING, 'nomic-embed-text:latest': SHOW_EMBED, 'gemma3:4b': SHOW_VISION, 'qwen3:4b': SHOW_CHAT_THINKING };
    let table = INVENTORY_TABLE;
    const calls: string[] = [];
    const runner: CliRunner = async (_bin, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'list') return { code: 0, stdout: table, stderr: '', timedOut: false };
      return { code: 0, stdout: show[args[1] as keyof typeof show] ?? '', stderr: '', timedOut: false };
    };
    const inventory = new OllamaChatModelInventory({ runner });
    await inventory.list();
    expect(calls.filter((c) => c.startsWith('show'))).toHaveLength(4);
    calls.length = 0;
    await inventory.list();
    expect(calls).toEqual(['list']);
    table = INVENTORY_TABLE.replace('a2af6cc3eb7f', 'bbbbbbbbbbbb');
    calls.length = 0;
    await inventory.list();
    expect(calls).toEqual(['list', 'show gemma3:4b']);
  });

  it('falls back to the narrow embedding-name rule when `ollama show` cannot answer, and does not cache that', async () => {
    const { runner, calls } = runnerFor({ 'granite3.3:8b': 'FAIL', 'nomic-embed-text:latest': 'FAIL', 'gemma3:4b': '  Model\n', 'qwen3:4b': 'FAIL' });
    const inventory = new OllamaChatModelInventory({ runner });
    expect(await inventory.list()).toEqual({
      status: 'OK',
      models: ['granite3.3:8b', 'gemma3:4b', 'qwen3:4b'],
      nonChat: ['nomic-embed-text:latest'],
    });
    expect(calls.find((c) => c.args[0] === 'show')?.timeoutMs).toBe(3_000);
    calls.length = 0;
    await inventory.list();
    expect(calls.filter((c) => c.args[0] === 'show')).toHaveLength(4);
  });

  it('is UNAVAILABLE when `ollama list` fails (no show is run)', async () => {
    const calls: string[] = [];
    const runner: CliRunner = async (_bin, args) => {
      calls.push(args[0] ?? '');
      return { code: 1, stdout: '', stderr: 'could not connect', timedOut: false };
    };
    expect(await new OllamaChatModelInventory({ runner }).list()).toEqual({ status: 'UNAVAILABLE' });
    expect(calls).toEqual(['list']);
  });
});
