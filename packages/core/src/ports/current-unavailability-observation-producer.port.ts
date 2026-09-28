import type { Capability } from '../domain';

export enum TrustedUnavailabilityObservationSource {
  TEST_FAKE = 'TEST_FAKE',
  CANONICAL_PROVIDER_REACHABILITY_PROBE = 'CANONICAL_PROVIDER_REACHABILITY_PROBE',
}

export enum TrustedUnavailabilityReason {
  ENDPOINT_UNREACHABLE = 'ENDPOINT_UNREACHABLE',
  AUTHENTICATION_UNAVAILABLE = 'AUTHENTICATION_UNAVAILABLE',
  PROVIDER_HEALTH_UNAVAILABLE = 'PROVIDER_HEALTH_UNAVAILABLE',
}

/** Test-only in C2B-1. Production composition must not install a producer. */
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
