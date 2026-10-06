import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalEnvironment } from './env-loader';

const TEST_KEY = 'CHUNSIK_ENV_LOADER_TEST';
const originalValue = process.env[TEST_KEY];
const tempDirectories: string[] = [];

function makeEnvFile(contents: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'quoky-env-loader-'));
  tempDirectories.push(directory);
  const envFilePath = path.join(directory, '.env.local');
  writeFileSync(envFilePath, contents, 'utf8');
  return envFilePath;
}

afterEach(() => {
  if (originalValue === undefined) delete process.env[TEST_KEY];
  else process.env[TEST_KEY] = originalValue;

  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('loadLocalEnvironment', () => {
  it('loads values from the caller-provided env file', () => {
    delete process.env[TEST_KEY];
    const envFilePath = makeEnvFile(`${TEST_KEY}=from-local-file\n`);

    loadLocalEnvironment({ envFilePath });

    expect(process.env[TEST_KEY]).toBe('from-local-file');
  });

  it('does not overwrite an existing process environment value', () => {
    process.env[TEST_KEY] = 'from-process';
    const envFilePath = makeEnvFile(`${TEST_KEY}=from-local-file\n`);

    loadLocalEnvironment({ envFilePath });

    expect(process.env[TEST_KEY]).toBe('from-process');
  });

  it('allows a missing env file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'quoky-env-loader-'));
    tempDirectories.push(directory);

    expect(() => loadLocalEnvironment({ envFilePath: path.join(directory, 'missing.env') })).not.toThrow();
  });

  it('reports non-ENOENT read failures without exposing the path or environment data', () => {
    const invalidPath = '\0private-value';

    expect(() => loadLocalEnvironment({ envFilePath: invalidPath })).toThrow(
      new Error('Failed to load local environment file.'),
    );
  });

  it('loads the environment before dynamically importing AppModule without importing main', () => {
    const source = readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const loadPosition = source.indexOf('loadLocalEnvironment(');
    const appModulePosition = source.indexOf("await import('./app.module')");

    expect(source).not.toMatch(/import\s+\{\s*AppModule\s*\}\s+from\s+['"]\.\/app\.module['"]/);
    expect(loadPosition).toBeGreaterThan(-1);
    expect(appModulePosition).toBeGreaterThan(loadPosition);
  });
});
