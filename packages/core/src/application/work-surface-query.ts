import type { Actor } from '../domain';
import { ResourceRef } from '../domain';
import type { ConnectorItem, ConnectorProvider } from '../ports';

export type WorkSurfaceSource = 'jira' | 'github';
export type WorkSurfaceSourceStatus = 'AVAILABLE' | 'IDENTITY_MISSING' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

export interface WorkSurfaceItem {
  resource: ResourceRef;
  title: string;
  url?: string;
  summary?: string;
}

export interface WorkSurfaceSourceAvailability {
  source: WorkSurfaceSource;
  status: WorkSurfaceSourceStatus;
  message: string;
}

export interface WorkSurface {
  /** COMPLETE can legitimately contain no items; PARTIAL never silently means "no work". */
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  items: WorkSurfaceItem[];
  sources: WorkSurfaceSourceAvailability[];
}

export const WORK_SURFACE_SOURCES: readonly WorkSurfaceSource[] = ['jira', 'github'];
const SOURCES = WORK_SURFACE_SOURCES;

export interface WorkSurfaceReadOptions {
  /** ADR-0122 D2.4: the sources a channel's permit allows; absent = every source. */
  readonly sources?: readonly WorkSurfaceSource[];
}

/**
 * Rebuildable, non-authoritative personal-work read model (ADR-0074).
 * Connector DTOs end here and never become domain or persistence state.
 */
export class WorkSurfaceQuery {
  constructor(private readonly connectors: { list(): readonly ConnectorProvider[] }) {}

  /**
   * `options.sources` (ADR-0122 D2.4, P2): read only these sources — a source the channel's permit withholds is never
   * queried, and the status is computed over the sources read. Absent: every source, exactly as before.
   */
  async forActor(actor: Actor, options: WorkSurfaceReadOptions = {}): Promise<WorkSurface> {
    const wanted = options.sources === undefined ? SOURCES : SOURCES.filter((source) => options.sources!.includes(source));
    const results = await Promise.all(wanted.map((source) => this.readSource(actor, source)));
    const items = results.flatMap((result) => result.items).sort(compareSurfaceItems);
    const sources = results.map((result) => result.availability);
    const availableCount = sources.filter((source) => source.status === 'AVAILABLE').length;

    return {
      status: availableCount === wanted.length ? 'COMPLETE' : availableCount === 0 ? 'UNAVAILABLE' : 'PARTIAL',
      items,
      sources,
    };
  }

  private async readSource(
    actor: Actor,
    source: WorkSurfaceSource,
  ): Promise<{ items: WorkSurfaceItem[]; availability: WorkSurfaceSourceAvailability }> {
    const identity = actor.identities
      .filter((candidate) => candidate.platform === source)
      .map((candidate) => candidate.externalId.trim())
      .filter(Boolean)
      .sort()[0];
    if (!identity) {
      return {
        items: [],
        availability: {
          source,
          status: 'IDENTITY_MISSING',
          message: `${source} identity is not configured for this Actor`,
        },
      };
    }

    const connector = this.connectors.list().find((candidate) => candidate.source === source);
    if (!connector) {
      return {
        items: [],
        availability: { source, status: 'NOT_CONFIGURED', message: `${source} connector is not configured` },
      };
    }

    try {
      if (!(await connector.isAvailable())) {
        return {
          items: [],
          availability: { source, status: 'UNAVAILABLE', message: `${source} connector is unavailable` },
        };
      }
      const result = await connector.query({ query: 'personal-work', params: { actorExternalId: identity } });
      return {
        items: result.items.map((item) => normalizeItem(source, item)),
        availability: { source, status: 'AVAILABLE', message: `${source} personal work is available` },
      };
    } catch {
      return {
        items: [],
        availability: { source, status: 'UNAVAILABLE', message: `${source} connector query failed` },
      };
    }
  }
}

function normalizeItem(source: WorkSurfaceSource, item: ConnectorItem): WorkSurfaceItem {
  return {
    resource: new ResourceRef({ source, externalId: item.id }),
    title: item.title,
    ...(item.url ? { url: item.url } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
  };
}

function compareSurfaceItems(left: WorkSurfaceItem, right: WorkSurfaceItem): number {
  return (
    compareText(left.resource.source, right.resource.source) ||
    compareText(left.title, right.title) ||
    compareText(left.resource.externalId, right.resource.externalId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
