import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0121 amendment A6.2, slice A6-S1: the answer function accepts only the two branded consent steps, and no other pending
 * step's module (approval, undo, handoff pick, request-list number, channel grant) can call it.
 * - The IMPORT test: no source file outside `consent-answer/` imports this module (an allowlist of none), and the Core package
 *   index does not re-export it. A module that wants the answer function has to change this test, in review.
 * - The TYPE-LEVEL test: a program compiled with the repository's strict options, in which every other pending step's type and
 *   an unbranded copy are refused by `ConsentPendingStore.open` (`@ts-expect-error` lines that must each be an error).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../../..');
const CORE_SRC = resolve(REPO, 'packages/core/src');
const ROOTS = ['packages', 'apps'].flatMap((top) => readdirSync(join(REPO, top)).map((name) => join(REPO, top, name, 'src')).filter((path) => existsSync(path)));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.includes('.test-support.') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gmu;
function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((match) => match[1] ?? '');
}
const intoConsentAnswer = (file: string, specifier: string): boolean =>
  specifier.startsWith('.') ? resolve(dirname(file), specifier).startsWith(HERE) : specifier.includes('consent-answer');

describe('A6-S1 import boundary: nothing outside consent-answer/ can reach the answer function', () => {
  it('no non-test source file in any package or app imports the consent-answer module', () => {
    const files = ROOTS.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(500);
    const importers = files.filter((file) => !file.startsWith(HERE) && importsOf(file).some((specifier) => intoConsentAnswer(file, specifier)));
    expect(importers.map((file) => relative(REPO, file))).toEqual([]);
  });

  it('the Core package and application indexes do not export it', () => {
    for (const index of ['index.ts', 'application/index.ts']) expect(readFileSync(join(CORE_SRC, index), 'utf8'), index).not.toMatch(/consent-answer|consent-pending/u);
  });

  it.each([
    ['approval', 'application/approval-decision.ts'],
    ['approval', 'application/approval-decision-service.ts'],
    ['approval', 'application/approval-manager.ts'],
    ['undo', 'application/nl-routing/undo-confirm.ts'],
    ['handoff pick', 'application/agent/handoff-slots.ts'],
    ['handoff pick', 'application/agent/handoff-grounding.ts'],
    ['destination pick (A7)', 'application/agent/cross-write.ts'],
    ['channel grant', 'application/surface-grants/surface-grant-service.ts'],
    ['channel grant', 'application/surface-grants/surface-grant-phrases.ts'],
    ['the live runtime (switch off is byte-identical: not wired)', 'application/conversation-runtime.ts'],
  ])('the %s module %s exists and does not import it', (_role, path) => {
    const file = join(CORE_SRC, path);
    expect(existsSync(file)).toBe(true);
    expect(importsOf(file).filter((specifier) => intoConsentAnswer(file, specifier))).toEqual([]);
  });
});

const PROBE = join(HERE, '__consent_type_boundary__.ts');
const PROBE_SOURCE = `
import { ConsentPendingStore, summaryConsentPending, topicConsentPending, type ConsentPending, type SummaryConsentPending, type TopicConsentPending } from './consent-pending';
import { answerConsentTurn } from './consent-answer';
import type { SurfaceGrantPending } from '../surface-grants/surface-grant-service';
import type { ApprovalRequest } from '../../domain';

declare const store: ConsentPendingStore;
declare const grant: SurfaceGrantPending;
declare const approval: ApprovalRequest;
const scope = { actorId: 'a', conversationKey: 'c' };
const summary = summaryConsentPending({ scope, language: 'ko', createdAtMs: 0, recipient: 'r', itemIds: ['i'], sources: ['mail'] });
const topic = topicConsentPending({ scope, language: 'ko', createdAtMs: 0, recipient: 'r', topic: 't' });
store.open(summary);
store.open(topic);
const either: ConsentPending = summary;
store.open(either);
// @ts-expect-error EXPECT a channel-grant pending step is no consent step
store.open(grant);
// @ts-expect-error EXPECT an approval request is no consent step
store.open(approval);
// @ts-expect-error EXPECT an undo, handoff-pick or request-list step (any other kind) is no consent step
store.open({ kind: 'undo-confirm', id: 'u' });
// @ts-expect-error EXPECT a structurally identical literal without the producer's brand is refused
store.open({ kind: 'summary-consent', scope, language: 'ko', createdAtMs: 0, recipient: 'r', reasked: false, itemIds: ['i'], sources: ['mail'] });
// @ts-expect-error EXPECT no origin field (AM-1, R10)
void summary.origin;
// @ts-expect-error EXPECT a claim is made only by the store
store.bind({ pending: summary, version: 1 }, 0);
// @ts-expect-error EXPECT the answer function takes the store, never a pending step of its own
void answerConsentTurn(grant, { scope, ownerDm: true, text: 'x', atMs: 0 }, { mode: 'off' });
type Accepted = Parameters<ConsentPendingStore['open']>[0];
const exactlyTheTwo: [Accepted] extends [SummaryConsentPending | TopicConsentPending] ? ([SummaryConsentPending | TopicConsentPending] extends [Accepted] ? true : false) : false = true;
void exactlyTheTwo;
`;

function probeDiagnostics(source: string): readonly ts.Diagnostic[] {
  const base = JSON.parse(readFileSync(join(REPO, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
  const { options } = ts.convertCompilerOptionsFromJson(base.compilerOptions, REPO);
  const compilerOptions: ts.CompilerOptions = { ...options, noEmit: true, composite: false, incremental: false, declaration: false, declarationMap: false, sourceMap: false, types: [] };
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    resolve(fileName) === PROBE ? ts.createSourceFile(fileName, source, languageVersion, true) : getSourceFile(fileName, languageVersion, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => resolve(fileName) === PROBE || fileExists(fileName);
  const program = ts.createProgram([PROBE], compilerOptions, host);
  const file = program.getSourceFile(PROBE)!;
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
}

describe('A6-S1 type-level boundary: only the two branded consent steps reach the answer pipeline', () => {
  it('every refused shape is a type error and every accepted one compiles (no diagnostic, no unused @ts-expect-error)', () => {
    const diagnostics = probeDiagnostics(PROBE_SOURCE);
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
  }, 60_000);

  it('is not vacuous: without the directives each marked line is an error', () => {
    const expected = PROBE_SOURCE.split('\n').filter((line) => line.includes('@ts-expect-error EXPECT')).length;
    expect(expected).toBe(7);
    const stripped = PROBE_SOURCE.replace(/\/\/ @ts-expect-error EXPECT/gu, '// refused:');
    const lines = new Set(probeDiagnostics(stripped).map((d) => d.file?.getLineAndCharacterOfPosition(d.start ?? 0).line));
    expect(lines.size).toBe(expected);
  }, 60_000);
});
