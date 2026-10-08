import type { Id, IsoTimestamp, Metadata } from './common';

/** A platform-native identity that maps to a Quoky Actor. */
export interface ExternalIdentity {
  /** The opaque platform id of the adapter that resolved this identity. */
  platform: string;
  /** Platform-native user id. */
  externalId: string;
}

/**
 * A platform-independent principal (ADR-0009). v1 is THIN: a single local human,
 * resolved from one chat-platform user. Authorization (PolicyProvider, teams/org,
 * approval authority) is intentionally NOT modeled yet.
 */
export interface Actor {
  id: Id;
  displayName: string;
  /** The platform identities that resolve to this actor. */
  identities: ExternalIdentity[];
  createdAt: IsoTimestamp;
  metadata?: Metadata;
}
