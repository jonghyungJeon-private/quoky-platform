import { describe, expect, it } from 'vitest';
import type { NotificationSinkOutcome, OwnerNotification } from '@quoky/core';
import { selectionFixture, TEST_OWNER } from '../../provider-selection/test-support';
import { OPS_CLOUD_IMAGE_WARNING, OpsProviderSelectionActions, providerDefaultNoticeText } from './provider-selection-actions';
import type { OpsOwnerResolution } from '../snapshot/build-snapshot';

const ACTOR = 'actor-owner';
const scope = (session: { readonly id: string }) => ({ sessionId: session.id, actorId: ACTOR });

/**
 * Runtime model switch, operations-UI side (ADR-0092 / ADR-0111 amendments; ADR-0113 D7 rules): owner only, through the
 * same `ProviderSelectionService` as chat, validated again at execution, persisted (the default only), audited, and
 * announced once to the owner DM as `OPS_DECISION_RESULT`.
 */

function actions(options: { owner?: OpsOwnerResolution; deliver?: NotificationSinkOutcome | 'throw'; env?: Record<string, string>; present?: string[] } = {}) {
  const f = selectionFixture({
    env: options.env ?? { QUOKY_CHAT_PROVIDER: 'claude', QUOKY_IMAGE_UNDERSTANDING_PROVIDER: 'off', QUOKY_OLLAMA_VISION_MODEL: 'gemma3:4b' },
    present: options.present ?? ['codex', 'ollama'],
  });
  const delivered: OwnerNotification[] = [];
  const logs: Array<[string, unknown]> = [];
  const ops = new OpsProviderSelectionActions({
    service: f.service,
    owner: async () => options.owner ?? { status: 'RESOLVED', actorId: 'actor-owner' },
    notice: {
      platform: 'discord',
      userId: TEST_OWNER,
      notify: async (notification) => {
        delivered.push(notification);
        if (options.deliver === 'throw') throw new Error('gateway down');
        return options.deliver ?? { status: 'SENT', via: 'DM' };
      },
    },
    clock: () => '2026-10-07T02:00:00.000Z',
    logger: { info: (event, fields) => logs.push([event, fields]), warn: (event, fields) => logs.push([event, fields]) },
  });
  return { f, ops, delivered, logs };
}

describe('OpsProviderSelectionActions.page', () => {
  it('shows the effective defaults with sources and readiness, every option with egress, and the cloud image warning', async () => {
    const { ops, f } = actions();
    f.ready.set('codex-cli', false);
    const page = await ops.page();
    if (page.status !== 'OK') throw new Error('refused');
    expect(page.chat).toMatchObject({ effective: 'claude:sonnet', source: '설정 QUOKY_CHAT_PROVIDER', readiness: '준비됨' });
    expect(page.chat.options.map((o) => [o.subject, o.readiness, o.egress, o.current])).toEqual([
      ['chat:claude:sonnet', '준비됨', '클라우드 (Anthropic으로 전송)', true],
      ['chat:claude:opus', '준비됨', '클라우드 (Anthropic으로 전송)', false],
      ['chat:claude:haiku', '준비됨', '클라우드 (Anthropic으로 전송)', false],
      ['chat:codex', '준비 안 됨', '클라우드 (OpenAI로 전송)', false],
      ['chat:ollama:llama3.1:latest', '준비됨', '로컬 (이 컴퓨터를 떠나지 않아요)', false],
      ['chat:ollama:granite3.3:8b', '준비됨', '로컬 (이 컴퓨터를 떠나지 않아요)', false],
    ]);
    expect(page.chat.reset).toBeUndefined();
    expect(page.image).toMatchObject({ effective: 'off', source: '설정 QUOKY_IMAGE_UNDERSTANDING_PROVIDER' });
    expect(page.image.options.map((o) => [o.subject, o.current, o.warning])).toEqual([
      ['image:claude', false, OPS_CLOUD_IMAGE_WARNING],
      ['image:ollama', false, undefined],
      ['image:off', true, undefined],
    ]);
    expect(page.sessionOverrides).toBe('0개');
  });

  it('offers the reset only while an operations-UI default is stored', async () => {
    const { ops } = actions();
    await ops.setDefault('chat:codex');
    const page = await ops.page();
    if (page.status !== 'OK') throw new Error('refused');
    expect(page.chat.reset?.subject).toBe('chat:reset');
    expect(page.chat.source).toBe('운영 화면 기본값 (다시 시작해도 유지)');
    expect(page.image.reset).toBeUndefined();
  });

  it('is refused (fail closed) unless the owner ids map to exactly one Actor', async () => {
    for (const status of ['NONE', 'AMBIGUOUS'] as const) {
      const { ops } = actions({ owner: { status } });
      expect(await ops.page()).toMatchObject({ status: 'REFUSED', outcome: { code: 'ACTIONS_DISABLED' } });
      expect(await ops.setDefault('chat:codex')).toMatchObject({ code: 'ACTIONS_DISABLED', ok: false });
    }
  });
});

describe('OpsProviderSelectionActions.setDefault', () => {
  it('sets the persisted chat default, audits it, applies it at once and sends one owner DM', async () => {
    const { ops, f, delivered, logs } = actions();
    const outcome = await ops.setDefault('chat:codex');
    expect(outcome).toEqual({ code: 'DEFAULT_SET', message: '대화 모델 기본값을 codex로 바꿨어요. DM으로 알렸어요.', ok: true });
    expect(f.store.get().chat).toEqual({ provider: 'codex' });
    expect((await f.router.select('GENERAL_CHAT' as never)).id).toBe('codex-cli');
    expect(delivered).toEqual([
      {
        correlationId: `ops-provider-default-chat-${Date.parse('2026-10-07T02:00:00.000Z')}`,
        target: { platform: 'discord', channelId: '', userId: TEST_OWNER },
        kind: 'OPS_DECISION_RESULT',
        text: '[Quoky 운영 화면] 운영 화면에서 대화 모델을 codex로 바꿨어요. 채팅에서 따로 바꾸지 않은 대화에 바로 적용돼요.',
      },
    ]);
    expect(f.logs.find((l) => l.message === 'provider.selection.changed')?.fields).toEqual({
      surface: 'ops-ui', actor: 'actor-owner', scope: 'default', tier: 'chat', selection: 'codex',
    });
    expect(logs).toContainEqual(['ops-ui.provider_default_notice', { surface: 'ops-ui', tier: 'chat', delivery: 'SENT' }]);
  });

  it('never touches a conversation\'s own override', async () => {
    const { ops, f } = actions();
    const session = await f.openSession();
    await f.service.setSessionChat(scope(session), { provider: 'claude', model: 'opus' }, { surface: 'chat', actor: 'actor-owner' });
    await ops.setDefault('chat:codex');
    expect(await f.service.effectiveChat(scope(session))).toMatchObject({ label: 'claude:opus', source: 'session' });
    const page = await ops.page();
    expect(page.status === 'OK' && page.sessionOverrides).toBe('1개');
  });

  it('image: choosing claude opens REMOTE at once and says images leave the host; reset restores the configuration', async () => {
    const { ops, f, delivered } = actions();
    // QUOKY_IMAGE_UNDERSTANDING_PROVIDER=off is an explicit default `off`: no locality at all, with the way back on.
    expect(await f.service.imageLocalities({})).toEqual({
      allowedLocalities: [],
      switchedOff: { scope: 'DEFAULT', choices: ['claude', 'ollama'], resetRestores: false },
    });
    expect((await ops.setDefault('image:claude')).code).toBe('DEFAULT_SET');
    expect(await f.service.imageLocalities({})).toEqual(['LOCAL', 'REMOTE']);
    expect(delivered.at(-1)?.text).toBe(providerDefaultNoticeText('image', 'claude', false));
    expect(delivered.at(-1)?.text).toContain('이제 첨부 이미지가 Anthropic으로 전송돼요.');
    const reset = await ops.setDefault('image:reset');
    expect(reset).toMatchObject({ code: 'DEFAULT_RESET', ok: true });
    expect(reset.message).toContain('이미지 모델 기본값을 설정값(off)으로 되돌렸어요.');
    expect(await f.service.imageLocalities({})).toMatchObject({ allowedLocalities: [] });
    expect(f.store.get().image).toBeUndefined();
  });

  it('chat reset returns to the env selection', async () => {
    const { ops, f, delivered } = actions();
    await ops.setDefault('chat:ollama:granite3.3:8b');
    expect(f.store.get().chat).toEqual({ provider: 'ollama', model: 'granite3.3:8b' });
    expect((await ops.setDefault('chat:reset')).message).toContain('대화 모델 기본값을 설정값(claude:sonnet)으로 되돌렸어요.');
    expect(delivered.at(-1)?.text).toBe('[Quoky 운영 화면] 운영 화면에서 대화 모델을 설정 기본값(claude:sonnet)으로 되돌렸어요. 채팅에서 따로 바꾸지 않은 대화에 바로 적용돼요.');
  });

  it.each([
    ['chat:gpt', 'INVALID_OPTION'],
    ['chat:claude:claude-3-opus', 'INVALID_OPTION'],
    ['chat:ollama:mistral', 'OLLAMA_MODEL_NOT_FOUND'],
    ['image:codex', 'INVALID_OPTION'],
    ['other:codex', 'INVALID_OPTION'],
    ['', 'INVALID_OPTION'],
  ])('validates %s again at execution (%s) and changes nothing', async (subject, code) => {
    const { ops, f, delivered } = actions();
    expect(await ops.setDefault(subject)).toMatchObject({ code, ok: false });
    expect(f.store.get()).toEqual({});
    expect(delivered).toEqual([]);
  });

  it('an installed embedding-only Ollama model is refused at execution and changes nothing', async () => {
    const { ops, f, delivered } = actions();
    f.inventory = { status: 'OK', models: ['granite3.3:8b'], nonChat: ['nomic-embed-text:latest'] };
    expect(await ops.setDefault('chat:ollama:nomic-embed-text:latest')).toMatchObject({ code: 'OLLAMA_MODEL_NOT_CHAT', ok: false });
    expect(f.store.get()).toEqual({});
    expect(delivered).toEqual([]);
  });

  it('a provider that cannot run here is refused', async () => {
    const { ops } = actions({ present: [] });
    expect(await ops.setDefault('chat:codex')).toMatchObject({ code: 'PROVIDER_NOT_ON_HOST', ok: false });
  });

  it('a failed DM notice does not undo the change and is reported by category', async () => {
    for (const deliver of [{ status: 'NOT_SENT', reason: 'DM_CLOSED', retryable: false } as NotificationSinkOutcome, 'throw' as const]) {
      const { ops, f } = actions({ deliver });
      const outcome = await ops.setDefault('chat:codex');
      expect(outcome).toMatchObject({ code: 'DEFAULT_SET', ok: true });
      expect(outcome.message).toContain('DM 알림은 보내지 못했어요.');
      expect(f.store.get().chat).toEqual({ provider: 'codex' });
    }
  });
});
