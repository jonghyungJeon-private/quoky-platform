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
    // CS-1a (rule ① confirm slice): `AgentRunService` opens the pending summary consent, so it imports the producer and the store
    // type; `agent-contract-check.ts` pins its dependency type (types only, no value); `quarantined-summary.ts` imports the brand
    // check and the `BoundConsent` type for `mintSummaryConsentToken`, the only maker of a consent token. Neither imports the answer function (the
    // next test pins that). CS-2 (the runtime gate) adds exactly three, each pinned by imported name below: the runtime base class
    // (the gate, by name), the runtime types (the gate type), and the application index (the store and the gate, never the answer function).
    expect(importers.map((file) => relative(REPO, file)).sort()).toEqual([
      'packages/core/src/application/agent/agent-contract-check.ts',
      'packages/core/src/application/agent/agent-run-service.ts',
      'packages/core/src/application/agent/quarantined-summary.ts',
      'packages/core/src/application/conversation-runtime/runtime-base.ts',
      'packages/core/src/application/conversation-runtime/types.ts',
      'packages/core/src/application/index.ts',
    ]);
  });

  it('the two pending-only importers reach only consent-pending, and the run service also the owner-yes check, by name (never the answer function or the classifier)', () => {
    const namesOf = (path: string): string[] => {
      const file = join(CORE_SRC, path);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const imported: string[] = [];
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.includes('consent-answer')) continue;
        const clause = node.importClause;
        expect(clause?.name, 'no default import').toBeUndefined();
        const bindings = clause?.namedBindings;
        expect(bindings !== undefined && ts.isNamedImports(bindings), `${path}: named imports only`).toBe(true);
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) imported.push(`${node.moduleSpecifier.text}#${element.propertyName?.text ?? element.name.text}`);
        }
      }
      return imported.sort();
    };
    expect(namesOf('application/agent/agent-contract-check.ts')).toEqual(['../consent-answer/consent-pending#ConsentPendingStore']);
    expect(namesOf('application/agent/agent-run-service.ts')).toEqual(['../consent-answer/consent-pending#BoundConsent', '../consent-answer/consent-pending#ConsentPendingStore', '../consent-answer/consent-pending#summaryConsentPending', '../consent-answer/consent-yes#isOwnerYes']);
  });

  it('quarantined-summary.ts imports from consent-answer/ exactly the BoundConsent type and the yes-brand check, by name', () => {
    const file = join(CORE_SRC, 'application/agent/quarantined-summary.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imported: string[] = [];
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.includes('consent-answer')) continue;
      const clause = node.importClause;
      expect(clause?.name, 'no default import').toBeUndefined();
      const bindings = clause?.namedBindings;
      expect(bindings !== undefined && ts.isNamedImports(bindings), 'named imports only').toBe(true);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) imported.push(`${node.moduleSpecifier.text}#${element.propertyName?.text ?? element.name.text}${clause?.isTypeOnly || element.isTypeOnly ? ':type' : ''}`);
      }
    }
    expect(imported.sort()).toEqual(['../consent-answer/consent-pending#BoundConsent:type', '../consent-answer/consent-yes#isOwnerYes']);
  });

  it('CS-2: the runtime reaches consent-answer/ only through the gate, by name (never the answer function, the classifier or the store)', () => {
    const named = (path: string): string[] => {
      const file = join(CORE_SRC, path);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const imported: string[] = [];
      for (const node of source.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.includes('consent-answer')) continue;
        const bindings = node.importClause?.namedBindings;
        expect(node.importClause?.name, 'no default import').toBeUndefined();
        expect(bindings !== undefined && ts.isNamedImports(bindings), `${path}: named imports only`).toBe(true);
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) imported.push(`${node.moduleSpecifier.text}#${element.propertyName?.text ?? element.name.text}${node.importClause?.isTypeOnly || element.isTypeOnly ? ':type' : ''}`);
        }
      }
      return imported.sort();
    };
    expect(named('application/conversation-runtime/runtime-base.ts')).toEqual(['../consent-answer/consent-turn-gate#ConsentTurnGate']);
    expect(named('application/conversation-runtime/types.ts')).toEqual(['../consent-answer/consent-turn-gate#ConsentTurnGate:type']);
  });

  it('the Core package index exports nothing of it; the application index exports exactly the store and the gate (and the gate types), by name', () => {
    expect(readFileSync(join(CORE_SRC, 'index.ts'), 'utf8')).not.toMatch(/consent-answer|consent-pending/u);
    const file = join(CORE_SRC, 'application/index.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const exported: string[] = [];
    for (const node of source.statements) {
      if (!ts.isExportDeclaration(node) || node.moduleSpecifier === undefined || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      if (!/consent-answer|consent-pending/u.test(node.moduleSpecifier.text)) continue;
      const clause = node.exportClause;
      expect(clause !== undefined && ts.isNamedExports(clause), 'no star re-export of consent-answer').toBe(true);
      if (clause !== undefined && ts.isNamedExports(clause)) for (const element of clause.elements) exported.push(`${node.moduleSpecifier.text}#${element.propertyName?.text ?? element.name.text}`);
    }
    expect(exported.sort()).toEqual([
      './consent-answer/consent-classifier#ConsentClassifierDeps',
      './consent-answer/consent-classifier#createConsentAnswerClassifier',
      './consent-answer/consent-pending#ConsentPendingStore',
      './consent-answer/consent-turn-gate#ConsentContinuation',
      './consent-answer/consent-turn-gate#ConsentGateOutcome',
      './consent-answer/consent-turn-gate#ConsentGateTurn',
      './consent-answer/consent-turn-gate#ConsentTurnGate',
      './consent-answer/consent-turn-gate#ConsentTurnGateDeps',
    ]);
    // The answer function has one non-test caller: the gate.
    const callers = sourceFiles(CORE_SRC).filter((path) => /\banswerConsentTurn\s*\(/u.test(readFileSync(path, 'utf8')) && !path.endsWith('consent-answer.ts'));
    expect(callers.map((path) => relative(REPO, path))).toEqual(['packages/core/src/application/consent-answer/consent-turn-gate.ts']);
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
    ['the live runtime entry (the gate is reached through the runtime base class, by name)', 'application/conversation-runtime.ts'],
    ['the platform facade (it only delivers `TurnResult.rerun`)', 'application/orchestrator.ts'],
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
import type { PendingQuestion } from '../nl-routing/selection-state';
import type { ValidatedAgentHandoff } from '../agent/plan-validator';

declare const store: ConsentPendingStore;
declare const grant: SurfaceGrantPending;
declare const approval: ApprovalRequest;
declare const undoConfirm: Extract<PendingQuestion, { kind: 'action-undo-confirm' }>;
declare const handoff: ValidatedAgentHandoff;
declare const requestList: Extract<PendingQuestion, { kind: 'entry' }>;
const scope = { actorId: 'a', conversationKey: 'c' };
const summary = summaryConsentPending({ scope, language: 'ko', createdAtMs: 0, recipient: 'r', sources: [{ source: 'mail', itemIds: ['i'] }], runRef: 'run-1' });
const topic = topicConsentPending({ scope, language: 'ko', createdAtMs: 0, recipient: 'r', topic: 't' });
store.open(summary);
store.open(topic);
const either: ConsentPending = summary;
store.open(either);
// @ts-expect-error EXPECT a channel-grant pending step is no consent step
store.open(grant);
// @ts-expect-error EXPECT an approval request is no consent step
store.open(approval);
// @ts-expect-error EXPECT the undo-confirm pending step is no consent step
store.open(undoConfirm);
// @ts-expect-error EXPECT a validated handoff (handoff slots) is no consent step
store.open(handoff);
// @ts-expect-error EXPECT the request-list (numbered entry) pending step is no consent step
store.open(requestList);
// @ts-expect-error EXPECT a structurally identical literal without the producer's brand is refused
store.open({ kind: 'summary-consent', scope, language: 'ko', createdAtMs: 0, recipient: 'r', reasked: false, sources: [{ source: 'mail', itemIds: ['i'] }], runRef: 'run-1' });
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
    expect(expected).toBe(9);
    const stripped = PROBE_SOURCE.replace(/\/\/ @ts-expect-error EXPECT/gu, '// refused:');
    const lines = new Set(probeDiagnostics(stripped).map((d) => d.file?.getLineAndCharacterOfPosition(d.start ?? 0).line));
    expect(lines.size).toBe(expected);
  }, 60_000);
});
