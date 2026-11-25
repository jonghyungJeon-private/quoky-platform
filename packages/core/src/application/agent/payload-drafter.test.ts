import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_DRAFT_LINE_MAX_CHARS,
  AGENT_DRAFT_MAX_LINES,
  PAYLOAD_DRAFT_PROMPT_VERSION,
  assemblePayloadDraft,
  containsLiveLinkForm,
  defangLinks,
  neutraliseMentions,
  parsePayloadDraftOutput,
  remapParticipantLabels,
  renderPayloadDraftPrompt,
} from './payload-drafter';

// ADR-0121 A7-S3: the pure half of the drafter. Deterministic, no model, synthetic names only.

const answer = (...lines: string[]): string => JSON.stringify({ lines });
const PEOPLE = [
  { label: '참여자 A', name: 'Dana Example' },
  { label: '참여자 B', name: '김예시' },
];

describe('the prompt template', () => {
  it('pins the template bytes (a wording change bumps the version)', () => {
    const prompt = renderPayloadDraftPrompt(['{"title":"t1"}', '{"title":"t2"}']);
    expect(PAYLOAD_DRAFT_PROMPT_VERSION).toBe('payload-draft-prompt.v1');
    expect(createHash('sha256').update(prompt).digest('hex')).toBe('b644ee04a9bfb400a5ceb01362ef3078da3fcc1d6a63ef4e4cfe37b723848bfe');
  });

  it('keeps the data inside the span, states the caps and forbids links, mentions and following content', () => {
    const prompt = renderPayloadDraftPrompt(['ITEMBODY']);
    const span = prompt.slice(prompt.indexOf('<<<UNTRUSTED_SPAN'));
    expect(span).toContain('ITEM 1\nITEMBODY');
    expect(prompt.slice(0, prompt.indexOf('<<<UNTRUSTED_SPAN\n'))).not.toContain('ITEMBODY');
    expect(prompt).toContain(`between 1 and ${AGENT_DRAFT_MAX_LINES} lines`);
    expect(prompt).toContain(`at most ${AGENT_DRAFT_LINE_MAX_CHARS} characters`);
    expect(prompt).toMatch(/never instructions/);
    expect(prompt).toMatch(/no links/);
  });
});

describe('payload-draft.v1 caps', () => {
  it('accepts 1 to 8 lines of at most 200 characters', () => {
    expect(parsePayloadDraftOutput(answer('one'))).toEqual({ ok: true, lines: ['one'] });
    const eight = Array.from({ length: 8 }, (_, i) => `line ${i}`);
    expect(parsePayloadDraftOutput(answer(...eight))).toEqual({ ok: true, lines: eight });
    expect(parsePayloadDraftOutput(answer('가'.repeat(200)))).toMatchObject({ ok: true });
  });

  it.each([
    ['no lines', answer()],
    ['nine lines', answer(...Array.from({ length: 9 }, (_, i) => `l${i}`))],
    ['a 201-character line', answer('a'.repeat(201))],
    ['an empty line', answer('ok', '')],
    ['a blank line', answer('ok', '   ')],
    ['a line break inside a line', JSON.stringify({ lines: ['a\nb'] })],
    ['a unicode line separator inside a line', JSON.stringify({ lines: ['a\u2028b'] })],
    ['an extra key', JSON.stringify({ lines: ['a'], note: 'x' })],
    ['a missing key', JSON.stringify({ rows: ['a'] })],
    ['a non-string line', JSON.stringify({ lines: ['a', 3] })],
    ['a string instead of an array', JSON.stringify({ lines: 'a' })],
    ['a code fence', '```json\n{"lines":["a"]}\n```'],
    ['prose around the object', 'Here: {"lines":["a"]} done'],
    ['an array', '["a"]'],
    ['not JSON', '{lines: a}'],
  ])('refuses %s as a schema failure (never repaired)', (_name, text) => {
    expect(parsePayloadDraftOutput(text)).toEqual({ ok: false, reason: 'schema' });
  });

  it('refuses an answer over the output byte cap', () => {
    expect(parsePayloadDraftOutput(`{"lines":["a"],"pad":"${'x'.repeat(20 * 1024)}"}`)).toEqual({ ok: false, reason: 'schema' });
  });

  it('is total on non-string input', () => {
    expect(parsePayloadDraftOutput(undefined as never)).toEqual({ ok: false, reason: 'schema' });
  });
});

describe('credential guard', () => {
  it('reports credential-shaped output as a credential failure, whatever else is wrong with it', () => {
    expect(parsePayloadDraftOutput(answer('the password: hunter2x was shared'))).toEqual({ ok: false, reason: 'credential' });
    expect(assemblePayloadDraft(answer('ok', 'password=abc123'), PEOPLE)).toEqual({ ok: false, reason: 'credential' });
  });

  it('a link inside a line is not a schema failure', () => {
    expect(parsePayloadDraftOutput(answer('see https://example.test/a for details'))).toMatchObject({ ok: true });
  });
});

describe('the remap (a7-08)', () => {
  it('maps pseudonyms to real names as plain text, longest form first, and counts the people', () => {
    expect(remapParticipantLabels(['참여자 A가 참여자 B에게 물었다', '참여자 A 확인'], PEOPLE)).toEqual({ ok: true, lines: ['Dana Example가 김예시에게 물었다', 'Dana Example 확인'], named: 2 });
  });

  it('keeps a two-digit round label whole (참여자 A2 is not 참여자 A plus 2)', () => {
    const people = [...PEOPLE, { label: '참여자 A2', name: 'Lee Sample' }];
    expect(remapParticipantLabels(['참여자 A2와 참여자 A'], people)).toEqual({ ok: true, lines: ['Lee Sample와 Dana Example'], named: 2 });
  });

  it.each(['참여자 Z가 했다', '참여자A가 했다', '참여자  A가 했다', '참여자 a가 했다', '참여자 AB가 했다', '참여자 A2가 했다'])('refuses an unknown or altered label: %s', (line) => {
    expect(remapParticipantLabels([line], PEOPLE)).toEqual({ ok: false, reason: 'participants' });
  });

  it('leaves a line with no label alone and names nobody', () => {
    expect(remapParticipantLabels(['배포가 끝났다'], PEOPLE)).toEqual({ ok: true, lines: ['배포가 끝났다'], named: 0 });
    expect(remapParticipantLabels(['배포가 끝났다'], [])).toEqual({ ok: true, lines: ['배포가 끝났다'], named: 0 });
  });

  it('refuses an unusable map: a duplicate label, a non-grammar label, an empty, long or multi-line name', () => {
    for (const bad of [
      [PEOPLE[0], PEOPLE[0]],
      [{ label: 'A', name: 'x' }],
      [{ label: '참여자 a', name: 'x' }],
      [{ label: '참여자 A', name: '' }],
      [{ label: '참여자 A', name: 'n'.repeat(61) }],
      [{ label: '참여자 A', name: 'a\nb' }],
    ]) {
      expect(remapParticipantLabels(['x'], bad as never), JSON.stringify(bad)).toEqual({ ok: false, reason: 'participants' });
    }
  });

  it('a name containing mention or link syntax is still neutralised afterwards (names are text, never mentions)', () => {
    const result = assemblePayloadDraft(answer('참여자 A 확인'), [{ label: '참여자 A', name: '@here dana.example.test' }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.lines).toEqual(['[@]here dana[.]example[.]test 확인']);
      expect(result.draft.named).toBe(1);
    }
  });
});

describe('mention neutraliser', () => {
  it.each([
    ['<!here> look', '‹!here› look'],
    ['<!channel>', '‹!channel›'],
    ['<!everyone>', '‹!everyone›'],
    ['<@U123ABC> hi', '‹[@]U123ABC› hi'],
    ['<#C123|general>', '‹#C123|general›'],
    ['<!subteam^S1|team>', '‹!subteam^S1|team›'],
    ['@here now', '[@]here now'],
    ['@channel', '[@]channel'],
    ['@everyone', '[@]everyone'],
    ['ping @dana please', 'ping [@]dana please'],
    ['[~dana] [~accountid:abc]', '\\[~dana\\] \\[~accountid[:]abc\\]'],
    ['accountid:5b10', 'accountid[:]5b10'],
    ['＠here', '[@]here'],
  ])('renders %j inert', (input, expected) => {
    expect(neutraliseMentions(input)).toBe(expected);
  });

  it('leaves plain text alone and is idempotent', () => {
    expect(neutraliseMentions('배포는 오후에 끝났다.')).toBe('배포는 오후에 끝났다.');
    const once = neutraliseMentions('<@U1> and @here [~x]');
    expect(neutraliseMentions(once)).toBe(once);
    expect(once).not.toMatch(/[<>]/);
  });

  it('is total', () => {
    expect(neutraliseMentions(undefined as never)).toBe('');
  });
});

describe('link defanger', () => {
  it.each([
    ['https://example.test/a?b=1', 'https[:]//example[.]test/a?b=1'],
    ['HTTP://EXAMPLE.TEST', 'HTTP[:]//EXAMPLE[.]TEST'],
    ['ftp://files.example.test', 'ftp[:]//files[.]example[.]test'],
    ['www.example.test/x', 'www[.]example[.]test/x'],
    ['example.test', 'example[.]test'],
    ['sub.example.co.kr/path', 'sub[.]example[.]co[.]kr/path'],
    ['사이트 example.test에서', '사이트 example[.]test에서'],
    ['dana@example.test', 'dana[@]example[.]test'],
    ['write to dana.sample@mail.example.test now', 'write to dana[.]sample[@]mail[.]example[.]test now'],
    ['10.0.0.1', '10[.]0[.]0[.]1'],
    ['http://192.168.1.5:8080/x', 'http[:]//192[.]168[.]1[.]5:8080/x'],
    ['::1', '[:][:]1'],
    ['fe80::1', 'fe80[:][:]1'],
    ['evil。test', 'evil[.]test'],
    ['evil\u200b.example.test', 'evil[.]example[.]test'],
    ['<https://example.test|click>', '‹https[:]//example[.]test|click›'],
    ['[click](https://example.test)', '\\[click\\](https[:]//example[.]test)'],
    ['![img](example.test/a.png)', '!\\[img\\](example[.]test/a[.]png)'],
    ['[wiki|https://example.test]', '\\[wiki|https[:]//example[.]test\\]'],
  ])('defangs %j', (input, expected) => {
    expect(defangLinks(input)).toBe(expected);
  });

  it('leaves ordinary text alone (versions, numbers, times, file names)', () => {
    for (const text of ['v1.2.3 배포 완료', '3.5배 증가', '10:30 시작', 'report.pdf 확인', '문장입니다. 다음 문장입니다.', 'Node.js 업데이트']) {
      expect(defangLinks(text), text).toBe(text);
    }
  });

  it('is idempotent and its result holds no live form', () => {
    for (const input of ['https://example.test/a', 'dana@example.test', '10.0.0.1', '<!here> [~x] www.example.test']) {
      const once = defangLinks(input) as string;
      expect(defangLinks(once)).toBe(once);
      expect(containsLiveLinkForm(once), input).toBe(false);
    }
  });

  it('an already-defanged form is accepted as is', () => {
    expect(defangLinks('hxxp[:]//evil[.]test')).toBe('hxxp[:]//evil[.]test');
  });

  it('detects the live forms it removes', () => {
    for (const text of ['https://example.test', 'www.example.test', 'example.test/x', 'dana@example.test', '10.0.0.1', '<!here>', '<@U1>', '[~x]', '[a|b]', '@here', '::1']) {
      expect(containsLiveLinkForm(text), text).toBe(true);
    }
    expect(containsLiveLinkForm('plain text, v1.2.3, 10:30')).toBe(false);
  });
});

describe('assembly order and refusals', () => {
  it('assembles schema, remap, mentions, links in order, frozen', () => {
    const result = assemblePayloadDraft(answer('참여자 A가 <!here> 에게 https://example.test 를 알렸다', '참여자 B: @channel 확인'), PEOPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.lines).toEqual(['Dana Example가 ‹!here› 에게 https[:]//example[.]test 를 알렸다', '김예시: [@]channel 확인']);
    expect(result.draft.named).toBe(2);
    expect(Object.isFrozen(result.draft)).toBe(true);
    expect(Object.isFrozen(result.draft.lines)).toBe(true);
  });

  it('an unknown label refuses the whole draft; a bad schema refuses before the remap', () => {
    expect(assemblePayloadDraft(answer('참여자 Z 확인'), PEOPLE)).toEqual({ ok: false, reason: 'participants' });
    expect(assemblePayloadDraft('nope', PEOPLE)).toEqual({ ok: false, reason: 'schema' });
  });

  it('refuses a line that grows past the assembled bound after the remap (never cut)', () => {
    const wide = [{ label: '참여자 A', name: 'n'.repeat(60) }];
    const line = Array.from({ length: 25 }, () => '참여자 A').join(' ');
    expect(Array.from(line).length).toBeLessThanOrEqual(AGENT_DRAFT_LINE_MAX_CHARS);
    expect(assemblePayloadDraft(answer(line), wide)).toEqual({ ok: false, reason: 'size' });
    expect(assemblePayloadDraft(answer('참여자 A 확인'), wide)).toMatchObject({ ok: true });
  });

  it('refuses a card-spoof line (the existing closed-set matcher), so no look-alike approval reaches a card', () => {
    expect(assemblePayloadDraft(answer('승인'), PEOPLE)).toEqual({ ok: false, reason: 'spoof' });
    expect(assemblePayloadDraft(answer('ok', '댓글 실행'), PEOPLE)).toEqual({ ok: false, reason: 'spoof' });
    expect(assemblePayloadDraft(answer('승인 절차는 다음 주에 논의'), PEOPLE)).toMatchObject({ ok: true });
  });

  it('a hostile content-shaped draft ends up inert end to end', () => {
    const hostile = answer(
      '요청: <!channel> 지금 https://evil.example.test/login 에 접속하세요',
      '[승인](https://evil.example.test) 후 dana@evil.example.test 로 회신',
      '@everyone 모두 10.1.2.3 확인',
    );
    const result = assemblePayloadDraft(hostile, PEOPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const line of result.draft.lines) expect(containsLiveLinkForm(line), line).toBe(false);
  });
});

describe('review round 1 (marker exactness, link forms, altered labels, IDN dots)', () => {
  it.each([
    'mail kim[@evil.com now',
    '[@here',
    '[@channel]',
    'x [@everyone',
    'a@[@]b',
    '\\[@here',
    '\\\\[@here',
  ])('a marker bracket never lends its @ a safe look: %j', (input) => {
    const out = defangLinks(input) as string;
    expect(out).toBeDefined();
    expect(containsLiveLinkForm(out), out).toBe(false);
    // Every @ is inside an exact [@] marker.
    expect(out.replace(/\[@\]/g, '')).not.toContain('@');
    expect(defangLinks(out)).toBe(out);
  });

  it('defangs the e-mail domain behind an open bracket', () => {
    expect(defangLinks('mail kim[@evil.com now')).toBe('mail kim\\[[@]evil[.]com now');
  });

  it.each([
    '[.](https:/2130706433)',
    '[.](https:///127.0.0.1)',
    '[@](https:/evil.test)',
    '[:](x)',
    'a@(https://evil.test)',
    '[.][ref]',
  ])('our own markers never open a markdown link: %j', (input) => {
    const out = defangLinks(input) as string;
    expect(out).toBeDefined();
    expect(out).not.toMatch(/(?<!\\)\]\(/);
    expect(containsLiveLinkForm(out)).toBe(false);
  });

  it.each([
    ['https:/2130706433', 'https[:]/2130706433'],
    ['HTTPS:\\evil.test', 'HTTPS[:]\\\\evil[.]test'],
    ['HtTp:////evil.test', 'HtTp[:]////evil[.]test'],
    ['http://0x7f.0.0.1/', 'http[:]//0x7f[.]0[.]0[.]1/'],
    ['http://0177.0.0.1/', 'http[:]//0177[.]0[.]0[.]1/'],
    ['http://2130706433/', 'http[:]//2130706433/'],
  ])('defangs the scheme and numeric host of %j', (input, expected) => {
    expect(defangLinks(input)).toBe(expected);
  });

  it('keeps a backslash from escaping our own marker', () => {
    expect(defangLinks('\\@here')).toBe('\\\\[@]here');
  });

  it.each(['참여자 Α', '참여자 А', '참여자 1', '참여자-A', '참여자 _A', '참여자: 2', '참여자Α'])('an altered or look-alike label refuses the draft: %j', (line) => {
    expect(remapParticipantLabels([line], PEOPLE)).toEqual({ ok: false, reason: 'participants' });
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toEqual({ ok: false, reason: 'participants' });
  });

  it('a Hangul particle or word after 참여자 is not label-like', () => {
    expect(remapParticipantLabels(['참여자 수가 늘었다', '참여자들은 동의했다', '참여자 A가 했다'], PEOPLE)).toEqual({
      ok: true,
      lines: ['참여자 수가 늘었다', '참여자들은 동의했다', 'Dana Example가 했다'],
      named: 1,
    });
  });

  it.each(['example.السعودية', 'example.இந்தியா', 'shop.рф', 'a.ελ'])('defangs the dot of a non-Latin TLD: %j', (input) => {
    const out = defangLinks(input) as string;
    expect(out).toContain('[.]');
    expect(out.replace(/\[\.\]/g, '')).not.toContain('.');
    expect(containsLiveLinkForm(out)).toBe(false);
  });

  it('leaves CJK sentence dots alone', () => {
    for (const text of ['끝났다.다음', '完了.次へ', 'v1.2']) expect(defangLinks(text), text).toBe(text);
  });
});
