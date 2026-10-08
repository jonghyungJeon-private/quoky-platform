import type { Id, IsoTimestamp, Metadata } from './common';
import type { Artifact } from './artifact';
import type { MessageContent } from './message-content';

/**
 * The conversation surface a message belongs to, expressed in GENERIC terms.
 *
 * IMPORTANT: these are plain strings, never platform SDK objects. This is the
 * boundary that keeps platform specifics (each chat platform's own adapter) out
 * of the core. A PlatformAdapter is responsible for translating its native
 * channel/guild/thread objects into this shape.
 */
export interface ConversationContext {
  /** Opaque platform identifier, set by the adapter. */
  platform: string;
  /** Generic "space" id — the platform's server or workspace, when it has one. */
  spaceId?: string;
  channelId: string;
  threadId?: string;
  userId: string;
  /**
   * Set by the adapter (PLT-0): true for a one-to-one conversation with the owner (a DM / private chat), false for a
   * channel or group. Absent on contexts recorded earlier; Core then treats a context without a `spaceId` as direct.
   */
  direct?: boolean;
}

/** Legacy, unused placeholder (pre-ADR-0111). Inbound attachments use {@link InboundAttachment}. */
export interface Attachment {
  id: Id;
  name: string;
  mimeType?: string;
  /** Remote URL as seen by the platform. */
  url?: string;
  /** Path once downloaded into the local workspace (filled in later). */
  localPath?: string;
}

/** ADR-0111 D1: what a platform adapter's bounded intake made of one attachment. */
export type InboundAttachmentKind = 'text' | 'image' | 'unsupported';

/** Why an attachment was not taken in (ADR-0111 D2/D3); the reply names the file with this reason. */
export type InboundAttachmentUnsupportedReason =
  /** Neither a UTF-8 text file (`text/*`, `.log`, `.md`, `.json`) nor a png/jpeg/webp image. */
  | 'UNSUPPORTED_TYPE'
  /** Over the size bound (declared size or bytes actually received). */
  | 'TOO_LARGE'
  /** Past the per-message attachment count bound. */
  | 'TOO_MANY'
  /** A text file the credential guard refused (ADR-0097); its content is dropped. */
  | 'CREDENTIAL_SHAPED'
  /** Declared as text but not valid UTF-8 text. */
  | 'NOT_UTF8_TEXT'
  /** A png/jpeg/webp image (a supported type) whose bytes failed structural validation: corrupt or malformed. */
  | 'INVALID_IMAGE'
  /** Not fetched from the platform's own CDN, or the transfer failed. */
  | 'DOWNLOAD_FAILED';

/** Image types the intake accepts (ADR-0111 D2). */
export type InboundImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

interface InboundAttachmentBase {
  /** Display name as uploaded, sanitized by the adapter (control characters removed, bounded). Untrusted. */
  readonly name: string;
  /** The platform-declared MIME type, when one was given. */
  readonly mimeType?: string;
  /** The platform-declared size in bytes. */
  readonly sizeBytes: number;
}

/**
 * A text file (ADR-0111 D3): bounded UTF-8 content held in memory only. Always UNTRUSTED readout — data, never
 * instructions — and already passed the credential guard. Never written into a workspace or durable memory.
 */
export interface InboundTextAttachment extends InboundAttachmentBase {
  readonly kind: 'text';
  readonly text: string;
  readonly trust: 'UNTRUSTED';
}

/**
 * An image (ADR-0111 D2/D4): an opaque, runner-owned local reference (a temporary file the adapter deletes after
 * the turn). Core never reads, persists, embeds or logs it; only an `IMAGE_UNDERSTANDING` provider receives it.
 */
export interface InboundImageAttachment extends InboundAttachmentBase {
  readonly kind: 'image';
  readonly mimeType: InboundImageMimeType;
  readonly imageRef: string;
  readonly trust: 'UNTRUSTED';
}

/** An attachment the intake refused; it carries no content, only the reason. */
export interface InboundUnsupportedAttachment extends InboundAttachmentBase {
  readonly kind: 'unsupported';
  readonly reason: InboundAttachmentUnsupportedReason;
}

/** One attachment of an admitted inbound message (ADR-0111 D1). Platform-neutral: no platform type crosses. */
export type InboundAttachment = InboundTextAttachment | InboundImageAttachment | InboundUnsupportedAttachment;

/** A normalized inbound message from any PlatformAdapter. */
export interface InboundMessage {
  id: Id;
  context: ConversationContext;
  text: string;
  /**
   * ADR-0111 D1 (optional, additive): attachments of a message that already passed the adapter's admission gate,
   * after bounded intake. Absent when the message had none.
   */
  attachments?: readonly InboundAttachment[];
  receivedAt: IsoTimestamp;
  metadata?: Metadata;
}

/** One file's portion of a code-change preview — the COMPLETE unified diff for that path, never clamped
 *  (Sprint 4c-Follow-up-5, F5-A). */
export interface PreviewFile {
  path: string;
  changeKind: 'add' | 'update' | 'delete';
  unifiedDiff: string;
}

/**
 * A COMPLETE structured code-change preview (Sprint 4c-Follow-up-5, F5-A / CA RC2). Produced in core from
 * the CodeProposal → Workspace diff; a PlatformAdapter chooses a delivery strategy (multipart text vs a
 * complete `.diff` attachment) and owns all platform presentation. `canonicalDiff` is the byte-for-byte
 * source of truth for delivery-equality (CA RC3). Platform-neutral: carries NO platform specifics.
 */
export interface PreviewArtifact {
  /** Stable, secret-safe correlation id for one preview's whole delivery lifecycle (Sprint 4c-Follow-up-5,
   *  F5-E). Generated once when the artifact is created; shared across every chunk, the attachment
   *  fallback, the delivery report, and safe logs. Never a content-derived hash. */
  previewId: string;
  /** Display-neutral header/summary prose (apply-boundary framing) — never the diff body. */
  header: string;
  /** Out-of-scope safety warning (Sprint 4c-Follow-up-5) — present when the proposal touched paths outside
   *  the requested/approved scope. MUST be delivered with the preview (final text message + attachment
   *  caption); it is a safety notice, not framing. Absent when there is nothing out of scope. */
  warning?: string;
  /** Trailing apply-boundary prose shown on the FINAL delivered message/attachment (CA RC9). */
  footer: string;
  files: PreviewFile[];
  /** The complete concatenated canonical diff payload under one newline policy. */
  canonicalDiff: string;
  /** Non-secret filename for the `.diff` attachment fallback. */
  attachmentFilename: string;
}

/**
 * How an adapter may present `OutboundMessage.text` (opt-in, ADR-0111 amendment of 2026-10-08). `model-reply`: the text
 * is a provider-generated answer (chat, summary, analysis, image reading), so an adapter MAY adapt its Markdown to the
 * platform (e.g. tables a platform cannot render). Absent: the text is delivered exactly as given — every
 * deterministic reply, preview, approval text, connector-write preview, diff and reminder.
 */
export type OutboundMessageFormat = 'model-reply';

/** A normalized outbound message the PlatformAdapter renders natively. */
export interface OutboundMessage {
  context: ConversationContext;
  text: string;
  /** Artifacts may be rendered as files, embeds, code blocks, etc. */
  artifacts?: Artifact[];
  replyToMessageId?: Id;
  metadata?: Metadata;
  /** A complete structured code-change preview (Sprint 4c-Follow-up-5, F5-A). When present, a
   *  preview-aware adapter delivers the FULL diff losslessly (multipart or attachment) instead of the
   *  bounded `text`. Preview-unaware adapters fall back to `text`. */
  preview?: PreviewArtifact;
  /** Set ONLY by the runtime on a provider-generated answer it delivers unchanged; see {@link OutboundMessageFormat}. */
  format?: OutboundMessageFormat;
  /**
   * PLT-0 (platform-neutral rendering): the reply as neutral content, present when it carries a span a platform renders
   * its own way (untrusted text, a link, a conversation reference, a platform note). `text` is then its plain rendering
   * (`plainTextOf`) and a platform adapter renders `content` with its own markup instead of sending `text`. Absent: the
   * reply is Quoky copy alone and `text` is delivered as given. Build both with `outboundMessage` / `withOutboundBody`.
   */
  content?: MessageContent;
}
