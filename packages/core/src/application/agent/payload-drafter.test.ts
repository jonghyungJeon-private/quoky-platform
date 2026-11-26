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
    ['https://example.test/a?b=1', 'https[:]/[/]example[.]test/a?b=1'],
    ['HTTP://EXAMPLE.TEST', 'HTTP[:]/[/]EXAMPLE[.]TEST'],
    ['ftp://files.example.test', 'ftp[:]/[/]files[.]example[.]test'],
    ['www.example.test/x', 'www[.]example[.]test/x'],
    ['example.test', 'example[.]test'],
    ['sub.example.co.kr/path', 'sub[.]example[.]co[.]kr/path'],
    ['사이트 example.test에서', '사이트 example[.]test에서'],
    ['dana@example.test', 'dana[@]example[.]test'],
    ['write to dana.sample@mail.example.test now', 'write to dana[.]sample[@]mail[.]example[.]test now'],
    ['10.0.0.1', '10[.]0[.]0[.]1'],
    ['http://192.168.1.5:8080/x', 'http[:]/[/]192[.]168[.]1[.]5:8080/x'],
    ['::1', '[:][:]1'],
    ['fe80::1', 'fe80[:][:]1'],
    ['evil。test', 'evil[.]test'],
    ['evil\u200b.example.test', 'evil[.]example[.]test'],
    ['<https://example.test|click>', '‹https[:]/[/]example[.]test|click›'],
    ['[click](https://example.test)', '\\[click\\]\\(https[:]/[/]example[.]test)'],
    ['![img](example.test/a.png)', '!\\[img\\]\\(example[.]test/a[.]png)'],
    ['[wiki|https://example.test]', '\\[wiki|https[:]/[/]example[.]test\\]'],
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
    expect(defangLinks('hxxp[:]//evil[.]test')).toBe('hxxp[:]/[/]evil[.]test');
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
    expect(result.draft.lines).toEqual(['Dana Example가 ‹!here› 에게 https[:]/[/]example[.]test 를 알렸다', '김예시: [@]channel 확인']);
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
    ['HtTp:////evil.test', 'HtTp[:]/[/][/][/]evil[.]test'],
    ['http://0x7f.0.0.1/', 'http[:]/[/]0x7f[.]0[.]0[.]1/'],
    ['http://0177.0.0.1/', 'http[:]/[/]0177[.]0[.]0[.]1/'],
    ['http://2130706433/', 'http[:]/[/]2130706433/'],
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

// Review round 2 (structural): markup-neutral output and the label token rule.
describe('review round 2: markup-neutral output', () => {
  it.each([
    '[.]: //2130706433',
    '[.]: //134744072',
    '//134744072',
    '!//134744072/x.png!',
    'http:134744072',
    'HTTP:134744072',
    '[x]: https://evil.test',
    '![x](y)',
    '<//x>',
    '[@]: //x',
    '/\\/x',
    '[.](//x)',
    '[@](//x)',
  ])('is markup-neutral: %j', (input) => {
    const out = defangLinks(input);
    expect(out, input).toBeDefined();
    const text = out as string;
    expect(text).not.toMatch(/\]:/u);
    expect(text).not.toMatch(/\]\(/u);
    expect(text).not.toContain('//');
    expect(text).not.toMatch(/[a-z]:\S/iu);
    expect(containsLiveLinkForm(text)).toBe(false);
    expect(defangLinks(text)).toBe(text);
  });

  it('turns the line-leading reference definition into inert markers', () => {
    expect(defangLinks('[.]: //2130706433')).toBe('[.][:] /[/]2130706433');
    expect(defangLinks('[@][.]')).toBe('[@][.]');
    expect(defangLinks('http:134744072')).toBe('http[:]134744072');
    expect(defangLinks('//134744072')).toBe('/[/]134744072');
  });

  it('leaves ordinary text alone (times, label colons with a space)', () => {
    for (const text of ['회의는 10:30에 시작', '결론: 승인', 'a/b 경로']) expect(defangLinks(text), text).toBe(text);
  });

  it('the re-check asserts the invariants, not only idempotence', () => {
    for (const text of ['x]: y', 'a](b', 'a//b', 'http:1', '\\//x']) expect(containsLiveLinkForm(text), text).toBe(true);
  });
});

describe('review round 2: the label token rule', () => {
  const MANY = [...PEOPLE, { label: '참여자 A2', name: 'Lee Sample' }];
  it.each(['참여자́ B', '참여자́ A', '참여자 A-2', '참여자 A 2', '참여자 A_2', '참여자 A.2', '참여자 A·2', '참여자 Á'])('refuses %j', (line) => {
    expect(remapParticipantLabels([line], MANY)).toEqual({ ok: false, reason: 'participants' });
  });

  it('maps a Hangul particle and a sentence-final dot; plain text passes', () => {
    expect(remapParticipantLabels(['참여자 A가 말했다', '그건 참여자 A.', '참여자 A. 다음', '참여자 수가 많다'], MANY)).toEqual({
      ok: true,
      lines: ['Dana Example가 말했다', '그건 Dana Example.', 'Dana Example. 다음', '참여자 수가 많다'],
      named: 1,
    });
  });

  it('maps the NFKC forms of a label (recorded for A7-S5 rows: Ⓐ, 𝐀, A² read as A, A, A2)', () => {
    const out = remapParticipantLabels(['참여자 Ⓐ', '참여자 𝐀', '참여자 A²'], MANY);
    expect(out).toEqual({ ok: true, lines: ['Dana Example', 'Dana Example', 'Lee Sample'], named: 2 });
  });
});

describe('review round 3: HTML character references', () => {
  it.each([
    'https&#58;&#47;&#47;evil&#46;com/x',
    'www&#46;evil&#46;com',
    'http&colon;&sol;&sol;134744072',
    'a&#64;evil&#46;com',
    'https&amp;#58;//evil.com',
    'https&#x3a;&#x2f;&#x2f;evil&#x2e;com',
    'https&#58&#47&#47evil&#46com',
    'https&#38;#58;&#38;#47;&#38;#47;evil.com',
    '＆#58;//x',
  ])('never leaves a live or decodable form: %j', (line) => {
    const result = assemblePayloadDraft(answer(line), PEOPLE);
    if (result.ok) {
      for (const out of result.draft.lines) {
        expect(out).not.toMatch(/&#|&[A-Za-z]/u);
        expect(out.replace(/\[[@.:/]\]/gu, '')).not.toMatch(/:\/\/|@|\.(?=[a-z])/u);
        expect(containsLiveLinkForm(out)).toBe(false);
      }
    }
  });

  it('decodes numeric references before every pass (the link is defanged, not passed)', () => {
    expect(assemblePayloadDraft(answer('see https&#58;&#47;&#47;evil&#46;com/x now'), PEOPLE)).toMatchObject({ ok: true, draft: { lines: ['see https[:]/[/]evil[.]com/x now'] } });
    expect(assemblePayloadDraft(answer('mail a&#64;evil&#46;com'), PEOPLE)).toMatchObject({ ok: true, draft: { lines: ['mail a[@]evil[.]com'] } });
    expect(assemblePayloadDraft(answer('x&#x3a;y&#38;#58;z'), PEOPLE)).toMatchObject({ ok: true });
  });

  it.each(['http&colon;&sol;&sol;134744072', 'a&amp;#58;b', 'x &lt;b&gt; y'])('refuses any named reference shape (fail closed): %j', (line) => {
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toEqual({ ok: false, reason: 'link' });
  });

  it('the re-check flags a raw reference and an undecodable one', () => {
    expect(containsLiveLinkForm('a &#58; b')).toBe(true);
    expect(containsLiveLinkForm('a &#99999999999; b')).toBe(true);
    expect(containsLiveLinkForm('a &colon; b')).toBe(true);
    expect(defangLinks('a &#99999999999; b')).toBeUndefined();
    expect(defangLinks('R & D, 5 &6')).toBe('R & D, 5 &6');
  });
});

describe('review round 3: label trailing punctuation', () => {
  it.each([
    ['(참여자 A).', '(Dana Example).'],
    ['참여자 A”', 'Dana Example”'],
    ['참여자 A…', 'Dana Example…'],
    ['참여자 A!?', 'Dana Example!?'],
  ])('maps %j', (line, expected) => {
    expect(remapParticipantLabels([line], PEOPLE)).toMatchObject({ ok: true, lines: [expected] });
  });

  it.each(['참여자 A’s', '참여자 A 3건', '참여자 A’s 말'])('still refuses (recorded fail-closed cost): %j', (line) => {
    expect(remapParticipantLabels([line], PEOPLE)).toEqual({ ok: false, reason: 'participants' });
  });

  it('maps the NFKC modifier letter `참여자 ᴬ` to A (recorded for A7-S5)', () => {
    expect(remapParticipantLabels(['참여자 ᴬ'], PEOPLE)).toMatchObject({ ok: true, lines: ['Dana Example'] });
  });
});

describe('review round 4: numeric references are decoded before the pseudonym remap', () => {
  it.each(['&#52280;여자 A', '참&#50668;자 A', '&#xCC38;&#xC5EC;&#xC790; A'])('the encoded label %j maps exactly like the plain label', (line) => {
    const encoded = assemblePayloadDraft(answer(`${line} 확인`), PEOPLE);
    const plain = assemblePayloadDraft(answer('참여자 A 확인'), PEOPLE);
    expect(encoded).toEqual(plain);
    expect(encoded).toMatchObject({ ok: true, draft: { named: 1 } });
  });
  it('an encoded altered label refuses like the plain altered label', () => {
    expect(assemblePayloadDraft(answer('&#xCC38;&#xC5EC;&#xC790; AB'), PEOPLE)).toEqual({ ok: false, reason: 'participants' });
    expect(assemblePayloadDraft(answer('&#52280;여자A'), PEOPLE)).toEqual({ ok: false, reason: 'participants' });
  });
  it('an encoded trailing dot after the label maps', () => {
    expect(assemblePayloadDraft(answer('참여자 A&#46;'), PEOPLE)).toEqual(assemblePayloadDraft(answer('참여자 A.'), PEOPLE));
    expect(assemblePayloadDraft(answer('참여자 A&#46;'), PEOPLE)).toMatchObject({ ok: true });
  });
});

describe('owner relaxation 2026-11-26: bare ampersand', () => {
  it.each(['Q&A', 'R&D', 'AT&T', 'Q&A and R&D at AT&T', 'a & b', 'x &6 y', 'R&Dteam', 'Tom&Jerry', 'a&b=c'])('passes byte-exact: %j', (line) => {
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toMatchObject({ ok: true, draft: { lines: [line] } });
  });
  it.each([
    '&amp;', '&lt;', '&gt;', '&quot;', '&colon;', '&sol;', '&Tab;', '&nbsp;', 'a&b;c', 'Q&A;',
    '&amp', '&lt', '&gt', '&quot', '&AMP', '&Lt', '&GT', '&QuOt', '&ampx', '&ltr', '&gtx', '&quotes', '&shy', '&SHY', '&LT',
    '＆amp', '＆lt;', '&#38;amp', '&#38;lt', '&#x26;quot', '&#38;colon;', '&#', '&#99999999999;', 'x&amp;#58;y',
  ])('still refuses: %j', (line) => {
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toEqual({ ok: false, reason: 'link' });
  });
  it.each(['&nbsp', '&copy'])('residual (recorded): a no-semicolon name that decodes to no syntax character passes: %j', (line) => {
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toMatchObject({ ok: true, draft: { lines: [line] } });
  });
  it('a no-semicolon name followed by a syntax character keeps that character neutralised', () => {
    expect(assemblePayloadDraft(answer('&nbsp<'), PEOPLE)).toMatchObject({ ok: true, draft: { lines: ['&nbsp‹'] } });
  });
  it('the re-check agrees', () => {
    expect(containsLiveLinkForm('Q&A and R&D')).toBe(false);
    expect(containsLiveLinkForm('a &lt b')).toBe(true);
    expect(containsLiveLinkForm('a &x; b')).toBe(true);
  });
});

describe('owner relaxation 2026-11-26: inert bracket pairs', () => {
  it.each([
    ['[BE-123]', '[BE-123]'],
    ['see [BE-123] now', 'see [BE-123] now'],
    ['[BE-1] and [BE-2].', '[BE-1] and [BE-2].'],
    ['[중요] 릴리즈', '[중요] 릴리즈'],
    ['[Q3 plan]', '[Q3 plan]'],
    ['[a]', '[a]'],
    ['(see [BE-1])', '(see [BE-1])'],
    ['x[BE-1]', 'x[BE-1]'],
    ['\\[BE-1]', '\\[BE-1\\]'],
  ])('keeps an inert pair: %j', (line, out) => {
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toMatchObject({ ok: true, draft: { lines: [out] } });
    expect(defangLinks(out)).toBe(out);
    expect(containsLiveLinkForm(out)).toBe(false);
  });
  it.each([
    ['[x](https://example.test)', '\\[x\\]\\(https[:]/[/]example[.]test)'],
    ['[BE-1](x)', '\\[BE-1\\]\\(x)'],
    ['[BE-1]: x', '\\[BE-1\\][:] x'],
    ['[BE-1]:x', '\\[BE-1\\][:]x'],
    ['![BE-1]', '!\\[BE-1\\]'],
    ['![BE-1](a)', '!\\[BE-1\\]\\(a)'],
    ['[a][BE-1]', '\\[a\\]\\[BE-1\\]'],
    ['[BE-1][x]', '\\[BE-1\\]\\[x\\]'],
    ['[BE-1][@]', '\\[BE-1\\][@]'],
    ['[@][BE-1]', '[@]\\[BE-1\\]'],
    ['[~user]', '\\[~user\\]'],
    ['[a|b]', '\\[a|b\\]'],
    ['[a.b]', '\\[a.b\\]'],
    ['[a/b]', '\\[a/b\\]'],
    ['[a:b]', '\\[a[:]b\\]'],
    ['[a b ]', '\\[a b \\]'],
    ['[ a]', '\\[ a\\]'],
    ['[-a]', '\\[-a\\]'],
    ['[]', '\\[\\]'],
    ['[[BE-1]]', '\\[[BE-1]\\]'],
    ['[BE-1]]', '[BE-1]\\]'],
    ['\\[BE-1\\]', '\\[BE-1\\]'],
    ['[ＢＥ-1](x)', '\\[BE-1\\]\\(x)'],
    ['［BE-1］：x', '\\[BE-1\\][:]x'],
    ['[BE-1]（x）', '\\[BE-1\\]\\(x)'],
    ['[' + 'a'.repeat(40) + ']', '\\[' + 'a'.repeat(40) + '\\]'],
  ])('still escapes a live or non-inert form: %j', (line, out) => {
    const result = assemblePayloadDraft(answer(line), PEOPLE);
    if (result.ok) {
      expect(result.draft.lines[0]).not.toMatch(/\]\(|\]:|!\[/u);
      expect(containsLiveLinkForm(result.draft.lines[0] ?? '')).toBe(false);
    }
    expect(defangLinks(line)).toBe(out);
  });
  it('is a fixed point and numeric references cannot smuggle a live bracket', () => {
    for (const line of ['[BE-1] x', '[BE-1]&#40;x&#41;', '&#91;BE-1&#93;&#40;x', '[BE-1]&#58; x', '&#33;[BE-1]', '[BE-1]&#91;x&#93;']) {
      const once = defangLinks(line);
      if (once !== undefined) {
        expect(defangLinks(once)).toBe(once);
        expect(containsLiveLinkForm(once)).toBe(false);
        expect(once.replace(/\\[\\[\](]|\[[@.:/]\]/gu, '')).not.toMatch(/\]\(|\]:|!\[|\]\[/u);
      }
    }
    expect(defangLinks('[BE-1]&#40;x&#41;')).toBe('\\[BE-1\\]\\(x)');
    expect(defangLinks('&#33;[BE-1]')).toBe('!\\[BE-1\\]');
  });
  it('the re-check refuses an unescaped live bracket', () => {
    for (const bad of ['[BE-1](x)', '[BE-1]: x', '![BE-1]', '[a][BE-1]', '[a.b]', '[~u]', '[a|b]']) expect(containsLiveLinkForm(bad)).toBe(true);
  });
});

describe('owner relaxation 2026-11-26: review round 1 pins (spaced, multiline, hidden-character forms)', () => {
  it.each([
    ['[a] (b)', '[a] (b)'],
    ['[a] [b]', '[a] [b]'],
    ['[a] : x', '[a] : x'],
    ['[a]@b', '\\[a\\][@]b'],
    ['[a]\u200b(x)', '\\[a\\]\\(x)'],
    ['[a]\u00ad(x)', '\\[a\\]\\(x)'],
  ])('exact output (inert): %j', (line, out) => {
    expect(assemblePayloadDraft(answer(line), PEOPLE)).toEqual({ ok: true, draft: { lines: [out], named: 0 } });
  });
  it('a reference definition on line 2 is sealed with [:]', () => {
    expect(assemblePayloadDraft(answer('[a]', '[a]: x'), PEOPLE)).toEqual({ ok: true, draft: { lines: ['[a]', '\\[a\\][:] x'], named: 0 } });
  });
});
