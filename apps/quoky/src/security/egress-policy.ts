import { isIpLiteral } from './ip-ranges';

/**
 * The egress allowlist and destination labels (ADR-0121 D8, design §5.1 inventory and §5.2).
 *
 * The allowlist is derived ONCE from the configuration at start (a connector that is not configured contributes no
 * host), frozen, and logged by name only. Each host maps to a base label (the connector or platform it belongs to);
 * {@link labelFor} refines a few labels by the request path so the §5.3 budgets can tell a Telegram long poll from a
 * send, a Slack search from other Slack calls, or Calendar from Drive on `www.googleapis.com`.
 *
 * Plain `http:` is allowed only for an exact `127.0.0.1:<port>` local endpoint (the local Ollama daemon), never for a
 * name, and never for another loopback address.
 */

export type EgressMode = 'off' | 'observe' | 'enforce';

/** The configuration facts the inventory is derived from (a structural subset of `QuokyConfig`). */
export interface EgressInventorySource {
  readonly telegram?: unknown;
  readonly connectors: {
    readonly jira?: { readonly host: string };
    readonly slack?: unknown;
    readonly confluence?: { readonly host: string };
  };
  readonly connectorWrites: { readonly slack?: unknown };
  readonly calendar?: unknown;
  readonly gmail?: unknown;
  readonly drive?: unknown;
  readonly githubApp?: unknown;
  readonly githubToken?: string;
  readonly ai: { readonly openai?: unknown; readonly gemini?: unknown; readonly ollamaEnabled: boolean };
}

export interface LocalEndpoint {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly label: string;
}

export interface EgressInventory {
  /** Allowlisted host (lowercase) → base label. */
  readonly hosts: ReadonlyMap<string, string>;
  /** The exact `127.0.0.1:<port>` endpoints that may be reached over plain http (and only those loopback ones). */
  readonly localEndpoints: readonly LocalEndpoint[];
}

/** The local Ollama daemon (`PROVIDER_ROUTING_LOOPBACK_ENDPOINT`, `ai-cli/src/cli-runner.ts`). */
export const OLLAMA_LOCAL_PORT = 11434;

/** The label of a destination that is not on the allowlist. */
export const UNLISTED_LABEL = 'unlisted';

/** Normalizes a configured base URL or bare host (Jira, Confluence) to its lowercase hostname. */
function hostOf(value: string): string | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const host = new URL(candidate).hostname.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

/** Derives the frozen allowlist from configuration (design §5.1). */
export function buildEgressInventory(source: EgressInventorySource): EgressInventory {
  const hosts = new Map<string, string>();
  const add = (host: string | undefined, label: string): void => {
    if (host !== undefined && !hosts.has(host)) hosts.set(host, label);
  };
  // Discord is always on: REST, the gateway websocket host, and the attachment CDNs (adapter-discord/src/attachments.ts).
  add('discord.com', 'discord');
  add('gateway.discord.gg', 'discord');
  add('cdn.discordapp.com', 'discord-attachments');
  add('media.discordapp.net', 'discord-attachments');
  if (source.telegram !== undefined) add('api.telegram.org', 'telegram');
  const googleCalendarOrDrive = source.calendar !== undefined || source.drive !== undefined;
  if (googleCalendarOrDrive) add('www.googleapis.com', 'google');
  if (source.gmail !== undefined) add('gmail.googleapis.com', 'gmail');
  if (googleCalendarOrDrive || source.gmail !== undefined) add('oauth2.googleapis.com', 'google-oauth');
  if (source.connectors.jira !== undefined) add(hostOf(source.connectors.jira.host), 'jira');
  if (source.connectors.confluence !== undefined) add(hostOf(source.connectors.confluence.host), 'confluence');
  if (source.connectors.slack !== undefined || source.connectorWrites.slack !== undefined) add('slack.com', 'slack');
  if (source.githubApp !== undefined || (source.githubToken ?? '') !== '') add('api.github.com', 'github');
  if (source.ai.openai !== undefined) add('api.openai.com', 'openai');
  if (source.ai.gemini !== undefined) add('generativelanguage.googleapis.com', 'gemini');
  const localEndpoints: LocalEndpoint[] = source.ai.ollamaEnabled
    ? [{ host: '127.0.0.1', port: OLLAMA_LOCAL_PORT, label: 'ollama-local' }]
    : [];
  return Object.freeze({ hosts: new Map(hosts), localEndpoints: Object.freeze(localEndpoints) });
}

/** Lowercase hostname without IPv6 brackets. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

export function localEndpointFor(inventory: EgressInventory, host: string, port: number): LocalEndpoint | undefined {
  return inventory.localEndpoints.find((endpoint) => endpoint.host === host && endpoint.port === port);
}

/**
 * The budget label of a request: the host's base label, refined by the path where the §5.3 budgets differ. Only the
 * path's fixed method or prefix is read; nothing from it is stored here.
 */
export function labelFor(inventory: EgressInventory, host: string, port: number, path: string): string {
  const normalized = normalizeHost(host);
  const local = localEndpointFor(inventory, normalized, port);
  if (local !== undefined) return local.label;
  const base = inventory.hosts.get(normalized);
  if (base === undefined) return UNLISTED_LABEL;
  const pathname = path.split('?')[0] ?? '';
  switch (base) {
    case 'telegram':
      if (pathname.startsWith('/file/')) return 'telegram-file';
      return pathname.endsWith('/getUpdates') ? 'telegram-poll' : 'telegram';
    case 'google':
      if (pathname.startsWith('/calendar/')) return 'google-calendar';
      if (pathname.startsWith('/drive/')) return 'google-drive';
      return 'google';
    case 'slack':
      return pathname.startsWith('/api/search.') ? 'slack-search' : 'slack';
    case 'jira':
      // Jira and Confluence on one Atlassian site: Confluence Cloud lives under /wiki.
      return pathname.startsWith('/wiki/') ? 'confluence' : 'jira';
    default:
      return base;
  }
}

/** A policy finding about a destination before any connection is made. */
export type DestinationFinding = 'new-destination' | 'ip-literal' | 'insecure-scheme';

/**
 * The name-level checks (design §5.2): https only (plain http only for an exact local endpoint), no IP literal (except
 * that endpoint), and the host must be on the allowlist. The address-level deny-range check happens at connect time.
 */
export function checkDestination(
  inventory: EgressInventory,
  destination: { readonly protocol: string; readonly host: string; readonly port: number },
): DestinationFinding[] {
  const host = normalizeHost(destination.host);
  if (localEndpointFor(inventory, host, destination.port) !== undefined) {
    return destination.protocol === 'http:' || destination.protocol === 'https:' ? [] : ['insecure-scheme'];
  }
  const findings: DestinationFinding[] = [];
  if (destination.protocol !== 'https:' && destination.protocol !== 'wss:') findings.push('insecure-scheme');
  if (isIpLiteral(host)) findings.push('ip-literal');
  else if (!inventory.hosts.has(host)) findings.push('new-destination');
  return findings;
}

const KEEP_WORD = /^[A-Za-z]+(?:[._-][A-Za-z]+)*$/;
const KEEP_VERSION = /^v[0-9]{1,2}(?:\.[0-9]{1,2})?$/;
const MAX_KEPT_SEGMENT = 40;
const MAX_TEMPLATE_LENGTH = 200;

/**
 * The ledger's path TEMPLATE (design §5.4): the query string is dropped, and every segment that is not a plain word
 * (letters with `.`/`_`/`-` separators, at most 40 characters), an API version (`v1`, `v2.1`) or a single digit (`/rest/api/3`)
 * becomes `{id}`. Ids, keys, e-mail addresses, file names and the Telegram `bot<token>` segment are therefore never
 * written. Example: `/bot<token>/getUpdates?offset=5` → `/{id}/getUpdates`.
 */
export function pathTemplate(path: string): string {
  const pathname = (path.split(/[?#]/)[0] ?? '').trim();
  if (pathname === '' || pathname === '/') return '/';
  const segments = pathname.split('/').map((segment) => {
    if (segment === '') return segment;
    if (segment.length <= MAX_KEPT_SEGMENT && (KEEP_WORD.test(segment) || KEEP_VERSION.test(segment) || /^[0-9]$/.test(segment))) {
      return segment;
    }
    return '{id}';
  });
  const template = segments.join('/');
  return template.length > MAX_TEMPLATE_LENGTH ? `${template.slice(0, MAX_TEMPLATE_LENGTH)}...` : template;
}
