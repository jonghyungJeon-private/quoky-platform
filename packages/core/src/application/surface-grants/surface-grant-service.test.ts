import { describe, expect, it } from 'vitest';
import type { Actor, ConversationContext, Id, InboundMessage, Session } from '../../domain';
import type { OwnerNotification } from '../../ports/notification-sink.port';
import { KeyedMutex } from '../../util/keyed-mutex';
import { ActorMetadataStore } from '../actor-metadata-store';
import { ACTION_SWITCH_METADATA_KEY, readActionSwitch } from '../nl-routing/action-switch';
import { decideSurface } from './surface-gate';
import { SURFACE_GRANTS_METADATA_KEY, grantedSurfaceGroups, readSurfaceGrants, surfaceChannelKey } from './surface-grant-record';
import { SURFACE_GRANT_PENDING_METADATA_KEY, SurfaceGrantService } from './surface-grant-service';

// ADR-0122 D3/D4/D6 (P1): the owner's list / revoke phrases, the owner check, receipts, the kill switch and the seed.

const T0 = '2026-10-15T09:00:00.000Z';
const OWNER_ID = '700000';
const CHANNEL: ConversationContext = { platform: 'discord', spaceId: '1520835639103324181', channelId: '1520835639904309350', userId: OWNER_ID, direct: false };
const OTHER: ConversationContext = { ...CHANNEL, channelId: '1520835639904309351' };
const DM: ConversationContext = { platform: 'discord', channelId: '900000', userId: OWNER_ID, direct: true };
const SEED = { channels: [{ key: surfaceChannelKey(CHANNEL), groups: ['jira-mine', 'jira-project', 'github', 'slack-search', 'confluence', 'calendar', 'todo', 'reminder', 'memory', 'code'] as const }] };

const SECOND_OWNER_ID = '700001';

function world(options: { readonly sessions?: boolean } = {}) {
  // Two configured owner accounts on one owner Actor (CA P2: only the account that asked may confirm).
  let actor: Actor = { id: 'owner', displayName: 'o', identities: [{ platform: 'discord', externalId: OWNER_ID }, { platform: 'discord', externalId: SECOND_OWNER_ID }], createdAt: T0 };
  let failSessionSaves = false;
  // One session per conversation (the runtime's session is per channel / thread); metadata only.
  const sessions = new Map<string, Session>();
  const sessionOf = (context: ConversationContext): Session => {
    const id = `s-${context.channelId}`;
    if (!sessions.has(id)) sessions.set(id, { id, actorId: 'owner', context, status: 'ACTIVE', createdAt: T0, lastActivityAt: T0 } as Session);
    return structuredClone(sessions.get(id)!);
  };
  let slow: Promise<void> | undefined;
  const logs: Array<[string, Record<string, string>]> = [];
  const receipts: OwnerNotification[] = [];
  const repo = {
    async get(id: Id) {
      const snapshot = id === actor.id ? structuredClone(actor) : null;
      if (slow !== undefined) {
        const wait = slow;
        slow = undefined;
        await wait;
      }
      return snapshot;
    },
    async save(next: Actor) {
      actor = structuredClone(next);
      return next;
    },
  };
  const service = new SurfaceGrantService({
    metadata: new ActorMetadataStore(repo, new KeyedMutex()),
    isOwner: (who, context) => who.identities.some((identity) => identity.platform === context.platform && identity.externalId === context.userId) && [OWNER_ID, SECOND_OWNER_ID].includes(context.userId),
    logger: { info: (event, fields) => logs.push([event, (fields ?? {}) as Record<string, string>]), warn: (event, fields) => logs.push([event, (fields ?? {}) as Record<string, string>]) },
    notify: async (notification) => {
      receipts.push(notification);
      return { status: 'SENT', via: 'DM' };
    },
    ...(options.sessions === false
      ? {}
      : {
          sessions: {
            async updateMetadataEntry(session: Pick<Session, 'id'>, key: string, update: (current: unknown) => unknown) {
              if (failSessionSaves) throw new Error('session save failed');
              const live = sessions.get(session.id);
              if (live === undefined) return null;
              const metadata: Record<string, unknown> = { ...(live.metadata ?? {}) };
              const next = update(metadata[key]);
              if (next === undefined) delete metadata[key];
              else metadata[key] = structuredClone(next);
              const saved = { ...live, metadata } as Session;
              sessions.set(session.id, saved);
              return structuredClone(saved);
            },
          },
        }),
  });
  let seq = 0;
  const say = (context: ConversationContext, text: string, extra: Partial<InboundMessage> = {}, at: string = T0): Promise<string | undefined> => {
    seq += 1;
    const message: InboundMessage = { id: `m${seq}`, context, text, receivedAt: at, ...extra };
    return service.handlePhrase(message, actor, at, sessionOf(context));
  };
  /** The runtime's order: the pending grant first (it may end the turn or be dropped), then the phrases. */
  const turn = async (context: ConversationContext, text: string, at: string = T0) => {
    seq += 1;
    const message: InboundMessage = { id: `m${seq}`, context, text, receivedAt: at };
    const pending = await service.handleGrantPending(message, sessionOf(context), actor, at);
    if (pending?.reply !== undefined) return pending.reply;
    const phrase = await service.handlePhrase(message, actor, at, sessionOf(context));
    return phrase ?? (pending?.cleared === true ? '<routed, pending dropped>' : '<routed>');
  };
  return {
    service,
    say,
    turn,
    pending: (context: ConversationContext) => sessionOf(context).metadata?.[SURFACE_GRANT_PENDING_METADATA_KEY],
    failSessionSaves: (fail: boolean) => {
      failSessionSaves = fail;
    },
    /** The next actor read waits for `until` (a lock interleaving test). */
    armSlowRead: (until: Promise<void>) => {
      slow = until;
    },
    sessionOf,
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

describe('owner phrases (D4: list and revoke)', () => {
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
    expect(await w.say(DM, '이 채널에 캘린더 허용')).toBe('채널 권한은 그 채널에서 보내 주세요. DM에서는 원래 모두 답해요.');
    expect(await w.say(CHANNEL, '이 채널에 메일 허용')).toBe('메일은(는) DM에서만 답해요. 채널에는 허용할 수 없어요.');
    expect(await w.say(CHANNEL, '이 채널에 대화 허용')).toMatch(/^어떤 묶음인지 모르겠어요/);
    expect(w.pending(CHANNEL)).toBeUndefined();
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
    await w.turn(CHANNEL, '허용 실행');
    await w.say(CHANNEL, '이 채널에 외부 쓰기 허용');
    await w.turn({ ...CHANNEL, userId: '800000' }, '허용 실행');
    expect(w.logs.map(([event]) => event)).toEqual(expect.arrayContaining(['surface_grant.pending', 'surface_grant.changed', 'surface_grant.pending_ended']));
    for (const [event, fields] of w.logs) {
      expect(event).toMatch(/^(surface_grant|nl_action)\./);
      for (const value of Object.values(fields)) {
        expect(String(value)).not.toMatch(/[가-힣]/);
        expect(String(value)).not.toContain(OWNER_ID);
      }
    }
  });
});

describe('the grant phrase and its `허용 실행` confirmation (D4.1–D4.3, P2)', () => {
  const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
  const CONFIRM_TAIL = '허용하려면 2분 안에 "허용 실행"이라고 보내 주세요. 다른 말을 보내면 취소돼요.';
  const STALE = '허용을 기다리는 사이에 채널 권한이 바뀌었어요(해제 또는 에이전트 중지). 아무것도 허용하지 않았어요. 다시 "이 채널에 … 허용"이라고 보내 주세요.';
  const NO_PENDING = '지금 허용을 기다리는 요청이 없어요. 아무것도 바꾸지 않았어요.';

  it('asks first (audience line, nothing saved), then `허용 실행` saves it with a log line and a one-line DM receipt', async () => {
    const w = world();
    const ask = await w.say(CHANNEL, '이 채널에 캘린더, 할 일 허용', { audience: { memberUpperBound: 12, restricted: false } });
    expect(ask).toBe(`이 채널에 다음을 허용할까요? · 캘린더 조회, 할 일\n이 채널을 볼 수 있는 사람은 모두 답을 볼 수 있어요. 서버 인원 최대 12명 · 비공개 채널: 아니오.\n${CONFIRM_TAIL}`);
    expect(w.granted()).toEqual([]);
    expect(w.pending(CHANNEL)).toEqual({
      v: 1,
      id: expect.any(String),
      key: surfaceChannelKey(CHANNEL),
      groups: ['calendar', 'todo'],
      expiresAt: later(120_000),
      userId: OWNER_ID,
      grantsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      switchDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(w.receipts).toEqual([]);
    expect(await w.turn(CHANNEL, '허용 실행', later(119_000))).toBe('이 채널에 허용했어요: 캘린더 조회, 할 일.');
    expect(w.granted()).toEqual(['calendar', 'todo']);
    expect(w.pending(CHANNEL)).toBeUndefined();
    expect(w.receipts).toEqual([{ correlationId: expect.any(String), target: CHANNEL, kind: 'SURFACE_GRANT', text: '채널 권한 허용: 1520835639904309350 — 캘린더 조회, 할 일.' }]);
    expect(w.logs).toContainEqual(['surface_grant.changed', { op: 'grant', platform: 'discord', channelId: CHANNEL.channelId, groups: 'calendar,todo', source: 'owner' }]);
    const list = await w.say(CHANNEL, '이 채널 권한');
    expect(list).toContain('- 캘린더 조회 (2026-10-15, 직접)');
    // Nothing is waiting any more: a second `허용 실행` changes nothing.
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('지금 허용을 기다리는 요청이 없어요. 아무것도 바꾸지 않았어요.');
    expect(w.receipts).toHaveLength(1);
  });

  it('the polite and spacing forms of `허용 실행` count; quoted, code-formatted or other words never confirm', async () => {
    for (const text of ['허용 실행', '허용실행', '허용 실행해줘', '허용 실행.']) {
      const w = world();
      await w.say(CHANNEL, '이 채널에 캘린더 허용');
      expect(await w.turn(CHANNEL, text), text).toBe('이 채널에 허용했어요: 캘린더 조회.');
    }
    for (const text of ['`허용 실행`', '> 허용 실행', '승인', '허용', '실행', '허용 실행할까?']) {
      const w = world();
      await w.say(CHANNEL, '이 채널에 캘린더 허용');
      expect(await w.turn(CHANNEL, text), text).toBe('<routed, pending dropped>');
      expect(w.granted(), text).toEqual([]);
      expect(w.pending(CHANNEL), text).toBeUndefined();
    }
  });

  it('the 2-minute window: after it `허용 실행` is refused and nothing is saved', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await w.turn(CHANNEL, '허용 실행', later(120_001))).toBe('허용 확인 시간(2분)이 지났어요. 아무것도 허용하지 않았어요. 다시 "이 채널에 … 허용"이라고 보내 주세요.');
    expect(w.granted()).toEqual([]);
    expect(w.pending(CHANNEL)).toBeUndefined();
    expect(w.receipts).toEqual([]);
    expect(w.logs).toContainEqual(['surface_grant.refused', { reason: 'confirmation-expired' }]);
  });

  it('any other message ends the pending grant and routes as before; a new grant phrase replaces it', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await w.turn(CHANNEL, '오늘 기분 좋아')).toBe('<routed, pending dropped>');
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('지금 허용을 기다리는 요청이 없어요. 아무것도 바꾸지 않았어요.');
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await w.turn(CHANNEL, '이 채널에 GitHub 허용')).toMatch(/^이 채널에 다음을 허용할까요\? · GitHub 조회\n/);
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('이 채널에 허용했어요: GitHub 조회.');
    expect(w.granted()).toEqual(['github']);
  });

  it('owner only: a non-owner\'s phrase is ordinary text, and a non-owner `허용 실행` grants nothing (the pending grant ends)', async () => {
    const w = world();
    const stranger: ConversationContext = { ...CHANNEL, userId: '800000' };
    expect(await w.say(stranger, '이 채널에 캘린더 허용')).toBeUndefined();
    expect(w.pending(CHANNEL)).toBeUndefined();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await w.turn(stranger, '허용 실행')).toBe('<routed, pending dropped>');
    expect(w.granted()).toEqual([]);
    expect(w.logs).toContainEqual(['surface_grant.refused', { reason: 'not-owner' }]);
    expect(await w.turn(stranger, '허용 실행')).toBe('<routed>');
  });

  it('a pending grant belongs to its channel: `허용 실행` in another channel finds nothing there', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await w.turn(OTHER, '허용 실행')).toBe('지금 허용을 기다리는 요청이 없어요. 아무것도 바꾸지 않았어요.');
    expect(w.granted(OTHER)).toEqual([]);
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('이 채널에 허용했어요: 캘린더 조회.');
  });

  it('in a DM `허용 실행` is ordinary text', async () => {
    const w = world();
    expect(await w.turn(DM, '허용 실행')).toBe('<routed>');
  });

  it('strong groups get their warning; `writes` names the read groups this channel still lacks', async () => {
    const w = world();
    await w.service.applySeed('owner', { channels: [{ key: surfaceChannelKey(CHANNEL), groups: ['jira-mine'] }] }, T0);
    const ask = await w.say(CHANNEL, '이 채널에 Slack, Jira 릴리스, 외부 쓰기, 코드 허용');
    expect(ask).toBe(
      [
        '이 채널에 다음을 허용할까요? · Jira 프로젝트·릴리스 조회(전체 담당), Slack 검색, 코드 작업, 외부 쓰기(승인)',
        '이 채널을 볼 수 있는 사람은 모두 답을 볼 수 있어요. 몇 명이 볼 수 있는지 확인하지 못했어요.',
        '주의: 다른 사람 담당 이슈와 릴리스 목록도 보여요.',
        '주의: Slack 검색 결과에는 비공개 채널·DM 메시지도 나올 수 있어요.',
        '주의: 코드 작업에는 GitHub 쓰기(푸시·PR 생성·병합·원격 브랜치 삭제)가 포함되고, 코드와 diff가 이 채널에 보여요.',
        '주의: 승인 카드에 보낼 내용 전체가 이 채널에 보여요.',
        '외부 쓰기는 같은 서비스의 조회 권한도 있어야 동작해요. 아직 없는 것: 캘린더 조회.',
        CONFIRM_TAIL,
      ].join('\n'),
    );
    const plain = await w.say(CHANNEL, '이 채널에 Confluence 허용', { audience: { restricted: true } });
    expect(plain).toBe(`이 채널에 다음을 허용할까요? · Confluence 검색\n이 채널을 볼 수 있는 사람은 모두 답을 볼 수 있어요. 비공개 채널: 예.\n${CONFIRM_TAIL}`);
  });

  it('already granted groups are not asked again; the 16-channel table refuses a 17th channel before and at the save', async () => {
    const w = world();
    await w.service.applySeed('owner', { channels: [{ key: surfaceChannelKey(CHANNEL), groups: ['calendar'] }] }, T0);
    expect(await w.say(CHANNEL, '이 채널에 캘린더 허용')).toBe('이미 이 채널에 허용돼 있어요: 캘린더 조회. 바뀐 것은 없어요.');
    expect(w.pending(CHANNEL)).toBeUndefined();
    const full = world();
    const keys = Array.from({ length: 16 }, (_, i) => ({ key: `discord:${CHANNEL.spaceId}:${9000 + i}`, groups: ['todo'] as const }));
    await full.service.applySeed('owner', { channels: keys }, T0);
    const limit = '채널 권한은 최대 16개 채널에만 허용할 수 있어요. 아무것도 허용하지 않았어요. 다른 채널의 권한을 먼저 해제해 주세요(그 채널에서 "이 채널 권한 모두 해제").';
    expect(await full.say(CHANNEL, '이 채널에 캘린더 허용')).toBe(limit);
    // A table that filled up between the question and the confirmation: the grants changed since, so nothing is allowed.
    const racing = world();
    await racing.say(CHANNEL, '이 채널에 캘린더 허용');
    await racing.service.applySeed('owner', { channels: keys }, T0);
    expect(await racing.turn(CHANNEL, '허용 실행')).toBe(STALE);
    expect(racing.granted()).toEqual([]);
  });

  it('while the kill switch is stopped, the question and the reply say the grant waits for `에이전트 재개`', async () => {
    const w = world();
    await w.service.handleSwitchPhrase(w.actor(), { id: 'k', context: DM, text: '에이전트 중지', receivedAt: T0 }, T0);
    expect(await w.say(CHANNEL, '이 채널에 캘린더 허용')).toContain('지금은 채널 권한이 모두 멈춰 있어요(에이전트 중지). "에이전트 재개" 후에 적용돼요.');
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('이 채널에 허용했어요: 캘린더 조회. "에이전트 재개" 전까지는 멈춰 있어요.');
    expect(decideSurface({ mode: 'enforce', context: CHANNEL, actor: w.actor(), groups: ['calendar'] })).toEqual({ allow: false, reason: 'suspended', group: 'calendar' });
  });

  it('without a session store the phrase answers "not available" and saves nothing', async () => {
    const w = world({ sessions: false });
    expect(await w.say(CHANNEL, '이 채널에 캘린더 허용')).toBe('채널 권한 허용 문장은 아직 준비 중이에요. 아무것도 바꾸지 않았어요. 지금은 배포 설정으로만 허용돼요.');
  });

  it('race through the lock: a revoke that arrives while the grant is being saved queues behind it and is not lost', async () => {
    const w = world();
    await w.service.applySeed('owner', { channels: [{ key: surfaceChannelKey(CHANNEL), groups: ['todo'] }] }, T0);
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    let release!: () => void;
    // The grant's locked re-read of the actor waits here; the revoke arrives meanwhile and must wait for the lock.
    w.armSlowRead(new Promise<void>((resolve) => (release = resolve)));
    const confirming = w.turn(CHANNEL, '허용 실행');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const revoking = w.say(CHANNEL, '이 채널에 할 일 허용 해제');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await confirming).toBe('이 채널에 허용했어요: 캘린더 조회.');
    expect(await revoking).toBe('이 채널에서 해제했어요: 할 일.');
    expect(w.granted()).toEqual(['calendar']);
  });

  it('two `허용 실행` at once: the pending grant is consumed once (one grant, one receipt)', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    const replies = await Promise.all([w.turn(CHANNEL, '허용 실행'), w.turn(CHANNEL, '허용 실행')]);
    expect(replies.sort()).toEqual(['이 채널에 허용했어요: 캘린더 조회.', '지금 허용을 기다리는 요청이 없어요. 아무것도 바꾸지 않았어요.'].sort());
    expect(w.receipts).toHaveLength(1);
  });

  it('CA P2: a failed session save on `허용 실행` grants nothing and keeps the pending grant (no replay window)', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    w.failSessionSaves(true);
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('채널 권한을 저장하지 못했어요. 아무것도 바뀌지 않았어요. 다시 시도해 주세요.');
    expect(w.granted()).toEqual([]);
    expect(await w.turn(CHANNEL, '오늘 기분 좋아')).toBe('<routed>'); // a failed drop is not reported as cleared
    w.failSessionSaves(false);
    expect(w.pending(CHANNEL)).toBeDefined();
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('이 채널에 허용했어요: 캘린더 조회.');
  });

  it('CA P2: only the owner account that asked can confirm (another configured owner id cannot)', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await w.turn({ ...CHANNEL, userId: SECOND_OWNER_ID }, '허용 실행')).toBe(NO_PENDING);
    expect(w.granted()).toEqual([]);
    expect(w.pending(CHANNEL)).toBeUndefined();
  });

  it('CA suggestion: "모든 채널 권한 해제" or "에이전트 중지" in the DM after the question voids the confirmation', async () => {
    const cleared = world();
    await cleared.service.applySeed('owner', { channels: [{ key: surfaceChannelKey(OTHER), groups: ['todo'] }] }, T0);
    await cleared.say(CHANNEL, '이 채널에 캘린더 허용');
    expect(await cleared.say(DM, '모든 채널 권한 해제')).toBe('모든 채널(1개)의 권한을 해제했어요.');
    expect(await cleared.turn(CHANNEL, '허용 실행')).toBe(STALE);
    expect(cleared.granted()).toEqual([]);

    const stopped = world();
    await stopped.say(CHANNEL, '이 채널에 캘린더 허용');
    await stopped.service.handleSwitchPhrase(stopped.actor(), { id: 'k', context: DM, text: '에이전트 중지', receivedAt: T0 }, T0);
    expect(await stopped.turn(CHANNEL, '허용 실행')).toBe(STALE);
    expect(stopped.granted()).toEqual([]);
  });

  it('Codex P2: a delayed `허용 실행` consumes only the pending grant its turn saw; a replacement is left untouched', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    const seenAtStart = w.sessionOf(CHANNEL); // the delayed confirmation turn began here
    await w.say(CHANNEL, '이 채널에 기억 허용'); // a newer question replaced the pending grant
    const replacement = w.pending(CHANNEL);
    const delayed = await w.service.handleGrantPending({ id: 'late', context: CHANNEL, text: '허용 실행', receivedAt: T0 }, seenAtStart, w.actor(), T0);
    expect(delayed).toEqual({ reply: NO_PENDING });
    expect(w.granted()).toEqual([]);
    expect(w.pending(CHANNEL)).toEqual(replacement);
    // A delayed other message does not drop the replacement either.
    expect(await w.service.handleGrantPending({ id: 'late2', context: CHANNEL, text: '오늘 기분 좋아', receivedAt: T0 }, seenAtStart, w.actor(), T0)).toBeUndefined();
    expect(w.pending(CHANNEL)).toEqual(replacement);
    expect(await w.turn(CHANNEL, '허용 실행')).toBe('이 채널에 허용했어요: 기억.');
  });

  it('CA P1: asked inside a thread, the question says the grant covers the parent channel and all its threads', async () => {
    const w = world();
    const thread: ConversationContext = { ...CHANNEL, threadId: '1520835639904309399' };
    expect(await w.say(thread, '이 채널에 캘린더 허용')).toContain('\n상위 채널 전체(모든 스레드 포함)에 적용돼요.\n');
    expect(await w.say(CHANNEL, '이 채널에 GitHub 허용')).not.toContain('상위 채널 전체');
  });

  it('CA P2: an approval-expiry turn (cancel only) ends the pending grant and never confirms', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    const message: InboundMessage = { id: 'x', context: CHANNEL, text: '허용 실행', receivedAt: T0 };
    expect(await w.service.handleGrantPending(message, w.sessionOf(CHANNEL), w.actor(), T0, { cancelOnly: true })).toEqual({ cleared: true });
    expect(w.granted()).toEqual([]);
    expect(w.pending(CHANNEL)).toBeUndefined();
    expect(await w.service.handleGrantPending(message, w.sessionOf(CHANNEL), w.actor(), T0, { cancelOnly: true })).toBeUndefined();
  });

  it('Codex P2 (final): the pending grant is bound to the turn\'s FIRST read, not to a touched (refreshed) session', async () => {
    const w = world();
    await w.say(CHANNEL, '이 채널에 캘린더 허용');
    const firstRead = w.pending(CHANNEL); // the delayed turn's openForContext saw this
    await w.say(CHANNEL, '이 채널에 기억 허용'); // replaced before that turn's touch
    const replacement = w.pending(CHANNEL);
    const touched = w.sessionOf(CHANNEL); // the touch returns the live row with the replacement
    const message: InboundMessage = { id: 'late', context: CHANNEL, text: '허용 실행', receivedAt: T0 };
    expect(await w.service.handleGrantPending(message, touched, w.actor(), T0, { seenPending: firstRead })).toEqual({ reply: NO_PENDING });
    expect(w.granted()).toEqual([]);
    expect(w.pending(CHANNEL)).toEqual(replacement);
    // Nothing pending at the first read: a confirmation answers "nothing pending" even if the touch shows one.
    expect(await w.service.handleGrantPending(message, touched, w.actor(), T0, { seenPending: undefined })).toEqual({ reply: NO_PENDING });
    expect(w.pending(CHANNEL)).toEqual(replacement);
  });

  it('CA / Codex P2 (final): the kill switch is compared on the LIVE actor inside the lock — a stop that lands while the confirmation waits, and stop → resume, both void it', async () => {
    const concurrent = world();
    await concurrent.say(CHANNEL, '이 채널에 캘린더 허용');
    const snapshot = concurrent.actor(); // the confirmation turn's actor snapshot: still running
    let release!: () => void;
    concurrent.armSlowRead(new Promise<void>((resolve) => (release = resolve)));
    // The stop takes the lock first (its read waits); the grant's locked save queues behind it.
    const stopping = concurrent.service.handleSwitchPhrase(snapshot, { id: 'k', context: DM, text: '에이전트 중지', receivedAt: T0 }, T0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const confirming = concurrent.service.handleGrantPending({ id: 'c', context: CHANNEL, text: '허용 실행', receivedAt: T0 }, concurrent.sessionOf(CHANNEL), snapshot, T0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await stopping;
    expect(await confirming).toEqual({ reply: STALE });
    expect(concurrent.granted()).toEqual([]);

    const flipped = world();
    await flipped.say(CHANNEL, '이 채널에 캘린더 허용');
    await flipped.service.handleSwitchPhrase(flipped.actor(), { id: 'k1', context: DM, text: '에이전트 중지', receivedAt: T0 }, T0);
    await flipped.service.handleSwitchPhrase(flipped.actor(), { id: 'k2', context: DM, text: '에이전트 재개', receivedAt: T0 }, T0);
    // "running" again, but the switch was written since (stop → resume): the confirmation is void.
    expect(await flipped.turn(CHANNEL, '허용 실행')).toBe(STALE);
    expect(flipped.granted()).toEqual([]);
  });
});
