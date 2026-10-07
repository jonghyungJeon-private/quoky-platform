import { Capability, SessionStatus, now as sharedClock } from '@quoky/core';
import type {
  AiExecutionLocality,
  AiProvider,
  Id,
  IsoTimestamp,
  Logger,
  ProviderPreference,
  ProviderSelectionContext,
  ProviderSelectionPolicy,
  Session,
} from '@quoky/core';
import type { OllamaModelInventory } from '@quoky/ai-cli';
import { sameOllamaModel } from '@quoky/ai-cli';
import type { ProviderCatalog } from './provider-catalog';
import {
  CHAT_TIER_CAPABILITIES,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_PINNED_CAPABILITIES,
  IMAGE_CHOICE_LOCALITY,
  chatChoiceFromData,
  chatChoiceIsCloud,
  chatChoiceToData,
  imageChoiceFromData,
  parseChatChoiceToken,
  parseImageChoiceToken,
} from './selection-choices';
import type { ChatChoice, ImageChoice, SelectionSource } from './selection-choices';
import type { PersistedProviderSelection, ProviderSelectionStore } from './selection-store';

/**
 * The owner's runtime model switch (ADR-0092 amendment and ADR-0111 amendment, runtime switching): the effective
 * selection, its precedence, its persistence, and the Core `ProviderSelectionPolicy` the router consults.
 *
 * **Precedence** (highest first), separately for the chat tier and for image understanding:
 *   1. `session`   — the owner's chat command in this conversation (`모델 변경: …`), stored on the Session row's
 *                    metadata (`quoky.providerSelection`), written field-scoped under the shared session write lock;
 *                    a new conversation (`새 대화`) opens a new Session, so the override ends with its Session.
 *   2. `persisted` — the operations-UI default (`<db dir>/ops/provider-selection.json`), survives restarts.
 *   3. `env`       — `QUOKY_CHAT_PROVIDER` / `QUOKY_IMAGE_UNDERSTANDING_PROVIDER`.
 *   4. `default`   — the derived default (`QUOKY_OLLAMA_ENABLED`; `QUOKY_OLLAMA_VISION_MODEL` presence).
 * A layer whose choice cannot run on this host (for example a Codex choice with no Codex registered) is skipped and
 * reported, never silently honoured.
 *
 * **Policy.** Chat tier: the effective choice's provider first, Claude next (selection-time fallback when the chosen
 * one is not ready). Image understanding: only the effective image provider (none for `off`), and the Core image
 * locality policy allows `REMOTE` only while the effective image choice is `claude`. Code, review, planning, project
 * analysis, tests and policy-sensitive chat: Claude (plus the configured Ollama chat model as the existing local code
 * fallback when the global chat default is Ollama), never a session choice. Every other capability: no preference.
 *
 * Readiness probes still decide availability; this service only expresses preference, as data.
 */

export const SESSION_SELECTION_METADATA_KEY = 'quoky.providerSelection';

export interface SessionSelection {
  readonly chat?: ChatChoice;
  readonly image?: ImageChoice;
}

export interface EffectiveChatSelection {
  readonly choice: ChatChoice;
  readonly label: string;
  readonly source: SelectionSource;
  readonly provider: AiProvider;
  /** Higher layers that named a choice this host cannot run. */
  readonly ignored: readonly SelectionSource[];
}

export interface EffectiveImageSelection {
  readonly choice: ImageChoice;
  readonly source: SelectionSource;
  /** `null` for `off`. */
  readonly provider: AiProvider | null;
  readonly ignored: readonly SelectionSource[];
}

export interface SelectionOption {
  readonly tier: 'chat' | 'image';
  /** The canonical choice token (`claude:opus`, `codex`, `ollama:granite3.3:8b`; image `claude`, `ollama`, `off`). */
  readonly token: string;
  /** `undefined` when readiness could not be determined. */
  readonly ready: boolean | undefined;
  /** Where the content goes when this option answers. */
  readonly egress: 'LOCAL' | 'ANTHROPIC' | 'OPENAI' | 'NONE';
  /** This option is the effective choice of the asked scope. */
  readonly current: boolean;
}

export interface SelectionStatus {
  readonly chat: EffectiveChatSelection & {
    readonly ready: boolean | undefined;
    /** Set when the chosen provider is not ready and Claude answers instead (the selection-time fallback). */
    readonly fallbackLabel?: string;
  };
  readonly image: EffectiveImageSelection & { readonly ready: boolean | undefined };
  /** The selection a conversation without its own override uses. */
  readonly defaults: { readonly chat: EffectiveChatSelection; readonly image: EffectiveImageSelection };
  /** The label of the Claude model that keeps code, review, planning and policy-sensitive chat. */
  readonly pinnedLabel: string;
}

export type SelectionRefusal =
  | 'UNKNOWN_PROVIDER'
  | 'CLAUDE_MODEL_NOT_ALLOWED'
  | 'CODEX_MODEL_NOT_ALLOWED'
  | 'MODEL_INVALID'
  | 'PROVIDER_NOT_ON_HOST'
  | 'OLLAMA_MODEL_NOT_FOUND'
  | 'OLLAMA_UNAVAILABLE'
  | 'IMAGE_CHOICE_INVALID'
  | 'IMAGE_OPTION_UNAVAILABLE'
  | 'TOO_MANY_MODELS';

export type ValidatedChoice<T> = { readonly ok: true; readonly choice: T } | { readonly ok: false; readonly refusal: SelectionRefusal };

export type SelectionWriteResult =
  | { readonly status: 'SET' | 'CLEARED' | 'UNCHANGED' }
  | { readonly status: 'SESSION_GONE' }
  | { readonly status: 'WRITE_FAILED' };

/** Who changed the selection, for the audit line. */
export interface SelectionActor {
  readonly surface: 'chat' | 'ops-ui';
  /** The owner Actor id (chat), or `owner` for the operations UI token holder. */
  readonly actor: string;
}

export interface ProviderSelectionServiceDeps {
  readonly catalog: ProviderCatalog;
  /** The installation-configured chat selection and whether it was set explicitly (`env`) or derived (`default`). */
  readonly envChat: { readonly choice: ChatChoice; readonly source: 'env' | 'default' };
  readonly envImage: { readonly choice: ImageChoice; readonly source: 'env' | 'default' };
  readonly store: ProviderSelectionStore;
  /** The session store, resolved at call time (storage repositories exist only after `storage.init()`). */
  readonly sessions: () => {
    get(id: Id): Promise<Session | null>;
    list?(): Promise<Session[]>;
  };
  /** The field-scoped, lock-held session metadata update (`SessionManager.updateMetadataEntry`). */
  readonly updateSessionEntry: (
    sessionId: Id,
    key: string,
    update: (current: unknown) => unknown,
  ) => Promise<Session | null>;
  /** A cached readiness probe (`AiProviderManager.isReady`). */
  readonly readiness: (provider: AiProvider) => Promise<boolean>;
  /** The local Ollama model inventory (`ollama list`). */
  readonly ollamaModels: () => Promise<OllamaModelInventory>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly clock?: () => IsoTimestamp;
}

const CHAT_TIER = new Set<Capability>(CHAT_TIER_CAPABILITIES);
const PINNED = new Set<Capability>(CLAUDE_PINNED_CAPABILITIES);

/** Parse a session's stored selection; anything malformed is dropped, and a closed session has none. */
export function sessionSelectionOf(session: Session | null): SessionSelection {
  if (session === null || session.status !== SessionStatus.ACTIVE) return {};
  return selectionFromData(session.metadata?.[SESSION_SELECTION_METADATA_KEY]);
}

function selectionFromData(raw: unknown): SessionSelection {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as { chat?: unknown; image?: unknown };
  const chat = record.chat === undefined ? null : chatChoiceFromData(record.chat);
  const image = record.image === undefined ? null : imageChoiceFromData(record.image);
  return { ...(chat ? { chat } : {}), ...(image ? { image } : {}) };
}

export class ProviderSelectionService implements ProviderSelectionPolicy {
  private readonly clock: () => IsoTimestamp;

  constructor(private readonly deps: ProviderSelectionServiceDeps) {
    this.clock = deps.clock ?? sharedClock;
  }

  // ── Core policy ────────────────────────────────────────────────────────────────────────────────────────────────

  async preferenceFor(capability: Capability, context: ProviderSelectionContext): Promise<ProviderPreference | null> {
    const claudeKey = this.deps.catalog.claude.id;
    try {
      if (CHAT_TIER.has(capability)) {
        const chat = await this.effectiveChat(context.sessionId);
        return { eligible: unique([chat.provider.id, claudeKey]), order: 'listed' };
      }
      if (capability === Capability.IMAGE_UNDERSTANDING) {
        const image = await this.effectiveImage(context.sessionId);
        return { eligible: image.provider === null ? [] : [image.provider.id], order: 'listed' };
      }
      if (PINNED.has(capability)) return this.pinnedPreference();
      return null;
    } catch {
      // Fail safe: the chat tier and pinned work go to Claude, images go nowhere.
      this.deps.logger.warn('provider selection unavailable; using the safe default', { capability });
      if (capability === Capability.IMAGE_UNDERSTANDING) return { eligible: [], order: 'listed' };
      if (CHAT_TIER.has(capability) || PINNED.has(capability)) return { eligible: [claudeKey], order: 'listed' };
      return null;
    }
  }

  /**
   * ADR-0111 amendment (runtime switching): the Core image locality policy for this request. `REMOTE` is allowed only
   * while the EFFECTIVE image choice is `claude`; switching to `ollama` or `off` stops cloud egress on the next turn.
   */
  async imageLocalities(context: ProviderSelectionContext): Promise<readonly AiExecutionLocality[]> {
    try {
      const image = await this.effectiveImage(context.sessionId);
      return image.choice === 'claude' && image.provider !== null ? ['LOCAL', 'REMOTE'] : ['LOCAL'];
    } catch {
      return ['LOCAL'];
    }
  }

  private pinnedPreference(): ProviderPreference {
    const { catalog } = this.deps;
    const global = this.chatFromLayers({});
    const ollama = global.choice.provider === 'ollama' && catalog.ollama !== undefined ? [catalog.ollama.id] : [];
    return { eligible: [catalog.claude.id, ...ollama], order: 'priority' };
  }

  // ── Effective selection ────────────────────────────────────────────────────────────────────────────────────────

  async sessionSelection(sessionId: Id | undefined): Promise<SessionSelection> {
    if (sessionId === undefined) return {};
    return sessionSelectionOf(await this.deps.sessions().get(sessionId));
  }

  async effectiveChat(sessionId?: Id): Promise<EffectiveChatSelection> {
    return this.chatFromLayers(await this.sessionSelection(sessionId));
  }

  async effectiveImage(sessionId?: Id): Promise<EffectiveImageSelection> {
    return this.imageFromLayers(await this.sessionSelection(sessionId));
  }

  /** The selection without any session override (what a new conversation uses). */
  globalChat(): EffectiveChatSelection {
    return this.chatFromLayers({});
  }

  globalImage(): EffectiveImageSelection {
    return this.imageFromLayers({});
  }

  private chatFromLayers(session: SessionSelection): EffectiveChatSelection {
    const { catalog, envChat, store } = this.deps;
    const layers: Array<[SelectionSource, ChatChoice | undefined]> = [
      ['session', session.chat],
      ['persisted', store.get().chat],
      [envChat.source, envChat.choice],
    ];
    const ignored: SelectionSource[] = [];
    for (const [source, choice] of layers) {
      if (choice === undefined) continue;
      const provider = catalog.resolveChat(choice);
      if (provider !== undefined) {
        const normalized = catalog.normalize(choice);
        return { choice: normalized, label: catalog.label(normalized), source, provider, ignored };
      }
      ignored.push(source);
    }
    return { choice: { provider: 'claude' }, label: catalog.label({ provider: 'claude' }), source: 'default', provider: catalog.claude, ignored };
  }

  private imageFromLayers(session: SessionSelection): EffectiveImageSelection {
    const { catalog, envImage, store } = this.deps;
    const layers: Array<[SelectionSource, ImageChoice | undefined]> = [
      ['session', session.image],
      ['persisted', store.get().image],
      [envImage.source, envImage.choice],
    ];
    const ignored: SelectionSource[] = [];
    for (const [source, choice] of layers) {
      if (choice === undefined) continue;
      const provider = catalog.resolveImage(choice);
      if (provider !== undefined) return { choice, source, provider, ignored };
      ignored.push(source);
    }
    return { choice: 'off', source: 'default', provider: null, ignored };
  }

  // ── Validation ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** Parse and validate a chat-tier token against this host (an Ollama model against the local `ollama list`). */
  async validateChatToken(token: string): Promise<ValidatedChoice<ChatChoice>> {
    const { catalog } = this.deps;
    // The configured `QUOKY_CLAUDE_MODEL` is always selectable by its own label, even when it is not an alias.
    if (token.trim().toLowerCase() === `claude:${catalog.claudeModel}`.toLowerCase()) {
      return { ok: true, choice: { provider: 'claude' } };
    }
    const parsed = parseChatChoiceToken(token);
    if (!parsed.ok) return { ok: false, refusal: parsed.reason };
    const choice = catalog.normalize(parsed.choice);
    if (!catalog.canChoose(choice.provider)) return { ok: false, refusal: 'PROVIDER_NOT_ON_HOST' };
    if (choice.provider === 'ollama') {
      if (choice.model === undefined && catalog.ollama === undefined) return { ok: false, refusal: 'PROVIDER_NOT_ON_HOST' };
      const inventory = await this.deps.ollamaModels();
      if (inventory.status !== 'OK') return { ok: false, refusal: 'OLLAMA_UNAVAILABLE' };
      const wanted = choice.model ?? catalog.ollamaModel;
      if (!inventory.models.some((model) => sameOllamaModel(model, wanted))) {
        return { ok: false, refusal: 'OLLAMA_MODEL_NOT_FOUND' };
      }
    }
    if (catalog.resolveChat(choice) === undefined) return { ok: false, refusal: 'TOO_MANY_MODELS' };
    return { ok: true, choice };
  }

  validateImageToken(token: string): ValidatedChoice<ImageChoice> {
    const choice = parseImageChoiceToken(token);
    if (choice === null) return { ok: false, refusal: 'IMAGE_CHOICE_INVALID' };
    if (this.deps.catalog.resolveImage(choice) === undefined) return { ok: false, refusal: 'IMAGE_OPTION_UNAVAILABLE' };
    return { ok: true, choice };
  }

  // ── Session override (chat command) ───────────────────────────────────────────────────────────────────────────

  async setSessionChat(sessionId: Id, choice: ChatChoice, actor: SelectionActor): Promise<SelectionWriteResult> {
    const result = await this.writeSession(sessionId, (current) => ({ ...current, chat: choice }));
    if (result.status === 'SET') this.audit(actor, 'session', 'chat', this.deps.catalog.label(choice), sessionId);
    return result;
  }

  async setSessionImage(sessionId: Id, choice: ImageChoice, actor: SelectionActor): Promise<SelectionWriteResult> {
    const result = await this.writeSession(sessionId, (current) => ({ ...current, image: choice }));
    if (result.status === 'SET') this.audit(actor, 'session', 'image', choice, sessionId);
    return result;
  }

  /** Clear this session's chat and image override (`all`) or the image override only. */
  async resetSession(sessionId: Id, tier: 'all' | 'image', actor: SelectionActor): Promise<SelectionWriteResult> {
    let had = false;
    const result = await this.writeSession(sessionId, (current) => {
      had = tier === 'all' ? current.chat !== undefined || current.image !== undefined : current.image !== undefined;
      return tier === 'all' ? {} : { ...(current.chat ? { chat: current.chat } : {}) };
    });
    if (result.status !== 'SET') return result;
    if (!had) return { status: 'UNCHANGED' };
    this.audit(actor, 'session', tier === 'all' ? 'chat+image' : 'image', 'reset', sessionId);
    return { status: 'CLEARED' };
  }

  private async writeSession(
    sessionId: Id,
    next: (current: SessionSelection) => SessionSelection,
  ): Promise<SelectionWriteResult> {
    try {
      const saved = await this.deps.updateSessionEntry(sessionId, SESSION_SELECTION_METADATA_KEY, (raw) => {
        const updated = next(selectionFromData(raw));
        if (updated.chat === undefined && updated.image === undefined) return undefined;
        return {
          ...(updated.chat ? { chat: chatChoiceToData(updated.chat) } : {}),
          ...(updated.image ? { image: updated.image } : {}),
          setAt: this.clock(),
        };
      });
      return saved === null ? { status: 'SESSION_GONE' } : { status: 'SET' };
    } catch {
      this.deps.logger.warn('provider selection session write failed', { code: 'SESSION_WRITE_FAILED' });
      return { status: 'WRITE_FAILED' };
    }
  }

  // ── Persisted default (operations UI) ─────────────────────────────────────────────────────────────────────────

  /** Set (or with `null`, reset to the configuration) the chat-tier default. */
  setDefaultChat(choice: ChatChoice | null, actor: SelectionActor): SelectionWriteResult {
    const { chat: _chat, ...rest } = this.deps.store.get();
    return this.writeDefault(choice === null ? rest : { ...rest, chat: choice }, actor, 'chat', choice === null ? 'reset' : this.deps.catalog.label(choice));
  }

  /** Set (or with `null`, reset to the configuration) the image default. */
  setDefaultImage(choice: ImageChoice | null, actor: SelectionActor): SelectionWriteResult {
    const { image: _image, ...rest } = this.deps.store.get();
    return this.writeDefault(choice === null ? rest : { ...rest, image: choice }, actor, 'image', choice ?? 'reset');
  }

  private writeDefault(
    next: { chat?: ChatChoice; image?: ImageChoice },
    actor: SelectionActor,
    tier: 'chat' | 'image',
    selection: string,
  ): SelectionWriteResult {
    try {
      this.deps.store.save({ ...next, updatedAt: this.clock() });
    } catch {
      this.deps.logger.warn('provider selection default write failed', { code: 'SELECTION_FILE_WRITE_FAILED', tier });
      return { status: 'WRITE_FAILED' };
    }
    this.audit(actor, 'default', tier, selection);
    return { status: selection === 'reset' ? 'CLEARED' : 'SET' };
  }

  /** The audit line of every selection change: who, where, which tier, what (labels only; never content). */
  private audit(actor: SelectionActor, scope: 'session' | 'default', tier: string, selection: string, sessionId?: Id): void {
    this.deps.logger.info('provider.selection.changed', {
      surface: actor.surface,
      actor: actor.actor,
      scope,
      tier,
      selection,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  // ── Status and options ────────────────────────────────────────────────────────────────────────────────────────

  async status(sessionId?: Id): Promise<SelectionStatus> {
    const session = await this.sessionSelection(sessionId);
    const chat = this.chatFromLayers(session);
    const image = this.imageFromLayers(session);
    const { catalog } = this.deps;
    const chatReady = await this.ready(chat.provider);
    const claudeReady = chat.provider === catalog.claude ? chatReady : await this.ready(catalog.claude);
    const fallback = chatReady === false && chat.provider !== catalog.claude && claudeReady !== false;
    return {
      chat: { ...chat, ready: chatReady, ...(fallback ? { fallbackLabel: catalog.label({ provider: 'claude' }) } : {}) },
      image: { ...image, ready: image.provider === null ? undefined : await this.ready(image.provider) },
      defaults: { chat: this.chatFromLayers({}), image: this.imageFromLayers({}) },
      pinnedLabel: catalog.label({ provider: 'claude' }),
    };
  }

  /**
   * Every selectable option on this host with its readiness: the Claude aliases, Codex when registered, the local Ollama
   * models (`ollama list`), then the image options. `current` marks the effective choice for `sessionId` (or the
   * default when absent). Probes are the cached readiness probes; no provider is executed and no model is loaded.
   */
  async options(sessionId?: Id): Promise<SelectionOption[]> {
    const { catalog } = this.deps;
    const session = await this.sessionSelection(sessionId);
    const chat = this.chatFromLayers(session);
    const image = this.imageFromLayers(session);
    const options: SelectionOption[] = [];
    const claudeReady = await this.ready(catalog.claude);
    const aliases = [catalog.claudeModel, ...CLAUDE_MODEL_ALIASES.filter((alias) => alias !== catalog.claudeModel)];
    for (const model of aliases) {
      const token = catalog.label({ provider: 'claude', model });
      options.push({ tier: 'chat', token, ready: claudeReady, egress: 'ANTHROPIC', current: chat.label === token });
    }
    if (catalog.codex !== undefined) {
      options.push({ tier: 'chat', token: 'codex', ready: await this.ready(catalog.codex), egress: 'OPENAI', current: chat.label === 'codex' });
    }
    if (catalog.ollamaUsable) {
      const inventory = await this.deps.ollamaModels();
      const models = inventory.status === 'OK' ? [...inventory.models] : [];
      if (catalog.ollama !== undefined && !models.some((model) => sameOllamaModel(model, catalog.ollamaModel))) {
        models.unshift(catalog.ollamaModel);
      }
      for (const model of models) {
        const token = catalog.label({ provider: 'ollama', model });
        const listed = inventory.status === 'OK' && inventory.models.some((m) => sameOllamaModel(m, model));
        options.push({
          tier: 'chat',
          token,
          ready: inventory.status === 'OK' ? listed : false,
          egress: 'LOCAL',
          current: chat.label === token,
        });
      }
    }
    for (const choice of ['claude', 'ollama', 'off'] as const) {
      const provider = catalog.resolveImage(choice);
      if (provider === undefined) continue;
      options.push({
        tier: 'image',
        token: choice,
        ready: provider === null ? undefined : await this.ready(provider),
        egress: IMAGE_CHOICE_LOCALITY[choice] === 'REMOTE' ? 'ANTHROPIC' : IMAGE_CHOICE_LOCALITY[choice] === 'LOCAL' ? 'LOCAL' : 'NONE',
        current: image.choice === choice,
      });
    }
    return options;
  }

  /** The stored operations-UI default (absent entries = the configuration applies). */
  persistedDefault(): PersistedProviderSelection {
    return this.deps.store.get();
  }

  /** How many open conversations carry their own override (operations UI display; a count only). */
  async sessionOverrideCount(): Promise<number | undefined> {
    const list = this.deps.sessions().list;
    if (list === undefined) return undefined;
    const sessions = await list.call(this.deps.sessions());
    return sessions.filter((session) => {
      const selection = sessionSelectionOf(session);
      return selection.chat !== undefined || selection.image !== undefined;
    }).length;
  }

  /** Whether a chat choice sends content off this host (Claude and Codex do). */
  isCloud(choice: ChatChoice): boolean {
    return chatChoiceIsCloud(choice);
  }

  private async ready(provider: AiProvider): Promise<boolean | undefined> {
    try {
      return await this.deps.readiness(provider);
    } catch {
      return undefined;
    }
  }
}

function unique(keys: readonly string[]): string[] {
  return keys.filter((key, index) => keys.indexOf(key) === index);
}
