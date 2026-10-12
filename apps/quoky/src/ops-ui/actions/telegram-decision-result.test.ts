import { describe, expect, it } from 'vitest';
import { deliverOwnerNotification } from '@quoky/adapter-discord';
import type {
  Actor,
  ApprovalSurfaceDecision,
  ConversationContext,
  Logger,
  NotificationSinkOutcome,
  OwnerNotification,
  PlatformAdapter,
} from '@quoky/core';

import { CompositePlatformAdapter } from '../../platform/composite-platform-adapter';
import { opsDecisionResultTarget } from '../ops-ui-wiring';
import { OpsUiActions, chatPlaceOf } from './ops-actions';
import type { OpsActionsDeps } from './ops-actions';

/**
 * TG-3 (ADR-0114 D11, amending ADR-0113 D7): an ops-UI decision on an approval that was created in the owner's Telegram
 * chat reports its `OPS_DECISION_RESULT` to the owner's DISCORD DM (the primary platform), through the real composite
 * and the real Discord owner-notification sink. Before TG-3 the target carried the Telegram chat, the composite sent it
 * to Discord as the D11 rule says, and the Discord sink refused it (`TARGET_NOT_ADMITTED`): the owner never heard.
 */

const DISCORD_OWNER = '111111111111111111';
const TELEGRAM_OWNER = '5550001';
const ACTOR = 'actor-owner';
const TS = '2026-10-12T00:00:00.000Z';
const silent: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const telegramChat: ConversationContext = { platform: 'telegram', channelId: TELEGRAM_OWNER, userId: TELEGRAM_OWNER, direct: true };
const discordDm: ConversationContext = { platform: 'discord', channelId: '888888888888888801', userId: DISCORD_OWNER, direct: true };

function child(platform: string): PlatformAdapter {
  return {
    platform,
    start: async () => undefined,
    stop: async () => undefined,
    onMessage: () => undefined,
    onApprovalDecision: () => undefined,
    sendMessage: async () => undefined,
    sendTyping: async () => undefined,
    requestApproval: async () => undefined,
  };
}

/** Discord (primary) with its real owner-notification sink over a recorded DM; Telegram with a recorded sink. */
function platforms() {
  const discordDms: Array<{ userId: string; content: string }> = [];
  const telegramNotes: OwnerNotification[] = [];
  const discord = Object.assign(child('discord'), {
    deliver: (notification: OwnerNotification): Promise<NotificationSinkOutcome> =>
      deliverOwnerNotification(notification, {
        ownerIds: [DISCORD_OWNER],
        channelIds: [],
        channelDelivery: false,
        fetchChannel: async () => null,
        fetchOwnerDm: async (userId) => ({
          send: async (options) => {
            discordDms.push({ userId, content: options.content });
            return { id: 'm1' };
          },
        }),
        logger: silent,
      }),
  });
  const telegram = Object.assign(child('telegram'), {
    deliver: async (notification: OwnerNotification): Promise<NotificationSinkOutcome> => {
      telegramNotes.push(notification);
      return { status: 'SENT', via: 'dm' };
    },
  });
  return { discordDms, telegramNotes, composite: new CompositePlatformAdapter(discord, [telegram], silent) };
}

function actions(
  chat: ConversationContext,
  sink: CompositePlatformAdapter,
  resultTarget: NonNullable<OpsActionsDeps['approvals']>['resultTarget'],
): OpsUiActions {
  const decided: ApprovalSurfaceDecision = {
    status: 'DECIDED',
    outcome: 'REJECTED',
    kind: 'PUSH',
    reply: { context: chat, text: '푸시 요청을 거절했어요.' },
    chat,
  };
  return new OpsUiActions({
    owner: async () => ({ status: 'RESOLVED', actorId: ACTOR }),
    clock: () => TS,
    timeZone: 'Asia/Seoul',
    approvals: {
      decisions: {
        locateForOpsUi: async () => ({
          status: 'FOUND',
          view: { approvalId: 'a'.repeat(32), kind: 'PUSH', riskLevel: 'HIGH', createdAt: TS, remainingMs: 1, approvable: false, chat },
        }),
        decideFromOpsUi: async () => decided,
      },
      actor: async () => ({ id: ACTOR }) as Actor,
      sessions: async () => [],
      notify: (notification) => sink.deliver(notification),
      ...(resultTarget === undefined ? {} : { resultTarget }),
    },
    logger: silent,
  });
}

const config = {
  discord: { ownerIds: [DISCORD_OWNER] },
  telegram: { ownerActorMap: [{ telegramId: TELEGRAM_OWNER, discordOwnerId: DISCORD_OWNER }] },
};

describe('TG-3: the ops-UI decision result for a Telegram-origin approval (ADR-0114 D11)', () => {
  it('goes once to the Discord owner DM through the composite, never to Telegram', async () => {
    const { discordDms, telegramNotes, composite } = platforms();
    const outcome = await actions(telegramChat, composite, opsDecisionResultTarget(config)).decideApproval('a'.repeat(32), 'reject', '');
    expect(outcome).toMatchObject({ code: 'REJECTED', ok: true });
    expect(outcome.message).toContain('DM으로 결과를 보냈어요.');
    expect(discordDms).toHaveLength(1);
    expect(discordDms[0]?.userId).toBe(DISCORD_OWNER);
    expect(discordDms[0]?.content).toContain('[Quoky 운영 화면] 푸시 승인 요청을 운영 화면에서 거절했어요.');
    expect(telegramNotes).toEqual([]);
  });

  it('negative control (the pre-TG-3 rule): the Telegram target is refused by the Discord sink and nobody hears', async () => {
    const { discordDms, telegramNotes, composite } = platforms();
    const outcome = await actions(telegramChat, composite, undefined).decideApproval('a'.repeat(32), 'reject', '');
    expect(outcome.message).toContain('DM 결과 알림은 보내지 못했어요.');
    expect(discordDms).toEqual([]);
    expect(telegramNotes).toEqual([]);
  });

  it('a Discord-origin decision is unchanged: the same owner DM as before', async () => {
    const { discordDms, composite } = platforms();
    const withRule = await actions(discordDm, composite, opsDecisionResultTarget(config)).decideApproval('a'.repeat(32), 'reject', '');
    const legacy = await actions(discordDm, composite, undefined).decideApproval('a'.repeat(32), 'reject', '');
    expect(withRule).toEqual(legacy);
    expect(discordDms.map((dm) => dm.userId)).toEqual([DISCORD_OWNER, DISCORD_OWNER]);
    expect(discordDms[0]?.content).toBe(discordDms[1]?.content);
  });

  it('no admissible owner DM: nothing is sent and the UI says so', async () => {
    const { discordDms, telegramNotes, composite } = platforms();
    const nobody = opsDecisionResultTarget({ discord: { ownerIds: ['1', '2'] } });
    const outcome = await actions(telegramChat, composite, nobody).decideApproval('a'.repeat(32), 'reject', '');
    expect(outcome.code).toBe('REJECTED');
    expect(outcome.message).toContain('DM 결과 알림은 보내지 못했어요.');
    expect(discordDms).toEqual([]);
    expect(telegramNotes).toEqual([]);
  });

  it('the confirmation page names the Telegram chat without an id or a link; Discord keeps its words', async () => {
    const { composite } = platforms();
    const preview = await actions(telegramChat, composite, opsDecisionResultTarget(config)).approvalPreview('a'.repeat(32));
    expect(preview).toMatchObject({ status: 'FOUND', chatPlace: 'Telegram 개인 대화' });
    expect(preview).not.toHaveProperty('chatLink');
    expect(JSON.stringify(preview)).not.toContain(TELEGRAM_OWNER);
    expect(chatPlaceOf(discordDm)).toBe('DM');
    expect(chatPlaceOf({ ...discordDm, spaceId: '999', direct: false })).toBe('채널');
    expect(chatPlaceOf({ platform: 'Bad Platform!', channelId: 'x', userId: 'y' })).toBe('다른 플랫폼 개인 대화');
  });
});
