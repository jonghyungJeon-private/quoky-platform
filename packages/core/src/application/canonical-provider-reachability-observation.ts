import {
  CanonicalReachabilityDiagnostic as Diagnostic,
  TrustedUnavailabilityObservationSource as Source,
  TrustedUnavailabilityReason as Reason,
  type CanonicalProviderReachabilityProbeTransport,
  type CurrentUnavailabilityObservationProducer,
} from '../ports';
import type { MonotonicClock } from './deadline-policy';
import { ProviderBindingRegistry } from './provider-binding-registry';
import type { ProviderId } from './provider-routing-contracts';

export const MAX_PRODUCTION_OBSERVATION_PROBE_MS = 2_000;

/** Bounded classification only; no raw transport error or secret can cross this boundary. */
export class CanonicalReachabilityObservationError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic);
    this.name = 'CanonicalReachabilityObservationError';
  }
}

/** Deterministic test transport. Its instances cannot acquire production-source authority. */
export class DeterministicFakeReachabilityProbeTransport implements CanonicalProviderReachabilityProbeTransport {
  readonly calls: Array<Parameters<CanonicalProviderReachabilityProbeTransport['probe']>[0]> = [];
  private next = 0;

  constructor(private readonly results: readonly (Diagnostic | Promise<Diagnostic>)[]) {}

  async probe(binding: Parameters<CanonicalProviderReachabilityProbeTransport['probe']>[0]): Promise<Diagnostic> {
    this.calls.push(binding);
    const result = this.results[this.next++];
    return result === undefined ? Diagnostic.UNSUPPORTED : result;
  }
}

const productionTransports = new WeakSet<object>();
const productionProducers = new WeakMap<object, Readonly<{ clock: MonotonicClock; bindings: ProviderBindingRegistry }>>();

/** No live diagnostic exists in this slice. Constructor is non-issuing even if bypassed at runtime. */
export class UnavailableProductionReachabilityProbeTransport implements CanonicalProviderReachabilityProbeTransport {
  private constructor() { Object.freeze(this); }

  static issueUnavailable(): UnavailableProductionReachabilityProbeTransport {
    const transport = new UnavailableProductionReachabilityProbeTransport();
    productionTransports.add(transport);
    return transport;
  }

  async probe(): Promise<Diagnostic> { return Diagnostic.UNSUPPORTED; }
}

/** Network-free production placeholder. A live diagnostic transport requires its own reviewed adapter slice. */
export function createUnavailableProductionReachabilityProbeTransport(): CanonicalProviderReachabilityProbeTransport {
  return UnavailableProductionReachabilityProbeTransport.issueUnavailable();
}

/** One canonical, in-process producer; transport input is derived from a frozen executable binding. */
export class CanonicalProviderReachabilityObservationProducer implements CurrentUnavailabilityObservationProducer {
  private constructor(
    readonly source: Source,
    private readonly transport: CanonicalProviderReachabilityProbeTransport,
    private readonly bindings: ProviderBindingRegistry,
    private readonly clock: MonotonicClock,
  ) { Object.freeze(this); }

  static forTest(transport: DeterministicFakeReachabilityProbeTransport,
    bindings: ProviderBindingRegistry, clock: MonotonicClock): CanonicalProviderReachabilityObservationProducer {
    if (!(transport instanceof DeterministicFakeReachabilityProbeTransport)) throw new Error('TEST_TRANSPORT_REQUIRED');
    return new CanonicalProviderReachabilityObservationProducer(Source.TEST_FAKE, transport, bindings, clock);
  }

  static fromIssuedProductionTransport(transport: CanonicalProviderReachabilityProbeTransport,
    bindings: ProviderBindingRegistry, clock: MonotonicClock): CanonicalProviderReachabilityObservationProducer {
    if (!transport || !productionTransports.has(transport) || !(bindings instanceof ProviderBindingRegistry)
      || !Object.isFrozen(bindings)) throw new Error('PRODUCTION_TRANSPORT_NOT_ISSUED');
    const producer = new CanonicalProviderReachabilityObservationProducer(
      Source.CANONICAL_PROVIDER_REACHABILITY_PROBE, transport, bindings, clock,
    );
    productionProducers.set(producer, Object.freeze({ clock, bindings }));
    return producer;
  }

  async observe(input: Parameters<CurrentUnavailabilityObservationProducer['observe']>[0]):
    ReturnType<CurrentUnavailabilityObservationProducer['observe']> {
    const binding = this.bindings.get(input.providerId as ProviderId);
    if (!binding || binding.providerId !== input.providerId) throw new CanonicalReachabilityObservationError(Diagnostic.UNKNOWN);
    const descriptor = Object.freeze({ providerId: binding.providerId,
      bindingVersion: binding.identity.bindingVersion, bindingDigest: binding.identity.bindingDigest });
    const start = this.clock.nowMs();
    if (!Number.isFinite(start) || start < 0) throw new CanonicalReachabilityObservationError(Diagnostic.UNKNOWN);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: Diagnostic;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => this.transport.probe(descriptor)),
        new Promise<Diagnostic>(resolve => { timer = setTimeout(() => resolve(Diagnostic.TIMEOUT), MAX_PRODUCTION_OBSERVATION_PROBE_MS); }),
      ]);
    } catch {
      result = Diagnostic.UNKNOWN;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // Classification completes before the observation timestamp is read.
    const diagnostic = Object.values(Diagnostic).includes(result) ? result : Diagnostic.UNKNOWN;
    const observedAtMonoMs = this.clock.nowMs();
    if (!Number.isFinite(observedAtMonoMs) || observedAtMonoMs < start) {
      throw new CanonicalReachabilityObservationError(Diagnostic.UNKNOWN);
    }
    if (observedAtMonoMs - start > MAX_PRODUCTION_OBSERVATION_PROBE_MS) {
      throw new CanonicalReachabilityObservationError(Diagnostic.TIMEOUT);
    }
    if (diagnostic === Diagnostic.PROVIDER_SERVICE_UNAVAILABLE) {
      return Object.freeze({ observedAtMonoMs, reason: Reason.PROVIDER_HEALTH_UNAVAILABLE });
    }
    if (diagnostic === Diagnostic.PROVIDER_AUTH_SERVICE_UNAVAILABLE) {
      return Object.freeze({ observedAtMonoMs, reason: Reason.AUTHENTICATION_UNAVAILABLE });
    }
    throw new CanonicalReachabilityObservationError(diagnostic);
  }
}

/** The source flag alone conveys no trust; exact issued object and composition identities are required. */
export function requireIssuedProductionObservationProducer(
  producer: CurrentUnavailabilityObservationProducer,
  clock: MonotonicClock,
  bindings: ProviderBindingRegistry | undefined,
): void {
  const issued = producer && productionProducers.get(producer);
  if (!issued || producer.source !== Source.CANONICAL_PROVIDER_REACHABILITY_PROBE
    || issued.clock !== clock || issued.bindings !== bindings) throw new Error('PRODUCTION_PRODUCER_NOT_ISSUED');
}
