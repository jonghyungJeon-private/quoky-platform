import { describe, expect, it } from 'vitest';
import { IntentClassifier, NON_ABSOLUTE_REGISTRATION_KIND, detectProjectRegistration } from './intent-classifier';
import { Capability, IntentType } from '../domain';
import type { InboundMessage } from '../domain';
import type { CapabilityRouter } from './capability-router';

const classifier = new IntentClassifier({} as unknown as CapabilityRouter);

function msg(text: string): InboundMessage {
  return { text, context: {} } as unknown as InboundMessage;
}

describe('IntentClassifier.classify (v1 deterministic)', () => {
  it.each([
    '내가 해야 할 일 보여줘',
    '제가 할 작업 알려줘',
    'Show me what I need to work on',
    'List my work',
  ])('routes the natural personal-work request to the read-only Work Surface: %s', async (text) => {
    const intent = await classifier.classify(msg(text));
    expect(intent).toMatchObject({
      type: IntentType.LOOKUP,
      capability: Capability.READONLY_LOOKUP,
      requiresWork: false,
      raw: { kind: 'personal-work-surface' },
    });
  });

  it('routes a structure/analysis question to PROJECT_ANALYSIS (ADR-0019)', async () => {
    for (const text of [
      '이 프로젝트가 어떤 구조인지 짧게 설명해줘',
      '이 레포 구조 분석해줘',
      'explain the structure of this repo',
      '패키지 구조 설명해줘',
    ]) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type).toBe(IntentType.PROJECT_ANALYSIS);
      expect(intent.capability).toBe(Capability.PROJECT_ANALYSIS);
      expect(intent.requiresWork).toBe(true);
    }
  });

  it('routes a registration command to REGISTER_PROJECT, not analysis', async () => {
    const intent = await classifier.classify(msg('이 프로젝트 등록해줘: /tmp/repo'));
    expect(intent.type).toBe(IntentType.REGISTER_PROJECT);
    expect(intent.raw).toEqual({ path: '/tmp/repo' });
  });

  it('falls back to general chat for an ordinary question', async () => {
    const intent = await classifier.classify(msg('춘식아 안녕?'));
    expect(intent.type).toBe(IntentType.CHAT);
    expect(intent.capability).toBe(Capability.GENERAL_CHAT);
  });

  it('keeps conversational testing and development topics in GENERAL_CHAT', async () => {
    for (const text of [
      '개발할 때 테스트가 많아지면 필요한 테스트만 빠르게 돌리는 것도 중요하지?',
      '개발할 때 테스트를 빠르게 돌리는 방법이 궁금해',
      '테스트 실행이 왜 중요한지 설명해줘',
      '요즘은 focused test를 먼저 실행하는 편이 효율적이지?',
      '테스트를 돌려야 개발이 안전하다는 말도 있지?',
      'pnpm test 실행 결과는 보통 어떻게 해석해?',
      'typecheck가 개발 중에 왜 필요한지 알려줘',
      'typecheck가 뭔지 설명해',
      '테스트를 돌리는 방법을 알려줘',
      '테스트 실행 결과를 설명해줘',
      '테스트를 돌려야 안전하다고 생각해',
      '테스트를 먼저 실행하는 편이 좋아',
      '왜 테스트를 실행해?',
      '왜 typecheck 해?',
    ]) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type, text).toBe(IntentType.CHAT);
      expect(intent.capability, text).toBe(Capability.GENERAL_CHAT);
    }
  });

  it('routes only explicit test action requests to RUN_TESTS', async () => {
    for (const text of [
      'pnpm test',
      'pnpm test 해줘',
      'pnpm test 실행해줘',
      '이 프로젝트 테스트 돌려봐',
      '현재 변경사항에 대해 focused test 실행해',
      '전체 테스트 돌려봐 주세요',
      '테스트 실행해줄 수 있어?',
      '테스트 돌려주실 수 있나요?',
      '테스트 부탁해요',
      '테스트 해 주십시오',
      'run tests',
    ]) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type, text).toBe(IntentType.RUN_TESTS);
      expect(intent.capability, text).toBe(Capability.TEST_EXECUTION);
      expect(intent.raw, text).toEqual({ kind: 'test' });
    }

    for (const text of ['타입체크 좀 해줘', 'typecheck 좀 부탁해', '타입체크 해주세요', 'run typecheck']) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type, text).toBe(IntentType.RUN_TESTS);
      expect(intent.capability, text).toBe(Capability.TEST_EXECUTION);
      expect(intent.raw, text).toEqual({ kind: 'typecheck' });
    }
  });

  it('never routes validation requests carrying denied fragments to RUN_TESTS', async () => {
    for (const text of [
      'typecheck 해주세요 ; rm -rf /',
      'rm -rf / ; typecheck 해주세요',
      'git status && run tests',
      'run tests | cat /etc/passwd',
    ]) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type, text).not.toBe(IntentType.RUN_TESTS);
      expect(intent.capability, text).not.toBe(Capability.TEST_EXECUTION);
    }
  });

  // Live Code Change Planning (ADR-0035) — deterministic code-change intent recognition.
  it('routes a bug-fix request to IMPLEMENT_CODE with raw.kind "fix"', async () => {
    const intent = await classifier.classify(msg('이 버그 고쳐줘'));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.capability).toBe(Capability.CODE_IMPLEMENTATION);
    expect(intent.requiresWork).toBe(true);
    expect(intent.raw).toEqual({ kind: 'fix' });
  });

  it('routes a "이 부분 수정해줘" request to IMPLEMENT_CODE with raw.kind "change"', async () => {
    const intent = await classifier.classify(msg('이 부분 수정해줘'));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.raw).toEqual({ kind: 'change' });
  });

  it('routes "코드 바꿔줘" to IMPLEMENT_CODE with raw.kind "change"', async () => {
    const intent = await classifier.classify(msg('코드 바꿔줘'));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.raw).toEqual({ kind: 'change' });
  });

  it('routes a refactor request to IMPLEMENT_CODE with raw.kind "refactor"', async () => {
    const intent = await classifier.classify(msg('이 함수 리팩터링 해줘'));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.raw).toEqual({ kind: 'refactor' });
  });

  it('does not shadow RUN_TESTS ("테스트 돌려줘" still classifies as a test run)', async () => {
    const intent = await classifier.classify(msg('테스트 돌려줘'));
    expect(intent.type).toBe(IntentType.RUN_TESTS);
    expect(intent.capability).toBe(Capability.TEST_EXECUTION);
  });

  it('does not shadow PROJECT_ANALYSIS ("이 프로젝트 구조 설명해줘" still classifies as analysis)', async () => {
    const intent = await classifier.classify(msg('이 프로젝트 구조 설명해줘'));
    expect(intent.type).toBe(IntentType.PROJECT_ANALYSIS);
    expect(intent.capability).toBe(Capability.PROJECT_ANALYSIS);
  });
});

// Sprint 4c-Follow-up (ADR-0062 draft) — deterministic PREVIEW intent + negation-aware TEST_EXECUTION detection.
describe('IntentClassifier — preview intent + negated test handling', () => {
  it('routes a Korean "미리보기" request to IMPLEMENT_CODE with raw.kind "preview"', async () => {
    for (const text of [
      '변경 미리보기 만들어줘',
      '코드 변경 미리보기 보여줘',
      '패치 미리보기만 보여줘',
      '파일 변경안 보여줘',
    ]) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
      expect(intent.capability).toBe(Capability.CODE_IMPLEMENTATION);
      expect(intent.raw).toEqual({ kind: 'preview' });
    }
  });

  it('routes an English "diff/patch preview only" request to IMPLEMENT_CODE (preview)', async () => {
    for (const text of ['diff preview only, please', 'show me a patch preview', 'preview the change only']) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
      expect(intent.raw).toEqual({ kind: 'preview' });
    }
  });

  it('routes the explicit /preview command to IMPLEMENT_CODE (preview)', async () => {
    const intent = await classifier.classify(msg('/preview 이 함수 리팩터링 초안 보여줘'));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.capability).toBe(Capability.CODE_IMPLEMENTATION);
    expect(intent.raw).toEqual({ kind: 'preview' });
    expect(intent.summary).toBe('이 함수 리팩터링 초안 보여줘');
  });

  it('P7/P8: a preview-only request that prohibits tests/commit/push routes to preview (never RUN_TESTS)', async () => {
    for (const text of [
      'diff preview only. do not run pnpm test. do not commit. do not push.',
      '변경 미리보기만 보여줘. pnpm test 실행하지 마. 커밋하지 마.',
    ]) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
      expect(intent.raw).toEqual({ kind: 'preview' });
    }
  });

  it('N6/N7: a NEGATED test request is NOT classified as RUN_TESTS', async () => {
    for (const text of ['테스트 실행하지 마', 'pnpm test 실행하지 마', 'do not run pnpm test']) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type).not.toBe(IntentType.RUN_TESTS);
    }
  });

  it('R9/R10: a genuine (non-negated) test request still classifies as RUN_TESTS (ADR-0033 unchanged)', async () => {
    for (const text of ['테스트 실행해줘', 'pnpm test 실행해줘', '이 프로젝트 테스트 돌려줘']) {
      const intent = await classifier.classify(msg(text));
      expect(intent.type).toBe(IntentType.RUN_TESTS);
      expect(intent.capability).toBe(Capability.TEST_EXECUTION);
    }
  });
});

// ── Sprint 4c-Follow-up-6 (F6-A/B/C) — clause-scoped, negation-aware test-run routing ──────────────
describe('IntentClassifier — Follow-up-6 routing matrix (Gate 4B FAIL fix)', () => {
  const SCENARIO_C = [
    '다음 파일을 새로 만들어줘.',
    '',
    '경로:',
    'docs/uat/github-app-auth-smoke.md',
    '',
    '내용:',
    '# GitHub App Auth UAT',
    '',
    '- marker: quoky-dev app auth smoke test',
    '',
    '조건:',
    '- preview only',
    '- 파일을 실제로 만들거나 수정하지 말 것',
    '- workspace apply 하지 말 것',
    '- 테스트 실행하지 말 것',
    '- git commit/push/PR 하지 말 것',
  ].join('\n');

  it('the EXACT Gate 4B Scenario C request classifies as CODE_IMPLEMENTATION (never RUN_TESTS)', async () => {
    const intent = await classifier.classify(msg(SCENARIO_C));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.capability).toBe(Capability.CODE_IMPLEMENTATION);
    expect(intent.type).not.toBe(IntentType.RUN_TESTS);
  });

  it('a create-file request whose CONTENT merely contains the word "test" is NOT a test run (the exact defect)', async () => {
    const intent = await classifier.classify(
      msg('파일 생성:\ndocs/x.md\n내용:\n- marker: smoke test\n조건:\n- preview only\n- 테스트 실행하지 말 것'),
    );
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
  });

  it('cross-clause noun/verb never infers RUN_TESTS (test noun in clause A, action verb in clause B)', async () => {
    // "test" only in a content line; "실행" only in a negated condition — must not combine into RUN_TESTS.
    const intent = await classifier.classify(msg('- marker: smoke test\n- 뭔가 실행하지 마'));
    expect(intent.type).not.toBe(IntentType.RUN_TESTS);
  });

  it('CA §2 required outcomes', async () => {
    // positive
    for (const t of ['테스트 실행해줘', 'pnpm test 실행해줘']) {
      expect((await classifier.classify(msg(t))).type, t).toBe(IntentType.RUN_TESTS);
    }
    // negated → not RUN_TESTS
    for (const t of ['테스트 실행하지 말 것', '테스트는 돌리지 마']) {
      expect((await classifier.classify(msg(t))).type, t).not.toBe(IntentType.RUN_TESTS);
    }
    // mixed create/code + negated test → CODE_IMPLEMENTATION
    for (const t of ['파일을 만들어줘. 테스트는 실행하지 마.', '코드를 수정해줘. pnpm test는 돌리지 마.']) {
      expect((await classifier.classify(msg(t))).type, t).toBe(IntentType.IMPLEMENT_CODE);
    }
  });

  it('an explicit create-file request routes to CODE_IMPLEMENTATION even without a preview phrase', async () => {
    const intent = await classifier.classify(msg('docs/x.md 파일을 만들어줘'));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
  });

  it('a negated create ("파일 만들지 마") does not force CODE_IMPLEMENTATION via the create signal', async () => {
    const intent = await classifier.classify(msg('그 파일 만들지 마'));
    expect(intent.type).not.toBe(IntentType.IMPLEMENT_CODE);
  });

  // F6 QA regressions (independent QA falsification): the classifier create-signal must be request-shaped, and
  // a create verb ending in "해줘" must not be consumed as a test-run action.
  it('a DESCRIPTIVE/past create phrase is NOT forced to CODE_IMPLEMENTATION ("이 파일이 어떻게 만들어졌는지 알려줘")', async () => {
    const intent = await classifier.classify(msg('이 파일이 어떻게 만들어졌는지 알려줘'));
    expect(intent.type).not.toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.type).not.toBe(IntentType.RUN_TESTS);
  });

  it('a "create a test file" request routes to CODE_IMPLEMENTATION, never RUN_TESTS ("테스트 파일 생성해줘")', async () => {
    for (const t of ['테스트 파일 생성해줘', '테스트 파일 만들어줘']) {
      const intent = await classifier.classify(msg(t));
      expect(intent.type, t).toBe(IntentType.IMPLEMENT_CODE);
      expect(intent.type, t).not.toBe(IntentType.RUN_TESTS);
    }
  });

  it('a genuine test run with an explicit run verb still classifies as RUN_TESTS (no over-tightening)', async () => {
    for (const t of ['테스트 돌려줘', '테스트 실행해줘', '이 프로젝트 테스트 실행해줘']) {
      expect((await classifier.classify(msg(t))).type, t).toBe(IntentType.RUN_TESTS);
    }
  });
});

// ── Sprint 4c-Follow-up-7 (F7-B) — preview-request routing coverage (Gate 5 live turn-1 misroute fix) ──
describe('IntentClassifier — Follow-up-7 preview-request routing (Gate 5 turn-1 fix)', () => {
  const GATE5_PREVIEW_REQUEST = [
    '현재 활성 프로젝트의 아래 기존 파일에 대한 패치 변경안을 미리보기로 보여줘.',
    '',
    '파일:',
    'gate5/apply-smoke.txt',
    '',
    '현재 내용:',
    'gate5 apply smoke',
    'marker: PENDING',
    '',
    '변경 후 내용:',
    'gate5 apply smoke',
    'marker: quoky-gate5-workspace-apply',
    '',
    '조건:',
    '- 지금은 preview만 보여줄 것',
    '- 실제 파일에는 적용하지 말 것',
    '- workspace apply 하지 말 것',
    '- 테스트나 명령을 실행하지 말 것',
    '- git add/commit/push/PR 하지 말 것',
  ].join('\n');

  it('the EXACT Gate 5 live preview request routes to CODE_IMPLEMENTATION (preview), NOT GENERAL_CHAT (the turn-1 defect)', async () => {
    const intent = await classifier.classify(msg(GATE5_PREVIEW_REQUEST));
    expect(intent.type).toBe(IntentType.IMPLEMENT_CODE);
    expect(intent.capability).toBe(Capability.CODE_IMPLEMENTATION);
    expect(intent.raw).toEqual({ kind: 'preview' });
    expect(intent.type).not.toBe(IntentType.CHAT);
  });

  it('the broadened preview phrasings all route to IMPLEMENT_CODE (preview)', async () => {
    for (const t of ['패치 변경안을 미리보기로 보여줘', '코드 변경안 미리보기', '파일 변경안을 미리보기로 보여줘', '변경안을 미리보기로 보여줘']) {
      const intent = await classifier.classify(msg(t));
      expect(intent.type, t).toBe(IntentType.IMPLEMENT_CODE);
      expect(intent.raw, t).toEqual({ kind: 'preview' });
    }
  });

  describe('everyday-request precision (T2)', () => {
    const noProject = { hasActiveProject: false };

    it('does not treat "7/3" as a project path', async () => {
      for (const ctx of [undefined, noProject]) {
        const intent = await classifier.classify(msg('7/3 회의 등록해줘'), ctx);
        expect(intent.type).toBe(IntentType.CHAT);
      }
    });

    it('still registers an absolute multi-segment path', async () => {
      const intent = await classifier.classify(msg('/Users/me/repo 프로젝트 등록해줘'), noProject);
      expect(intent.type).toBe(IntentType.REGISTER_PROJECT);
    });

    it('downgrades bare keywords to GENERAL_CHAT without an active project', async () => {
      for (const text of ['이 문장 분석해줘', '이 코드 버그 고쳐줘 const a = 1;', '테스트 실행해줘']) {
        const intent = await classifier.classify(msg(text), noProject);
        expect(intent.type, text).toBe(IntentType.CHAT);
        expect(intent.capability, text).toBe(Capability.GENERAL_CHAT);
      }
    });

    it('keeps project routing for project nouns, file paths and /preview', async () => {
      expect((await classifier.classify(msg('이 프로젝트 분석해줘'), noProject)).type).toBe(IntentType.PROJECT_ANALYSIS);
      expect((await classifier.classify(msg('src/app.ts 버그 고쳐줘'), noProject)).type).toBe(IntentType.IMPLEMENT_CODE);
      const preview = await classifier.classify(msg('/preview 로그인 수정'), noProject);
      expect(preview.type).toBe(IntentType.IMPLEMENT_CODE);
      expect(preview.raw).toEqual({ kind: 'preview' });
    });

    it('keeps project routing for English/Korean project nouns with no project', async () => {
      for (const text of ['analyze this project', '이 레포 분석해줘']) {
        expect((await classifier.classify(msg(text), noProject)).type).toBe(IntentType.PROJECT_ANALYSIS);
      }
    });

    it('does not register a single-segment path, but accepts "경로:/a/b"', async () => {
      expect((await classifier.classify(msg('/tmp 등록해줘'), noProject)).type).not.toBe(IntentType.REGISTER_PROJECT);
      expect((await classifier.classify(msg('경로:/Users/me/repo 등록해줘'))).type).toBe(IntentType.REGISTER_PROJECT);
    });

    it('pins bare test-command routing: RUN_TESTS context-free, GENERAL_CHAT with no project', async () => {
      expect((await classifier.classify(msg('pnpm test 실행해줘'))).type).toBe(IntentType.RUN_TESTS);
      expect((await classifier.classify(msg('pnpm test 실행해줘'), noProject)).type).toBe(IntentType.CHAT);
    });

    it('does not read slashes, relative imports or method calls in snippets as file paths', async () => {
      for (const text of [
        '이 코드 버그 고쳐줘 const r = await response.json();',
        "이 코드 버그 고쳐줘 import { a } from './utils';",
        '이 코드 버그 고쳐줘 const avg = total/count;',
        'A/B 테스트 결과 분석해줘',
        'UI/UX 트렌드 분석해줘',
      ]) {
        const intent = await classifier.classify(msg(text), noProject);
        expect(intent.type, text).toBe(IntentType.CHAT);
      }
    });

    it('keeps routing for real paths and plural project nouns', async () => {
      expect((await classifier.classify(msg('./src/app.ts 버그 고쳐줘'), noProject)).type).toBe(IntentType.IMPLEMENT_CODE);
      expect((await classifier.classify(msg('packages/core/src 분석해줘'), noProject)).type).toBe(IntentType.PROJECT_ANALYSIS);
      for (const text of ['analyze these projects', 'check my repos and analyze them']) {
        expect((await classifier.classify(msg(text), noProject)).type, text).toBe(IntentType.PROJECT_ANALYSIS);
      }
    });

    it('downgraded intent has the plain chat shape', async () => {
      const intent = await classifier.classify(msg('  이 문장 분석해줘  '), noProject);
      expect(intent.requiresWork).toBe(true);
      expect(intent.summary).toBe('이 문장 분석해줘');
      expect(intent.raw).toBeUndefined();
    });

    it('hasActiveProject=true keeps bare IMPLEMENT_CODE and RUN_TESTS routing', async () => {
      const active = { hasActiveProject: true };
      expect((await classifier.classify(msg('이 코드 버그 고쳐줘 const a = 1;'), active)).type).toBe(IntentType.IMPLEMENT_CODE);
      expect((await classifier.classify(msg('pnpm test 실행해줘'), active)).type).toBe(IntentType.RUN_TESTS);
    });

    it('pins path extraction: "~/code/repo" is not registered, a trailing slash is trimmed', async () => {
      expect((await classifier.classify(msg('~/code/repo 등록해줘'))).type).toBe(IntentType.CHAT);
      const intent = await classifier.classify(msg('/Users/me/repo/ 등록해줘'));
      expect(intent.type).toBe(IntentType.REGISTER_PROJECT);
      expect(intent.raw).toEqual({ path: '/Users/me/repo' });
    });

    it('omitted ctx or hasActiveProject=true keeps the context-free behavior', async () => {
      for (const ctx of [undefined, {}, { hasActiveProject: true }]) {
        expect((await classifier.classify(msg('이 문장 분석해줘'), ctx)).type).toBe(IntentType.PROJECT_ANALYSIS);
      }
    });
  });
});

describe('IntentClassifier — non-absolute project registration (QA-015)', () => {
  const noProject = { hasActiveProject: false };

  it.each([
    ['이 프로젝트 등록해줘: ../../etc', '../../etc'],
    ['이 프로젝트 등록해줘: ./my-repo', './my-repo'],
    ['이 프로젝트 등록해줘: ~/code/my-repo', '~/code/my-repo'],
    ['이 저장소 등록해줘 my-org/my-repo', 'my-org/my-repo'],
    ['register this repo: ../repo', '../repo'],
  ])('"%s" is a REGISTER_PROJECT request without a registrable path', async (text, path) => {
    const intent = await classifier.classify(msg(text), noProject);
    expect(intent.type).toBe(IntentType.REGISTER_PROJECT);
    expect(intent.raw).toEqual({ kind: NON_ABSOLUTE_REGISTRATION_KIND });
    expect(intent.raw?.path).toBeUndefined(); // nothing for ProjectManager to resolve against the cwd
    expect(detectProjectRegistration(text)).toEqual({ path, absolute: false });
  });

  it.each([
    '7/3 회의 등록해줘', // T2: no project noun, date is not a path
    '~/code/repo 등록해줘', // the only "repo" is inside the path — not a project noun
    '프로젝트 등록/삭제 방법 알려줘', // prose with a slash is not a path
    '프로젝트 등록하는 방법 알려줘', // no path at all
    '7/3 프로젝트 회의 등록해줘', // digits-only slash token is a date
  ])('"%s" is not a project registration', async (text) => {
    expect((await classifier.classify(msg(text), noProject)).type).not.toBe(IntentType.REGISTER_PROJECT);
    expect(detectProjectRegistration(text)).toBeNull();
  });

  it('an absolute path still registers exactly as before', async () => {
    const intent = await classifier.classify(msg('이 프로젝트 등록해줘: /Users/me/my-repo'), noProject);
    expect(intent.type).toBe(IntentType.REGISTER_PROJECT);
    expect(intent.raw).toEqual({ path: '/Users/me/my-repo' });
  });
});
