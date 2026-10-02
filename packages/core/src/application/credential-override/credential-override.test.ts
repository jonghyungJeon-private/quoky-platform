import { describe, expect, it } from 'vitest';
import { ApprovalStatus, Capability, RiskLevel } from '../../domain';
import type { ApprovalRequest, WorkspaceRef } from '../../domain';
import type { ExecutionOutcome, ExecutionRequest } from '../execution-orchestrator';
import {
  CREDENTIAL_OVERRIDE_SEND_PHRASES,
  MAX_CREDENTIAL_OVERRIDE_GRANTS,
  type CredentialOverrideAnchor,
  type CredentialOverrideGrantRecord,
  assessCredentialOverrideAnchor,
  assessCredentialOverrideCoverage,
  credentialOverrideApprovalReason,
  credentialOverrideContentSha256,
  interpretCredentialOverrideDecision,
  invalidateCredentialOverrideAnchor,
  isStrayCredentialOverridePhrase,
  isWellFormedCredentialOverrideAnchor,
} from './credential-override';

const T0 = '2026-10-02T00:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

const WS: WorkspaceRef = { id: 'ws-1', rootPath: '/repo', kind: 'local-clone' };
const ASSIGN = 'export const a = 1;\n\nconst password = "demo-value";\n';
const ASSIGN_SHA = credentialOverrideContentSha256(ASSIGN);
const OTHER = 'const apiKey = "demo-value";\n';
const TOKEN = 'const k = "AKIAIOSFODNN7EXAMPLE";\n';

const binding = {
  ownerActorId: 'owner-1',
  sessionId: 'sess-1',
  workspaceRef: WS,
  projectId: 'proj-1',
  requestTaskId: 'task-request',
  executionPlanId: 'plan-1',
};

const grantOf = (o: Partial<CredentialOverrideGrantRecord> = {}): CredentialOverrideGrantRecord => ({
  ...binding,
  approvalRequestId: 'appr-1',
  targetIndex: 0,
  path: 'src/a.ts',
  contentSha256: ASSIGN_SHA,
  detector: 'credential-assignment',
  line: 3,
  state: 'PENDING',
  createdAt: T0,
  ...o,
});

const anchorOf = (o: Partial<CredentialOverrideAnchor> = {}): CredentialOverrideAnchor => ({
  kind: 'code-preview-credential-override',
  status: 'PENDING',
  ...binding,
  request: {
    goal: 'g', instruction: 'i', requiredCapabilities: [Capability.CODE_IMPLEMENTATION], requestedBy: 'owner-1',
  } as ExecutionRequest,
  outcome: { refs: { executionPlanRef: { id: 'plan-1', goal: 'g' } } } as unknown as ExecutionOutcome,
  newFileTargets: [],
  grants: [grantOf()],
  createdAt: T0,
  updatedAt: T0,
  ...o,
});

const approvalOf = (o: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'appr-1',
  executionPlanRef: { id: 'plan-1', goal: 'g' },
  status: ApprovalStatus.PENDING,
  riskLevel: RiskLevel.CRITICAL,
  reason: 'r',
  requestedBy: 'owner-1',
  createdAt: T0,
  updatedAt: T0,
  ...o,
});

const approvedBy = (id: string, decidedBy = 'owner-1', createdAt = T0): ApprovalRequest =>
  approvalOf({ id, status: ApprovalStatus.APPROVED, decision: true, decidedBy, decidedAt: createdAt, createdAt });

const mapOf = (...requests: ApprovalRequest[]): Map<string, ApprovalRequest> => new Map(requests.map((r) => [r.id, r]));

describe('interpretCredentialOverrideDecision (ADR-0097 D3)', () => {
  it.each([
    ...CREDENTIAL_OVERRIDE_SEND_PHRASES,
    '  그래도   보내줘  ',
    '그래도 보내줘.',
    '그래도 보내줘!!',
    'Send Anyway',
    'SEND ANYWAY!',
    '그래도 보내줘'.normalize('NFD'),
  ])('%j → send', (text) => {
    expect(interpretCredentialOverrideDecision(text)).toBe('send');
  });

  it.each(['취소', '거절', '거절해줘', 'cancel', 'no', 'deny', '보내지 마', '보내지마', '보내지 마.', '그만'])(
    '%j → deny',
    (text) => {
      expect(interpretCredentialOverrideDecision(text)).toBe('deny');
    },
  );

  it.each([
    '승인',
    '승인해줘',
    'ok',
    'OK',
    '좋아',
    '네',
    '진행해',
    'yes',
    '그래도 보내줘?',
    'src/a.ts 그래도 보내줘',
    '그래도 보내줘 src/a.ts',
    '그래도 보내줘 그리고 테스트도 돌려줘',
    '보내줘',
    'send',
    '그래도',
    '',
    '이 파일 뭐가 문제야?',
  ])('%j → reprompt (never sends)', (text) => {
    expect(interpretCredentialOverrideDecision(text)).toBe('reprompt');
  });

  it('shares no word with the plan-approval vocabulary', () => {
    for (const phrase of CREDENTIAL_OVERRIDE_SEND_PHRASES) {
      expect(phrase).not.toMatch(/승인|진행|좋아|\bok\b|\byes\b|approve|proceed/i);
    }
  });
});

describe('isStrayCredentialOverridePhrase', () => {
  it('is true only for a whole-message send phrase', () => {
    expect(isStrayCredentialOverridePhrase('그래도 보내줘')).toBe(true);
    expect(isStrayCredentialOverridePhrase(' send anyway! ')).toBe(true);
    expect(isStrayCredentialOverridePhrase('승인')).toBe(false);
    expect(isStrayCredentialOverridePhrase('그래도 보내줘?')).toBe(false);
    expect(isStrayCredentialOverridePhrase('그래도 보내줘 라는 말은 무슨 뜻이야')).toBe(false);
    expect(isStrayCredentialOverridePhrase('보내지 마')).toBe(false);
  });
});

describe('credentialOverrideApprovalReason', () => {
  it('carries index, full hash, detector and line — never a path or content', () => {
    const reason = credentialOverrideApprovalReason({ targetIndex: 2, contentSha256: ASSIGN_SHA, line: 3 });
    expect(reason).toContain('#2');
    expect(reason).toContain(`sha256=${ASSIGN_SHA}`);
    expect(reason).toContain('detector=credential-assignment');
    expect(reason).toContain('line=3');
    expect(reason).not.toContain('src/');
    expect(reason).not.toContain('demo-value');
  });
});

describe('assessCredentialOverrideAnchor — restart reconstruction (ADR-0097 D5)', () => {
  it('keeps a PENDING grant whose request is still PENDING and unexpired', () => {
    const result = assessCredentialOverrideAnchor(anchorOf(), mapOf(approvalOf()), at(10));
    expect(result).toMatchObject({ kind: 'awaiting-decision', grant: { approvalRequestId: 'appr-1' } });
    expect(result.kind === 'awaiting-decision' && result.remainingMs).toBe(20 * 60_000);
  });

  it('keeps a GRANTED set only if every request is APPROVED by the owner within the TTL', () => {
    const anchor = anchorOf({
      status: 'GRANTED',
      grants: [grantOf({ state: 'GRANTED', grantedBy: 'owner-1', grantedAt: T0 })],
    });
    expect(assessCredentialOverrideAnchor(anchor, mapOf(approvedBy('appr-1')), at(29))).toMatchObject({ kind: 'ready' });
    expect(assessCredentialOverrideAnchor(anchor, mapOf(approvedBy('appr-1')), at(30))).toMatchObject({
      kind: 'invalid', reason: 'expired',
    });
    expect(assessCredentialOverrideAnchor(anchor, mapOf(approvedBy('appr-1', 'intruder')), at(1))).toMatchObject({
      kind: 'invalid', reason: 'denied',
    });
    expect(
      assessCredentialOverrideAnchor(anchor, mapOf(approvalOf({ status: ApprovalStatus.REJECTED, decision: false })), at(1)),
    ).toMatchObject({ kind: 'invalid', reason: 'denied' });
    expect(assessCredentialOverrideAnchor(anchor, mapOf(approvalOf()), at(1))).toMatchObject({
      kind: 'invalid', reason: 'inconsistent',
    });
  });

  it('invalidates a PENDING grant whose request is REJECTED, expired or missing', () => {
    expect(
      assessCredentialOverrideAnchor(anchorOf(), mapOf(approvalOf({ status: ApprovalStatus.REJECTED })), at(1)),
    ).toMatchObject({ kind: 'invalid', reason: 'denied' });
    const expired = assessCredentialOverrideAnchor(anchorOf(), mapOf(approvalOf()), at(30));
    expect(expired).toMatchObject({ kind: 'invalid', reason: 'expired', pendingApproval: { id: 'appr-1' } });
    expect(assessCredentialOverrideAnchor(anchorOf(), new Map(), at(1))).toMatchObject({
      kind: 'invalid', reason: 'expired', pendingApproval: null,
    });
    expect(
      assessCredentialOverrideAnchor(anchorOf(), mapOf(approvalOf({ createdAt: 'not-a-date' })), at(1)),
    ).toMatchObject({ kind: 'invalid', reason: 'expired' });
  });

  it('invalidates a PENDING grant whose request was decided outside the anchor record', () => {
    expect(assessCredentialOverrideAnchor(anchorOf(), mapOf(approvedBy('appr-1')), at(1))).toMatchObject({
      kind: 'invalid', reason: 'inconsistent',
    });
  });

  it('never honors a request that is not this anchor\'s own CRITICAL override, nor hands a foreign one back', () => {
    const granted = anchorOf({
      status: 'GRANTED',
      grants: [grantOf({ state: 'GRANTED', grantedBy: 'owner-1', grantedAt: T0 })],
    });
    const low = approvalOf({ status: ApprovalStatus.APPROVED, decision: true, decidedBy: 'owner-1', riskLevel: RiskLevel.LOW });
    const otherPlan = approvalOf({
      status: ApprovalStatus.APPROVED, decision: true, decidedBy: 'owner-1', executionPlanRef: { id: 'plan-2', goal: 'g' },
    });
    for (const foreign of [low, otherPlan]) {
      expect(assessCredentialOverrideAnchor(granted, mapOf(foreign), at(1))).toMatchObject({
        kind: 'invalid', reason: 'inconsistent',
      });
    }
    const foreignPending = approvalOf({ riskLevel: RiskLevel.LOW });
    expect(assessCredentialOverrideAnchor(anchorOf(), mapOf(foreignPending), at(1))).toEqual({
      kind: 'invalid', reason: 'inconsistent', pendingApproval: null,
    });
  });

  it('bounds the whole set by its OLDEST grant', () => {
    const anchor = anchorOf({
      grants: [
        grantOf({ state: 'GRANTED', grantedBy: 'owner-1', grantedAt: at(1) }),
        grantOf({ approvalRequestId: 'appr-2', path: 'src/b.ts', targetIndex: 1, createdAt: at(20) }),
      ],
    });
    const approvals = mapOf(approvedBy('appr-1'), approvalOf({ id: 'appr-2', createdAt: at(20) }));
    const fresh = assessCredentialOverrideAnchor(anchor, approvals, at(25));
    expect(fresh.kind === 'awaiting-decision' && fresh.remainingMs).toBe(5 * 60_000);
    expect(assessCredentialOverrideAnchor(anchor, approvals, at(31))).toMatchObject({
      kind: 'invalid', reason: 'expired', pendingApproval: { id: 'appr-2' },
    });
  });

  it('keeps a CONSUMED (or partially consumed) anchor terminal', () => {
    expect(assessCredentialOverrideAnchor(anchorOf({ status: 'CONSUMED' }), new Map(), at(99))).toEqual({
      kind: 'consumed',
    });
    const partial = anchorOf({
      status: 'GRANTED',
      grants: [grantOf({ state: 'CONSUMED' }), grantOf({ approvalRequestId: 'appr-2', path: 'src/b.ts' })],
    });
    expect(assessCredentialOverrideAnchor(partial, new Map(), at(1))).toEqual({ kind: 'consumed' });
  });

  it('keeps an INVALIDATED anchor invalid with its recorded reason', () => {
    const anchor = invalidateCredentialOverrideAnchor(anchorOf(), 'reset', 'owner-1', at(1));
    expect(assessCredentialOverrideAnchor(anchor, mapOf(approvalOf()), at(2))).toMatchObject({
      kind: 'invalid', reason: 'reset', pendingApproval: { id: 'appr-1' },
    });
  });

  it('never honors a malformed anchor', () => {
    const six = Array.from({ length: MAX_CREDENTIAL_OVERRIDE_GRANTS + 1 }, (_, i) =>
      grantOf({ approvalRequestId: `appr-${i}`, path: `src/f${i}.ts`, state: 'GRANTED', grantedBy: 'owner-1' }),
    );
    const malformed: CredentialOverrideAnchor[] = [
      anchorOf({ grants: [] }),
      anchorOf({ grants: six }),
      anchorOf({ grants: [grantOf(), grantOf({ approvalRequestId: 'appr-2', path: 'src/b.ts', state: 'GRANTED' })] }),
      anchorOf({ grants: [grantOf({ sessionId: 'other-session' })] }),
      anchorOf({ grants: [grantOf({ executionPlanId: 'plan-2' })] }),
      anchorOf({ grants: [grantOf({ workspaceRef: { ...WS, rootPath: '/elsewhere' } })] }),
      anchorOf({ grants: [grantOf({ contentSha256: 'abc' })] }),
      anchorOf({ grants: [grantOf({ line: 0 })] }),
      anchorOf({ grants: [grantOf({ state: 'GRANTED', grantedBy: 'owner-1' }), grantOf({ approvalRequestId: 'appr-2' })] }), // dup path
    ];
    for (const anchor of malformed) {
      expect(isWellFormedCredentialOverrideAnchor(anchor)).toBe(false);
      expect(assessCredentialOverrideAnchor(anchor, mapOf(approvalOf()), at(1))).toMatchObject({
        kind: 'invalid', reason: 'inconsistent',
      });
    }
    expect(isWellFormedCredentialOverrideAnchor(anchorOf())).toBe(true);
  });
});

describe('invalidateCredentialOverrideAnchor', () => {
  it('flips every unconsumed grant and the anchor, recording reason, actor and time', () => {
    const anchor = anchorOf({
      grants: [
        grantOf({ state: 'GRANTED', grantedBy: 'owner-1' }),
        grantOf({ approvalRequestId: 'appr-2', path: 'src/b.ts' }),
      ],
    });
    const result = invalidateCredentialOverrideAnchor(anchor, 'denied', 'owner-1', at(3));
    expect(result).toMatchObject({
      status: 'INVALIDATED', invalidationReason: 'denied', invalidatedBy: 'owner-1', invalidatedAt: at(3),
    });
    expect(result.grants.map((g) => [g.state, g.invalidationReason])).toEqual([
      ['INVALIDATED', 'denied'],
      ['INVALIDATED', 'denied'],
    ]);
    expect(anchor.status).toBe('PENDING'); // pure
  });
});

describe('assessCredentialOverrideCoverage', () => {
  const readerOf = (files: Record<string, string>) => ({
    read: async (_ref: WorkspaceRef, path: string): Promise<string> => {
      const content = files[path];
      if (content === undefined) throw new Error('not readable');
      return content;
    },
  });
  const granted = grantOf({ state: 'GRANTED', grantedBy: 'owner-1' });

  it('is covered when every refused target has a matching GRANTED grant, and returns no content', async () => {
    const result = await assessCredentialOverrideCoverage(
      readerOf({ 'src/a.ts': ASSIGN, 'src/c.ts': 'export const c = 1;\n' }), WS, ['src/a.ts', 'src/c.ts'], [], [granted],
    );
    expect(result).toEqual({ kind: 'covered' });
    expect(JSON.stringify(result)).not.toContain('demo-value');
  });

  it('reports the next refused target without a grant (a PENDING grant does not cover)', async () => {
    const files = readerOf({ 'src/a.ts': ASSIGN, 'src/b.ts': OTHER });
    const next = await assessCredentialOverrideCoverage(files, WS, ['src/a.ts', 'src/b.ts'], [], [granted]);
    expect(next).toEqual({
      kind: 'needs-override',
      refusal: { targetIndex: 1, targetPath: 'src/b.ts', contentSha256: credentialOverrideContentSha256(OTHER), line: 1 },
    });
    expect(JSON.stringify(next)).not.toContain('demo-value');
    const pendingOnly = await assessCredentialOverrideCoverage(files, WS, ['src/a.ts'], [], [grantOf()]);
    expect(pendingOnly).toMatchObject({ kind: 'needs-override', refusal: { targetPath: 'src/a.ts' } });
  });

  it('blocks on a secret-token target, a changed granted file, or an unreadable target', async () => {
    expect(
      await assessCredentialOverrideCoverage(readerOf({ 'src/a.ts': ASSIGN, 'src/t.ts': TOKEN }), WS, ['src/a.ts', 'src/t.ts'], [], [granted]),
    ).toMatchObject({ kind: 'blocked', reason: 'target-contains-credential', targetIndex: 1 });
    expect(
      await assessCredentialOverrideCoverage(readerOf({ 'src/a.ts': `${ASSIGN}// edited\n` }), WS, ['src/a.ts'], [], [granted]),
    ).toMatchObject({ kind: 'blocked', reason: 'target-changed-since-override', targetPath: 'src/a.ts' });
    expect(await assessCredentialOverrideCoverage(readerOf({}), WS, ['.env'], [], [granted])).toEqual({
      kind: 'blocked', reason: 'target-read-failed', targetIndex: 0,
    });
  });

  it('skips explicit new-file targets', async () => {
    expect(await assessCredentialOverrideCoverage(readerOf({}), WS, ['src/new.ts'], ['src/new.ts'], [])).toEqual({
      kind: 'covered',
    });
  });
});
