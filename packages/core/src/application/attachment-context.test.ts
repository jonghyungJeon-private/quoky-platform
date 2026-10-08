import { describe, expect, it } from 'vitest';
import type { ContextBundle, InboundAttachment, InboundMessage } from '../domain';
import {
  MAX_ATTACHED_TEXT_TOTAL_CHARS,
  MAX_ATTACHMENT_NAME_CHARS,
  clipHeadAndTail,
  currentTurnAttachmentsOf,
  hasEffectiveText,
  isCredentialShapedValue,
  hasNoUsableAttachment,
  isAttachmentReplyWithheld,
  prepareAttachedTextFiles,
  promptSafeAttachmentName,
  renderAttachedFileContent,
  renderAttachmentReplyWithheld,
  renderAttachmentsNotRead,
  withAttachedTextFiles,
} from './attachment-context';
import { containsCredentialMaterial } from './credential-guard';

const txt = (name: string, text: string): InboundAttachment => ({
  kind: 'text',
  name,
  mimeType: 'text/plain',
  sizeBytes: text.length,
  text,
  trust: 'UNTRUSTED',
});
const refused = (name: string, reason: 'CREDENTIAL_SHAPED' | 'TOO_LARGE' | 'UNSUPPORTED_TYPE'): InboundAttachment => ({
  kind: 'unsupported',
  name,
  sizeBytes: 10,
  reason,
});
const img: InboundAttachment = {
  kind: 'image',
  name: 'shot.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  imageRef: '/tmp/q/intake-1.png',
  trust: 'UNTRUSTED',
};
const messageWith = (attachments?: InboundAttachment[]): InboundMessage => ({
  id: 'm',
  context: { platform: 'test', channelId: 'c', userId: 'u' },
  text: '이 로그에서 문제 원인 요약해줘',
  receivedAt: '2026-10-07T00:00:00.000Z',
  ...(attachments ? { attachments } : {}),
});
const points = (s: string) => [...s].length;
const LOG = [
  '2026-10-07 10:12:09.006 ERROR [payment] PaymentGatewayTimeout: upstream did not respond within 5000ms (orderId=1183)',
  '2026-10-07 10:12:17.900 WARN  [circuit] payment-gateway circuit OPEN after 2 consecutive failures',
].join('\n');

describe('attachment-context (ADR-0111 D3, MM-1)', () => {
  it('carries a readable text file verbatim as untrusted attached data', () => {
    const current = currentTurnAttachmentsOf(messageWith([txt('app-error.log', LOG)]));
    expect(current).toEqual({
      textFiles: [
        {
          name: 'app-error.log',
          content: LOG,
          truncated: false,
          provenance: 'USER_ATTACHMENT',
          epistemicStatus: 'UNTRUSTED_ATTACHED_DATA',
        },
      ],
      notReadCount: 0,
    });
  });

  it('is undefined without attachments and skips images (MM-2 routes those)', () => {
    expect(currentTurnAttachmentsOf(messageWith())).toBeUndefined();
    expect(currentTurnAttachmentsOf(messageWith([]))).toBeUndefined();
    expect(currentTurnAttachmentsOf(messageWith([img]))).toBeUndefined();
  });

  it('counts refused attachments without carrying anything of them', () => {
    const current = currentTurnAttachmentsOf(
      messageWith([refused('config.yml', 'CREDENTIAL_SHAPED'), txt('a.log', 'ok'), refused('big.log', 'TOO_LARGE')]),
    );
    expect(current?.textFiles.map((f) => f.name)).toEqual(['a.log']);
    expect(current?.notReadCount).toBe(2);
    expect(JSON.stringify(current)).not.toContain('config.yml');
  });

  it('re-checks the credential guard at use: a matching file is dropped (never redacted) and counted as not read', () => {
    const current = currentTurnAttachmentsOf(
      messageWith([txt('config.json', '{ "db_password": "hunter2-prod" }\n'), txt('a.log', LOG)]),
    );
    expect(current?.textFiles.map((f) => f.name)).toEqual(['a.log']);
    expect(current?.notReadCount).toBe(1);
    expect(JSON.stringify(current)).not.toContain('hunter2-prod');
  });

  it('bounds all files together, shared evenly, keeping each file’s beginning and end', () => {
    const big = (tag: string) => `${tag}-HEAD\n${'x'.repeat(10_000)}\n${tag}-TAIL`;
    const current = currentTurnAttachmentsOf(messageWith([txt('a.log', big('A')), txt('b.log', big('B'))]));
    const files = current?.textFiles ?? [];
    expect(files).toHaveLength(2);
    const total = files.reduce((sum, f) => sum + points(f.content), 0);
    expect(total).toBeLessThanOrEqual(MAX_ATTACHED_TEXT_TOTAL_CHARS);
    for (const [file, tag] of [[files[0], 'A'], [files[1], 'B']] as const) {
      expect(file?.truncated).toBe(true);
      expect(file?.content.startsWith(`${tag}-HEAD`)).toBe(true);
      expect(file?.content.endsWith(`${tag}-TAIL`)).toBe(true);
      expect(file?.content).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/u);
    }
  });

  it('clips a name and leaves a short file untouched', () => {
    const current = currentTurnAttachmentsOf(messageWith([txt('n'.repeat(500), 'short')]));
    expect(points(current?.textFiles[0]?.name ?? '')).toBe(MAX_ATTACHMENT_NAME_CHARS);
    expect(clipHeadAndTail('short', 100)).toEqual({ text: 'short', truncated: false });
    const clipped = clipHeadAndTail('가'.repeat(5_000), 1_000);
    expect(clipped.truncated).toBe(true);
    expect(points(clipped.text)).toBeLessThanOrEqual(1_000);
  });

  it('withAttachedTextFiles returns the same bundle when the message has no attachment', () => {
    const bundle: ContextBundle = { taskId: 't', conversationTranscript: [], backgroundResources: [] };
    expect(withAttachedTextFiles(bundle, messageWith())).toBe(bundle);
    expect(withAttachedTextFiles(bundle, messageWith([txt('a.log', LOG)])).currentAttachments?.textFiles).toHaveLength(1);
  });

  it('hasNoUsableAttachment: true only when nothing of the attachments survives the final preparation', () => {
    expect(hasNoUsableAttachment(messageWith())).toBe(false);
    expect(hasNoUsableAttachment(messageWith([refused('config.yml', 'CREDENTIAL_SHAPED')]))).toBe(true);
    expect(hasNoUsableAttachment(messageWith([refused('big.log', 'TOO_LARGE'), refused('m.mp4', 'UNSUPPORTED_TYPE')]))).toBe(true);
    expect(hasNoUsableAttachment(messageWith([refused('big.log', 'TOO_LARGE'), txt('a.log', 'ok')]))).toBe(false);
    expect(hasNoUsableAttachment(messageWith([refused('big.log', 'TOO_LARGE'), img]))).toBe(false);
  });

  it('P2-4: a text file Core drops at its final re-check counts as unusable, like an adapter refusal', () => {
    const escaped = 'pass' + '\u001b[31m' + 'word=demo-review-value';
    const message = messageWith([txt('notes.txt', escaped)]);
    expect(currentTurnAttachmentsOf(message)).toEqual({ textFiles: [], notReadCount: 1, notReadReasons: ['CORE_RECHECK'] });
    expect(hasNoUsableAttachment(message)).toBe(true);
  });

  it('carries the intake reason of each refused attachment (live QA D13)', () => {
    const message: InboundMessage = {
      ...messageWith([txt('ok.txt', 'hello')]),
      attachments: [
        { kind: 'unsupported', name: 'qa-notes.pdf', mimeType: 'application/pdf', sizeBytes: 2048, reason: 'UNSUPPORTED_TYPE' },
        { kind: 'unsupported', name: 'big.log', mimeType: 'text/plain', sizeBytes: 9_000_000, reason: 'TOO_LARGE' },
      ],
    };
    expect(currentTurnAttachmentsOf(message)).toEqual({
      textFiles: [],
      notReadCount: 2,
      notReadReasons: ['UNSUPPORTED_TYPE', 'TOO_LARGE'],
    });
  });

  it('P1-1: the guard runs on the normalized, clipped text exactly as sent (an escape cannot split a secret)', () => {
    const escaped = 'line 1\npass' + '\u001b[31m' + 'word=demo-review-value\nline 3';
    // The raw text hides the pattern from the detector; the normalized one does not.
    expect(containsCredentialMaterial(escaped)).toBe(false);
    expect(containsCredentialMaterial(escaped.replace('\u001b[31m', ''))).toBe(true);
    const prepared = prepareAttachedTextFiles([{ name: 'app.log', text: escaped }]);
    expect(prepared).toEqual({ files: [], droppedCount: 1 });
    expect(JSON.stringify(currentTurnAttachmentsOf(messageWith([txt('app.log', escaped)])))).not.toContain('demo-review-value');
  });

  it('P1-1: terminal framing is stripped before clipping, so the content is exactly what a composer sends', () => {
    const prepared = prepareAttachedTextFiles([{ name: 'c.log', text: '\u001b[31mERROR\u001b[0m boom' }]);
    expect(prepared.files[0]?.content).toBe('ERROR boom');
  });

  it('P1-2: a credential-shaped file name is replaced by a neutral label; the harmless content is kept', () => {
    const secretName = 'sk-' + 'A'.repeat(24) + '.log';
    expect(containsCredentialMaterial(secretName)).toBe(true);
    const current = currentTurnAttachmentsOf(messageWith([txt(secretName, LOG)]));
    expect(current?.textFiles.map((f) => f.name)).toEqual(['attachment-1.log']);
    expect(current?.textFiles[0]?.content).toBe(LOG);
    expect(JSON.stringify(current)).not.toContain('A'.repeat(24));
    expect(promptSafeAttachmentName(secretName, 'image', 2)).toBe('image-2.log');
    expect(promptSafeAttachmentName('app-error.log', 'attachment', 1)).toBe('app-error.log');
    expect(promptSafeAttachmentName('a\u001b[31mb.log', 'attachment', 1)).toBe('ab.log');
  });

  it('every prepared file renders to text the credential guard accepts', () => {
    const prepared = prepareAttachedTextFiles([{ name: 'a.log', text: LOG }, { name: 'b.md', text: '# notes' }]);
    for (const file of prepared.files) expect(containsCredentialMaterial(renderAttachedFileContent(file))).toBe(false);
  });

  it('re-review P1: a zero-width or bidi character splitting a secret does not get a file through', () => {
    for (const ch of ['\u200B', '\u200C', '\u202E', '\uFEFF', '\r']) {
      const text = 'pass' + ch + 'word=demo-review-value';
      expect(prepareAttachedTextFiles([{ name: 'a.log', text }])).toEqual({ files: [], droppedCount: 1 });
      const name = 's' + ch + 'k-' + 'A'.repeat(24) + '.log';
      expect(promptSafeAttachmentName(name, 'attachment', 1)).toBe('attachment-1.log');
    }
  });

  it('re-review P2: metadata is walked raw, so a CR or NUL inside a value is not hidden by JSON escaping', () => {
    for (const ch of ['\r', '\u0000']) {
      const note = 'pass' + ch + 'word=demo-review-value';
      expect(isAttachmentReplyWithheld('요약입니다', [{ title: 'r', metadata: { note } }])).toBe(true);
      expect(isCredentialShapedValue({ nested: [{ deeper: { note } }] })).toBe(true);
      expect(isCredentialShapedValue({ ['pass' + ch + 'word=demo-review-value']: 1 })).toBe(true);
    }
    // The structured assignment form is still caught through the serialized view.
    expect(isCredentialShapedValue({ password: 'demo-review-value' })).toBe(true);
    expect(isCredentialShapedValue({ model: 'granite3.3:8b', tokens: 207, ok: true })).toBe(false);
    // Fail closed on cyclic or oversized data.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isCredentialShapedValue(cyclic)).toBe(true);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i += 1) deep = { d: deep };
    expect(isCredentialShapedValue(deep)).toBe(true);
  });

  describe('metadata is read without executing anything (re-review P2, safe snapshot)', () => {
    const VALUE = 'demo-review-value';
    const withheld = (metadata: unknown) => isAttachmentReplyWithheld('요약입니다', [{ title: 'r', metadata }]);

    it.each([
      ['CR', '\r'],
      ['NUL', '\u0000'],
      ['ZWSP', '\u200B'],
    ])('a key split by %s is caught together with its value', (_label, ch) => {
      const key = 'pass' + ch + 'word';
      expect(isCredentialShapedValue({ [key]: VALUE })).toBe(true);
      expect(withheld({ [key]: VALUE })).toBe(true);
      expect(withheld({ outer: [{ [key]: VALUE }] })).toBe(true);
      expect(withheld({ ['api' + ch + '_key']: VALUE })).toBe(true);
    });

    it('a getter is never invoked and counts as a match', () => {
      let calls = 0;
      const metadata = {};
      Object.defineProperty(metadata, 'note', { enumerable: true, get: () => { calls += 1; return 'ok'; } });
      expect(withheld(metadata)).toBe(true);
      expect(calls).toBe(0);
    });

    it('a throwing getter never runs: nothing escapes and the reply is withheld', () => {
      const metadata = {};
      Object.defineProperty(metadata, 'boom', { enumerable: true, get: () => { throw new Error('getter ran'); } });
      expect(() => withheld(metadata)).not.toThrow();
      expect(withheld(metadata)).toBe(true);
    });

    it('boxed primitives, toJSON, overridden array methods, class instances, symbol keys and proxies count as a match', () => {
      expect(withheld({ note: new String('ok') })).toBe(true);
      let toJsonCalls = 0;
      expect(withheld({ note: { toJSON: () => { toJsonCalls += 1; return 'ok'; } } })).toBe(true);
      expect(toJsonCalls).toBe(0);
      const list = ['ok'];
      let someCalls = 0;
      Object.defineProperty(list, 'some', { value: () => { someCalls += 1; return false; } });
      expect(withheld({ list })).toBe(true);
      expect(someCalls).toBe(0);
      class Note { readonly text = 'ok'; }
      expect(withheld({ note: new Note() })).toBe(true);
      expect(withheld({ [Symbol('k')]: 'ok' })).toBe(true);
      expect(withheld({ note: new Proxy({}, {}) })).toBe(true);
      expect(withheld({ fn: () => 'ok' })).toBe(true);
    });

    it('round 5: the artifact container must be a real, non-proxy array; nothing escapes', () => {
      let traps = 0;
      const proxyArray = new Proxy([], { get: () => { traps += 1; return 0; }, getPrototypeOf: () => { traps += 1; return Array.prototype; } });
      expect(isAttachmentReplyWithheld('요약입니다', proxyArray)).toBe(true);
      const throwing = new Proxy([], { ownKeys: () => { throw new Error('trap ran'); }, get: () => { throw new Error('trap ran'); } });
      expect(() => isAttachmentReplyWithheld('요약입니다', throwing)).not.toThrow();
      expect(isAttachmentReplyWithheld('요약입니다', throwing)).toBe(true);
      expect(traps).toBe(0);
      expect(isAttachmentReplyWithheld('요약입니다', { 0: { title: 'r', content: 'ok' } })).toBe(true);
      expect(isAttachmentReplyWithheld('요약입니다', 'not an array')).toBe(true);
      expect(isAttachmentReplyWithheld(42 as unknown as string, [])).toBe(true);
      const extraKey = [{ title: 'r' }] as unknown[] & { note?: string };
      extraKey.note = 'ok';
      expect(isAttachmentReplyWithheld('요약입니다', extraKey)).toBe(true);
    });

    it('round 5: a metadata getter that would return a secret first and a benign value second is rejected, never called', () => {
      let calls = 0;
      const artifact = { title: 'r', content: 'ok' };
      Object.defineProperty(artifact, 'metadata', {
        enumerable: true,
        get: () => { calls += 1; return calls === 1 ? { note: 'pass' + 'word=' + VALUE } : { note: 'ok' }; },
      });
      expect(isAttachmentReplyWithheld('요약입니다', [artifact])).toBe(true);
      expect(calls).toBe(0);
    });

    it.each([
      ['CR', '\r'],
      ['NUL', '\u0000'],
      ['ZWSP', '\u200B'],
    ])('round 5: an array with a non-index key split by %s is withheld', (_label, ch) => {
      const list = ['ok'] as unknown[] & Record<string, unknown>;
      list['pass' + ch + 'word'] = VALUE;
      expect(withheld({ list })).toBe(true);
      const keyOnly = ['ok'] as unknown[] & Record<string, unknown>;
      keyOnly['pass' + ch + 'word=' + VALUE] = true;
      expect(withheld({ list: keyOnly })).toBe(true);
    });

    it('round 5: a key that itself carries `password=…` is caught on its own', () => {
      expect(withheld({ ['pass' + 'word=' + VALUE]: true })).toBe(true);
    });

    it('round 5: shared references are not cycles; a real cycle still is', () => {
      const shared = { model: 'x', tokens: 3 };
      expect(withheld({ a: shared, b: shared, list: [shared, shared] })).toBe(false);
      const cyclic: Record<string, unknown> = { a: shared };
      cyclic.self = cyclic;
      expect(withheld(cyclic)).toBe(true);
    });

    it('round 5: Core-generated identity fields are not scanned (a UUID can look like a card number)', () => {
      const artifact = { id: '0b7f2c1e-1111-4222-8333-944445555666', kind: 'MARKDOWN_REPORT', title: 'r', content: 'ok', createdAt: '2026-10-07T00:00:00.000Z' };
      expect(isAttachmentReplyWithheld('요약입니다', [artifact])).toBe(false);
      expect(isAttachmentReplyWithheld('요약입니다', [{ ...artifact, title: 'pass' + 'word=' + VALUE }])).toBe(true);
      expect(isAttachmentReplyWithheld('요약입니다', [{ ...artifact, uri: 's' + 'k-' + 'A'.repeat(24) }])).toBe(true);
    });

    it('final check: a top-level artifact key/value pair is composite-checked like metadata', () => {
      expect(isAttachmentReplyWithheld('summary', [{ title: 'r', password: VALUE }])).toBe(true);
      expect(isAttachmentReplyWithheld('summary', [{ title: 'r', ['pass' + '\r' + 'word']: VALUE }])).toBe(true);
      expect(isAttachmentReplyWithheld('summary', [{ title: 'r', metadata: { password: VALUE } }])).toBe(true);
      expect(isAttachmentReplyWithheld('summary', [{ title: 'r', tokens: 207, model: 'x' }])).toBe(false);
    });

    it.each(['id', 'taskId', 'taskRunId', 'createdAt', 'kind'])(
      'final check: identity field %s must be a string primitive or undefined',
      (field) => {
        const base = { id: 'a1', kind: 'MARKDOWN_REPORT', title: 'r', content: 'ok', createdAt: '2026-10-07T00:00:00.000Z' };
        expect(isAttachmentReplyWithheld('summary', [{ ...base, [field]: 'plain-string' }])).toBe(false);
        expect(isAttachmentReplyWithheld('summary', [{ ...base, [field]: undefined }])).toBe(false);
        let traps = 0;
        const proxy = new Proxy({}, { get: () => { traps += 1; return 'x'; } });
        for (const bad of [proxy, () => 'x', new String('x'), 42, { nested: 'x' }, ['x'], null]) {
          expect(isAttachmentReplyWithheld('summary', [{ ...base, [field]: bad }])).toBe(true);
        }
        expect(traps).toBe(0);
        let calls = 0;
        const accessor = { ...base };
        Object.defineProperty(accessor, field, { enumerable: true, get: () => { calls += 1; return 'x'; } });
        expect(isAttachmentReplyWithheld('summary', [accessor])).toBe(true);
        expect(calls).toBe(0);
      },
    );

    it('ordinary plain metadata is not withheld', () => {
      expect(withheld({ tokens: 207, model: 'x' })).toBe(false);
      expect(withheld({ model: 'granite3.3:8b', promptSha256: 'a'.repeat(64), outputSanitized: true, list: [1, 'two', null] })).toBe(false);
      expect(withheld(Object.assign(Object.create(null) as object, { tokens: 3 }))).toBe(false);
      expect(withheld({ password: VALUE })).toBe(true);
    });
  });

  it('re-review P3: whitespace and invisible characters are not effective text', () => {
    for (const text of ['', '   ', '\u200B', '\uFEFF \u200C\n', '\u200B ']) {
      expect(hasEffectiveText(text), JSON.stringify(text)).toBe(false);
    }
    for (const text of ['<@1> 요약해줘', 'What is 2 + 2?', '?', 'ok']) {
      expect(hasEffectiveText(text), text).toBe(true);
    }
  });

  it('TG-1: Core knows no platform mention syntax (addressing is normalized by the platform adapter)', () => {
    // The Discord adapter turns an addressing-only attachment message into '' before it reaches Core
    // (`adapter-discord/src/addressing.ts`); Core treats any visible character as text.
    for (const text of ['<@123456789012345678>', '<@&42> <#99>', '@quoky_bot']) expect(hasEffectiveText(text), text).toBe(true);
  });

  it('P2-6: a credential-shaped reply or artifact is withheld; an ordinary log summary is not', () => {
    expect(isAttachmentReplyWithheld('결제 게이트웨이 타임아웃 후 서킷이 열렸어요.')).toBe(false);
    expect(isAttachmentReplyWithheld('설정값은 pass' + 'word=demo-review-value 입니다')).toBe(true);
    expect(isAttachmentReplyWithheld('설정값은 pass' + '\u200B' + 'word=demo-review-value 입니다')).toBe(true);
    expect(isAttachmentReplyWithheld('요약입니다', [{ title: 'r', content: 'pass' + 'word=demo-review-value' }])).toBe(true);
    expect(isAttachmentReplyWithheld('요약입니다', [{ title: 'r', metadata: { note: 's' + 'k-' + 'A'.repeat(24) } }])).toBe(true);
    expect(isAttachmentReplyWithheld('요약입니다', [{ title: 'r', content: '요약입니다' }])).toBe(false);
    expect(renderAttachmentReplyWithheld('ko')).toContain('저장하지도 않았어요');
    expect(renderAttachmentReplyWithheld('en')).toContain('not shown or saved');
  });

  it('the not-read reply is truthful in both languages', () => {
    expect(renderAttachmentsNotRead('ko')).toContain('읽지 않았기 때문에');
    expect(renderAttachmentsNotRead('ko')).toContain('어디로도 보내지 않았어요');
    expect(renderAttachmentsNotRead('en')).toContain('I did not read the attached file');
  });
});
