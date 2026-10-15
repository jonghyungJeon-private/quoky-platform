import { renderDriveDmOnly } from '../drive/drive-reply-renderer';
import { renderMailDmOnly } from '../mail/mail-reply-renderer';
import { renderBriefDmOnly } from '../reminders/reminder-turn-handler';
import type { SurfaceDecision } from './surface-gate';
import { DM_ONLY_SURFACE_GROUPS, GRANTABLE_SURFACE_GROUPS, SURFACE_GROUPS, surfaceGroupLabel, type SurfaceGroupId } from './surface-groups';
import { SURFACE_GRANT_MAX_CHANNELS } from './surface-grant-record';

/**
 * ADR-0122 fixed copy (KO/EN). Every reply here carries no data: no item, no message text, no channel or user name.
 * A channel is named only by its id inside a PLT-0 conversation-reference span rendered by the platform (P2 lists).
 */

export type SurfaceCopyLanguage = 'ko' | 'en';

/**
 * P2: the grant phrase (`이 채널에 … 허용`) and its `허용 실행` confirmation exist, so the denial copy tells the owner how
 * to grant (ADR D2.7). The hint names only the group's label: no data, nothing read.
 */
export const SURFACE_GRANT_PHRASE_AVAILABLE = true;

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

/** The grant phrase without a session store to hold the confirmation (a composition without it). Nothing changes. */
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
    ? `I did not recognize that permission group. Groups: ${labels}. Example: "이 채널에 캘린더 허용" or "이 채널에 캘린더 허용 해제".`
    : `어떤 묶음인지 모르겠어요. 묶음: ${labels}. 예: "이 채널에 캘린더 허용", "이 채널에 캘린더 허용 해제".`;
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

// ── the grant and its confirmation (D4.1–D4.3, P2) ───────────────────────────────────────────────────────────────

/** D4.3: the content-free audience facts an adapter may add from its cache (never fetched). */
export interface SurfaceAudienceFacts {
  readonly memberUpperBound?: number;
  readonly restricted?: boolean;
}

/** D4.3: "서버 인원 최대 N명 · 비공개 채널: 예/아니오"; nothing known → the neutral line. */
export function renderSurfaceAudienceLine(audience: SurfaceAudienceFacts | undefined, language: SurfaceCopyLanguage): string {
  const count = audience?.memberUpperBound;
  const knownCount = typeof count === 'number' && Number.isInteger(count) && count >= 0;
  const knownRestricted = typeof audience?.restricted === 'boolean';
  if (!knownCount && !knownRestricted) {
    return language === 'en' ? 'I could not tell how many people can see it' : '몇 명이 볼 수 있는지 확인하지 못했어요';
  }
  const parts: string[] = [];
  if (knownCount) parts.push(language === 'en' ? `server members: at most ${count}` : `서버 인원 최대 ${count}명`);
  if (knownRestricted) {
    parts.push(language === 'en' ? `private channel: ${audience!.restricted ? 'yes' : 'no'}` : `비공개 채널: ${audience!.restricted ? '예' : '아니오'}`);
  }
  return parts.join(' · ');
}

/** D4.2: the extra warning line of a strong group (`undefined` for the others). */
export function renderSurfaceStrongWarning(group: SurfaceGroupId, language: SurfaceCopyLanguage): string | undefined {
  switch (group) {
    case 'slack-search':
      return language === 'en'
        ? 'Slack search results can include messages from private channels and DMs.'
        : 'Slack 검색 결과에는 비공개 채널·DM 메시지도 나올 수 있어요.';
    case 'jira-project':
      return language === 'en'
        ? 'Issues assigned to other people and release lists are shown too.'
        : '다른 사람 담당 이슈와 릴리스 목록도 보여요.';
    case 'writes':
      return language === 'en'
        ? 'Each approval card shows the whole content to be sent in this channel.'
        : '승인 카드에 보낼 내용 전체가 이 채널에 보여요.';
    case 'code':
      return language === 'en'
        ? 'Code work includes GitHub writes (push, PR creation, merge, remote branch delete), and code and diffs are shown here.'
        : '코드 작업에는 GitHub 쓰기(푸시·PR 생성·병합·원격 브랜치 삭제)가 포함되고, 코드와 diff가 이 채널에 보여요.';
    default:
      return undefined;
  }
}

/** The read groups a connector write needs besides `writes` (D1, owner decision 5). */
export const SURFACE_WRITE_READ_GROUPS: readonly SurfaceGroupId[] = Object.freeze(['jira-mine', 'slack-search', 'calendar'] as SurfaceGroupId[]);

/** D4.2: the confirmation of `이 채널에 … 허용` (nothing is saved until `허용 실행`). */
export function renderSurfaceGrantConfirm(input: {
  readonly groups: readonly SurfaceGroupId[];
  readonly audience?: SurfaceAudienceFacts;
  /** For `writes`: the service read groups this channel would still lack (D1: a write also needs its read group). */
  readonly missingWriteReadGroups: readonly SurfaceGroupId[];
  readonly suspended: boolean;
  readonly language: SurfaceCopyLanguage;
}): string {
  const { language } = input;
  const labels = input.groups.map((id) => surfaceGroupLabel(id, language)).join(', ');
  const lines: string[] = [];
  if (language === 'en') {
    lines.push(`Allow the following in this channel? · ${labels}`);
    lines.push(`Everyone who can see this channel can see the answers. ${renderSurfaceAudienceLine(input.audience, 'en')}.`);
  } else {
    lines.push(`이 채널에 다음을 허용할까요? · ${labels}`);
    lines.push(`이 채널을 볼 수 있는 사람은 모두 답을 볼 수 있어요. ${renderSurfaceAudienceLine(input.audience, 'ko')}.`);
  }
  for (const id of input.groups) {
    const warning = renderSurfaceStrongWarning(id, language);
    if (warning !== undefined) lines.push(`${language === 'en' ? 'Note' : '주의'}: ${warning}`);
  }
  if (input.groups.includes('writes') && input.missingWriteReadGroups.length > 0) {
    const missing = input.missingWriteReadGroups.map((id) => surfaceGroupLabel(id, language)).join(', ');
    lines.push(
      language === 'en'
        ? `A write also needs that service's read permission here; not allowed yet: ${missing}.`
        : `외부 쓰기는 같은 서비스의 조회 권한도 있어야 동작해요. 아직 없는 것: ${missing}.`,
    );
  }
  if (input.suspended) {
    lines.push(language === 'en' ? 'Channel permissions are paused now (agent stopped); this takes effect after "에이전트 재개".' : '지금은 채널 권한이 모두 멈춰 있어요(에이전트 중지). "에이전트 재개" 후에 적용돼요.');
  }
  lines.push(
    language === 'en'
      ? 'To allow it, send "허용 실행" within 2 minutes. Any other message cancels this.'
      : '허용하려면 2분 안에 "허용 실행"이라고 보내 주세요. 다른 말을 보내면 취소돼요.',
  );
  return lines.join('\n');
}

/** `허용 실행` saved the grant. */
export function renderSurfaceGranted(groups: readonly SurfaceGroupId[], suspended: boolean, language: SurfaceCopyLanguage): string {
  const labels = groups.map((id) => surfaceGroupLabel(id, language)).join(', ');
  const base = language === 'en' ? `Allowed in this channel: ${labels}.` : `이 채널에 허용했어요: ${labels}.`;
  if (!suspended) return base;
  return language === 'en' ? `${base} They are paused until "에이전트 재개".` : `${base} "에이전트 재개" 전까지는 멈춰 있어요.`;
}

/** Every group asked for is already granted here: nothing to confirm. */
export function renderSurfaceAlreadyGranted(groups: readonly SurfaceGroupId[], language: SurfaceCopyLanguage): string {
  const labels = groups.map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en' ? `Already allowed in this channel: ${labels}. Nothing changed.` : `이미 이 채널에 허용돼 있어요: ${labels}. 바뀐 것은 없어요.`;
}

/** `허용 실행` after the 2-minute window. */
export function renderSurfaceGrantExpired(language: SurfaceCopyLanguage): string {
  return language === 'en'
    ? 'The 2 minutes to confirm have passed. Nothing was allowed. Send "이 채널에 … 허용" again.'
    : '허용 확인 시간(2분)이 지났어요. 아무것도 허용하지 않았어요. 다시 "이 채널에 … 허용"이라고 보내 주세요.';
}

/** `허용 실행` with no grant waiting in this channel. */
export function renderSurfaceGrantNoPending(language: SurfaceCopyLanguage): string {
  return language === 'en'
    ? 'No permission is waiting for confirmation here. Nothing was changed.'
    : '지금 허용을 기다리는 요청이 없어요. 아무것도 바꾸지 않았어요.';
}

/** Owner decision 13: a 17th channel. */
export function renderSurfaceGrantChannelLimit(language: SurfaceCopyLanguage): string {
  return language === 'en'
    ? `Permissions can be allowed in at most ${SURFACE_GRANT_MAX_CHANNELS} channels. Nothing was allowed. Clear another channel first ("이 채널 권한 모두 해제" there).`
    : `채널 권한은 최대 ${SURFACE_GRANT_MAX_CHANNELS}개 채널에만 허용할 수 있어요. 아무것도 허용하지 않았어요. 다른 채널의 권한을 먼저 해제해 주세요(그 채널에서 "이 채널 권한 모두 해제").`;
}

/** The one-line owner DM receipt of a grant (D3, owner decision 10). */
export function renderSurfaceGrantReceipt(channelId: string, groups: readonly SurfaceGroupId[], language: SurfaceCopyLanguage = 'ko'): string {
  const what = groups.map((id) => surfaceGroupLabel(id, language)).join(', ');
  return language === 'en' ? `Channel permission allowed: ${channelId} — ${what}.` : `채널 권한 허용: ${channelId} — ${what}.`;
}

/** Help lines of the owner's channel-permission phrases (shown only while `QUOKY_CHANNEL_GRANTS=enforce`). */
export const SURFACE_GRANT_HELP_LINES: readonly string[] = Object.freeze([
  '- 채널 권한(그 채널에서): "이 채널에 캘린더 허용" → 2분 안에 "허용 실행", "이 채널 권한 보여줘"',
  '- 채널 권한 해제: "이 채널에 캘린더 허용 해제", "이 채널 권한 모두 해제", DM에서 "채널 권한 목록", "모든 채널 권한 해제"',
]);
