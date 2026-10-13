import { TELEGRAM_METHODS } from '@quoky/adapter-telegram';
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
  // DRV-2b (ADR-0118 amendment 2026-10-12 (c)): the per-sheet spreadsheet read of the Drive connector, same grant.
  if (source.drive !== undefined) add('sheets.googleapis.com', 'google-sheets');
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
      if (pathname.endsWith('/sendChatAction')) return 'telegram-typing';
      return pathname.endsWith('/getUpdates') ? 'telegram-poll' : 'telegram';
    case 'discord':
      return /^\/api\/v[0-9]+\/channels\/[^/]+\/typing$/.test(pathname) ? 'discord-typing' : 'discord';
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

/**
 * Fixed path prefixes per budget label (an ALLOW-list). A prefix segment is a literal, `{v}` (an API version such as
 * `v1`, `v10`, `v1beta`) or `{n}` (one digit, `/rest/api/3`). Nothing after the longest matching prefix is ever written:
 * each later segment becomes `{id}`.
 */
const PATH_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  discord: [
    '/api/{v}/channels', '/api/{v}/guilds', '/api/{v}/users', '/api/{v}/webhooks', '/api/{v}/gateway/bot', '/api/{v}/gateway',
    '/api/{v}/applications', '/api/{v}/interactions', '/api/{v}/oauth2',
  ],
  'discord-typing': ['/api/{v}/channels'],
  'discord-attachments': ['/attachments', '/ephemeral-attachments'],
  'google-calendar': ['/calendar/v3/calendars', '/calendar/v3/users/me/calendarList', '/calendar/v3/freeBusy'],
  'google-drive': ['/drive/v3/files', '/drive/v3/drives', '/drive/v3/about'],
  'google-sheets': ['/v4/spreadsheets'],
  google: ['/calendar/v3', '/drive/v3'],
  gmail: [
    '/gmail/v1/users/me/messages', '/gmail/v1/users/me/threads', '/gmail/v1/users/me/labels', '/gmail/v1/users/me/profile',
  ],
  'google-oauth': ['/token'],
  jira: [
    '/rest/api/{n}/search/jql', '/rest/api/{n}/search', '/rest/api/{n}/issue', '/rest/api/{n}/myself', '/rest/api/{n}/project',
    '/rest/api/{n}/user', '/rest/api/{n}', '/rest/agile/1.0/board', '/rest/agile/1.0/sprint',
  ],
  confluence: [
    '/wiki/rest/api/content', '/wiki/rest/api/search', '/wiki/rest/api/space', '/wiki/rest/api',
    '/wiki/api/v2/pages', '/wiki/api/v2/spaces', '/wiki/api/v2',
  ],
  github: [
    '/repos', '/user', '/users', '/orgs', '/installation/repositories', '/app/installations', '/search/issues', '/search/code',
    '/rate_limit', '/graphql',
  ],
  openai: ['/v1/chat/completions', '/v1/responses', '/v1/models'],
  gemini: ['/{v}/models'],
  'ollama-local': ['/api/tags', '/api/generate', '/api/chat', '/api/embed', '/api/embeddings', '/api/version', '/api/show'],
  'telegram-file': ['/file'],
};

/**
 * Labels whose path is `/<token>/<method>`: only a method of the adapter's closed list (`TELEGRAM_METHODS`,
 * `adapter-telegram/src/bot-api.ts`) is kept; any other method is written as `{method}`.
 */
const TELEGRAM_LABELS: ReadonlySet<string> = new Set(['telegram', 'telegram-poll', 'telegram-typing']);
const TELEGRAM_METHOD_NAMES: ReadonlySet<string> = new Set<string>(TELEGRAM_METHODS);
/**
 * The Slack Web API methods Quoky calls (`connector-slack/src/index.ts`, `slack-channel-writer.ts`) — a closed list.
 * Any other method after `/api` is written as `{method}`, so a dotted segment that is not one of these can never carry
 * data into the ledger.
 */
export const SLACK_METHODS: ReadonlySet<string> = new Set([
  'search.messages',
  'conversations.info',
  'conversations.history',
  'conversations.list',
  'conversations.replies',
  'chat.postMessage',
  'chat.getPermalink',
]);
/**
 * The Sheets API custom methods Quoky calls on a spreadsheet (`connector-gdrive/src/sheets-reader.ts`) — a closed list.
 * In `/v4/spreadsheets/{id}/<method>` any other segment is written as `{method}`.
 */
export const GOOGLE_SHEETS_METHODS: ReadonlySet<string> = new Set(['values:batchGet']);
/** The placeholder for a method segment outside the closed lists. */
const METHOD_PLACEHOLDER = '{method}';
const VERSION_SEGMENT = /^v[0-9]{1,2}(?:beta[0-9]?|alpha[0-9]?)?(?:\.[0-9]{1,2})?$/;
const MAX_ID_SEGMENTS = 6;

function matchPrefix(segments: readonly string[], prefix: string): string[] | undefined {
  const parts = prefix.split('/').filter((part) => part !== '');
  if (parts.length > segments.length) return undefined;
  const kept: string[] = [];
  for (const [index, part] of parts.entries()) {
    const segment = segments[index] ?? '';
    if (part === '{v}' ? VERSION_SEGMENT.test(segment) : part === '{n}' ? /^[0-9]$/.test(segment) : part === segment) {
      kept.push(segment);
    } else {
      return undefined;
    }
  }
  return kept;
}

/**
 * The ledger's path TEMPLATE (design §5.4), built from an allow-list. The query string and fragment are dropped. The
 * longest fixed prefix of the label (`PATH_PREFIXES`, e.g. `/api/v10/channels`, `/rest/api/3/search`) is kept, and every
 * later segment becomes `{id}` (at most 6; more are dropped). Two closed method lists are kept as well: the Telegram Bot
 * API method after the `bot<token>` segment (always `{id}`) and the Slack Web API method after `/api`; a method outside
 * those lists becomes `{method}`.
 * The Sheets API method after `/v4/spreadsheets/{id}` is kept only from its closed list (`GOOGLE_SHEETS_METHODS`).
 * A file name, an e-mail address, a repository or owner name, a space key, a user name, a channel, issue or Drive id and
 * a webhook token therefore never reach the ledger, whether or not they consist of letters only. An unlisted host keeps
 * no segment at all. Example: `/bot<token>/getUpdates?offset=5` → `/{id}/getUpdates`.
 */
export function pathTemplate(label: string, path: string): string {
  const pathname = (path.split(/[?#]/)[0] ?? '').trim();
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return '/';
  let kept: string[] = [];
  if (TELEGRAM_LABELS.has(label)) {
    const method = segments[1];
    if (segments.length === 2 && method !== undefined) {
      return `/{id}/${TELEGRAM_METHOD_NAMES.has(method) ? method : METHOD_PLACEHOLDER}`;
    }
    return `/${segments.slice(0, MAX_ID_SEGMENTS).map(() => '{id}').join('/')}`;
  }
  if (label === 'google-sheets') {
    const prefix = matchPrefix(segments, '/v4/spreadsheets');
    if (prefix !== undefined) {
      const method = segments[3];
      if (segments.length === 3) return `/${[...prefix, '{id}'].join('/')}`;
      if (segments.length === 4 && method !== undefined) {
        return `/${[...prefix, '{id}', GOOGLE_SHEETS_METHODS.has(method) ? method : METHOD_PLACEHOLDER].join('/')}`;
      }
      kept = prefix;
    }
  } else if (label === 'slack' || label === 'slack-search') {
    const method = segments[1];
    if (segments[0] === 'api' && method !== undefined) {
      kept = ['api', SLACK_METHODS.has(method) ? method : METHOD_PLACEHOLDER];
    }
  } else {
    for (const prefix of PATH_PREFIXES[label] ?? []) {
      const match = matchPrefix(segments, prefix);
      if (match !== undefined && match.length > kept.length) kept = match;
    }
  }
  const rest = segments.slice(kept.length, kept.length + MAX_ID_SEGMENTS).map(() => '{id}');
  return `/${[...kept, ...rest].join('/')}`;
}
