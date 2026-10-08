import type { IsoTimestamp, Logger, NotificationSinkOutcome, OwnerNotification } from '@quoky/core';

import type {
  OpsActionOutcome,
  OpsProviderOptionView,
  OpsProviderSelectionPage,
  OpsProviderTierView,
} from '../http/view-model';
import type { OpsOwnerResolution } from '../snapshot/build-snapshot';
import { guardText } from '../snapshot/guard';
import type {
  ProviderSelectionService,
  SelectionOption,
  SelectionRefusal,
} from '../../provider-selection/provider-selection-service';
import type { SelectionSource } from '../../provider-selection/selection-choices';

/**
 * The operations-UI side of the owner's runtime model switch (ADR-0092 amendment and ADR-0111 amendment, runtime
 * switching; ADR-0113 D7 handling rules):
 *
 * - **Owner only.** Every call resolves the owner `Actor` (ADR-0009 mapping, read-only); zero or several Actors refuse
 *   (`ACTIONS_DISABLED`), fail closed — the same gate as every other UI action.
 * - **No bypass.** The page and the change go through `ProviderSelectionService`, the one place the chat command uses
 *   too; this module validates the option again at execution time (an Ollama model against `ollama list`).
 * - **What changes.** Only the persisted DEFAULT (the private file beside the DB), never a conversation's own chat
 *   override, so a conversation that ran `모델 변경` keeps its choice.
 * - **Audit and notice.** The service writes the content-free `provider.selection.changed` line (surface `ops-ui`); a
 *   successful change sends one `OPS_DECISION_RESULT` DM to the owner ("운영 화면에서 대화 모델을 codex로 바꿨어요"),
 *   never to a channel and never resent. The UI shows only the outcome code and fixed copy.
 * - **Display.** Labels (`claude:opus`, `codex`, `ollama:<model>`, `claude`/`ollama`/`off`), sources, readiness and the
 *   egress note; every string passes the strict credential guard again.
 *
 * Option subjects are `chat:<token>`, `chat:reset`, `image:<choice>` and `image:reset`.
 */

export interface OpsProviderSelectionDeps {
  readonly service: Pick<
    ProviderSelectionService,
    | 'globalChat'
    | 'globalImage'
    | 'options'
    | 'status'
    | 'validateChatToken'
    | 'validateImageToken'
    | 'setDefaultChat'
    | 'setDefaultImage'
    | 'sessionOverrideCount'
    | 'persistedDefault'
  >;
  readonly owner: () => Promise<OpsOwnerResolution>;
  /** The owner DM target (`QUOKY_DISCORD_OWNER_IDS`, first id); absent → no notice. */
  readonly notice?: {
    readonly platform: string;
    readonly userId: string;
    readonly notify: (notification: OwnerNotification) => Promise<NotificationSinkOutcome>;
  };
  readonly clock: () => IsoTimestamp;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

const DISABLED: OpsActionOutcome = {
  code: 'ACTIONS_DISABLED',
  message: '소유자 ID가 정확히 하나의 Actor에 연결되어 있지 않아 처리할 수 없어요. 채팅을 쓰세요.',
  ok: false,
};
const FAILED: OpsActionOutcome = { code: 'FAILED', message: '처리하지 못했어요. 잠시 뒤 다시 시도하세요.', ok: false };
const INVALID: OpsActionOutcome = { code: 'INVALID_OPTION', message: '알 수 없는 선택이에요. 모델 기본값 화면에서 다시 고르세요.', ok: false };

const REFUSALS: Readonly<Record<SelectionRefusal, OpsActionOutcome>> = {
  UNKNOWN_PROVIDER: INVALID,
  CLAUDE_MODEL_NOT_ALLOWED: INVALID,
  CODEX_MODEL_NOT_ALLOWED: INVALID,
  MODEL_INVALID: INVALID,
  IMAGE_CHOICE_INVALID: INVALID,
  PROVIDER_NOT_ON_HOST: { code: 'PROVIDER_NOT_ON_HOST', message: '그 모델은 이 컴퓨터에서 쓸 수 없어요. 바꾸지 않았어요.', ok: false },
  OLLAMA_MODEL_NOT_FOUND: { code: 'OLLAMA_MODEL_NOT_FOUND', message: '로컬 Ollama에 그 모델이 없어요. 바꾸지 않았어요.', ok: false },
  OLLAMA_MODEL_NOT_CHAT: { code: 'OLLAMA_MODEL_NOT_CHAT', message: '그 Ollama 모델은 대화용이 아니에요 (예: 임베딩 전용). 바꾸지 않았어요.', ok: false },
  OLLAMA_UNAVAILABLE: { code: 'OLLAMA_UNAVAILABLE', message: 'Ollama가 응답하지 않아 모델을 확인하지 못했어요. 바꾸지 않았어요.', ok: false },
  IMAGE_OPTION_UNAVAILABLE: { code: 'IMAGE_OPTION_UNAVAILABLE', message: '그 이미지 모델은 이 컴퓨터에 설정되어 있지 않아요. 바꾸지 않았어요.', ok: false },
  TOO_MANY_MODELS: { code: 'TOO_MANY_MODELS', message: '이번 실행에서 고를 수 있는 모델 수를 넘었어요. 바꾸지 않았어요.', ok: false },
};

const SOURCE_TEXT: Readonly<Record<'chat' | 'image', Readonly<Record<SelectionSource, string>>>> = {
  chat: {
    session: '대화별 변경',
    persisted: '운영 화면 기본값 (다시 시작해도 유지)',
    env: '설정 QUOKY_CHAT_PROVIDER',
    default: '기본값 (QUOKY_OLLAMA_ENABLED에서 도출)',
  },
  image: {
    session: '대화별 변경',
    persisted: '운영 화면 기본값 (다시 시작해도 유지)',
    env: '설정 QUOKY_IMAGE_UNDERSTANDING_PROVIDER',
    default: '기본값 (QUOKY_OLLAMA_VISION_MODEL에서 도출)',
  },
};

/** The one-line warning shown with the cloud image option (ADR-0111 amendment: images leave the host). */
export const OPS_CLOUD_IMAGE_WARNING = '이 선택은 첨부 이미지를 이 컴퓨터 밖(Anthropic)으로 보내요.';
/** The same warning for the Codex image option (ADR-0111 amendment of 2026-10-08: images go to OpenAI). */
export const OPS_CODEX_IMAGE_WARNING = '이 선택은 첨부 이미지를 이 컴퓨터 밖(OpenAI)으로 보내요.';

/** The egress warning for a cloud image option, by where its bytes go; none for a local or `off` option. */
function cloudImageWarning(option: Pick<SelectionOption, 'tier' | 'egress'>): string | undefined {
  if (option.tier !== 'image') return undefined;
  if (option.egress === 'ANTHROPIC') return OPS_CLOUD_IMAGE_WARNING;
  if (option.egress === 'OPENAI') return OPS_CODEX_IMAGE_WARNING;
  return undefined;
}

function readinessText(ready: boolean | undefined): string {
  return ready === true ? '준비됨' : ready === false ? '준비 안 됨' : '';
}

function egressText(option: Pick<SelectionOption, 'egress'>): string {
  switch (option.egress) {
    case 'LOCAL':
      return '로컬 (이 컴퓨터를 떠나지 않아요)';
    case 'OPENAI':
      return '클라우드 (OpenAI로 전송)';
    case 'ANTHROPIC':
      return '클라우드 (Anthropic으로 전송)';
    default:
      return '사용 안 함';
  }
}

/** The DM notice text for a changed default (fixed copy + the label only). */
export function providerDefaultNoticeText(tier: 'chat' | 'image', label: string, reset: boolean): string {
  const what = tier === 'chat' ? '대화 모델' : '이미지 모델';
  const head = reset
    ? `[Quoky 운영 화면] 운영 화면에서 ${what}을 설정 기본값(${label})으로 되돌렸어요.`
    : `[Quoky 운영 화면] 운영 화면에서 ${what}을 ${label}로 바꿨어요.`;
  const tail =
    tier === 'image' && label === 'claude'
      ? ' 이제 첨부 이미지가 Anthropic으로 전송돼요.'
      : tier === 'image' && label === 'codex'
        ? ' 이제 첨부 이미지가 OpenAI로 전송돼요.'
        : ' 채팅에서 따로 바꾸지 않은 대화에 바로 적용돼요.';
  return `${head}${tail}`;
}

export class OpsProviderSelectionActions {
  constructor(private readonly deps: OpsProviderSelectionDeps) {}

  async page(): Promise<OpsProviderSelectionPage> {
    const owner = await this.ownerOrRefusal();
    if (owner !== null) return { status: 'REFUSED', outcome: owner };
    try {
      const { service } = this.deps;
      const [options, status, overrides] = await Promise.all([
        service.options(),
        service.status(),
        service.sessionOverrideCount().catch(() => undefined),
      ]);
      const persisted = service.persistedDefault();
      const view = (option: SelectionOption): OpsProviderOptionView => {
        const warning = cloudImageWarning(option);
        return {
          subject: `${option.tier}:${option.token}`,
          label: guardText(option.token),
          readiness: readinessText(option.ready),
          egress: egressText(option),
          current: option.current,
          ...(warning !== undefined ? { warning } : {}),
        };
      };
      const chat: OpsProviderTierView = {
        effective: guardText(status.defaults.chat.label),
        source: SOURCE_TEXT.chat[status.defaults.chat.source],
        readiness:
          readinessText(status.chat.ready) +
          (status.chat.fallbackLabel !== undefined ? ` → 지금은 ${guardText(status.chat.fallbackLabel)}가 대신 답해요` : ''),
        options: options.filter((option) => option.tier === 'chat').map(view),
        ...(persisted.chat !== undefined
          ? { reset: { subject: 'chat:reset', label: '설정 기본값으로 되돌리기 (대화)', readiness: '', egress: '', current: false } }
          : {}),
      };
      const image: OpsProviderTierView = {
        effective: status.defaults.image.choice,
        source: SOURCE_TEXT.image[status.defaults.image.source],
        readiness: status.defaults.image.provider === null ? '' : readinessText(status.image.ready),
        options: options.filter((option) => option.tier === 'image').map(view),
        ...(persisted.image !== undefined
          ? { reset: { subject: 'image:reset', label: '설정 기본값으로 되돌리기 (이미지)', readiness: '', egress: '', current: false } }
          : {}),
      };
      return {
        status: 'OK',
        chat,
        image,
        sessionOverrides: overrides === undefined ? 'unknown' : `${overrides}개`,
        notes: [
          '코드 작업·리뷰·계획·민감한 대화는 항상 Claude가 맡아요 (바꿀 수 없어요).',
          '선택한 모델이 준비되지 않으면 Claude가 대신 답해요.',
          '채팅의 "모델 변경"은 그 대화에만 적용되고, 여기 기본값보다 우선해요.',
        ],
      };
    } catch {
      this.deps.logger.warn('ops-ui.provider_selection_failed', { surface: 'ops-ui' });
      return { status: 'REFUSED', outcome: FAILED };
    }
  }

  /** Set or reset one default; `subject` comes from the server-side one-time intent. */
  async setDefault(subject: string): Promise<OpsActionOutcome> {
    let owner: OpsOwnerResolution;
    try {
      owner = await this.deps.owner();
    } catch {
      return DISABLED;
    }
    if (owner.status !== 'RESOLVED') return DISABLED;
    const actor = { surface: 'ops-ui' as const, actor: owner.actorId };
    const match = /^(chat|image):(.{1,160})$/u.exec(subject);
    if (match === null) return INVALID;
    const tier = match[1] as 'chat' | 'image';
    const token = match[2] as string;
    const { service } = this.deps;
    try {
      if (tier === 'chat') {
        if (token === 'reset') {
          const written = service.setDefaultChat(null, actor);
          if (written.status === 'WRITE_FAILED') return FAILED;
          return this.changed('chat', service.globalChat().label, true);
        }
        const validated = await service.validateChatToken(token);
        if (!validated.ok) return REFUSALS[validated.refusal];
        if (service.setDefaultChat(validated.choice, actor).status === 'WRITE_FAILED') return FAILED;
        return this.changed('chat', service.globalChat().label, false);
      }
      if (token === 'reset') {
        if (service.setDefaultImage(null, actor).status === 'WRITE_FAILED') return FAILED;
        return this.changed('image', service.globalImage().choice, true);
      }
      const validated = service.validateImageToken(token);
      if (!validated.ok) return REFUSALS[validated.refusal];
      if (service.setDefaultImage(validated.choice, actor).status === 'WRITE_FAILED') return FAILED;
      return this.changed('image', validated.choice, false);
    } catch {
      this.deps.logger.warn('ops-ui.provider_selection_failed', { surface: 'ops-ui' });
      return FAILED;
    }
  }

  private async changed(tier: 'chat' | 'image', label: string, reset: boolean): Promise<OpsActionOutcome> {
    const delivery = await this.notify(tier, label, reset);
    const what = tier === 'chat' ? '대화 모델' : '이미지 모델';
    const head = reset ? `${what} 기본값을 설정값(${label})으로 되돌렸어요.` : `${what} 기본값을 ${label}로 바꿨어요.`;
    const notice =
      delivery === 'SENT' ? 'DM으로 알렸어요.' : delivery === 'NONE' ? '' : 'DM 알림은 보내지 못했어요.';
    return { code: reset ? 'DEFAULT_RESET' : 'DEFAULT_SET', message: guardText(`${head} ${notice}`.trim()), ok: true };
  }

  private async notify(tier: 'chat' | 'image', label: string, reset: boolean): Promise<NotificationSinkOutcome['status'] | 'FAILED' | 'NONE'> {
    const notice = this.deps.notice;
    if (notice === undefined) return 'NONE';
    let delivery: NotificationSinkOutcome['status'] | 'FAILED';
    try {
      const sent = await notice.notify({
        correlationId: `ops-provider-default-${tier}-${Date.parse(this.deps.clock())}`,
        // Owner DM only: no guild, so no channel routing is possible.
        target: { platform: notice.platform, channelId: '', userId: notice.userId },
        kind: 'OPS_DECISION_RESULT',
        text: guardText(providerDefaultNoticeText(tier, label, reset)),
      });
      delivery = sent.status;
    } catch {
      delivery = 'FAILED';
    }
    this.deps.logger[delivery === 'SENT' ? 'info' : 'warn']('ops-ui.provider_default_notice', { surface: 'ops-ui', tier, delivery });
    return delivery;
  }

  /** `null` when the owner resolves to exactly one Actor; otherwise the fail-closed refusal. */
  private async ownerOrRefusal(): Promise<OpsActionOutcome | null> {
    try {
      return (await this.deps.owner()).status === 'RESOLVED' ? null : DISABLED;
    } catch {
      return DISABLED;
    }
  }
}
