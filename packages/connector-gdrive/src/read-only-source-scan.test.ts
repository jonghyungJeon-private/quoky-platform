import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0118 D3/D6 source scan (DRV-1, the GML-1 review P3-4 form): the Drive adapter can only call read endpoints. Every
 * non-test source file of the package is read and checked, so a later change that adds a write call, a write scope, a
 * binary download or a second request site fails here (the runtime guard `assertGDriveReadRequest` is the other half).
 */
const dir = new URL('./', import.meta.url);
const sources = readdirSync(dir)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));
/** Code with comments removed (the doc comments name the forbidden operations on purpose). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('connector-gdrive read-only source scan (ADR-0118 D3/D6)', () => {
  it('scans the whole package', () => {
    expect(sources.map((source) => source.name).sort()).toEqual([
      'errors.ts', 'gdrive-reader.ts', 'index.ts', 'oauth.ts', 'sheets-reader.ts', 'text.ts', 'token-file.ts',
    ]);
  });

  it('names no Drive write endpoint, sharing call or upload', () => {
    const forbidden = [
      /\/permissions\b/,
      /\/copy\b/,
      /\/revisions\b/,
      /\/comments\b/,
      /\/replies\b/,
      /\/watch\b/,
      /\/changes\b/,
      /\/about\b/,
      /\/drives\b/,
      /\/teamdrives\b/,
      /\/upload\b/,
      /\/download\b/,
      /\/modifyLabels\b/,
      /\/generateIds\b/,
      /\/emptyTrash\b|\/trash\b/,
      /uploadType/,
      /addParents|removeParents/,
      /\btrashed\s*[:=]\s*true\b/,
      /\bpageToken\b/,
      /acknowledgeAbuse/,
      // DRV-2b: no Sheets write method, no grid data, no formula rendering, no developer metadata or sheet copy.
      /batchUpdate/,
      /values:(?:update|append|clear|batchUpdate|batchClear|batchUpdateByDataFilter|batchClearByDataFilter|batchGetByDataFilter)/,
      /:append\b|:clear\b/,
      /includeGridData/,
      /['"`]FORMULA['"`]|UNFORMATTED_VALUE/,
      /developerMetadata|copyTo|getByDataFilter/,
      /spreadsheets\.readonly|auth\/spreadsheets/,
    ];
    for (const { name, text } of sources) {
      for (const pattern of forbidden) expect(code(text), `${name} ${pattern}`).not.toMatch(pattern);
    }
  });

  it('uses only GET for the Drive API; the single POST is the OAuth token request', () => {
    // Any quote style, template literals included, and any `method` binding.
    const methods = sources.flatMap(({ name, text }) =>
      [...code(text).matchAll(/\bmethod\b\s*[:=]\s*(['"`])([A-Za-z]+)\1/g)].map((match) => `${name}:${match[2]}`),
    );
    expect(methods.sort()).toEqual(['gdrive-reader.ts:GET', 'oauth.ts:POST']);
    for (const { name, text } of sources) {
      expect(code(text), name).not.toMatch(/(['"`])(?:PUT|PATCH|DELETE)\1/i);
      // A computed method (`method: verb`) would hide from the literal scan above (`method: string` is a type).
      expect(code(text), name).not.toMatch(/\bmethod\s*:\s*(?!['"`]|string\b)[A-Za-z_$][\w$]*/);
    }
    const oauth = code(sources.find((source) => source.name === 'oauth.ts')?.text ?? '');
    expect(oauth).toMatch(/fetchImpl\(GDRIVE_OAUTH_TOKEN_URL,/);
  });

  it('has exactly two request sites: the token POST and the guarded GET', () => {
    const sites = sources.flatMap(({ name, text }) => [...code(text).matchAll(/\bfetchImpl\(/g)].map(() => name));
    expect(sites.sort()).toEqual(['gdrive-reader.ts', 'oauth.ts']);
    // Every reference, not just calls: an alias (`const send = this.fetchImpl`) would be a hidden site.
    const references = sources.flatMap(({ name, text }) => [...code(text).matchAll(/\bfetchImpl\b/g)].map(() => name));
    expect(references.sort()).toEqual([
      'gdrive-reader.ts', // config field
      'gdrive-reader.ts', // private field
      'gdrive-reader.ts', // constructor assignment (left)
      'gdrive-reader.ts', // constructor assignment (right, the config value)
      'gdrive-reader.ts', // the guarded GET
      'gdrive-reader.ts', // handed to the token refresh (key)
      'gdrive-reader.ts', // handed to the token refresh (value)
      'oauth.ts', // option type
      'oauth.ts', // the token POST
    ]);
    const reader = code(sources.find((source) => source.name === 'gdrive-reader.ts')?.text ?? '');
    // The GET site asserts the read-only allowlist (Drive, or the DRV-2b Sheets read) before it sends.
    expect(reader).toMatch(/assertGoogleReadRequest\(url, method\);\s*try \{\s*return await this\.fetchImpl\(url,/);
    // The Sheets module builds and checks requests only: it holds no request site of its own.
    const sheets = code(sources.find((source) => source.name === 'sheets-reader.ts')?.text ?? '');
    expect(sheets).not.toMatch(/\bfetch(?:Impl)?\b/);
    expect(code(sources.map((source) => source.text).join('\n'))).not.toMatch(/\bfetch\(/);
  });

  it('exports text only: the export types are text/plain and text/csv, and a media download (alt=media) is forbidden (CA review P2-2)', () => {
    const reader = code(sources.find((source) => source.name === 'gdrive-reader.ts')?.text ?? '');
    const exportTypes = [...reader.matchAll(/\]: '([a-z]+\/[a-z.+-]+)'/g)].map((match) => match[1]);
    expect(exportTypes).toEqual(['text/plain', 'text/csv']);
    expect(reader).not.toMatch(/alt\s*=\s*media|['"]alt['"]|\balt\b\s*:/);
    expect(reader).not.toMatch(/searchParams\.set\('alt'/);
    expect(reader).toMatch(/!isDriveTextExportable\(summary\.kind\) \|\| exportType === undefined/);
  });

  it('the scan patterns catch every quote style and aliasing (not vacuous)', () => {
    const methodOf = (line: string) => [...line.matchAll(/\bmethod\b\s*[:=]\s*(['"`])([A-Za-z]+)\1/g)].map((match) => match[2]);
    expect(methodOf("method: 'POST'")).toEqual(['POST']);
    expect(methodOf('method: "DELETE"')).toEqual(['DELETE']);
    expect(methodOf('method: `PATCH`')).toEqual(['PATCH']);
    expect(methodOf("const method = 'PUT'")).toEqual(['PUT']);
    expect(/\bmethod\s*:\s*(?!['"`]|string\b)[A-Za-z_$][\w$]*/.test('method: verb')).toBe(true);
    expect('const send = this.fetchImpl;'.match(/\bfetchImpl\b/g)).toHaveLength(1);
    expect([...'fetch(`https://evil.example/x`)'.matchAll(/['"`]\w+:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1])).toEqual(['evil.example']);
    expect(/\/permissions\b/.test('`${GDRIVE_FILES_PATH}/${id}/permissions`')).toBe(true);
  });

  it('requests and accepts drive.readonly only: no other Google scope string appears', () => {
    const scopes = sources.flatMap(({ text }) => [...text.matchAll(/https:\/\/(?:www\.googleapis\.com\/auth\/[\w.]+|mail\.google\.com\/?)/g)].map((match) => match[0]));
    expect([...new Set(scopes)]).toEqual(['https://www.googleapis.com/auth/drive.readonly']);
  });

  it('DRV-2: the shared-drive parameters are fixed values in one table, never a write or a broader corpus', () => {
    const reader = code(sources.find((source) => source.name === 'gdrive-reader.ts')?.text ?? '');
    expect(reader).toMatch(/corpora: 'allDrives',\s*includeItemsFromAllDrives: 'true',\s*supportsAllDrives: 'true',/);
    expect(reader).not.toMatch(/corpora\s*[:=]\s*['"`](?:domain|drive|user)/);
    expect(reader).not.toMatch(/driveId/);
  });

  it('DRV-2b: Sheets reads are values only, formatted, by rows; the two paths are pinned', () => {
    const sheets = code(sources.find((source) => source.name === 'sheets-reader.ts')?.text ?? '');
    expect(sheets).toMatch(/GSHEETS_VALUE_RENDER_OPTION = 'FORMATTED_VALUE'/);
    expect(sheets).toMatch(/GSHEETS_MAJOR_DIMENSION = 'ROWS'/);
    expect([...sheets.matchAll(/`\/v4\/spreadsheets\/\$\{encodeURIComponent\(id\)\}([^`]*)`/g)].map((match) => match[1])).toEqual(['', '/values:batchGet']);
  });

  it('pins its egress to the Drive API, Sheets API and OAuth hosts', () => {
    const hosts = new Set(
      sources.flatMap(({ text }) => [...code(text).matchAll(/['"`]\w+:\/\/([a-z0-9.-]+)/gi)].map((match) => match[1])),
    );
    expect([...hosts].sort()).toEqual(['accounts.google.com', 'oauth2.googleapis.com', 'sheets.googleapis.com', 'www.googleapis.com']);
  });
});
