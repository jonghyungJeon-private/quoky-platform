import { describe, expect, it } from 'vitest';
import { Capability, SessionStatus } from '@quoky/core';
import type { Actor, InboundMessage, Session, TurnHandlerContext } from '@quoky/core';
import {
  MODEL_LISTING_TTL_MS,
  MODEL_SELECTION_COPY,
  MODEL_SELECTION_HELP_LINES,
  MODEL_SELECTION_TURN_HANDLER_ORDER,
  ModelSelectionTurnHandler,
} from './model-command-turn-handler';
import { SESSION_SELECTION_METADATA_KEY } from './provider-selection-service';
import { TEST_OWNER, replyText, selectionFixture } from './test-support';
import type { SelectionFixture } from './test-support';

const ACTOR = 'actor-owner';
const scope = (session: { readonly id: string }) => ({ sessionId: session.id, actorId: ACTOR });

/**
 * The owner's model command (ADR-0092 amendment, runtime switching): every form, list numbering and its 30-minute
 * window, refusals, the owner check, the session-only scope (a new conversation has no override) and field-scoped
 * session saves. No provider is executed by any command.
 */

const T0 = '2026-10-07T01:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function harness(env: Record<string, string> = { QUOKY_CHAT_PROVIDER: 'claude' }, present: string[] = ['codex', 'ollama']) {
  const f = selectionFixture({ env: { OLLAMA_MODEL: 'llama3.1', ...env }, present });
  const handler = new ModelSelectionTurnHandler({ service: f.service, ownerIds: [TEST_OWNER] });
  const actor: Actor = { id: 'actor-owner', displayName: 'owner', createdAt: T0 } as unknown as Actor;
  async function say(session: Session, text: string, now = T0, userId = TEST_OWNER) {
    const message: InboundMessage = {
      id: `m-${Math.random()}`,
      context: { ...session.context, userId },
      text,
      receivedAt: now,
    };
    const live = f.rows.get(session.id) ?? session;
    const ctx: TurnHandlerContext = {
      message,
      session: live,
      actor,
      now,
      applyAnchor: null,
      resolveActiveWorkspace: async () => null,
    };
    return handler.handle(ctx);
  }
  return { f, handler, say };
}

/** The calling Actor's own entry (overrides are keyed by Session and Actor). */
const overrideOf = (f: SelectionFixture, sessionId: string, actorId: string = ACTOR) =>
  (f.rows.get(sessionId)?.metadata?.[SESSION_SELECTION_METADATA_KEY] as { byActor?: Record<string, unknown> } | undefined)?.byActor?.[actorId];

describe('registration facts', () => {
  it('is a pre-classify handler at order 70 with one bounded help line', () => {
    const { handler } = harness();
    expect(handler.id).toBe('model-selection');
    expect(handler.stage).toBe('pre-classify');
    expect(handler.order).toBe(MODEL_SELECTION_TURN_HANDLER_ORDER);
    expect(MODEL_SELECTION_HELP_LINES).toHaveLength(1);
    expect(Array.from(MODEL_SELECTION_HELP_LINES[0] as string).length).toBeLessThanOrEqual(120);
  });

  it('falls through for anything that is not a model command', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    for (const text of ['모델 변경해야 할까?', '안녕', 'codex로 바꿔줘', '모델 상태가 궁금해']) {
      expect(await say(session, text), text).toBeNull();
    }
  });
});

describe('모델 상태 / 모델 목록', () => {
  it('status shows the effective chat and image selection, source, readiness and egress', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' });
    const session = await f.openSession();
    for (const text of ['모델 상태', '/model status']) {
      const reply = replyText(await say(session, text));
      expect(reply).toContain('- 대화: claude:sonnet · 출처: 설정(QUOKY_CHAT_PROVIDER) · 준비됨 · 클라우드(Anthropic으로 전송)');
      expect(reply).toContain('- 이미지: claude · 출처: 설정(QUOKY_IMAGE_UNDERSTANDING_PROVIDER) · 준비됨 · 클라우드(이미지가 Anthropic으로 전송돼요)');
      expect(reply).toContain('코드 작업·리뷰·계획·민감한 대화는 항상 claude:sonnet가 맡아요.');
    }
    expect(f.executed).toEqual([]);
  });

  it('status tells the truth when the chosen provider is not ready (Claude answers instead)', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    await say(session, '모델 변경: codex');
    f.ready.set('codex-cli', false);
    const reply = replyText(await say(session, '모델 상태'));
    expect(reply).toContain('- 대화: codex · 출처: 이 대화에서 변경 · 준비 안 됨');
    expect(reply).toContain('codex가 준비되지 않아 지금은 claude:sonnet가 대신 답해요.');
  });

  it('list numbers every chat-tier option and image option with readiness, marking the current ones', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' });
    const session = await f.openSession();
    const reply = replyText(await say(session, '모델 목록'));
    expect(reply.split('\n')).toEqual([
      '고를 수 있는 모델이에요 (번호는 30분 동안 이 대화에서 쓸 수 있어요).',
      '대화:',
      '1. claude:sonnet · 준비됨 · 클라우드(Anthropic) · 현재',
      '2. claude:opus · 준비됨 · 클라우드(Anthropic)',
      '3. claude:haiku · 준비됨 · 클라우드(Anthropic)',
      '4. codex · 준비됨 · 클라우드(OpenAI)',
      '5. ollama:llama3.1 · 준비됨 · 로컬',
      '6. ollama:granite3.3:8b · 준비됨 · 로컬',
      '이미지:',
      '7. 이미지 claude · 준비됨 · 클라우드(Anthropic) · 현재',
      '8. 이미지 codex · 준비됨 · 클라우드(OpenAI)',
      '9. 이미지 off · 사용 안 함',
      '바꾸려면 "모델 변경: 2" 또는 "/model codex"처럼 보내 주세요. 이 대화에서만 적용돼요 (기본값은 운영 화면에서).',
    ]);
    expect(replyText(await say(session, '/model'))).toBe(reply);
    expect(f.executed).toEqual([]);
  });
});

describe('모델 변경 (session only)', () => {
  it.each([
    ['모델 변경: codex', 'codex', { provider: 'codex' }],
    ['/model codex', 'codex', { provider: 'codex' }],
    ['/model claude:opus', 'claude:opus', { provider: 'claude', model: 'opus' }],
    ['모델 변경: claude:haiku', 'claude:haiku', { provider: 'claude', model: 'haiku' }],
    ['/model ollama:granite3.3:8b', 'ollama:granite3.3:8b', { provider: 'ollama', model: 'granite3.3:8b' }],
    ['모델 변경: ollama', 'ollama:llama3.1', { provider: 'ollama' }],
  ])('%s sets this session only and confirms the scope', async (text, label, stored) => {
    const { f, say } = harness();
    const session = await f.openSession();
    const other = await f.openSession();
    const reply = replyText(await say(session, text));
    expect(reply).toContain(`이 대화의 대화 모델을 ${label}로 바꿨어요. 이 대화에서만 적용돼요 (기본값은 운영 화면에서).`);
    expect(overrideOf(f, session.id)).toEqual({ chat: stored, setAt: '2026-10-07T01:00:00.000Z' });
    expect(overrideOf(f, other.id)).toBeUndefined();
    // The global default never changes from chat.
    expect(f.store.get()).toEqual({});
    expect((await f.router.select(Capability.GENERAL_CHAT, { sessionId: other.id, actorId: ACTOR })).id).toBe('claude-cli');
  });

  it('names the egress truthfully', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    expect(replyText(await say(session, '모델 변경: codex'))).toContain('대화 내용이 OpenAI로 전송돼요.');
    expect(replyText(await say(session, '모델 변경: ollama:granite3.3:8b'))).toContain('대화 내용은 이 컴퓨터를 떠나지 않아요.');
    expect(replyText(await say(session, '모델 변경: claude'))).toContain('대화 내용이 Anthropic로 전송돼요.');
  });

  it('numbers refer to the last list of THIS conversation and expire after 30 minutes', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    const other = await f.openSession();
    expect(replyText(await say(session, '모델 변경: 2'))).toBe(MODEL_SELECTION_COPY.listFirst);
    await say(session, '모델 목록');
    expect(replyText(await say(other, '모델 변경: 2'))).toBe(MODEL_SELECTION_COPY.listFirst);
    expect(replyText(await say(session, '모델 변경: 2', at(MODEL_LISTING_TTL_MS)))).toContain('claude:opus로 바꿨어요');
    expect(replyText(await say(session, '모델 변경: 99', at(MODEL_LISTING_TTL_MS)))).toBe(MODEL_SELECTION_COPY.numberNotListed);
    expect(replyText(await say(session, '모델 변경: 4', at(MODEL_LISTING_TTL_MS + 1)))).toBe(MODEL_SELECTION_COPY.listFirst);
    expect(overrideOf(f, session.id)).toMatchObject({ chat: { provider: 'claude', model: 'opus' } });
  });

  it('a listed image number sets the image override; an image command refuses a chat number', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'claude' });
    const session = await f.openSession();
    await say(session, '모델 목록');
    expect(replyText(await say(session, '이미지 모델 변경: 2'))).toBe(MODEL_SELECTION_COPY.numberIsChat);
    expect(replyText(await say(session, '모델 변경: 9'))).toContain('이 대화의 이미지 모델을 off로 바꿨어요.');
    expect(replyText(await say(session, '모델 변경: 8'))).toContain('이 대화의 이미지 모델을 codex로 바꿨어요.');
    expect(overrideOf(f, session.id)).toMatchObject({ image: 'codex' });
    await say(session, '이미지 모델 변경: off');
    expect(overrideOf(f, session.id)).toMatchObject({ image: 'off' });
  });

  it('a listed Ollama model removed since the listing is refused at selection time', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    await say(session, '모델 목록');
    f.inventory = { status: 'OK', models: ['llama3.1:latest'] };
    expect(replyText(await say(session, '모델 변경: 6'))).toContain('로컬 Ollama에 그 모델이 없어요.');
    expect(overrideOf(f, session.id)).toBeUndefined();
  });

  it.each([
    ['모델 변경: gpt', '모르는 모델이에요.'],
    ['/model claude:claude-3-opus', 'Claude 모델은 sonnet, opus, haiku 중에서만'],
    ['/model codex:gpt-5', 'Codex 모델은 설정(QUOKY_CODEX_MODEL)으로만'],
    ['/model ollama:mistral', '로컬 Ollama에 그 모델이 없어요.'],
    ['모델 변경: claude opus', '모델 명령은 이렇게 써요'],
    ['/model a b c', '모델 명령은 이렇게 써요'],
    ['이미지 모델 변경: gpt', '이미지 모델은 claude, codex, ollama, openai, off 중에서'],
    ['이미지 모델 변경: codex:gpt-5', '이미지 모델은 claude, codex, ollama, openai, off 중에서'],
    ['이미지 모델 변경: ollama', 'QUOKY_OLLAMA_VISION_MODEL이 필요해요'],
  ])('refuses %s truthfully and changes nothing', async (text, expected) => {
    const { f, say } = harness();
    const session = await f.openSession();
    expect(replyText(await say(session, text))).toContain(expected);
    expect(overrideOf(f, session.id)).toBeUndefined();
  });

  it('a provider that cannot run on this host is refused', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude' }, []);
    const session = await f.openSession();
    expect(replyText(await say(session, '모델 변경: codex'))).toContain('그 모델은 이 컴퓨터에서 쓸 수 없어요');
    expect(replyText(await say(session, '모델 변경: ollama:granite3.3:8b'))).toContain('그 모델은 이 컴퓨터에서 쓸 수 없어요');
  });

  it('Ollama not answering is refused (nothing changes)', async () => {
    const { f, say } = harness();
    f.inventory = { status: 'UNAVAILABLE' };
    const session = await f.openSession();
    expect(replyText(await say(session, '/model ollama:granite3.3:8b'))).toContain('Ollama가 응답하지 않아');
  });

  it('image overrides: claude warns about egress, ollama is local, off stops analysis', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' });
    const session = await f.openSession();
    expect(replyText(await say(session, '이미지 모델 변경: claude'))).toContain('이미지가 Anthropic으로 전송돼요.');
    expect(await f.service.imageLocalities({ sessionId: session.id, actorId: ACTOR })).toEqual(['LOCAL', 'REMOTE']);
    expect(replyText(await say(session, '/model image ollama'))).toContain('이미지는 이 컴퓨터를 떠나지 않아요.');
    expect(await f.service.imageLocalities({ sessionId: session.id, actorId: ACTOR })).toEqual(['LOCAL']);
    expect(replyText(await say(session, '이미지 모델 변경: off'))).toContain('이 대화에서는 이미지를 분석하지 않아요.');
    expect(overrideOf(f, session.id)).toMatchObject({ image: 'off' });
  });

  it('image override codex (ADR-0111 amendment 2026-10-08): warns that images go to OpenAI and opens REMOTE for this conversation only', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' });
    const session = await f.openSession();
    const ctx = { sessionId: session.id, actorId: ACTOR };
    expect(replyText(await say(session, '이미지 모델 변경: codex'))).toBe(
      '이 대화의 이미지 모델을 codex로 바꿨어요. 이 대화에서만 적용돼요 (기본값은 운영 화면에서). 이미지가 OpenAI로 전송돼요.',
    );
    expect(overrideOf(f, session.id)).toMatchObject({ image: 'codex' });
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL', 'REMOTE']);
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL']);
    expect(replyText(await say(session, '모델 상태'))).toContain(
      '- 이미지: codex · 출처: 이 대화에서 변경 · 준비됨 · 클라우드(이미지가 OpenAI로 전송돼요)',
    );
    expect(replyText(await say(session, '/model image ollama'))).toContain('이미지는 이 컴퓨터를 떠나지 않아요.');
    expect(await f.service.imageLocalities(ctx)).toEqual(['LOCAL']);
    expect(f.executed).toEqual([]);
  });

  it('image override codex is refused when the Codex CLI is not on this host', async () => {
    const { f, say } = harness({ QUOKY_CHAT_PROVIDER: 'claude' }, []);
    const session = await f.openSession();
    expect(replyText(await say(session, '이미지 모델 변경: codex'))).toContain('codex는 Codex CLI');
    expect(overrideOf(f, session.id)).toBeUndefined();
  });
});

describe('모델 기본값으로 / reset, new conversation and owner check', () => {
  it('reset clears chat and image overrides; the image-only reset keeps the chat override', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    await say(session, '모델 변경: codex');
    await say(session, '이미지 모델 변경: off');
    expect(replyText(await say(session, '이미지 모델 기본값으로'))).toContain('이 대화의 이미지 모델 선택을 지웠어요.');
    expect(overrideOf(f, session.id)).toMatchObject({ chat: { provider: 'codex' } });
    expect(replyText(await say(session, '/model reset'))).toContain('이 대화의 모델 선택을 지웠어요. 이제 기본값(대화 claude:sonnet, 이미지 off)을 써요.');
    expect(overrideOf(f, session.id)).toBeUndefined();
    expect(replyText(await say(session, '모델 기본값으로'))).toContain('이 대화에는 따로 바꾼 모델 선택이 없어요.');
  });

  it('새 대화 (a closed session) ends the override: the next conversation starts from the default', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    await say(session, '모델 변경: codex');
    expect((await f.router.select(Capability.GENERAL_CHAT, { sessionId: session.id, actorId: ACTOR })).id).toBe('codex-cli');
    await f.sessions.close(f.rows.get(session.id) as Session);
    expect(f.rows.get(session.id)?.status).toBe(SessionStatus.CLOSED);
    expect((await f.router.select(Capability.GENERAL_CHAT, { sessionId: session.id, actorId: ACTOR })).id).toBe('claude-cli');
    const next = await f.openSession();
    expect((await f.router.select(Capability.GENERAL_CHAT, { sessionId: next.id, actorId: ACTOR })).id).toBe('claude-cli');
    // A command against the closed session changes nothing.
    expect(replyText(await say(session, '모델 변경: codex'))).toBe(MODEL_SELECTION_COPY.sessionGone);
  });

  it('in a shared channel Session each owner Actor sees and changes only its own override (both directions)', async () => {
    const { f, handler } = harness();
    const shared = await f.openSession();
    const turn = (actorId: string, text: string) =>
      handler.handle({
        message: { id: `m-${actorId}-${text}`, context: shared.context, text, receivedAt: T0 },
        session: f.rows.get(shared.id) as Session,
        actor: { id: actorId } as unknown as Actor,
        now: T0,
        applyAnchor: null,
        resolveActiveWorkspace: async () => null,
      });
    await turn('actor-a', '모델 변경: codex');
    expect(replyText(await turn('actor-b', '모델 상태'))).toContain('- 대화: claude:sonnet · 출처: 설정(QUOKY_CHAT_PROVIDER)');
    await turn('actor-b', '/model claude:opus');
    expect(overrideOf(f, shared.id, 'actor-a')).toMatchObject({ chat: { provider: 'codex' } });
    expect(overrideOf(f, shared.id, 'actor-b')).toMatchObject({ chat: { provider: 'claude', model: 'opus' } });
    expect(replyText(await turn('actor-a', '모델 상태'))).toContain('- 대화: codex · 출처: 이 대화에서 변경');
    // A's listing numbers never resolve for B, and A's reset never clears B's.
    await turn('actor-a', '모델 목록');
    expect(replyText(await turn('actor-b', '모델 변경: 1'))).toBe(MODEL_SELECTION_COPY.listFirst);
    await turn('actor-a', '모델 기본값으로');
    expect(overrideOf(f, shared.id, 'actor-a')).toBeUndefined();
    expect(overrideOf(f, shared.id, 'actor-b')).toMatchObject({ chat: { provider: 'claude', model: 'opus' } });
  });

  it('a non-owner changes nothing and sees nothing', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    for (const text of ['모델 변경: codex', '모델 상태', '모델 목록', '/model reset']) {
      expect(replyText(await say(session, text, T0, '999999999999999999'))).toBe(MODEL_SELECTION_COPY.notOwner);
    }
    expect(overrideOf(f, session.id)).toBeUndefined();
  });

  it('saves only the override key, field-scoped on the live row (another writer\'s fields survive)', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    // Another writer moved the live row on (a task pointer, another metadata key) after this turn's snapshot was taken.
    f.rows.set(session.id, { ...session, activeTaskId: 'task-9', metadata: { other: true } });
    await say(session, '모델 변경: codex');
    expect(f.rows.get(session.id)).toMatchObject({
      activeTaskId: 'task-9',
      metadata: { other: true, [SESSION_SELECTION_METADATA_KEY]: { byActor: { [ACTOR]: { chat: { provider: 'codex' } } } } },
    });
  });

  it('a failing store answers with fixed copy and never throws', async () => {
    const { f, say } = harness();
    const session = await f.openSession();
    (f.service as unknown as { status: () => Promise<never> }).status = async () => {
      throw new Error('boom');
    };
    const outcome = await say(session, '모델 상태');
    expect(replyText(outcome)).toBe(MODEL_SELECTION_COPY.failed);
    expect(outcome?.status).toBe('FAILED');
  });
});
