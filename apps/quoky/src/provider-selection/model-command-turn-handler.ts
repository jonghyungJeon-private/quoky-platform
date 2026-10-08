import { parseModelSelectionCommand } from '@quoky/core';
import { OPENAI_MODEL_ALLOW_LIST } from '@quoky/ai-openai-api';
import type {
  ConversationTurnHandler,
  Id,
  Logger,
  ModelSelectionChoice,
  ModelSelectionCommand,
  TurnHandlerContext,
  TurnHandlerReply,
} from '@quoky/core';
import type {
  ProviderSelectionService,
  SelectionOption,
  SelectionRefusal,
  SelectionStatus,
} from './provider-selection-service';
import { IMAGE_CHOICE_EGRESS } from './selection-choices';
import type { ImageChoice, SelectionSource } from './selection-choices';

/**
 * The owner's model-selection chat command (ADR-0092 amendment, runtime switching; OpenClaw `/model` style) as an
 * ADR-0096 `pre-classify` turn handler. Deterministic and owner-only, it never calls a provider (readiness probes and
 * `ollama list` only), creates no Task and changes nothing but the CALLER's own override in THIS conversation (keyed by
 * Session and Actor) — never another Actor's, and never the global default, which the operations UI owns.
 *
 * - `모델 상태` / `/model status`: the effective chat and image selection, its source and readiness.
 * - `모델 목록` / `/model`: a numbered list of the selectable chat-tier models and image options with readiness. The
 *   numbers stay valid for this conversation for {@link MODEL_LISTING_TTL_MS} (like the learning listings).
 * - `모델 변경: codex` / `모델 변경: 2` / `/model claude:opus` / `/model openai:gpt-4.1-mini` / `/model ollama:granite3.3:8b`: this session's chat tier.
 * - `이미지 모델 변경: ollama` / `이미지 모델 변경: codex` / `/model image off`: this session's image understanding.
 * - `모델 기본값으로` / `/model reset` (and `이미지 모델 기본값으로`): clear this session's override.
 *
 * Writes go through `ProviderSelectionService` → `SessionManager.updateMetadataEntry` (field-scoped, under the shared
 * session write lock); a new conversation (`새 대화`) opens a fresh Session, so the override ends with its Session.
 */

export const MODEL_SELECTION_TURN_HANDLER_ID = 'model-selection';
/** `pre-classify`, order 70: after the learning commands (60), before to-dos (100). */
export const MODEL_SELECTION_TURN_HANDLER_ORDER = 70;
/** List numbers stay valid this long (the ADR-0107 learning-listing window). */
export const MODEL_LISTING_TTL_MS = 30 * 60 * 1000;
/** At most this many conversations' listings are remembered (oldest dropped first). */
export const MODEL_LISTING_MAX_BINDINGS = 64;

/** One contributed help line (ADR-0096 D6; under the composer's 120-character bound). */
export const MODEL_SELECTION_HELP_LINES: readonly string[] = Object.freeze([
  '- 모델: "모델 상태", "모델 목록", "모델 변경: codex", "이미지 모델 변경: off", "모델 기본값으로" (이 대화에서만)',
]);

const SESSION_ONLY = '이 대화에서만 적용돼요 (기본값은 운영 화면에서).';

export const MODEL_SELECTION_COPY = {
  notOwner: '모델 변경은 소유자만 할 수 있어요.',
  failed: '모델 선택을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
  sessionGone: '이 대화가 이미 끝나서 바꾸지 않았어요. 새 대화에서 다시 시도해 주세요.',
  usage:
    '모델 명령은 이렇게 써요: "모델 상태", "모델 목록", "모델 변경: codex"(또는 목록 번호), "/model claude:opus", ' +
    '"이미지 모델 변경: claude|ollama|off", "모델 기본값으로". 이 대화에서만 적용돼요.',
  listFirst: '먼저 "모델 목록"을 보여 달라고 해 주세요. 번호는 목록을 본 뒤 30분 동안만 이 대화에서 쓸 수 있어요.',
  numberNotListed: '목록에 없는 번호예요. "모델 목록"을 다시 확인해 주세요.',
  numberIsChat: '그 번호는 대화 모델이에요. "모델 변경: 번호"로 고르세요.',
} as const;

const REFUSAL_COPY: Readonly<Record<SelectionRefusal, string>> = {
  UNKNOWN_PROVIDER: '모르는 모델이에요. claude, codex, ollama, openai 중에서 고르거나 "모델 목록"을 보세요.',
  CLAUDE_MODEL_NOT_ALLOWED: 'Claude 모델은 sonnet, opus, haiku 중에서만 고를 수 있어요 (예: "모델 변경: claude:opus").',
  CODEX_MODEL_NOT_ALLOWED: 'Codex 모델은 설정(QUOKY_CODEX_MODEL)으로만 정해요. "모델 변경: codex"로 고르세요.',
  OPENAI_MODEL_NOT_ALLOWED: `OpenAI 모델은 ${OPENAI_MODEL_ALLOW_LIST.join(', ')} 중에서만 고를 수 있어요 (예: "모델 변경: openai:gpt-4.1-mini").`,
  MODEL_INVALID: '모델 이름이 올바르지 않아요. "모델 목록"에서 고르세요.',
  PROVIDER_NOT_ON_HOST: '그 모델은 이 컴퓨터에서 쓸 수 없어요 (CLI나 모델 설정이 없어요). "모델 목록"에서 고르세요.',
  OLLAMA_MODEL_NOT_FOUND: '로컬 Ollama에 그 모델이 없어요. "모델 목록"에서 고르세요.',
  OLLAMA_MODEL_NOT_CHAT: '그 Ollama 모델은 대화용이 아니에요 (예: 임베딩 전용). 바꾸지 않았어요. "모델 목록"에서 고르세요.',
  OLLAMA_UNAVAILABLE: 'Ollama가 응답하지 않아 로컬 모델을 확인하지 못했어요. 바꾸지 않았어요.',
  IMAGE_CHOICE_INVALID: '이미지 모델은 claude, codex, ollama, openai, off 중에서 고를 수 있어요.',
  IMAGE_OPTION_UNAVAILABLE:
    '그 이미지 모델은 이 컴퓨터에 설정되어 있지 않아요 (codex는 Codex CLI, openai는 QUOKY_OPENAI_API_KEY와 QUOKY_OPENAI_MODEL, 로컬은 QUOKY_OLLAMA_VISION_MODEL이 필요해요).',
  TOO_MANY_MODELS: '이번 실행에서 고를 수 있는 모델 수를 넘었어요. 이미 쓴 모델을 고르거나 다시 시작한 뒤 고르세요.',
};

const SOURCE_LABEL: Readonly<Record<'chat' | 'image', Readonly<Record<SelectionSource, string>>>> = {
  chat: {
    session: '이 대화에서 변경',
    persisted: '운영 화면 기본값',
    env: '설정(QUOKY_CHAT_PROVIDER)',
    default: '기본값(설정에서 도출)',
  },
  image: {
    session: '이 대화에서 변경',
    persisted: '운영 화면 기본값',
    env: '설정(QUOKY_IMAGE_UNDERSTANDING_PROVIDER)',
    default: '기본값(설정에서 도출)',
  },
};

function readiness(ready: boolean | undefined): string {
  return ready === true ? '준비됨' : ready === false ? '준비 안 됨' : '확인 못 함';
}

/** Whether a chat label's content goes to OpenAI (Codex CLI or the OpenAI API). */
function isOpenAiLabel(label: string): boolean {
  return label === 'codex' || label.startsWith('openai:');
}

function chatEgress(label: string): string {
  if (label.startsWith('ollama:')) return '로컬(이 컴퓨터를 떠나지 않아요)';
  return isOpenAiLabel(label) ? '클라우드(OpenAI로 전송)' : '클라우드(Anthropic으로 전송)';
}

function imageEgress(choice: ImageChoice): string {
  switch (IMAGE_CHOICE_EGRESS[choice]) {
    case 'ANTHROPIC':
      return '클라우드(이미지가 Anthropic으로 전송돼요)';
    case 'OPENAI':
      return '클라우드(이미지가 OpenAI로 전송돼요)';
    case 'LOCAL':
      return '로컬(이미지가 이 컴퓨터를 떠나지 않아요)';
    default:
      return '이미지 분석 안 함';
  }
}

function optionEgress(option: SelectionOption): string {
  if (option.egress === 'LOCAL') return '로컬';
  if (option.egress === 'NONE') return '사용 안 함';
  return option.egress === 'OPENAI' ? '클라우드(OpenAI)' : '클라우드(Anthropic)';
}

export function renderModelStatus(status: SelectionStatus): string {
  const { chat, image, defaults } = status;
  const chatLine = [`- 대화: ${chat.label}`, `출처: ${SOURCE_LABEL.chat[chat.source]}`, readiness(chat.ready), chatEgress(chat.label)];
  const lines = ['모델 상태 (이 대화 기준)', chatLine.join(' · ')];
  if (chat.fallbackLabel !== undefined) lines.push(`  → ${chat.label}가 준비되지 않아 지금은 ${chat.fallbackLabel}가 대신 답해요.`);
  else if (chat.ready === false) lines.push('  → 지금 준비된 대화 모델이 없어요.');
  if (chat.ignored.length > 0) lines.push('  → 이 컴퓨터에서 쓸 수 없는 선택은 건너뛰었어요.');
  const imageLine = [`- 이미지: ${image.choice}`, `출처: ${SOURCE_LABEL.image[image.source]}`];
  if (image.provider !== null) imageLine.push(readiness(image.ready));
  imageLine.push(imageEgress(image.choice));
  lines.push(imageLine.join(' · '));
  if (image.ignored.length > 0) lines.push('  → 이 컴퓨터에서 쓸 수 없는 이미지 선택은 건너뛰었어요.');
  lines.push(`- 기본값: 대화 ${defaults.chat.label} (${SOURCE_LABEL.chat[defaults.chat.source]}), 이미지 ${defaults.image.choice} (${SOURCE_LABEL.image[defaults.image.source]})`);
  lines.push(`- 코드 작업·리뷰·계획·민감한 대화는 항상 ${status.pinnedLabel}가 맡아요.`);
  return lines.join('\n');
}

export function renderModelList(options: readonly SelectionOption[]): string {
  const lines = ['고를 수 있는 모델이에요 (번호는 30분 동안 이 대화에서 쓸 수 있어요).', '대화:'];
  options.forEach((option, index) => {
    if (option.tier === 'image' && options[index - 1]?.tier !== 'image') lines.push('이미지:');
    const parts = [`${index + 1}. ${option.tier === 'image' ? `이미지 ${option.token}` : option.token}`];
    if (option.ready !== undefined) parts.push(readiness(option.ready));
    parts.push(optionEgress(option));
    if (option.current) parts.push('현재');
    lines.push(parts.join(' · '));
  });
  lines.push(`바꾸려면 "모델 변경: 2" 또는 "/model codex"처럼 보내 주세요. ${SESSION_ONLY}`);
  return lines.join('\n');
}

function renderChatSet(label: string, status: SelectionStatus): string {
  const parts = [`이 대화의 대화 모델을 ${label}로 바꿨어요. ${SESSION_ONLY}`];
  parts.push(label.startsWith('ollama:') ? '대화 내용은 이 컴퓨터를 떠나지 않아요.' : `대화 내용이 ${isOpenAiLabel(label) ? 'OpenAI' : 'Anthropic'}로 전송돼요.`);
  if (status.chat.fallbackLabel !== undefined) parts.push(`지금은 ${label}가 준비되지 않아 ${status.chat.fallbackLabel}가 대신 답해요.`);
  return parts.join(' ');
}

function renderImageSet(choice: ImageChoice): string {
  const egress = IMAGE_CHOICE_EGRESS[choice];
  const tail =
    egress === 'ANTHROPIC'
      ? '이미지가 Anthropic으로 전송돼요.'
      : egress === 'OPENAI'
        ? '이미지가 OpenAI로 전송돼요.'
        : egress === 'LOCAL'
          ? '이미지는 이 컴퓨터를 떠나지 않아요.'
          : '이 대화에서는 이미지를 분석하지 않아요.';
  return `이 대화의 이미지 모델을 ${choice}로 바꿨어요. ${SESSION_ONLY} ${tail}`;
}

interface Listing {
  readonly tokens: ReadonlyArray<{ readonly tier: 'chat' | 'image'; readonly token: string }>;
  readonly boundAtMs: number;
}

export interface ModelSelectionTurnHandlerDeps {
  readonly service: Pick<
    ProviderSelectionService,
    'status' | 'options' | 'validateChatToken' | 'validateImageToken' | 'setSessionChat' | 'setSessionImage' | 'resetSession'
  >;
  /** The configured owner ids (`QUOKY_DISCORD_OWNER_IDS`); the platform gate admits only them, this re-checks. */
  readonly ownerIds: readonly string[];
  readonly logger?: Pick<Logger, 'warn'>;
}

export class ModelSelectionTurnHandler implements ConversationTurnHandler {
  readonly id = MODEL_SELECTION_TURN_HANDLER_ID;
  readonly stage = 'pre-classify' as const;
  readonly order = MODEL_SELECTION_TURN_HANDLER_ORDER;
  readonly helpLines = MODEL_SELECTION_HELP_LINES;
  private readonly listings = new Map<string, Listing>();

  constructor(private readonly deps: ModelSelectionTurnHandlerDeps) {}

  async handle(ctx: TurnHandlerContext): Promise<TurnHandlerReply | null> {
    const command = parseModelSelectionCommand(ctx.message.text);
    if (command === null) return null;
    const reply = (text: string, status: 'RESPONDED' | 'FAILED' = 'RESPONDED'): TurnHandlerReply => ({
      reply: { context: ctx.message.context, text },
      status,
    });
    // Defense in depth: the Discord entry boundary (ADR-0091) admits only owners; a non-owner never changes anything.
    if (!this.deps.ownerIds.includes(ctx.message.context.userId)) return reply(MODEL_SELECTION_COPY.notOwner);
    try {
      return reply(await this.run(command, ctx));
    } catch (err) {
      try {
        this.deps.logger?.warn('model selection command failed', {
          command: command.kind,
          errorName: err instanceof Error ? err.name : typeof err,
        });
      } catch {
        // best-effort
      }
      return reply(MODEL_SELECTION_COPY.failed, 'FAILED');
    }
  }

  private async run(command: ModelSelectionCommand, ctx: TurnHandlerContext): Promise<string> {
    // The caller's own override only: keyed by (Session, Actor), so a shared channel Session never mixes Actors.
    const scope = { sessionId: ctx.session.id, actorId: ctx.actor.id };
    const actor = { surface: 'chat' as const, actor: ctx.actor.id };
    const { service } = this.deps;
    switch (command.kind) {
      case 'usage':
        return MODEL_SELECTION_COPY.usage;
      case 'status':
        return renderModelStatus(await service.status(scope));
      case 'list': {
        const options = await service.options(scope);
        this.bind(this.listingKey(scope), options, Date.parse(ctx.now));
        return renderModelList(options);
      }
      case 'reset': {
        const result = await service.resetSession(scope, command.tier, actor);
        if (result.status === 'SESSION_GONE') return MODEL_SELECTION_COPY.sessionGone;
        if (result.status === 'WRITE_FAILED') return MODEL_SELECTION_COPY.failed;
        const status = await service.status(scope);
        const defaults = `대화 ${status.chat.label}, 이미지 ${status.image.choice}`;
        const what = command.tier === 'image' ? '이미지 모델 선택' : '모델 선택';
        return result.status === 'UNCHANGED'
          ? `이 대화에는 따로 바꾼 ${what}이 없어요. 지금은 ${defaults}을 써요.`
          : `이 대화의 ${what}을 지웠어요. 이제 기본값(${defaults})을 써요.`;
      }
      case 'set':
        return this.set(command.tier, command.choice, scope, actor, Date.parse(ctx.now));
    }
  }

  private async set(
    tier: 'chat' | 'image',
    choice: ModelSelectionChoice,
    scope: { readonly sessionId: Id; readonly actorId: Id },
    actor: { surface: 'chat'; actor: string },
    nowMs: number,
  ): Promise<string> {
    let target: { tier: 'chat' | 'image'; token: string };
    if (choice.kind === 'number') {
      const listed = this.resolve(this.listingKey(scope), choice.number, nowMs);
      if (listed === 'NO_LISTING') return MODEL_SELECTION_COPY.listFirst;
      if (listed === 'NOT_LISTED') return MODEL_SELECTION_COPY.numberNotListed;
      if (tier === 'image' && listed.tier === 'chat') return MODEL_SELECTION_COPY.numberIsChat;
      target = listed;
    } else {
      target = { tier, token: choice.token };
    }
    const { service } = this.deps;
    if (target.tier === 'image') {
      const validated = service.validateImageToken(target.token);
      if (!validated.ok) return REFUSAL_COPY[validated.refusal];
      const written = await service.setSessionImage(scope, validated.choice, actor);
      return this.written(written.status) ?? renderImageSet(validated.choice);
    }
    const validated = await service.validateChatToken(target.token);
    if (!validated.ok) return REFUSAL_COPY[validated.refusal];
    const written = await service.setSessionChat(scope, validated.choice, actor);
    const refused = this.written(written.status);
    if (refused !== undefined) return refused;
    const status = await service.status(scope);
    return renderChatSet(status.chat.label, status);
  }

  private written(status: string): string | undefined {
    if (status === 'SESSION_GONE') return MODEL_SELECTION_COPY.sessionGone;
    if (status === 'WRITE_FAILED') return MODEL_SELECTION_COPY.failed;
    return undefined;
  }

  /** Listings are per (Session, Actor) too: one Actor's numbers never resolve for another. */
  private listingKey(scope: { readonly sessionId: Id; readonly actorId: Id }): string {
    return `${scope.sessionId}\u0000${scope.actorId}`;
  }

  private bind(key: string, options: readonly SelectionOption[], nowMs: number): void {
    this.listings.delete(key);
    this.listings.set(key, { tokens: options.map(({ tier, token }) => ({ tier, token })), boundAtMs: nowMs });
    while (this.listings.size > MODEL_LISTING_MAX_BINDINGS) {
      const oldest = this.listings.keys().next().value;
      if (oldest === undefined) break;
      this.listings.delete(oldest);
    }
  }

  private resolve(
    key: string,
    number: number,
    nowMs: number,
  ): { tier: 'chat' | 'image'; token: string } | 'NO_LISTING' | 'NOT_LISTED' {
    const listing = this.listings.get(key);
    if (
      listing === undefined ||
      !Number.isFinite(nowMs) ||
      nowMs < listing.boundAtMs ||
      nowMs - listing.boundAtMs > MODEL_LISTING_TTL_MS
    ) {
      this.listings.delete(key);
      return 'NO_LISTING';
    }
    return listing.tokens[number - 1] ?? 'NOT_LISTED';
  }
}
