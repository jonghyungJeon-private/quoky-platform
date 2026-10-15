import { renderDriveDmOnly } from '../drive/drive-reply-renderer';
import { renderMailDmOnly } from '../mail/mail-reply-renderer';
import { renderBriefDmOnly } from '../reminders/reminder-turn-handler';
import type { SurfaceDecision } from './surface-gate';
import { DM_ONLY_SURFACE_GROUPS, GRANTABLE_SURFACE_GROUPS, SURFACE_GROUPS, surfaceGroupLabel, type SurfaceGroupId } from './surface-groups';

/**
 * ADR-0122 fixed copy (KO/EN). Every reply here carries no data: no item, no message text, no channel or user name.
 * A channel is named only by its id inside a PLT-0 conversation-reference span rendered by the platform (P2 lists).
 */

export type SurfaceCopyLanguage = 'ko' | 'en';

/**
 * P1: the grant phrase (`이 채널에 … 허용`) and its `허용 실행` confirmation are P2, so the denial copy does not yet tell
 * the owner to send it (it would get the "not available yet" reply). P2 flips this and the denial gains the ADR D2.7 hint.
 */
export const SURFACE_GRANT_PHRASE_AVAILABLE = false;

/** The A6 action refusal (byte-identical to the handlers' own copy, A6-D1). */
export function renderNlActionDmOnly(language: SurfaceCopyLanguage): string {
  return language === 'en' ? 'I do that only in a direct message. Nothing was changed.' : '이 작업은 DM에서만 해요. 아무것도 바꾸지 않았어요.';
}

function renderAgentDmOnly(language: SurfaceCopyLanguage): string {
  return language === 'en' ? 'The agent runs only in a direct message. Nothing was read.' : '에이전트는 DM에서만 실행해요. 아무것도 읽지 않았어요.';
}

/** The DM-only copy of a DM-only group: the group's existing copy, so the visible text is unchanged (D2.7). */
export function renderSurfaceDmOnly(group: SurfaceGroupId, language: SurfaceCopyLanguage): string {
  switch (group) {
    case 'mail':
      return renderMailDmOnly(language);
    case 'drive':
      return renderDriveDmOnly(language);
    case 'brief':
      return renderBriefDmOnly(language);
    case 'nl-actions':
      return renderNlActionDmOnly(language);
    case 'agent':
      return renderAgentDmOnly(language);
    default:
      return language === 'en'
        ? `'${surfaceGroupLabel(group, 'en')}' works only in a direct message. Nothing was read.`
        : `'${surfaceGroupLabel(group, 'ko')}'은(는) DM에서만 답해요. 아무것도 읽지 않았어요.`;
  }
}

/** The denial reply (D2.7): not granted, DM-only, suspended, or unclassified. */
export function renderSurfaceDenied(decision: Extract<SurfaceDecision, { allow: false }>, language: SurfaceCopyLanguage): string {
  if (decision.reason === 'suspended') {
    return language === 'en'
      ? 'Channel permissions are all paused right now (agent stopped). Nothing was read.'
      : '채널 권한이 지금 모두 멈춰 있어요(에이전트 중지). 아무것도 읽지 않았어요.';
  }
  if (decision.reason === 'dm-only' && decision.group !== undefined) return renderSurfaceDmOnly(decision.group, language);
  if (decision.reason === 'unclassified' || decision.group === undefined) {
    return language === 'en'
      ? 'I cannot answer that in this channel. Nothing was read. Please ask in a direct message.'
      : '이 채널에서는 답할 수 없는 요청이에요. 아무것도 읽지 않았어요. DM으로 물어봐 주세요.';
  }
  const label = surfaceGroupLabel(decision.group, language);
  if (language === 'en') {
    const hint = SURFACE_GRANT_PHRASE_AVAILABLE ? ` To allow it here, send "이 채널에 ${surfaceGroupLabel(decision.group, 'ko')} 허용".` : '';
    return `This channel has no '${label}' permission. Nothing was read. Please ask in a direct message.${hint}`;
  }
  const hint = SURFACE_GRANT_PHRASE_AVAILABLE ? `, 이 채널에 허용하려면 "이 채널에 ${label} 허용"이라고 보내 주세요` : '';
  return `이 채널에서는 '${label}' 권한이 없어요. 아무것도 읽지 않았어요. DM으로 물어보시${hint ? `거나${hint}` : '면 돼요'}.`;
}

// ── grant phrases (D4) ─────────────────────────────────────────────────────────────────────────────────────────────

/** P1: the grant phrase is recognized but not yet available (P2 adds the confirmation). Nothing changes. */
export function renderSurfaceGrantNotYet(language: SurfaceCopyLanguage): string {
  return language === 'en'
    ? 'Granting channel permissions by message is not available yet. Nothing was changed. For now only the deployment setting grants them.'
    : '채널 권한 허용 문장은 아직 준비 중이에요. 아무것도 바꾸지 않았어요. 지금은 배포 설정으로만 허용돼요.';
}

export function renderSurfaceGrantChannelOnly(language: SurfaceCopyLanguage): string {
  return language === 'en'
    ? 'Send channel permission commands in that channel. In a direct message everything is answered already.'
    : '채널 권한은 그 채널에서 보내 주세요. DM에서는 원래 모두 답해요.';
}

export function renderSurfaceGrantDmOnlyGroup(group: SurfaceGroupId, language: SurfaceCopyLanguage): string {
  const label = surfaceGroupLabel(group, language);
  return language === 'en'
    ? `${label} is answered only in a direct message. It cannot be allowed in a channel.`
    : `${label}은(는) DM에서만 답해요. 채널에는 허용할 수 없어요.`;
}

export function renderSurfaceGrantUsage(language: SurfaceCopyLanguage): string {
  const labels = GRANTABLE_SURFACE_GROUPS.map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en'
    ? `I did not recognize that permission group. Groups: ${labels}. Example: "이 채널에 캘린더 허용 해제".`
    : `어떤 묶음인지 모르겠어요. 묶음: ${labels}. 예: "이 채널에 캘린더 허용 해제".`;
}

export function renderSurfaceGrantWriteFailed(language: SurfaceCopyLanguage): string {
  return language === 'en'
    ? 'I could not save the channel permissions. Nothing was changed; please try again.'
    : '채널 권한을 저장하지 못했어요. 아무것도 바뀌지 않았어요. 다시 시도해 주세요.';
}

function dmOnlyLine(language: SurfaceCopyLanguage): string {
  const labels = DM_ONLY_SURFACE_GROUPS.filter((id) => id !== 'agent').map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en' ? `Direct message only: ${labels}.` : `DM에서만: ${labels}.`;
}

function alwaysLine(language: SurfaceCopyLanguage): string {
  const labels = (['chat', 'help', 'control'] as const).map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en' ? `Always: ${labels}.` : `항상 됨: ${labels}.`;
}

function sourceLabel(source: 'owner' | 'seed', language: SurfaceCopyLanguage): string {
  if (language === 'en') return source === 'seed' ? 'pre-granted at deploy' : 'by you';
  return source === 'seed' ? '배포 시 사전 허용' : '직접';
}

/** D4.4 `이 채널 권한 보여줘`: the granted groups with date and source, then the always and DM-only groups. */
export function renderSurfaceChannelList(
  granted: readonly { readonly group: SurfaceGroupId; readonly at: string; readonly source: 'owner' | 'seed' }[],
  suspended: boolean,
  language: SurfaceCopyLanguage,
): string {
  const lines: string[] = [];
  if (granted.length === 0) {
    lines.push(language === 'en' ? 'This channel has no permissions granted.' : '이 채널에 허용된 묶음이 없어요.');
  } else {
    lines.push(language === 'en' ? 'Allowed in this channel:' : '이 채널에 허용된 묶음:');
    for (const entry of granted) {
      lines.push(`- ${surfaceGroupLabel(entry.group, language)} (${entry.at.slice(0, 10)}, ${sourceLabel(entry.source, language)})`);
    }
  }
  if (suspended && granted.length > 0) {
    lines.push(language === 'en' ? 'All of them are paused now (agent stopped).' : '지금은 모두 멈춰 있어요(에이전트 중지).');
  }
  lines.push(alwaysLine(language), dmOnlyLine(language));
  return lines.join('\n');
}

/** D4.4 `채널 권한 목록` (DM): every channel with grants, named by its ids, with its groups. */
export function renderSurfaceAllChannelsList(
  channels: readonly { readonly channelId: string; readonly groups: readonly SurfaceGroupId[] }[],
  suspended: boolean,
  language: SurfaceCopyLanguage,
): string {
  if (channels.length === 0) return language === 'en' ? 'No channel has permissions granted.' : '권한이 허용된 채널이 없어요.';
  const lines = [language === 'en' ? 'Channels with permissions:' : '권한이 허용된 채널:'];
  for (const channel of channels) {
    lines.push(`- ${channel.channelId}: ${channel.groups.map((id) => surfaceGroupLabel(id, language)).join(', ')}`);
  }
  if (suspended) lines.push(language === 'en' ? 'All of them are paused now (agent stopped).' : '지금은 모두 멈춰 있어요(에이전트 중지).');
  return lines.join('\n');
}

export function renderSurfaceRevoked(groups: readonly SurfaceGroupId[], language: SurfaceCopyLanguage): string {
  if (groups.length === 0) {
    return language === 'en' ? 'Those were not allowed in this channel. Nothing changed.' : '이 채널에 허용돼 있지 않은 묶음이에요. 바뀐 것은 없어요.';
  }
  const labels = groups.map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en' ? `Removed from this channel: ${labels}.` : `이 채널에서 해제했어요: ${labels}.`;
}

export function renderSurfaceChannelCleared(count: number, language: SurfaceCopyLanguage): string {
  if (count === 0) return language === 'en' ? 'This channel had no permissions. Nothing changed.' : '이 채널에는 허용된 묶음이 없었어요. 바뀐 것은 없어요.';
  return language === 'en' ? 'Removed every permission of this channel.' : '이 채널의 권한을 모두 해제했어요.';
}

export function renderSurfaceAllCleared(channels: number, language: SurfaceCopyLanguage): string {
  if (channels === 0) return language === 'en' ? 'No channel had permissions. Nothing changed.' : '권한이 허용된 채널이 없었어요. 바뀐 것은 없어요.';
  return language === 'en' ? `Removed the permissions of every channel (${channels}).` : `모든 채널(${channels}개)의 권한을 해제했어요.`;
}

/** The one-line owner DM receipt of a revoke (D3, owner decision 10). */
export function renderSurfaceRevokeReceipt(channelId: string, groups: readonly SurfaceGroupId[] | 'all', language: SurfaceCopyLanguage = 'ko'): string {
  const what = groups === 'all' ? (language === 'en' ? 'every permission' : '모든 권한') : groups.map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en' ? `Channel permission removed: ${channelId} — ${what}.` : `채널 권한 해제: ${channelId} — ${what}.`;
}

export function renderSurfaceAllRevokeReceipt(channels: number, language: SurfaceCopyLanguage = 'ko'): string {
  return language === 'en' ? `Channel permissions removed in every channel (${channels}).` : `모든 채널(${channels}개)의 권한을 해제했어요.`;
}

/** D6: the seed DM, first application. */
export function renderSurfaceSeedApplied(channelId: string, groups: readonly SurfaceGroupId[]): string {
  return `배포 시 사전 허용: ${channelId}에 ${groups.map((id) => surfaceGroupLabel(id)).join(', ')}. 해제: 그 채널에서 "이 채널 권한 모두 해제".`;
}

/** D6: a changed seed value that adds groups absent now (they may have been revoked since the earlier seed). */
export function renderSurfaceSeedReAdded(channelId: string, groups: readonly SurfaceGroupId[]): string {
  return `배포 설정이 바뀌어 해제하셨던 ${groups.map((id) => surfaceGroupLabel(id)).join(', ')}을(를) ${channelId}에 다시 허용했어요. 원치 않으면 그 채널에서 '… 허용 해제'라고 보내 주세요.`;
}

/** A6-D3 / D4.6: the kill-switch phrase while only the channel grants (not A6 actions) are on. */
export function renderSurfaceSwitchReply(state: 'running' | 'stopped' | undefined, language: SurfaceCopyLanguage): string {
  if (state === undefined) {
    return language === 'en' ? 'I could not save the switch. Nothing changed; please try again.' : '스위치를 저장하지 못했어요. 아무것도 바뀌지 않았어요. 다시 시도해 주세요.';
  }
  if (state === 'stopped') {
    return language === 'en'
      ? 'Every channel permission is paused (kept, not deleted). Send "에이전트 재개" to resume.'
      : '채널 권한을 모두 멈췄어요(지우지 않고 보관해요). 다시 켜려면 "에이전트 재개"라고 보내 주세요.';
  }
  return language === 'en' ? 'Channel permissions are active again.' : '채널 권한을 다시 켰어요.';
}

/** The line appended to the A6 switch reply while the channel grants are enforced too (D4.6). */
export function renderSurfaceSwitchSuffix(state: 'running' | 'stopped', language: SurfaceCopyLanguage): string {
  if (state === 'stopped') return language === 'en' ? 'Every channel permission is paused as well.' : '채널 권한도 모두 멈췄어요.';
  return language === 'en' ? 'Channel permissions are active again as well.' : '채널 권한도 다시 켰어요.';
}

/** The label set of the closed table, for help and tests. */
export function surfaceGroupLabels(language: SurfaceCopyLanguage): readonly string[] {
  return Object.values(SURFACE_GROUPS).map((definition) => definition.label[language]);
}
