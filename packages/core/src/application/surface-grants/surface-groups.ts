/**
 * ADR-0122 D1: the closed list of capability groups a channel turn is gated by. Adding or widening a group, or moving a
 * path between groups, needs an amendment of ADR-0122.
 *
 * - `always`: allowed on every surface; not grantable, not revocable.
 * - `grantable`: allowed in a DM; in a channel only with a live grant for that channel. `strong` groups carry an extra
 *   warning when granted (P2).
 * - `dm-only`: allowed in a DM; never in a channel, never grantable (a stored grant naming one is ignored on read).
 */

export const SURFACE_GROUP_IDS = [
  'chat',
  'help',
  'control',
  'jira-mine',
  'jira-project',
  'github',
  'slack-search',
  'confluence',
  'calendar',
  'todo',
  'reminder',
  'memory',
  'code',
  'writes',
  'mail',
  'drive',
  'brief',
  'nl-actions',
  'agent',
] as const;
export type SurfaceGroupId = (typeof SURFACE_GROUP_IDS)[number];

export type SurfaceGroupClass = 'always' | 'grantable' | 'dm-only';

export interface SurfaceGroupDefinition {
  readonly id: SurfaceGroupId;
  readonly class: SurfaceGroupClass;
  readonly strong: boolean;
  readonly label: { readonly ko: string; readonly en: string };
  /** Names the owner may write in a grant phrase (matched NFC, case-folded, spaces collapsed; see `resolveSurfaceGroupAlias`). */
  readonly aliases: readonly string[];
}

function group(
  id: SurfaceGroupId,
  cls: SurfaceGroupClass,
  ko: string,
  en: string,
  aliases: readonly string[],
  strong = false,
): SurfaceGroupDefinition {
  return Object.freeze({ id, class: cls, strong, label: Object.freeze({ ko, en }), aliases: Object.freeze([...aliases]) });
}

export const SURFACE_GROUPS: Readonly<Record<SurfaceGroupId, SurfaceGroupDefinition>> = Object.freeze({
  chat: group('chat', 'always', '대화', 'Chat', ['대화', 'chat']),
  help: group('help', 'always', '도움말', 'Help', ['도움말', 'help']),
  control: group('control', 'always', '제어', 'Control', ['제어', 'control']),
  'jira-mine': group('jira-mine', 'grantable', 'Jira 내 담당 조회', 'Jira (my items)', ['jira', '지라', 'jira 내 담당', '지라 내 담당', 'jira mine', 'my jira']),
  'jira-project': group(
    'jira-project',
    'grantable',
    'Jira 프로젝트·릴리스 조회(전체 담당)',
    'Jira (project and releases, every assignee)',
    ['jira 릴리스', '지라 릴리스', 'jira 프로젝트', '지라 프로젝트', 'jira 전체', '지라 전체', 'jira 프로젝트·릴리스', 'jira release', 'jira project'],
    true,
  ),
  github: group('github', 'grantable', 'GitHub 조회', 'GitHub', ['github', '깃허브', '깃헙']),
  'slack-search': group('slack-search', 'grantable', 'Slack 검색', 'Slack search', ['slack', '슬랙'], true),
  confluence: group('confluence', 'grantable', 'Confluence 검색', 'Confluence search', ['confluence', '컨플루언스']),
  calendar: group('calendar', 'grantable', '캘린더 조회', 'Calendar', ['캘린더', '일정', 'calendar']),
  todo: group('todo', 'grantable', '할 일', 'To-dos', ['할 일', '할일', 'todo', 'to-do', 'todos']),
  reminder: group('reminder', 'grantable', '알림', 'Reminders', ['알림', '리마인더', 'reminder', 'reminders']),
  memory: group('memory', 'grantable', '기억', 'Memory', ['기억', 'memory']),
  code: group('code', 'grantable', '코드 작업', 'Code work', ['코드 작업', '코드', 'code', 'code work'], true),
  writes: group('writes', 'grantable', '외부 쓰기(승인)', 'External writes (approved)', ['외부 쓰기', '외부 쓰기(승인)', '쓰기', 'writes'], true),
  mail: group('mail', 'dm-only', '메일', 'Mail', ['메일', 'mail', 'gmail', '지메일']),
  drive: group('drive', 'dm-only', '드라이브', 'Drive', ['드라이브', 'drive', '구글 드라이브', 'google drive']),
  brief: group('brief', 'dm-only', '브리핑', 'Brief', ['브리핑', 'brief']),
  'nl-actions': group('nl-actions', 'dm-only', '자연어 실행', 'Natural-language actions', ['자연어 실행', 'nl actions']),
  agent: group('agent', 'dm-only', '에이전트', 'Agent', ['에이전트', 'agent']),
});

export function isSurfaceGroupId(value: unknown): value is SurfaceGroupId {
  return typeof value === 'string' && (SURFACE_GROUP_IDS as readonly string[]).includes(value);
}

export function surfaceGroupClass(id: SurfaceGroupId): SurfaceGroupClass {
  return SURFACE_GROUPS[id].class;
}

export function isGrantableSurfaceGroup(id: SurfaceGroupId): boolean {
  return SURFACE_GROUPS[id].class === 'grantable';
}

export function surfaceGroupLabel(id: SurfaceGroupId, language: 'ko' | 'en' = 'ko'): string {
  return SURFACE_GROUPS[id].label[language];
}

/** The grantable groups, in table order. */
export const GRANTABLE_SURFACE_GROUPS: readonly SurfaceGroupId[] = Object.freeze(
  SURFACE_GROUP_IDS.filter((id) => SURFACE_GROUPS[id].class === 'grantable'),
);
export const DM_ONLY_SURFACE_GROUPS: readonly SurfaceGroupId[] = Object.freeze(
  SURFACE_GROUP_IDS.filter((id) => SURFACE_GROUPS[id].class === 'dm-only'),
);

/** NFC, trimmed, whitespace collapsed, case-folded. */
export function normalizeSurfaceGroupName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Every alias (and every label) → its group; built once, aliases are unique (pinned by the test). */
const ALIAS_INDEX: ReadonlyMap<string, SurfaceGroupId> = (() => {
  const index = new Map<string, SurfaceGroupId>();
  for (const id of SURFACE_GROUP_IDS) {
    const definition = SURFACE_GROUPS[id];
    for (const name of [...definition.aliases, definition.label.ko, definition.label.en, id]) {
      const key = normalizeSurfaceGroupName(name);
      if (!index.has(key)) index.set(key, id);
    }
  }
  return index;
})();

/**
 * ADR-0122 D4: a group name the owner wrote, case-folded, with an optional trailing `조회` or `검색`. `Jira` / `지라` alone
 * is `jira-mine`; `Jira 릴리스` / `Jira 프로젝트` / `Jira 전체` are `jira-project`. `undefined` when it names no group.
 */
export function resolveSurfaceGroupAlias(name: string): SurfaceGroupId | undefined {
  const key = normalizeSurfaceGroupName(name);
  if (key.length === 0) return undefined;
  const direct = ALIAS_INDEX.get(key);
  if (direct !== undefined) return direct;
  const stripped = key.replace(/\s*(?:조회|검색)$/u, '').trim();
  return stripped.length > 0 && stripped !== key ? ALIAS_INDEX.get(stripped) : undefined;
}
