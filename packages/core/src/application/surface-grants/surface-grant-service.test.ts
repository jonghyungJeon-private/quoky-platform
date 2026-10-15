import { describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, Id, InboundMessage } from '../../domain';
import type { OwnerNotification } from '../../ports/notification-sink.port';
import { KeyedMutex } from '../../util/keyed-mutex';
import { ActorMetadataStore } from '../actor-metadata-store';
import { ACTION_SWITCH_METADATA_KEY, readActionSwitch } from '../nl-routing/action-switch';
import { decideSurface } from './surface-gate';
import { SURFACE_GRANTS_METADATA_KEY, grantedSurfaceGroups, readSurfaceGrants, surfaceChannelKey } from './surface-grant-record';
import { SurfaceGrantService } from './surface-grant-service';

// ADR-0122 D3/D4/D6 (P1): the owner's list / revoke phrases, the owner check, receipts, the kill switch and the seed.

const T0 = '2026-10-15T09:00:00.000Z';
const OWNER_ID = '700000';
const CHANNEL: ConversationContext = { platform: 'discord', spaceId: '1520835639103324181', channelId: '1520835639904309350', userId: OWNER_ID, direct: false };
const OTHER: ConversationContext = { ...CHANNEL, channelId: '1520835639904309351' };
const DM: ConversationContext = { platform: 'discord', channelId: '900000', userId: OWNER_ID, direct: true };
const SEED = { channels: [{ key: surfaceChannelKey(CHANNEL), groups: ['jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code'] as const }] };

function world() {
  let actor: Actor = { id: 'owner', displayName: 'o', identities: [{ platform: 'discord', externalId: OWNER_ID }], createdAt: T0 };
  const logs: Array<[string, Record<string, string>]> = [];
  const receipts: OwnerNotification[] = [];
  const repo = {
    async get(id: Id) {
      return id === actor.id ? structuredClone(actor) : null;
    },
    async save(next: Actor) {
      actor = structuredClone(next);
      return next;
    },
  };
  const service = new SurfaceGrantService({
    metadata: new ActorMetadataStore(repo, new KeyedMutex()),
    isOwner: (who, context) => who.identities.some((identity) => identity.platform === context.platform && identity.externalId === context.userId) && context.userId === OWNER_ID,
    logger: { info: (event, fields) => logs.push([event, (fields ?? {}) as Record<string, string>]), warn: (event, fields) => logs.push([event, (fields ?? {}) as Record<string, string>]) },
    notify: async (notification) => {
      receipts.push(notification);
      return { status: 'SENT', via: 'DM' };
    },
  });
  let seq = 0;
  const say = (context: ConversationContext, text: string): Promise<string | undefined> => {
    seq += 1;
    const message: InboundMessage = { id: `m${seq}`, context, text, receivedAt: T0 };
    return service.handlePhrase(message, actor, T0);
  };
  return {
    service,
    say,
    actor: () => actor,
    logs,
    receipts,
    granted: (context = CHANNEL) => grantedSurfaceGroups(readSurfaceGrants(actor.metadata?.[SURFACE_GRANTS_METADATA_KEY]), surfaceChannelKey(context)),
  };
}

describe('the deploy seed (D6)', () => {
  it('is merged once per digest, logged content-free; revoked groups are not re-added by the same seed', async () => {
    const w = world();
    const first = await w.service.applySeed('owner', SEED, T0);
    expect(first?.applied).toBe(true);
    expect(w.granted()).toEqual([...SEED.channels[0]!.groups]);
    expect(w.logs).toContainEqual(['surface_grant.seeded', { platform: 'discord', channelId: CHANNEL.channelId, groups: SEED.channels[0]!.groups.join(','), seedDigest: first!.digest.slice(0, 16) }]);
    expect(await w.say(CHANNEL, '이 채널에 Slack 검색 허용 해제')).toBe('이 채널에서 해제했어요: Slack 검색.');
    expect((await w.service.applySeed('owner', SEED, T0))?.applied).toBe(false);
    expect(w.granted()).not.toContain('slack-search');
    expect(await w.say(DM, '모든 채널 권한 해제')).toBe('모든 채널(1개)의 권한을 해제했어요.');
    expect((await w.service.applySeed('owner', SEED, T0))?.applied).toBe(false);
    expect(w.granted()).toEqual([]);
    expect(readSurfaceGrants(w.actor().metadata?.[SURFACE_GRANTS_METADATA_KEY]).seeds).toEqual([first!.digest]);
  });

  it('an absent owner Actor is a logged skip, never a crash', async () => {
    const w = world();
    expect(await w.service.applySeed('nobody', SEED, T0)).toBeUndefined();
    expect(w.logs.at(-1)?.[0]).toBe('surface_grant.seed_failed');
  });
});

describe('owner phrases (D4, P1: list and revoke; grant is P2)', () => {
  it('list in the channel shows the groups with date and source, then the always and DM-only lines', async () => {
    const w = world();
    expect(await w.say(CHANNEL, '이 채널 권한 보여줘')).toBe('이 채널에 허용된 묶음이 없어요.\n항상 됨: 대화, 도움말, 제어.\nDM에서만: 메일, 드라이브, 브리핑, 자연어 실행.');
    await w.service.applySeed('owner', { channels: [{ key: surfaceChannelKey(CHANNEL), groups: ['calendar', 'todo'] }] }, T0);
    expect(await w.say(CHANNEL, '이 채널 권한')).toBe(
      '이 채널에 허용된 묶음:\n- 캘린더 조회 (2026-10-15, 배포 시 사전 허용)\n- 할 일 (2026-10-15, 배포 시 사전 허용)\n항상 됨: 대화, 도움말, 제어.\nDM에서만: 메일, 드라이브, 브리핑, 자연어 실행.',
    );
    expect(await w.say(DM, '채널 권한 목록')).toBe('권한이 허용된 채널:\n- 1520835639904309350: 캘린더 조회, 할 일');
    expect(await w.say(CHANNEL, '채널 권한 목록')).toBeUndefined(); // the DM form is ordinary text in a channel
  });

  it('revoke is immediate, with a fixed reply and a one-line DM receipt; nothing else changes', async () => {
    const w = world();
    await w.service.applySeed('owner', SEED, T0);
    await w.service.applySeed('owner', { channels: [{ key: surfaceChannelKey(OTHER), groups: ['todo'] }] }, T0);
    expect(await w.say(CHANNEL, '이 채널에 캘린더, GitHub 허용 해제')).toBe('이 채널에서 해제했어요: 캘린더 조회, GitHub 조회.');
    expect(w.granted()).not.toContain('calendar');
    expect(w.granted(OTHER)).toEqual(['todo']);
    expect(w.receipts).toEqual([{ correlationId: expect.any(String), target: CHANNEL, kind: 'SURFACE_GRANT', text: '채널 권한 해제: 1520835639904309350 — 캘린더 조회, GitHub 조회.' }]);
    expect(await w.say(CHANNEL, '이 채널에 캘린더 허용 해제')).toBe('이 채널에 허용돼 있지 않은 묶음이에요. 바뀐 것은 없어요.');
    expect(w.receipts).toHaveLength(1);
    expect(await w.say(CHANNEL, '이 채널 권한 모두 해제해줘')).toBe('이 채널의 권한을 모두 해제했어요.');
    expect(w.granted()).toEqual([]);
    expect(w.granted(OTHER)).toEqual(['todo']);
    expect(w.receipts.at(-1)?.text).toBe('채널 권한 해제: 1520835639904309350 — 모든 권한.');
  });

  it('wrong place or group: fixed replies that read and write nothing', async () => {
    const w = world();
    expect(await w.say(DM, '이 채널 권한 보여줘')).toBe('채널 권한은 그 채널에서 보내 주세요. DM에서는 원래 모두 답해요.');
    expect(await w.say(DM, '이 채널에 캘린더 허용 해제')).toBe('채널 권한은 그 채널에서 보내 주세요. DM에서는 원래 모두 답해요.');
    expect(await w.say(CHANNEL, '이 채널에 메일 허용 해제')).toBe('메일은(는) DM에서만 답해요. 채널에는 허용할 수 없어요.');
    expect(await w.say(CHANNEL, '이 채널에 아무거나 허용 해제')).toMatch(/^어떤 묶음인지 모르겠어요/);
    expect(await w.say(CHANNEL, '모든 채널 권한 해제')).toMatch(/DM에서 보내 주세요/);
    expect(await w.say(CHANNEL, '이 채널에 캘린더 허용')).toBe('채널 권한 허용 문장은 아직 준비 중이에요. 아무것도 바꾸지 않았어요. 지금은 배포 설정으로만 허용돼요.');
    expect(w.actor().metadata).toBeUndefined();
    expect(w.receipts).toEqual([]);
  });

  it('a non-owner (or an actor without the identity) gets nothing: ordinary text, `surface_grant.refused`', async () => {
    const w = world();
    await w.service.applySeed('owner', SEED, T0);
    const stranger: ConversationContext = { ...CHANNEL, userId: '800000' };
    expect(await w.say(stranger, '이 채널 권한 모두 해제')).toBeUndefined();
    expect(w.granted()).toHaveLength(10);
    expect(w.logs.at(-1)).toEqual(['surface_grant.refused', { reason: 'not-owner' }]);
  });
});

describe('the kill switch suspends every grant (D4.6)', () => {
  it('`에이전트 중지` in the owner DM writes the same switch; grants are kept and come back with `에이전트 재개`', async () => {
    const w = world();
    await w.service.applySeed('owner', SEED, T0);
    const message = (text: string, context = DM): InboundMessage => ({ id: text, context, text, receivedAt: T0 });
    expect(await w.service.handleSwitchPhrase(w.actor(), message('에이전트 중지', CHANNEL), T0)).toBeUndefined();
    expect(await w.service.handleSwitchPhrase(w.actor(), message('에이전트 중지'), T0)).toBe('채널 권한을 모두 멈췄어요(지우지 않고 보관해요). 다시 켜려면 "에이전트 재개"라고 보내 주세요.');
    expect(w.actor().metadata?.[ACTION_SWITCH_METADATA_KEY]).toEqual({ state: 'stopped', at: T0 });
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor: w.actor(), groups: ['calendar'] })).toEqual({ allow: false, reason: 'suspended', group: 'calendar' });
    expect(w.granted()).toHaveLength(10);
    expect(await w.say(CHANNEL, '이 채널 권한')).toContain('지금은 모두 멈춰 있어요(에이전트 중지).');
    expect(await w.service.handleSwitchPhrase(w.actor(), message('에이전트 재개'), T0)).toBe('채널 권한을 다시 켰어요.');
    expect(readActionSwitch(w.actor()).state).toBe('running');
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor: w.actor(), groups: ['calendar'] })).toEqual({ allow: true });
    expect(await w.service.handleSwitchPhrase(w.actor(), message('에이전트 상태'), T0)).toBeUndefined();
  });
});

describe('content-free logs (D3)', () => {
  it('no message text, item, channel or user name in any surface_* field', async () => {
    const w = world();
    await w.service.applySeed('owner', SEED, T0);
    await w.say(CHANNEL, '이 채널에 캘린더 허용 해제');
    await w.say({ ...CHANNEL, userId: '800000' }, '이 채널 권한 모두 해제');
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    for (const [event, fields] of w.logs) {
      expect(event).toMatch(/^(surface_grant|nl_action)\./);
      for (const value of Object.values(fields)) {
        expect(String(value)).not.toMatch(/[가-힣]/);
        expect(String(value)).not.toContain(OWNER_ID);
      }
    }
  });
});
