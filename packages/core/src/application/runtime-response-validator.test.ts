import { describe, expect, it } from 'vitest';
import { Capability, IntentType, RiskLevel, TaskStatus } from '../domain';
import type { ContextBundle, Task } from '../domain';
import {
  ResponseValidationReasonCode,
  RuntimeValidationRule,
  ValidationDisposition,
} from './runtime-response-validation-contracts';
import { RuntimeResponseValidator, projectBoundedProviderOutput } from './runtime-response-validator';
import { PromptComposer } from './prompt-composer';
import { PromptRenderer } from './prompt-renderer';
import { validationProfileId } from './provider-routing-contracts';
import {
  AUTHORITY_SENSITIVE,
  GENERAL_CHAT,
  LOW_RISK_FAST_PATH,
  ValidationProfileRegistry,
  createDefaultValidationProfileRegistry,
} from './validation-profile-registry';

const validator = new RuntimeResponseValidator(createDefaultValidationProfileRegistry());

function validate(
  text: string,
  profile = GENERAL_CHAT,
  prompt = 'Please summarize the public project status.',
  contextCorpus: readonly string[] = [],
  recencyFact?: string,
  currentUserTurn?: string,
) {
  return validator.validate({
    validationProfile: profile,
    prompt,
    ...(recencyFact === undefined ? {} : { recencyFact }),
    ...(currentUserTurn === undefined ? {} : { currentUserTurn }),
    contextCorpus,
    result: { text },
  });
}

describe('RuntimeResponseValidator', () => {
  it('returns a byte-identical frozen result for the same input without copying bodies', () => {
    const input = {
      validationProfile: GENERAL_CHAT,
      prompt: 'raw private prompt that must never be copied',
      contextCorpus: ['raw private context entry that must never be copied'],
      result: {
        text: 'A concise public answer.',
        raw: { stderr: 'secret raw debug' },
        audit: { environment: 'private environment' },
      },
    } as const;
    const first = validator.validate(input);
    const second = validator.validate(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasonCodes)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/raw private|stderr|environment|public answer/);
  });

  it('rejects empty and output-limit violations', () => {
    expect(validate('   ', LOW_RISK_FAST_PATH)).toMatchObject({
      disposition: ValidationDisposition.REJECT,
      reasonCodes: [ResponseValidationReasonCode.EMPTY_OUTPUT],
    });
    const tinyProfile = validationProfileId('TINY_PROFILE');
    const tinyValidator = new RuntimeResponseValidator(
      new ValidationProfileRegistry([
        {
          profileId: tinyProfile,
          version: '1',
          rules: [RuntimeValidationRule.NON_EMPTY, RuntimeValidationRule.OUTPUT_LIMIT],
          outputLimitBytes: 24,
          escalationEnabled: false,
        },
      ]),
    );
    expect(
      tinyValidator.validate({ validationProfile: tinyProfile, prompt: 'short prompt', result: { text: 'too long' } }),
    ).toMatchObject({
      disposition: ValidationDisposition.REJECT,
      reasonCodes: [ResponseValidationReasonCode.OUTPUT_LIMIT_VIOLATION],
    });
  });

  it('rejects prompt leak, multi-entry echo, and secret exposure as safety reasons', () => {
    const leakedPrompt = 'The private instruction contains enough canonical words to exceed the bounded matching window safely.';
    expect(validate(`Prefix: ${leakedPrompt}`, GENERAL_CHAT, leakedPrompt).reasonCodes).toContain(
      ResponseValidationReasonCode.PROMPT_LEAK,
    );

    const corpus = [
      'First protected context entry contains private operational details.',
      'Second protected context entry contains private customer details.',
    ];
    const echo = validate(`Summary: ${corpus.join(' ')}`, GENERAL_CHAT, 'Unrelated short prompt.', corpus);
    expect(echo.disposition).toBe(ValidationDisposition.REJECT);
    expect(echo.reasonCodes).toContain(ResponseValidationReasonCode.MULTI_ENTRY_ECHO);

    const secret = validate('The token is github' + '_pat_abcdefghijklmnop123456.');
    expect(secret.disposition).toBe(ValidationDisposition.REJECT);
    expect(secret.reasonCodes).toContain(ResponseValidationReasonCode.SECRET_EXPOSURE_RISK);
  });

  it('does not flag natural partial prompt reuse below the bounded token-window threshold', () => {
    const prompt =
      'Summarize the public release status, deployment notes, compatibility findings, and remaining follow-up work.';
    const result = validate(
      'The release status is stable, with two follow-up items remaining.',
      GENERAL_CHAT,
      prompt,
    );

    expect(result.disposition).toBe(ValidationDisposition.ACCEPT);
    expect(result.reasonCodes).not.toContain(ResponseValidationReasonCode.PROMPT_LEAK);
  });

  it('accepts a GENERAL_CHAT response grounded in bounded entities from the authoritative recent fact', () => {
    const fact = '내가 가장 좋아하는 음식은 해산물 파스타야.';
    const result = validate(
      '맞아요. 해산물 파스타를 가장 좋아한다고 알려 주셨어요.',
      GENERAL_CHAT,
      'real prompt text is irrelevant to the structured fact',
      [],
      fact,
      '방금 내가 좋아한다고 말한 음식이 뭐였지?',
    );

    expect(result).toMatchObject({ disposition: ValidationDisposition.ACCEPT, reasonCodes: [] });
  });

  it.each([
    '제가 기억한 바로는 가장 좋아하는 음식은 초밥이에요.',
    '해산물 파스타를 좋아하지 않는다고 말했어요.',
  ])('escalates a GENERAL_CHAT response that ignores or contradicts the authoritative recent fact', (text) => {
    const fact = '내가 가장 좋아하는 음식은 해산물 파스타야.';
    const result = validate(
      text,
      GENERAL_CHAT,
      'real prompt text is irrelevant to the structured fact',
      [],
      fact,
      '아까 내가 좋아한다고 말한 음식이 뭐였지?',
    );

    expect(result).toMatchObject({
      disposition: ValidationDisposition.ESCALATE,
      reasonCodes: [ResponseValidationReasonCode.RECENCY_GROUNDING_VIOLATION],
    });
  });

  it('does not activate recency grounding without a structured recency fact', () => {
    expect(validate('An unrelated but otherwise valid answer.')).toMatchObject({
      disposition: ValidationDisposition.ACCEPT,
      reasonCodes: [],
    });
  });

  it('validates structured recency through a real PromptComposer → PromptRenderer prompt', () => {
    const fact = 'The selected release codename is Atlas.';
    const currentUserTurn = 'What codename did I say above?';
    const task: Task = {
      id: 'task-real-prompt',
      title: 'Follow-up',
      description: currentUserTurn,
      status: TaskStatus.PENDING,
      intent: {
        type: IntentType.CHAT,
        capability: Capability.GENERAL_CHAT,
        confidence: 1,
        requiresWork: true,
        summary: currentUserTurn,
      },
      riskLevel: RiskLevel.LOW,
      context: { platform: 'test', channelId: 'channel', userId: 'user' },
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    const bundle: ContextBundle = {
      taskId: task.id,
      conversationTranscript: [
        {
          role: 'user',
          content: fact,
          provenance: 'USER',
          epistemicStatus: 'USER_CLAIM_OR_INTENT',
        },
      ],
      backgroundResources: [],
    };
    const request = new PromptRenderer().render(new PromptComposer().compose(task, bundle), {
      capability: Capability.GENERAL_CHAT,
    });

    expect(request.prompt).not.toContain('immediatelyPreviousUserTurn');
    expect(request.prompt).toContain(fact);
    expect(
      validate(
        'The selected release codename is Zephyr.',
        GENERAL_CHAT,
        request.prompt,
        [],
        fact,
        currentUserTurn,
      ),
    ).toMatchObject({
      disposition: ValidationDisposition.ESCALATE,
      reasonCodes: [ResponseValidationReasonCode.RECENCY_GROUNDING_VIOLATION],
    });
    expect(
      validate(
        'The selected release codename is Atlas.',
        GENERAL_CHAT,
        request.prompt,
        [],
        fact,
        currentUserTurn,
      ),
    ).toMatchObject({
      disposition: ValidationDisposition.ACCEPT,
      reasonCodes: [],
    });
  });

  it.each([
    ['What is the weather tomorrow?', 'It will be sunny tomorrow.'],
    ['안녕하세요', '안녕하세요! 무엇을 도와드릴까요?'],
    ['알겠어요', '좋아요.'],
    ['새 프로젝트의 테스트 전략을 알려줘', '단위 테스트부터 시작하는 것이 좋아요.'],
  ])('accepts an unrelated, greeting, or topic-shift current turn: %s', (currentUserTurn, response) => {
    expect(
      validate(
        response,
        GENERAL_CHAT,
        'prompt text is not parsed',
        [],
        '내가 가장 좋아하는 음식은 해산물 파스타야.',
        currentUserTurn,
      ),
    ).toMatchObject({ disposition: ValidationDisposition.ACCEPT, reasonCodes: [] });
  });

  it('does not treat 안녕하세요 as negated intent', () => {
    expect(
      validate(
        '제 별명은 Atlas예요.',
        GENERAL_CHAT,
        'prompt text is not parsed',
        [],
        '안녕하세요, 제 별명은 Atlas예요.',
        '방금 말한 제 별명이 뭐였지?',
      ),
    ).toMatchObject({ disposition: ValidationDisposition.ACCEPT, reasonCodes: [] });
  });

  it('measures OUTPUT_LIMIT from the complete bounded-output UTF-8 JSON at the exact byte boundary', () => {
    const profileId = validationProfileId('BOUNDARY_PROFILE');
    const result = {
      text: 'Boundary response.',
      artifacts: [
        {
          id: 'artifact-boundary',
          kind: 'DOCUMENT',
          title: 'Boundary artifact',
          content: 'bounded',
          createdAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    } as const;
    const maxOutputBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    const boundaryValidator = new RuntimeResponseValidator(
      new ValidationProfileRegistry([
        {
          profileId,
          version: '1',
          rules: [RuntimeValidationRule.NON_EMPTY, RuntimeValidationRule.OUTPUT_LIMIT],
          outputLimitBytes: maxOutputBytes,
          escalationEnabled: false,
        },
      ]),
    );

    expect(boundaryValidator.validate({ validationProfile: profileId, prompt: 'Unrelated.', result })).toMatchObject({
      disposition: ValidationDisposition.ACCEPT,
      reasonCodes: [],
      byteCount: maxOutputBytes,
    });
    expect(
      boundaryValidator.validate({
        validationProfile: profileId,
        prompt: 'Unrelated.',
        result: {
          ...result,
          artifacts: [{ ...result.artifacts[0], content: `${result.artifacts[0].content}!` }],
        },
      }),
    ).toMatchObject({
      disposition: ValidationDisposition.REJECT,
      reasonCodes: [ResponseValidationReasonCode.OUTPUT_LIMIT_VIOLATION],
      byteCount: maxOutputBytes + 1,
    });
  });

  it('excludes artifact createdAt only from responseSha256 while retaining full-output byteCount', () => {
    const firstResult = {
      text: 'Stable response.',
      artifacts: [
        {
          id: 'artifact-stable',
          kind: 'DOCUMENT',
          title: 'Stable artifact',
          content: 'same content',
          createdAt: '2026-08-02T00:00:00.000Z',
        },
      ],
    } as const;
    const secondResult = {
      ...firstResult,
      artifacts: [{ ...firstResult.artifacts[0], createdAt: '2027-09-03T01:02:03.000Z' }],
    } as const;
    const first = validator.validate({ validationProfile: GENERAL_CHAT, prompt: 'Unrelated.', result: firstResult });
    const second = validator.validate({ validationProfile: GENERAL_CHAT, prompt: 'Unrelated.', result: secondResult });

    expect(first.responseSha256).toBe(second.responseSha256);
    expect(first.byteCount).toBe(Buffer.byteLength(JSON.stringify(firstResult), 'utf8'));
    expect(second.byteCount).toBe(Buffer.byteLength(JSON.stringify(secondResult), 'utf8'));
    expect(projectBoundedProviderOutput(firstResult, first).artifacts[0]?.createdAt).toBe(
      firstResult.artifacts[0].createdAt,
    );
    expect(projectBoundedProviderOutput(secondResult, second).artifacts[0]?.createdAt).toBe(
      secondResult.artifacts[0].createdAt,
    );
  });

  it('allows semantic escalation only for the authority-sensitive profile', () => {
    const claim = 'I verified that the production service is currently healthy.';
    expect(validate(claim, GENERAL_CHAT)).toMatchObject({
      disposition: ValidationDisposition.ACCEPT,
      reasonCodes: [],
    });
    expect(validate(claim, AUTHORITY_SENSITIVE)).toMatchObject({
      disposition: ValidationDisposition.ESCALATE,
      reasonCodes: [ResponseValidationReasonCode.AUTHORITY_SCOPE_VIOLATION],
    });
    expect(validate('I cannot verify whether the production service is currently healthy.', AUTHORITY_SENSITIVE)).toMatchObject({
      disposition: ValidationDisposition.ACCEPT,
      reasonCodes: [],
    });
  });

  it('fails closed with a bounded result when validation cannot process malformed input', () => {
    const result = validator.validate({
      validationProfile: GENERAL_CHAT,
      prompt: 'safe prompt',
      result: { text: null as unknown as string, raw: { stack: 'private stack' } },
    });
    expect(result).toMatchObject({
      disposition: ValidationDisposition.REJECT,
      reasonCodes: [ResponseValidationReasonCode.VALIDATOR_INTERNAL_FAILURE],
    });
    expect(JSON.stringify(result)).not.toMatch(/private stack/);
  });

  it('projects only accepted output and strips raw, audit, uri, and artifact metadata', () => {
    const result = {
      text: 'Validated response.',
      artifacts: [
        {
          id: 'artifact-1',
          kind: 'DOCUMENT',
          title: 'Result',
          content: 'bounded content',
          uri: '/private/runtime/path',
          metadata: { providerDebug: 'secret' },
          createdAt: '2026-08-02T00:00:00.000Z',
        },
      ],
      raw: { stderr: 'private' },
      audit: { environment: 'private' },
    } as const;
    const validation = validator.validate({
      validationProfile: GENERAL_CHAT,
      prompt: 'Short unrelated prompt.',
      result,
    });
    const bounded = projectBoundedProviderOutput(result, validation);

    expect(bounded).toMatchObject({ text: 'Validated response.', artifacts: [{ title: 'Result' }] });
    expect(JSON.stringify(bounded)).not.toMatch(/providerDebug|runtime\/path|stderr|environment/);
    expect(Object.isFrozen(bounded)).toBe(true);
    expect(Object.isFrozen(bounded.artifacts)).toBe(true);
    expect(Object.isFrozen(bounded.artifacts[0])).toBe(true);
    expect(() => projectBoundedProviderOutput({ text: 'changed' }, validation)).toThrow(/does not match/);
  });
});
