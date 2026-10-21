import { describe, expect, it } from 'vitest';
import type { ConnectorItem, ConnectorProvider, ConnectorQuery, ConnectorResult } from '../../ports';
import { ConnectorQueryError } from '../../ports';
import { plainTextOf } from '../message-rendering';
import { validateSelection } from '../nl-routing/selection-validator';
import { prepareSelectionInput } from '../nl-routing/selection-input';
import { buildSelectionPrompt } from '../nl-routing/selection-prompt';
import { NL_WAVE1_ENTRIES, jiraKeywordCarriesQualifier, nlWave1Entry } from '../nl-routing/wave1-entries';
import type { NlCatalogEntry } from '../nl-routing/catalog';
import { hasJiraReleaseLink, normalizeSiteHost, parseJiraReleaseLinks, releaseLinkOnSite } from './jira-release-link';
import { lookupJiraRelease, splitKeyFromRelease, stripRedundantProjectKey, matchProjects, matchRelease, nearbyReleases, stripReleaseWords, type ReleaseLookupCommand } from './jira-release-lookup';
import { renderReleaseIssues } from './jira-release-renderer';
import { detectWorkChatCommand } from './work-chat-command';
import { workChatCommandForSelection } from './work-chat-selection';

/** ADR-0120 amendment A8: Jira release listings, offline (scripted connector, no network). */

const SITE = 'charancha.atlassian.net';
const LINK = `https://${SITE}/projects/OP26/versions/16555/tab/release-report-all-issues`;

describe('Jira release links (A8): parsed deterministically, used only on the configured site', () => {
  it.each([
    [LINK, { host: SITE, projectKey: 'OP26', versionId: '16555' }],
    [`https://${SITE}/projects/OP26/versions/16555`, { host: SITE, projectKey: 'OP26', versionId: '16555' }],
    [`https://${SITE}/browse/OP26/fixforversion/16555`, { host: SITE, projectKey: 'OP26', versionId: '16555' }],
    [`https://CHARANCHA.atlassian.net/projects/op26/versions/16555/`, { host: SITE, projectKey: 'OP26', versionId: '16555' }],
    [`(${LINK}).`, { host: SITE, projectKey: 'OP26', versionId: '16555' }],
    [`https://${SITE}/projects/OP26`, { host: SITE, projectKey: 'OP26' }],
    [`https://${SITE}/browse/OP26`, { host: SITE, projectKey: 'OP26' }],
    [`https://${SITE}/projects/OP26/versions/16555?selectedItem=x#y`, { host: SITE, projectKey: 'OP26', versionId: '16555' }],
  ])('%s', (text, link) => {
    expect(parseJiraReleaseLinks(`이거 확인해줘 ${text}`)).toEqual([link]);
  });

  it.each([
    [`https://${SITE}/browse/OP26-123`, 'an issue link'],
    [`http://${SITE}/projects/OP26/versions/16555`, 'plain http'],
    [`https://user:pw@${SITE}/projects/OP26/versions/16555`, 'credentials'],
    [`https://${SITE}:8443/projects/OP26/versions/16555`, 'a port'],
    [`https://${SITE}/projects/OP26/versions/abc`, 'a non-numeric version id'],
    [`https://${SITE}/projects/OP26/versions/0`, 'a zero version id'],
    [`https://${SITE}/projects/O/versions/1`, 'a one-letter key'],
    [`https://${SITE}/wiki/spaces/OP26`, 'another path'],
    ['jira > 차란차 운영 2026 > 릴리스', 'no link at all'],
  ])('ignores %s (%s)', (text) => {
    expect(parseJiraReleaseLinks(text)).toEqual([]);
    expect(hasJiraReleaseLink(text)).toBe(false);
  });

  it('keeps only a link whose host equals the configured site (case-insensitive); any other host is ignored', () => {
    const links = parseJiraReleaseLinks(`https://evil.example/projects/OP26/versions/1 ${LINK} https://${SITE}.evil.example/projects/OP26/versions/2`);
    expect(links.map((link) => link.host)).toEqual(['evil.example', SITE, `${SITE}.evil.example`]);
    expect(releaseLinkOnSite(links, SITE)?.versionId).toBe('16555');
    expect(releaseLinkOnSite(links, `https://${SITE.toUpperCase()}`)?.versionId).toBe('16555');
    expect(releaseLinkOnSite(links.filter((link) => link.host !== SITE), SITE)).toBeUndefined();
    expect(releaseLinkOnSite(links, undefined)).toBeUndefined();
    expect(normalizeSiteHost('https://Example.atlassian.net/')).toBe('example.atlassian.net');
    expect(normalizeSiteHost('  ')).toBeUndefined();
  });
});

// -- a scripted connector -------------------------------------------------------------------------------------------

const PROJECTS: ConnectorItem[] = [
  { id: 'OP25', title: '차란차 운영 2025' },
  { id: 'OP26', title: '차란차 운영 2026' },
  { id: 'WEB', title: '웹 개발' },
];
const RELEASES: Record<string, ConnectorItem[]> = {
  OP25: [{ id: '15000', title: '20251015', status: 'released' }],
  OP26: [
    { id: '16600', title: '20261022', status: 'unreleased', url: `https://${SITE}/projects/OP26/versions/16600/tab/release-report-all-issues` },
    { id: '16555', title: '20261015', status: 'released', url: `https://${SITE}/projects/OP26/versions/16555/tab/release-report-all-issues` },
    { id: '16500', title: '20261008', status: 'released' },
  ],
  WEB: [],
};
const ISSUES: ConnectorItem[] = [
  { id: 'OP26-1', title: '로그인 오류', status: '배포 완료', statusCategory: 'done', assignee: '홍길동', url: `https://${SITE}/browse/OP26-1` },
  { id: 'OP26-2', title: '결제 개선', status: '진행 중', statusCategory: 'in-progress', assignee: '김철수', url: `https://${SITE}/browse/OP26-2` },
  { id: 'OP26-3', title: '문구 수정', status: 'To Do', statusCategory: 'todo', url: `https://${SITE}/browse/OP26-3` },
];

function connector(overrides: { items?: (query: ConnectorQuery) => ConnectorResult | Promise<ConnectorResult> } = {}): { provider: ConnectorProvider; queries: ConnectorQuery[] } {
  const queries: ConnectorQuery[] = [];
  return {
    queries,
    provider: {
      source: 'jira',
      readOnly: true,
      async isAvailable() {
        return true;
      },
      async query(query: ConnectorQuery) {
        queries.push(query);
        if (query.query === 'containers') return { source: 'jira', items: PROJECTS };
        if (query.query === 'releases') return { source: 'jira', items: RELEASES[String(query.params?.container)] ?? [] };
        if (query.query === 'release-items') return overrides.items ? overrides.items(query) : { source: 'jira', items: ISSUES };
        throw new ConnectorQueryError('UNSUPPORTED_QUERY');
      },
    },
  };
}

async function run(command: Partial<ReleaseLookupCommand>, options: { identity?: string; items?: (query: ConnectorQuery) => ConnectorResult } = {}) {
  const fake = connector(options.items ? { items: options.items } : {});
  const result = await lookupJiraRelease({
    connector: fake.provider,
    command: { scope: 'all', links: [], ...command },
    siteHost: SITE,
    ...(options.identity !== undefined ? { identity: options.identity } : {}),
  });
  const text = result.kind === 'body' ? plainTextOf(result.body) : `FAILURE ${result.reason}`;
  return { result, text, queries: fake.queries };
}

describe('lookupJiraRelease (A8): resolve what the owner named, read the release, never guess', () => {
  it('owner sentence 1: "차란차 운영" matches two projects; the release name narrows it to OP26, any assignee', async () => {
    const { text, queries } = await run({ release: '20261015', project: '차란차 운영' });
    expect(queries.map((query) => query.query)).toEqual(['containers', 'releases', 'releases', 'release-items']);
    expect(queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
    expect(text).toContain('**Jira 릴리스 20261015** · 차란차 운영 2026 (OP26) · 전체 담당');
    expect(text).toContain('이슈 3건: 완료 1 · 진행 중 1 · 할 일 1');
    expect(text).toContain('- [OP26-1] 로그인 오류 · 홍길동 · 배포 완료 https://charancha.atlassian.net/browse/OP26-1');
    expect(text).toContain('- [OP26-3] 문구 수정 · 담당자 없음 · To Do');
    expect(text).toContain(`릴리스 페이지: ${LINK}`);
    // Grouped like the release report: 완료, then 진행 중, then 할 일.
    expect(text.indexOf('완료 (1)')).toBeLessThan(text.indexOf('진행 중 (1)'));
    expect(text.indexOf('진행 중 (1)')).toBeLessThan(text.indexOf('할 일 (1)'));
  });

  it('an ambiguous project without a release that narrows it is asked, with the candidates', async () => {
    const { text, queries } = await run({ project: '차란차 운영' });
    expect(queries.map((query) => query.query)).toEqual(['containers']);
    expect(text).toContain('"차란차 운영"에 맞는 Jira 프로젝트가 여러 개예요');
    expect(text).toContain('- 차란차 운영 2025 (OP25)');
    expect(text).toContain('- 차란차 운영 2026 (OP26)');
    const both = await run({ project: '차란차 운영', release: '없는버전' });
    expect(both.text).toContain('여러 개예요');
    expect(both.queries.some((query) => query.query === 'release-items')).toBe(false);
  });

  it('owner sentence 4: a project and no release is the project release list', async () => {
    const { text, queries } = await run({ project: '차란차 운영 2026' });
    expect(queries.map((query) => query.query)).toEqual(['containers', 'releases']);
    expect(text).toContain('**차란차 운영 2026 (OP26) 릴리스** (미출시 1 · 출시 2)');
    expect(text).toContain('- 20261022 · 미출시');
  });

  it('owner sentence 3: a release with no project goes to Jira as a quoted name (no project listing)', async () => {
    const { queries, text } = await run({ release: '20261015' });
    expect(queries.map((query) => query.query)).toEqual(['release-items']);
    expect(queries[0]?.params).toEqual({ releaseName: '20261015', limit: 20 });
    expect(text).toContain('**Jira 릴리스 20261015** · 전체 담당');
    const unknown = await run({ release: '없음' }, { items: () => { throw new ConnectorQueryError('NOT_FOUND'); } });
    expect(unknown.text).toContain('"없음" 릴리스를 찾지 못했어요');
    expect(unknown.text).toContain('프로젝트 이름도 함께');
  });

  it('a release name not in the project: up to five of its release names, nothing read', async () => {
    const { text, queries } = await run({ project: 'OP26', release: '20261016' });
    expect(queries.map((query) => query.query)).toEqual(['containers', 'releases']);
    expect(text).toContain('차란차 운영 2026 (OP26)에서 "20261016" 릴리스를 찾지 못했어요.');
    expect(text).toContain('비슷한 릴리스: 20261015, 20261022, 20261008');
  });

  it('the owner link on the configured site: its key and id, never its URL, reach the connector', async () => {
    const links = parseJiraReleaseLinks(`이거 봐줘 ${LINK}`);
    const { text, queries } = await run({ links });
    expect(queries.map((query) => query.query)).toEqual(['releases', 'release-items']);
    expect(queries[1]?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
    expect(JSON.stringify(queries)).not.toContain('https://');
    expect(text).toContain('**Jira 릴리스 20261015** · OP26 · 전체 담당');
    // The page link is the adapter's release URL; Core builds no Jira URL (none when the release is not listed).
    expect(text).toContain(`릴리스 페이지: ${LINK}`);
    const unlisted = await run({ links: parseJiraReleaseLinks(`https://${SITE}/projects/OP26/versions/19999`) });
    expect(unlisted.queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '19999', limit: 20 });
    expect(unlisted.text).not.toContain('릴리스 페이지');
  });

  it('a link on another host is ignored and never fetched; with nothing else named the owner is asked', async () => {
    const links = parseJiraReleaseLinks('https://evil.example/projects/OP26/versions/16555');
    const { text, queries } = await run({ links });
    expect(queries).toEqual([]);
    expect(text).toContain('설정된 Jira 사이트의 링크가 아니라서 그 링크는 열지 않았어요.');
    expect(text).toContain('어느 릴리스를 볼까요?');
    const named = await run({ links, release: '20261015', project: 'OP26' });
    expect(named.queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
    expect(named.text).toContain('그 링크는 열지 않았어요');
  });

  it('scope mine needs the owner identity and sends it as the assignee; all never does', async () => {
    expect((await run({ release: '20261015', scope: 'mine' })).text).toBe('FAILURE IDENTITY_MISSING');
    const mine = await run({ release: '20261015', project: 'OP26', scope: 'mine' }, { identity: 'acc-1' });
    expect(mine.queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '16555', assignee: 'acc-1', limit: 20 });
    expect(mine.text).toContain('· 내 담당');
    const all = await run({ release: '20261015', project: 'OP26' }, { identity: 'acc-1' });
    expect(all.queries.at(-1)?.params).not.toHaveProperty('assignee');
  });

  it('a partial page says so; an empty release says so; a connector failure is its reason', async () => {
    const partial = await run({ release: '20261015' }, { items: () => ({ source: 'jira', items: ISSUES, truncated: true }) });
    expect(partial.text).toContain('이슈 3건 이상');
    expect(partial.text).toContain('일부만 표시');
    const empty = await run({ project: 'OP26', release: '20261015' }, { items: () => ({ source: 'jira', items: [] }) });
    expect(empty.text).toContain('이 릴리스에 포함된 이슈가 없어요.');
    const denied = await run({ release: '20261015' }, { items: () => { throw new ConnectorQueryError('UNAUTHORIZED'); } });
    expect(denied.text).toBe('FAILURE UNAUTHORIZED');
  });
});

describe('A8 review fixes: default scope, channels, deadline, first-page narrowing, release words', () => {
  it('the owner own items are the default command scope', async () => {
    const mine = await run({ release: '20261015', project: 'OP26', scope: 'mine' }, { identity: 'acc-1' });
    expect(mine.text).toContain('· 내 담당');
  });

  it('owner decision 7: in a channel every-assignee scope and the lists are refused before or instead of any list', async () => {
    const fake = connector();
    const ask = (command: Partial<ReleaseLookupCommand>) =>
      lookupJiraRelease({ connector: fake.provider, command: { scope: 'mine', links: [], ...command }, identity: 'acc-1', siteHost: SITE, inChannel: true }).then((result) => (result.kind === 'body' ? plainTextOf(result.body) : result.reason));
    expect(await ask({ release: '20261015', scope: 'all' })).toBe('전체 담당 릴리스 조회는 DM에서만 할 수 있어요.');
    expect(fake.queries).toEqual([]);
    expect(await ask({ project: 'OP26' })).toContain('프로젝트·릴리스 목록은 DM에서만');
    expect(await ask({ project: '차란차 운영' })).toContain('프로젝트·릴리스 목록은 DM에서만');
    expect(await ask({ project: 'OP26', release: '20261016' })).not.toContain('비슷한 릴리스');
    expect(await ask({ project: 'OP26', release: '20261015' })).toContain('**Jira 릴리스 20261015** · 차란차 운영 2026 (OP26) · 내 담당');
  });

  it('the deadline is checked before every query: once it passed no further query starts', async () => {
    const fake = connector();
    const stop = new AbortController();
    const slow: ConnectorProvider = { ...fake.provider, query: async (query) => { const result = await fake.provider.query(query); stop.abort(); return result; } };
    const result = await lookupJiraRelease({ connector: slow, command: { scope: 'all', links: [], release: '20261015', project: '차란차 운영' }, siteHost: SITE, signal: stop.signal });
    expect(result).toEqual({ kind: 'failure', reason: 'TIMEOUT' });
    expect(fake.queries.map((query) => query.query)).toEqual(['containers']);
  });

  it('ambiguous projects are narrowed on the first page of each release list only', async () => {
    const { queries } = await run({ release: '20261015', project: '차란차 운영' });
    expect(queries.filter((query) => query.query === 'releases').map((query) => query.params)).toEqual([{ container: 'OP25', limit: 50 }, { container: 'OP26', limit: 50 }]);
  });

  it('a release name without a project drops the closed release words, and retries the words as written when unknown', async () => {
    const stripped = await run({ release: '20261015 배포건' });
    expect(stripped.queries[0]?.params).toEqual({ releaseName: '20261015', limit: 20 });
    expect(stripReleaseWords('Release 1.0')).toBe('1.0');
    const names: unknown[] = [];
    const retried = await run({ release: 'Release 1.0' }, { items: (query) => { names.push(query.params?.releaseName); if (query.params?.releaseName === '1.0') throw new ConnectorQueryError('NOT_FOUND'); return { source: 'jira', items: ISSUES }; } });
    expect(names).toEqual(['1.0', 'Release 1.0']);
    expect(retried.text).toContain('**Jira 릴리스 Release 1.0**');
  });
});

describe('A8 review round 2: whole dotted versions, proven uniqueness, channel order, DM hint', () => {
  const item = (title: string, id = title): ConnectorItem => ({ id, title });

  it('a dotted version is one token: 2.3 is not 2.3.1 or 1.2.3, 10 is not 1.10, dated names still match', () => {
    expect(matchRelease([item('2.3.1')], '2.3')).toBeUndefined();
    expect(matchRelease([item('1.2.3')], '2.3 버전')).toBeUndefined();
    expect(matchRelease([item('1.10')], '10')).toBeUndefined();
    expect(matchRelease([item('릴리스 2.3 핫픽스', 'a')], '2.3')?.id).toBe('a');
    expect(matchRelease([item('배포일_20261015(목)', 'a')], '20261015')?.id).toBe('a');
    expect(matchRelease([item('1.0', 'a')], 'Release 1.0')?.id).toBe('a');
  });

  it('more ambiguous projects than the bound: asked, nothing narrowed on a subset', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `AB${i}`, title: `공통 이름 ${i}` }));
    const queries: ConnectorQuery[] = [];
    const provider: ConnectorProvider = {
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => { queries.push(query); return query.query === 'containers' ? { source: 'jira', items: many } : { source: 'jira', items: [item('1.0', 'v')] }; },
    };
    const result = await lookupJiraRelease({ connector: provider, command: { scope: 'all', links: [], project: '공통 이름', release: '1.0' }, siteHost: SITE });
    expect(result.kind === 'body' && plainTextOf(result.body)).toContain('여러 개예요');
    expect(queries.map((query) => query.query)).toEqual(['containers']);
  });

  it('a single token hit on a partial listing is not unique: ambiguity or not found, never a pick', async () => {
    const partial = (items: ConnectorItem[], truncated: boolean): ConnectorProvider => ({
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => (query.query === 'containers' ? { source: 'jira', items: PROJECTS } : query.query === 'releases' ? { source: 'jira', items, ...(truncated ? { truncated: true } : {}) } : { source: 'jira', items: ISSUES }),
    });
    const ask = async (provider: ConnectorProvider, command: Partial<ReleaseLookupCommand>) => {
      const result = await lookupJiraRelease({ connector: provider, command: { scope: 'all', links: [], ...command }, siteHost: SITE });
      return result.kind === 'body' ? plainTextOf(result.body) : result.reason;
    };
    // Named project, truncated listing, token hit only.
    expect(await ask(partial([item('배포일_20261015(목)', 'a')], true), { project: 'OP26', release: '20261015' })).toContain('찾지 못했어요');
    // Ambiguous projects: a hit on a 50-item first page is not proven unique.
    const page = Array.from({ length: 50 }, (_, i) => item(`x${i}`));
    expect(await ask(partial([...page.slice(1), item('배포일_20261015(목)', 'a')], false), { project: '차란차 운영', release: '20261015' })).toContain('여러 개예요');
  });

  it('several token matches in one ambiguous project are ambiguity, not "no match": another project is not picked', async () => {
    const provider: ConnectorProvider = {
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) =>
        query.query === 'containers' ? { source: 'jira', items: PROJECTS }
        : query.query === 'releases' ? { source: 'jira', items: query.params?.container === 'OP25' ? [item('a_20261015', '1'), item('b_20261015', '2')] : [item('c_20261015', '3')] }
        : { source: 'jira', items: ISSUES },
    };
    const result = await lookupJiraRelease({ connector: provider, command: { scope: 'all', links: [], project: '차란차 운영', release: '20261015' }, siteHost: SITE });
    expect(result.kind === 'body' && plainTextOf(result.body)).toContain('여러 개예요');
  });

  it('in a channel a project list is refused before the project catalog is read', async () => {
    const fake = connector();
    const result = await lookupJiraRelease({ connector: fake.provider, command: { scope: 'mine', links: [], project: '차란차 운영 2026' }, identity: 'acc-1', siteHost: SITE, inChannel: true });
    expect(result.kind === 'body' && plainTextOf(result.body)).toContain('DM에서만');
    expect(fake.queries).toEqual([]);
  });

  it('a truncated project listing with one visible name match is not picked: the owner is asked, a channel gets no list', async () => {
    const payments = (): ConnectorProvider => ({
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => (query.query === 'containers' ? { source: 'jira', items: [{ id: 'PAY', title: 'Payments' }], truncated: true } : { source: 'jira', items: ISSUES }),
    });
    const dm = await lookupJiraRelease({ connector: payments(), command: { scope: 'all', links: [], project: 'Payments', release: '20261015' }, siteHost: SITE });
    expect(dm.kind === 'body' && plainTextOf(dm.body)).toContain('여러 개예요');
    const fake = { ...payments() };
    const queries: ConnectorQuery[] = [];
    const channelProvider: ConnectorProvider = { ...fake, query: async (query) => { queries.push(query); return fake.query(query); } };
    const channel = await lookupJiraRelease({ connector: channelProvider, command: { scope: 'mine', links: [], project: 'Payments', release: '20261015' }, identity: 'acc-1', siteHost: SITE, inChannel: true });
    expect(channel.kind === 'body' && plainTextOf(channel.body)).toContain('DM에서만');
    expect(channel.kind === 'body' && plainTextOf(channel.body)).not.toContain('Payments (PAY)');
    expect(queries.map((query) => query.query)).toEqual(['containers']);
  });

  it('a truncated project listing still accepts an exact project key', async () => {
    const { text, queries } = await run({ project: 'OP26', release: '20261015' }, {});
    expect(text).toContain('차란차 운영 2026 (OP26)');
    expect(queries.some((query) => query.query === 'release-items')).toBe(true);
    const provider: ConnectorProvider = {
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => (query.query === 'containers' ? { source: 'jira', items: PROJECTS, truncated: true } : query.query === 'releases' ? { source: 'jira', items: RELEASES[String(query.params?.container)] ?? [] } : { source: 'jira', items: ISSUES }),
    };
    const result = await lookupJiraRelease({ connector: provider, command: { scope: 'all', links: [], project: 'OP26', release: '20261015' }, siteHost: SITE });
    expect(result.kind === 'body' && plainTextOf(result.body)).toContain('(OP26)');
  });

  it('key split on a truncated listing: "OP26 WEB 20261015" (WEB may be a hidden project) is not split silently', async () => {
    const provider = (truncated: boolean): ConnectorProvider => ({
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => (query.query === 'containers' ? { source: 'jira', items: [PROJECTS[1] as ConnectorItem], ...(truncated ? { truncated: true } : {}) } : { source: 'jira', items: ISSUES }),
    });
    const queries: ConnectorQuery[] = [];
    const base = provider(true);
    const recording: ConnectorProvider = { ...base, query: async (query) => { queries.push(query); return base.query(query); } };
    await lookupJiraRelease({ connector: recording, command: { scope: 'all', links: [], release: 'OP26 WEB 20261015' }, siteHost: SITE });
    const items = queries.find((query) => query.query === 'release-items');
    expect(items?.params).toEqual({ releaseName: 'OP26 WEB 20261015', limit: 20 });
    expect(queries.some((query) => query.query === 'releases')).toBe(false);
  });

  it('key split on a truncated listing: "OP26 20261015" with the one key visible is split', async () => {
    const queries: ConnectorQuery[] = [];
    const base: ConnectorProvider = {
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => (query.query === 'containers' ? { source: 'jira', items: [PROJECTS[1] as ConnectorItem], truncated: true } : query.query === 'releases' ? { source: 'jira', items: RELEASES[String(query.params?.container)] ?? [] } : { source: 'jira', items: ISSUES }),
    };
    const recording: ConnectorProvider = { ...base, query: async (query) => { queries.push(query); return base.query(query); } };
    const result = await lookupJiraRelease({ connector: recording, command: { scope: 'all', links: [], release: 'OP26 20261015' }, siteHost: SITE });
    expect(queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
    expect(result.kind === 'body' && plainTextOf(result.body)).toContain('차란차 운영 2026 (OP26)');
  });

  it('key split on a complete listing is unchanged: "OP26 WEB 20261015" keeps the text; "OP26 20261015" splits', async () => {
    const two = await run({ release: 'OP26 WEB 20261015' }, {});
    expect(two.queries.find((query) => query.query === 'release-items')?.params).toEqual({ releaseName: 'OP26 WEB 20261015', limit: 20 });
    const one = await run({ release: 'OP26 20261015' }, {});
    expect(one.queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
  });

  it('own items empty: a DM is told how to ask for every assignee, a channel is not', async () => {
    const empty = { items: () => ({ source: 'jira', items: [] }) };
    const dm = await run({ release: '20261015', project: 'OP26', scope: 'mine' }, { identity: 'acc-1', ...empty });
    expect(dm.text).toContain("전체 담당으로 보려면 '전체 담당'이라고 말씀해 주세요");
    const fake = connector(empty);
    const channel = await lookupJiraRelease({ connector: fake.provider, command: { scope: 'mine', links: [], project: 'OP26', release: '20261015' }, identity: 'acc-1', siteHost: SITE, inChannel: true });
    expect(channel.kind === 'body' && plainTextOf(channel.body)).not.toContain('전체 담당으로 보려면');
    const all = await run({ release: '20261015', project: 'OP26' }, { items: () => ({ source: 'jira', items: [] }) });
    expect(all.text).not.toContain('전체 담당으로 보려면');
  });
});

describe('live names (owner-approved read-only probe, 2026-10-15): project "차란차 플랫폼 운영 2026", version "배포일_20261015(목)"', () => {
  const live: ConnectorItem[] = [
    { id: 'APPOP', title: '차란차 플랫폼 APP운영' },
    { id: 'OP25', title: '차란차 플랫폼 운영 2025' },
    { id: 'OP26', title: '차란차 플랫폼 운영 2026' },
    { id: 'COP26', title: '코브랜드 운영 2026' },
  ];
  const versions: ConnectorItem[] = [
    { id: '16591', title: '배포일_20261020(화)' },
    { id: '16555', title: '배포일_20261015(목)' },
    { id: '16104', title: '비정기 배포' },
  ];

  it('the owner words match the project by whole words and the release by a whole token', () => {
    expect(matchProjects(live, '차란차 운영 2026').map((item) => item.id)).toEqual(['OP26']);
    expect(matchProjects(live, '차란차 운영').map((item) => item.id)).toEqual(['OP25', 'OP26']);
    expect(matchRelease(versions, '20261015')?.id).toBe('16555');
    expect(matchRelease(versions, '20261015 배포건')?.id).toBe('16555');
    expect(matchRelease(versions, '2026101')).toBeUndefined();
    expect(matchRelease([...versions, { id: '9', title: '핫픽스_20261015' }], '20261015')).toBeUndefined();
    expect(nearbyReleases(versions, '20261016').map((item) => item.title).slice(0, 2)).toEqual(['배포일_20261015(목)', '배포일_20261020(화)']);
  });
});

describe('name matching (A8): exact first, then normalized containment; closed release words only compare', () => {
  it('matches projects by key, name, spacing and the word 프로젝트', () => {
    expect(matchProjects(PROJECTS, 'op26').map((item) => item.id)).toEqual(['OP26']);
    expect(matchProjects(PROJECTS, '차란차운영2026').map((item) => item.id)).toEqual(['OP26']);
    expect(matchProjects(PROJECTS, '차란차 운영 2026 프로젝트').map((item) => item.id)).toEqual(['OP26']);
    expect(matchProjects(PROJECTS, '차란차 운영').map((item) => item.id)).toEqual(['OP25', 'OP26']);
    expect(matchProjects(PROJECTS, '모바일')).toEqual([]);
  });

  it('matches a release exactly or without the closed release words, never by a fuzzy guess', () => {
    const releases = RELEASES.OP26 ?? [];
    expect(matchRelease(releases, '20261015')?.id).toBe('16555');
    expect(matchRelease(releases, '20261015 배포건')?.id).toBe('16555');
    expect(matchRelease(releases, '릴리스 20261015')?.id).toBe('16555');
    expect(matchRelease(releases, '2026101')).toBeUndefined();
    expect(matchRelease(releases, '20261015 배포건이')).toBeUndefined();
    expect(nearbyReleases(releases, '20261016').map((item) => item.title)).toEqual(['20261015', '20261022', '20261008']);
  });
});

describe('the release report renderer (A8)', () => {
  it('stays within the message budget with 20 long items and keeps the release page link', () => {
    const items: ConnectorItem[] = Array.from({ length: 20 }, (_, i) => ({
      id: `OP26-${100 + i}`,
      title: '아주 긴 제목 '.repeat(10),
      status: '진행 중',
      statusCategory: i % 2 === 0 ? 'done' : 'in-progress',
      assignee: '담당자 이름',
      url: `https://${SITE}/browse/OP26-${100 + i}`,
    }));
    const text = plainTextOf(renderReleaseIssues({ releaseName: '20261015', releaseUrl: LINK, scope: 'all', items, truncated: true }));
    expect(Array.from(text).length).toBeLessThanOrEqual(1800);
    expect(text).toContain('이슈 20건 이상 — 표시한 20건 기준: 완료 10 · 진행 중 10 · 할 일 0 (일부만 표시, 전체는 릴리스 페이지에서)');
    expect(text).toContain(`릴리스 페이지: ${LINK}`);
    expect(text).toContain('(길이 때문에 일부는 생략했어요)');
  });
});

// -- selection side --------------------------------------------------------------------------------------------------

const ALL: readonly NlCatalogEntry[] = Object.values(NL_WAVE1_ENTRIES);
const NOW = '2026-10-15T03:00:00.000Z';

function validate(entryId: string, args: Record<string, string | boolean>, text: string, previousArgs?: Record<string, string>) {
  const prepared = prepareSelectionInput(text);
  if ('skip' in prepared) throw new Error('skipped');
  return validateSelection(
    { entryId, args },
    { offered: new Map(ALL.map((entry) => [entry.id, entry] as const)), groundingText: prepared.groundingText, ...(previousArgs ? { previousArgs } : {}), now: NOW, timeZone: 'Asia/Seoul' },
  );
}

describe('jira.release validation (A8)', () => {
  it('needs a release, a project or a release link; values are grounded verbatim', () => {
    expect(validate('jira.release', { release: '20261015', project: '차란차 운영' }, 'jira에서 20261015 배포건 뭐 있는지 확인해줘 차란차 운영')).toMatchObject({ ok: true, value: { args: { release: '20261015', project: '차란차 운영' } } });
    expect(validate('jira.release', {}, LINK)).toMatchObject({ ok: true, value: { args: {} } });
    expect(validate('jira.release', {}, 'https://evil.example/projects/OP26/versions/1 봐줘')).toMatchObject({ ok: true });
    expect(validate('jira.release', {}, '전체 담당 이슈 보여줘')).toMatchObject({ ok: false, reason: 'missing-arg', arg: 'release' });
    expect(validate('jira.release', { release: '20261016' }, '20261015 릴리스 보여줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'release' });
    expect(validate('jira.release', { project: 'OP27' }, 'OP26 릴리스')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'project' });
  });

  it('owner decision 2: mine is the default (dropped from the canonical args); all needs the owner explicit words', () => {
    expect(validate('jira.release', { release: '20261015', scope: 'all' }, '20261015 릴리스 보여줘')).toMatchObject({ ok: false, reason: 'ungrounded', arg: 'scope' });
    expect(validate('jira.release', { release: '20261015', scope: 'mine' }, '20261015 릴리스 중에 내 담당만')).toMatchObject({ ok: true, value: { args: { release: '20261015' } } });
    for (const text of ['내 담당 말고 전체 담당은?', '20261015 담당 상관없이 보여줘', '20261015 모든 담당자 거', 'release 20261015 for all assignees']) {
      expect(validate('jira.release', { release: '20261015', scope: 'all' }, text, { release: '20261015' }), text).toMatchObject({ ok: true, value: { args: { release: '20261015', scope: 'all' } } });
    }
    // A follow-up keeps a stated every-assignee scope from the previous selection.
    expect(validate('jira.release', { release: '20261015', scope: 'all' }, '몇 개야?', { release: '20261015', scope: 'all' })).toMatchObject({ ok: true });
  });

  it('jira.issues refuses a request for every assignee (its own items cannot answer it)', () => {
    expect(validate('jira.issues', { status: 'all' }, 'jira 전체 담당 이슈 다 보여줘')).toMatchObject({ ok: false, reason: 'invalid-arg', arg: 'role' });
    expect(validate('jira.issues', {}, '모든 담당자 이슈 보여줘')).toMatchObject({ ok: false, reason: 'invalid-arg' });
    expect(validate('jira.issues', { status: 'all' }, '완료된 것까지 jira 이슈 전체 보여줘')).toMatchObject({ ok: true });
  });

  it('the basis line names the release, the project and the scope', () => {
    const entry = nlWave1Entry('jira.release');
    expect(entry.describe?.({ release: '20261015', project: '차란차 운영' }, undefined, 'ko')).toBe('릴리스 "20261015" / 프로젝트 "차란차 운영" / 내 담당');
    expect(entry.describe?.({ release: '20261015', scope: 'all' }, undefined, 'ko')).toBe('릴리스 "20261015" / 전체 담당');
    expect(entry.describe?.({ project: 'OP26' }, undefined, 'ko')).toBe('프로젝트 "OP26" / 릴리스 목록');
    expect(entry.describe?.({}, undefined, 'ko')).toBe('링크의 릴리스 / 내 담당');
  });

  it('the selection maps to a release command with the links of the owner own words', () => {
    expect(workChatCommandForSelection({ entryId: 'jira.release', args: { release: '20261015' }, language: 'ko' }, `봐줘 ${LINK}`)).toEqual({
      kind: 'release',
      source: 'jira',
      release: '20261015',
      scope: 'mine',
      links: [{ host: SITE, projectKey: 'OP26', versionId: '16555' }],
    });
    expect(workChatCommandForSelection({ entryId: 'jira.release', args: { scope: 'all', project: 'OP26' }, language: 'ko' })).toMatchObject({ scope: 'all', project: 'OP26', links: [] });
  });
});

describe('the A2 yield (A8): a Jira keyword slot that names a release or every assignee yields to selection', () => {
  it('release and all-assignee words are qualifiers the keyword forms cannot carry', () => {
    expect(jiraKeywordCarriesQualifier('20261015 릴리스')).toBe(true);
    expect(jiraKeywordCarriesQualifier('20261015 배포건')).toBe(true);
    expect(jiraKeywordCarriesQualifier('전체 담당')).toBe(true);
    expect(jiraKeywordCarriesQualifier('release 2.3')).toBe(true);
    expect(jiraKeywordCarriesQualifier('위클리카')).toBe(false);
  });

  it.each(['20261015 릴리스 관련 jira 이슈 보여줘', '지라에서 2.3.0 release 검색해줘'])('%s: grammar with yield off, selection with yield on', (text) => {
    expect(detectWorkChatCommand(text)).toMatchObject({ kind: 'lookup', source: 'jira' });
    expect(detectWorkChatCommand(text, { yieldToSelection: true })).toBeNull();
  });
});

describe('prompt nl-select.v39 (A8): the jira.release examples appear only while the entry is offered', () => {
  it('shows the entry and its examples with it, and is unchanged without it', () => {
    const withRelease = buildSelectionPrompt({ entries: [nlWave1Entry('jira.issues'), nlWave1Entry('jira.release')], text: 'x' });
    expect(withRelease).toContain('- jira.release: ');
    expect(withRelease).toContain('release: verbatim text.');
    expect(withRelease).toContain('scope: mine|all.');
    expect(withRelease).toContain('Message: 2.4.1 배포건 정리해줘');
    const without = buildSelectionPrompt({ entries: [nlWave1Entry('jira.issues')], text: 'x' });
    expect(without).not.toContain('jira.release');
    expect(without).not.toContain('2.4.1');
  });
});

describe('jira.release arg canonicalization (structural, v39)', () => {
  const argsOf = (result: ReturnType<typeof validate>) => (result.ok ? result.value.args : result);

  it('never splits "<KEY> <version>" in the validator (the lookup verifies the key against visible projects)', () => {
    expect(argsOf(validate('jira.release', { release: 'RC 2026' }, 'RC 2026 보여줘'))).toEqual({ release: 'RC 2026' });
    expect(argsOf(validate('jira.release', { release: 'ZQX9 20990101' }, 'ZQX9 20990101 보여줘'))).toEqual({ release: 'ZQX9 20990101' });
  });

  it('drops digits that come only from a pasted link, keeps digits the owner wrote or the previous selection holds', () => {
    const link = 'https://example.atlassian.net/projects/ZQX9/versions/16555/tab/release-report-all-issues';
    expect(argsOf(validate('jira.release', { release: '16555' }, `확인 ${link}`))).toEqual({});
    expect(argsOf(validate('jira.release', { release: '16555' }, `16555 확인 ${link}`))).toEqual({ release: '16555' });
    expect(argsOf(validate('jira.release', { release: '16555' }, '16555 확인'))).toEqual({ release: '16555' });
    expect(argsOf(validate('jira.release', { release: '20261015' }, '이 프로젝트에서도 보여줘 https://example.atlassian.net/projects/WEB', { release: '20261015' }))).toEqual({ release: '20261015' });
  });

  it('drops a project copied only from a pasted link (the link names it); keeps one the owner wrote or the previous selection holds', () => {
    const link = 'https://example.atlassian.net/projects/ZQX9/versions/16555/tab/release-report-all-issues';
    expect(argsOf(validate('jira.release', { project: 'ZQX9', release: '16555' }, `이 릴리스 이슈 정리해줘 ${link}`))).toEqual({});
    expect(argsOf(validate('jira.release', { project: 'zqx9' }, `확인 ${link}`))).toEqual({});
    expect(argsOf(validate('jira.release', { project: 'ZQX9' }, `ZQX9 이거 확인 ${link}`))).toEqual({ project: 'ZQX9' });
    expect(argsOf(validate('jira.release', { project: 'ZQX9', release: '20261015' }, `20261015 확인 ${link}`, { project: 'ZQX9' }))).toEqual({ project: 'ZQX9', release: '20261015' });
    // No link: the rule never fires (an ungrounded project is still refused by grounding).
    expect(argsOf(validate('jira.release', { project: 'ZQX9' }, 'ZQX9 릴리스 목록'))).toEqual({ project: 'ZQX9' });
  });
});

describe('lookupJiraRelease: the project words with the release words name one project (no such release)', () => {
  const only26: ConnectorItem[] = [{ id: 'OP26', title: '차란차 운영 2026' }, { id: 'WEB', title: '웹 개발' }];
  const lookup = async (command: Partial<ReleaseLookupCommand>, projects: ConnectorItem[], options: { truncated?: boolean; inChannel?: boolean; releases?: ConnectorItem[] } = {}) => {
    const queries: ConnectorQuery[] = [];
    const provider: ConnectorProvider = {
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) => {
        queries.push(query);
        if (query.query === 'containers') return { source: 'jira', items: projects, ...(options.truncated ? { truncated: true } : {}) };
        if (query.query === 'releases') return { source: 'jira', items: options.releases ?? RELEASES[String(query.params?.container)] ?? [] };
        return { source: 'jira', items: ISSUES };
      },
    };
    const result = await lookupJiraRelease({ connector: provider, command: { scope: 'all', links: [], ...command }, siteHost: SITE, identity: 'acc-1', ...(options.inChannel ? { inChannel: true } : {}) });
    return { text: result.kind === 'body' ? plainTextOf(result.body) : result.reason, queries };
  };

  it('one matching project: "차란차 운영" + "2026" is the release list of 차란차 운영 2026 (no extra read)', async () => {
    const { text, queries } = await lookup({ project: '차란차 운영', release: '2026' }, only26);
    expect(queries.map((query) => query.query)).toEqual(['containers', 'releases']);
    expect(text).toContain('**차란차 운영 2026 (OP26) 릴리스**');
  });

  it('several matching projects: the joined words pick the one they name, after no candidate held the release', async () => {
    const { text, queries } = await lookup({ project: '차란차 운영', release: '2026' }, PROJECTS);
    expect(queries.map((query) => query.query)).toEqual(['containers', 'releases', 'releases', 'releases']);
    expect(queries.at(-1)?.params).toEqual({ container: 'OP26' });
    expect(text).toContain('**차란차 운영 2026 (OP26) 릴리스**');
  });

  it('never folds back when the release exists, several releases hold it, the listing is truncated, or the words name no project', async () => {
    const exists = await lookup({ project: '차란차 운영', release: '2026' }, only26, { releases: [{ id: '1', title: '2026' }] });
    expect(exists.queries.at(-1)?.params).toMatchObject({ releaseId: '1' });
    const several = await lookup({ project: '차란차 운영', release: '2026' }, only26, { releases: [{ id: '1', title: '2026 상반기' }, { id: '2', title: '2026 하반기' }] });
    expect(several.text).toContain('릴리스를 찾지 못했어요');
    const truncated = await lookup({ project: '차란차 운영', release: '2026' }, only26, { truncated: true });
    expect(truncated.text).not.toContain('릴리스** (');
    const other = await lookup({ project: 'OP26', release: '2027' }, only26);
    expect(other.text).toContain('"2027" 릴리스를 찾지 못했어요');
  });

  it('only the exact full name counts: "Mobile App" + a missing "9.9.9" is a missing release, never its own release list', async () => {
    const mobile: ConnectorItem[] = [{ id: 'MOB', title: 'Mobile App' }, { id: 'WEB', title: '웹 개발' }];
    const dm = await lookup({ project: 'Mobile App', release: '9.9.9' }, mobile, { releases: [{ id: '1', title: '1.0.0' }] });
    expect(dm.text).toContain('"9.9.9" 릴리스를 찾지 못했어요');
    expect(dm.text).not.toContain('Mobile App (MOB) 릴리스**');
    const channel = await lookup({ project: 'Mobile App', release: '9.9.9', scope: 'mine' }, mobile, { releases: [{ id: '1', title: '1.0.0' }], inChannel: true });
    expect(channel.text).not.toContain('DM에서만');
    expect(channel.text).toContain('"9.9.9" 릴리스를 찾지 못했어요');
    // A plain substring of a longer name does not count either ("차란차" + "운영" is not "차란차 운영 2026").
    expect((await lookup({ project: '차란차', release: '운영' }, only26)).text).not.toContain('릴리스** (');
  });

  it('in a channel the folded-back list is refused like any list', async () => {
    const { text, queries } = await lookup({ project: '차란차 운영', release: '2026', scope: 'mine' }, only26, { inChannel: true });
    expect(text).toContain('DM에서만');
    expect(queries.some((query) => query.query === 'release-items')).toBe(false);
  });
});

describe('lookupJiraRelease: a key repeated inside the release words', () => {
  it('strips the key when project already is that same visible key', async () => {
    const { text, queries } = await run({ project: 'OP26', release: 'OP26 20261015' });
    expect(queries.at(-1)?.params).toEqual({ container: 'OP26', releaseId: '16555', limit: 20 });
    expect(text).toContain('**Jira 릴리스 20261015**');
  });

  it('an exact release named with the key wins over the key-stripped name; the stripped name is the fallback', async () => {
    const both: ConnectorProvider = {
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) =>
        query.query === 'containers' ? { source: 'jira', items: PROJECTS }
        : query.query === 'releases' ? { source: 'jira', items: [{ id: '1', title: '20261015' }, { id: '2', title: 'OP26 20261015' }] }
        : { source: 'jira', items: ISSUES },
    };
    const seen: ConnectorQuery[] = [];
    const spy: ConnectorProvider = { ...both, query: async (query) => { seen.push(query); return both.query(query); } };
    await lookupJiraRelease({ connector: spy, command: { scope: 'all', links: [], project: 'OP26', release: 'OP26 20261015' }, siteHost: SITE });
    expect(seen.at(-1)?.params).toMatchObject({ container: 'OP26', releaseId: '2' });
    const fallback = await run({ project: 'OP26', release: 'OP26 20261015' });
    expect(fallback.queries.at(-1)?.params).toMatchObject({ releaseId: '16555' });
  });

  it('the original wording with release words resolves to the key-named release; a truncated listing never falls back to the stripped name', async () => {
    const listing = (truncated: boolean, withKeyed = true): ConnectorProvider => ({
      source: 'jira', readOnly: true, isAvailable: async () => true,
      query: async (query) =>
        query.query === 'containers' ? { source: 'jira', items: PROJECTS }
        : query.query === 'releases' ? { source: 'jira', items: [{ id: '1', title: '20261015' }, ...(withKeyed ? [{ id: '2', title: 'OP26 20261015' }] : [])], ...(truncated ? { truncated: true } : {}) }
        : { source: 'jira', items: ISSUES },
    });
    const ask = async (provider: ConnectorProvider, release: string) => {
      const seen: ConnectorQuery[] = [];
      const spy: ConnectorProvider = { ...provider, query: async (query) => { seen.push(query); return provider.query(query); } };
      const result = await lookupJiraRelease({ connector: spy, command: { scope: 'all', links: [], project: 'OP26', release }, siteHost: SITE });
      return { seen, text: result.kind === 'body' ? plainTextOf(result.body) : result.reason };
    };
    expect((await ask(listing(false), 'OP26 20261015 배포건')).seen.at(-1)?.params).toMatchObject({ releaseId: '2' });
    const partial = await ask(listing(true, false), 'OP26 20261015 배포건');
    expect(partial.seen.some((query) => query.query === 'release-items')).toBe(false);
    expect(partial.text).toContain('찾지 못했어요');
  });

  it('leaves a different key alone when a project is set, and a key-shaped word that is no visible project', async () => {
    expect(stripRedundantProjectKey(PROJECTS, 'OP26', 'WEB 20261015')).toBeUndefined();
    expect(stripRedundantProjectKey(PROJECTS, 'RC', 'RC 2026')).toBeUndefined();
    const { text } = await run({ project: 'OP26', release: 'WEB 20261015' });
    expect(text).toContain('찾지 못했어요');
    const none = await run({ release: 'RC 2026' });
    expect(none.text).not.toContain('프로젝트 "RC"');
  });
});
