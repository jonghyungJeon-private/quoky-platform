import type { Capability } from '../domain';

export enum TrustedUnavailabilityObservationSource {
  TEST_FAKE = 'TEST_FAKE',
  CANONICAL_PROVIDER_REACHABILITY_PROBE = 'CANONICAL_PROVIDER_REACHABILITY_PROBE',
}

export enum TrustedUnavailabilityReason {
  /** Legacy TEST_FAKE reason; canonical production diagnostics never emit it. */
  ENDPOINT_UNREACHABLE = 'ENDPOINT_UNREACHABLE',
  /** The provider's authentication SERVICE is unavailable, never a credential or account failure. */
  AUTHENTICATION_UNAVAILABLE = 'AUTHENTICATION_UNAVAILABLE',
  PROVIDER_HEALTH_UNAVAILABLE = 'PROVIDER_HEALTH_UNAVAILABLE',
}

/** C2B observation seam. Production source requires an issued producer capability. */
export interface CurrentUnavailabilityObservationProducer {
  readonly source: TrustedUnavailabilityObservationSource;
  observe(input: Readonly<{
    providerId: string;
    taskId: string;
    executionId: string;
    capability: Capability;
    routingContextDigest: string;
    configurationDigest: string;
  }>): Promise<Readonly<{ observedAtMonoMs: number; reason: TrustedUnavailabilityReason }>>;
}

/** Closed provider-native diagnostic. Only the two provider-service results can issue Kind B evidence. */
export enum CanonicalReachabilityDiagnostic {
  AVAILABLE = 'AVAILABLE',
  PROVIDER_SERVICE_UNAVAILABLE = 'PROVIDER_SERVICE_UNAVAILABLE',
  PROVIDER_AUTH_SERVICE_UNAVAILABLE = 'PROVIDER_AUTH_SERVICE_UNAVAILABLE',
  CREDENTIAL_INVALID = 'CREDENTIAL_INVALID',
  CREDENTIAL_MISSING = 'CREDENTIAL_MISSING',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  LOCAL_SECRET_FAILURE = 'LOCAL_SECRET_FAILURE',
  LOCAL_PROCESS_FAILURE = 'LOCAL_PROCESS_FAILURE',
  LOCAL_NETWORK_FAILURE = 'LOCAL_NETWORK_FAILURE',
  TIMEOUT = 'TIMEOUT',
  UNSUPPORTED = 'UNSUPPORTED',
  UNKNOWN = 'UNKNOWN',
}

/** Identity only: no URL, host, command, endpoint, model request or secret. */
export interface CanonicalProviderReachabilityProbeTransport {
  probe(binding: Readonly<{ providerId: string; bindingVersion: string;
    bindingDigest: string }>): Promise<CanonicalReachabilityDiagnostic>;
}
