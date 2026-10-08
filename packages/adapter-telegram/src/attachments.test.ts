import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundAttachment, InboundMessage, LogFields, Logger } from '@quoky/core';
import {
  ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_MAX_BYTES,
  renderAttachmentIntakeNote,
  TelegramAttachmentIntake,
  TEXT_ATTACHMENT_MAX_BYTES,
} from './attachments';
import type { TelegramAttachmentSource, TelegramFileGateway } from './attachments';
import { TELEGRAM_API_ORIGIN, TelegramApiError, TelegramFailureCode } from './bot-api';
import { TelegramBotToken } from './bot-token';
import { canonicalizeImage } from './image-canonical';
import { jpegImage, PNG_SIGNATURE, pngChunk, pngImage, riffChunk, riffWebp, vp8lPayload } from './image-test-support';
import { TelegramPlatformAdapter } from './telegram-platform-adapter';
import type { TelegramAdapterOptions } from './telegram-platform-adapter';
import {
  bytesReply,
  documentField,
  errorReply,
  FAKE_BOT_ID,
  FAKE_TOKEN,
  FAKE_TOKEN_SECRET,
  FakeTelegram,
  fileReply,
  flush,
  mediaUpdate,
  okReply,
  OWNER_ID,
  photoField,
  reactionUpdate,
  STRANGER_ID,
  textUpdate,
  until,
} from './test-support';

const PNG = pngImage();
const JPEG = jpegImage();
const WEBP = riffWebp([riffChunk('VP8L', vp8lPayload())]);
/** Credential-shaped bytes built at runtime (no credential literal in source). */
const SECRET = Buffer.from('pass' + 'word=SYNTHETIC_REVIEW_ONLY', 'latin1');

let scratch: string;
let tempRoot: string;
beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'quoky-tg-intake-'));
  tempRoot = path.join(scratch, 'intake');
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A scripted gateway: per file id a `getFile` answer, per file path the downloaded bytes (or a failure). */
function fakeGateway(files: Record<string, { path?: string; size?: number; bytes?: Buffer; downloadError?: unknown; getFileError?: unknown }>) {
  const calls: string[] = [];
  const gateway: TelegramFileGateway = {
    getFile: async (fileId) => {
      calls.push(`getFile:${fileId}`);
      const file = files[fileId];
      if (!file) throw new TelegramApiError(TelegramFailureCode.BAD_REQUEST, 'getFile', 400);
      if (file.getFileError !== undefined) throw file.getFileError;
      return { file_id: fileId, file_unique_id: 'u', ...(file.path !== undefined ? { file_path: file.path } : {}), ...(file.size !== undefined ? { file_size: file.size } : {}) };
    },
    download: async (filePath, maxBytes) => {
      calls.push(`download:${filePath}:${maxBytes}`);
      const file = Object.values(files).find((entry) => entry.path === filePath);
      if (file?.downloadError !== undefined) throw file.downloadError;
      const bytes = file?.bytes ?? Buffer.alloc(0);
      if (bytes.length > maxBytes) throw new TelegramApiError(TelegramFailureCode.RESPONSE_TOO_LARGE, 'downloadFile', 200);
      return bytes;
    },
  };
  return { gateway, calls };
}

function doc(fileId: string, name: string | undefined, contentType: string | undefined, size: number | undefined): TelegramAttachmentSource {
  return { kind: 'file', fileId, name, contentType, size };
}

/** Every regular file under `dir` (none when it does not exist). */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

const reasons = (attachments: readonly InboundAttachment[]) => attachments.map((a) => (a.kind === 'unsupported' ? a.reason : a.kind));

describe('Telegram attachment intake — ADR-0111 bounds from metadata, before any Bot API call', () => {
  it('refuses an oversized text or image from the update metadata with no getFile and no download', async () => {
    const { gateway, calls } = fakeGateway({});
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([
      doc('t', 'big.log', 'text/plain', TEXT_ATTACHMENT_MAX_BYTES + 1),
      doc('i', 'photo.jpg', 'image/jpeg', IMAGE_ATTACHMENT_MAX_BYTES + 1),
    ]);
    expect(reasons(result.attachments)).toEqual(['TOO_LARGE', 'TOO_LARGE']);
    expect(result.diagnostics.map((d) => d.detail)).toEqual(['DECLARED_SIZE', 'DECLARED_SIZE']);
    expect(calls).toEqual([]);
  });

  it('accepts exactly the bounds (256 KiB text, 8 MiB image are not over them)', async () => {
    const text = Buffer.alloc(TEXT_ATTACHMENT_MAX_BYTES, 'a');
    const { gateway } = fakeGateway({ t: { path: 'documents/file_1.txt', size: text.length, bytes: text } });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('t', 'a.txt', 'text/plain', TEXT_ATTACHMENT_MAX_BYTES)]);
    expect(reasons(result.attachments)).toEqual(['text']);
  });

  it('refuses unsupported types (zip, pdf, svg, gif, no type) from metadata with no call', async () => {
    const { gateway, calls } = fakeGateway({});
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([
      doc('a', 'x.zip', 'application/zip', 10),
      doc('b', 'x.pdf', 'application/pdf', 10),
      doc('c', 'v.svg', 'image/svg+xml', 10),
    ]);
    expect(reasons(result.attachments)).toEqual(['UNSUPPORTED_TYPE', 'UNSUPPORTED_TYPE', 'UNSUPPORTED_TYPE']);
    const more = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('d', 'g.gif', 'image/gif', 10), doc('e', undefined, undefined, 10)]);
    expect(reasons(more.attachments)).toEqual(['UNSUPPORTED_TYPE', 'UNSUPPORTED_TYPE']);
    expect(calls).toEqual([]);
  });

  it('takes in at most 3 per turn; the rest are TOO_MANY and never fetched', async () => {
    const files = Object.fromEntries(['1', '2', '3', '4', '5'].map((id) => [id, { path: `documents/file_${id}.txt`, size: 2, bytes: Buffer.from('ok') }]));
    const { gateway, calls } = fakeGateway(files);
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake(['1', '2', '3', '4', '5'].map((id) => doc(id, `${id}.txt`, 'text/plain', 2)));
    expect(ATTACHMENT_MAX_COUNT).toBe(3);
    expect(reasons(result.attachments)).toEqual(['text', 'text', 'text', 'TOO_MANY', 'TOO_MANY']);
    expect(calls.filter((call) => call.startsWith('getFile:4') || call.startsWith('getFile:5'))).toEqual([]);
  });

  it('a sticker, voice note or video is named as unsupported and never fetched', async () => {
    const { gateway, calls } = fakeGateway({});
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([
      { kind: 'unsupported-media', name: 'voice', contentType: 'audio/ogg', size: 10 },
    ]);
    expect(result.attachments).toEqual([{ name: 'voice', mimeType: 'audio/ogg', sizeBytes: 10, kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' }]);
    expect(calls).toEqual([]);
  });

  it('checks getFile’s file_size before the download, and needs a file_path', async () => {
    const { gateway, calls } = fakeGateway({
      big: { path: 'photos/file_1.jpg', size: IMAGE_ATTACHMENT_MAX_BYTES + 1, bytes: PNG },
      nopath: {},
    });
    // The update gave no size: getFile's size decides, before any byte is fetched.
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([
      doc('big', 'photo.jpg', 'image/jpeg', undefined),
      doc('nopath', 'a.txt', 'text/plain', 3),
    ]);
    expect(reasons(result.attachments)).toEqual(['TOO_LARGE', 'DOWNLOAD_FAILED']);
    expect(result.diagnostics.map((d) => d.detail)).toEqual(['GET_FILE_SIZE', 'NO_FILE_PATH']);
    expect(calls).toEqual(['getFile:big', 'getFile:nopath']);
  });

  it('enforces the bound while streaming (TOO_LARGE), and a failed call is DOWNLOAD_FAILED with a fixed code only', async () => {
    const leaky = new TypeError(`fetch failed ${TELEGRAM_API_ORIGIN}/file/bot${FAKE_TOKEN}/documents/file_9.txt`);
    const { gateway, calls } = fakeGateway({
      a: { path: 'documents/file_1.txt', bytes: Buffer.alloc(TEXT_ATTACHMENT_MAX_BYTES + 1, 'a') },
      b: { path: 'documents/file_2.txt', downloadError: new TelegramApiError(TelegramFailureCode.UNAVAILABLE, 'downloadFile', 502) },
      c: { getFileError: leaky },
    });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([
      doc('a', 'a.txt', 'text/plain', undefined),
      doc('b', 'b.txt', 'text/plain', 4),
      doc('c', 'c.txt', 'text/plain', 4),
    ]);
    expect(reasons(result.attachments)).toEqual(['TOO_LARGE', 'DOWNLOAD_FAILED', 'DOWNLOAD_FAILED']);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ detail: 'STREAM_BOUND', failure: 'RESPONSE_TOO_LARGE' }),
      expect.objectContaining({ detail: 'DOWNLOAD_FAILED', failure: 'UNAVAILABLE', httpStatus: 502 }),
      expect.objectContaining({ detail: 'GET_FILE_FAILED', failure: 'UNEXPECTED' }),
    ]);
    expect(calls).toContain(`download:documents/file_1.txt:${TEXT_ATTACHMENT_MAX_BYTES}`);
    // The diagnostics never carry a URL, a token, a file path or a file id.
    const serialized = JSON.stringify(result);
    for (const leaked of [FAKE_TOKEN_SECRET, 'documents/', 'file_9']) expect(serialized).not.toContain(leaked);
  });
});

describe('Telegram attachment intake — text files: strict UTF-8 and the credential guard (ADR-0111 D3)', () => {
  it('a UTF-8 text file becomes UNTRUSTED in-memory text; invalid UTF-8 or binary is refused', async () => {
    const { gateway } = fakeGateway({
      ok: { path: 'documents/file_1.log', bytes: Buffer.from('2026-10-08 INFO 빌드 완료\n') },
      bad: { path: 'documents/file_2.log', bytes: Buffer.from([0x66, 0xff, 0xfe]) },
      nul: { path: 'documents/file_3.txt', bytes: Buffer.from('a\u0000b') },
    });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([
      doc('ok', 'build.log', undefined, 30),
      doc('bad', 'bad.log', 'text/plain', 3),
      doc('nul', 'nul.txt', 'text/plain', 3),
    ]);
    expect(result.attachments[0]).toEqual({ name: 'build.log', sizeBytes: 30, kind: 'text', text: '2026-10-08 INFO 빌드 완료\n', trust: 'UNTRUSTED' });
    expect(reasons(result.attachments).slice(1)).toEqual(['NOT_UTF8_TEXT', 'NOT_UTF8_TEXT']);
  });

  it('a credential-shaped file is refused and its content never reaches the result or the diagnostics', async () => {
    const secret = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
    const { gateway } = fakeGateway({ s: { path: 'documents/file_1.txt', bytes: Buffer.from(`deploy token ${secret}\n`) } });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('s', 'token.txt', 'text/plain', 60)]);
    expect(reasons(result.attachments)).toEqual(['CREDENTIAL_SHAPED']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('a display name is sanitized (controls, bidi) and bounded', async () => {
    const { gateway } = fakeGateway({});
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('x', `a‮exe.zip${'n'.repeat(300)}`, 'application/zip', 1)]);
    expect(result.attachments[0]?.name).not.toContain('‮');
    expect(Array.from(result.attachments[0]?.name ?? '').length).toBeLessThanOrEqual(120);
  });
});

describe('Telegram attachment intake — images through the #143 canonical intake', () => {
  it('png/jpeg/webp become an opaque 0600 temp file of the CANONICAL bytes in a private directory; release deletes them', async () => {
    const { gateway } = fakeGateway({
      p: { path: 'photos/file_1.jpg', bytes: PNG },
      j: { path: 'photos/file_2.jpg', bytes: JPEG },
      w: { path: 'documents/file_3.webp', bytes: WEBP },
    });
    const intake = new TelegramAttachmentIntake(gateway, { tempRoot });
    // A Telegram "photo" declared as JPEG whose bytes are PNG is a PNG: the bytes decide.
    const result = await intake.intake([doc('p', 'photo.jpg', 'image/jpeg', PNG.length), doc('j', 'photo.jpg', 'image/jpeg', JPEG.length), doc('w', 'w.webp', 'image/webp', WEBP.length)]);
    const images = result.attachments.filter((a): a is Extract<InboundAttachment, { kind: 'image' }> => a.kind === 'image');
    expect(images.map((image) => image.mimeType)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
    for (const [index, image] of images.entries()) {
      expect(path.basename(path.dirname(image.imageRef))).toMatch(/^proc-[A-Za-z0-9]{6}$/u);
      expect(path.dirname(path.dirname(image.imageRef))).toBe(tempRoot);
      expect(path.basename(image.imageRef)).toMatch(/^intake-[0-9a-f-]{36}\.(png|jpg|webp)$/u);
      expect((await fs.stat(image.imageRef)).mode & 0o777).toBe(0o600);
      const source = [PNG, JPEG, WEBP][index] as Buffer;
      const canonical = canonicalizeImage(source, image.mimeType);
      expect(canonical.ok && (await fs.readFile(image.imageRef)).equals(canonical.bytes)).toBe(true);
      expect(image.trust).toBe('UNTRUSTED');
    }
    expect((await fs.stat(tempRoot)).mode & 0o777).toBe(0o700);
    await result.release();
    for (const image of images) await expect(fs.stat(image.imageRef)).rejects.toThrow();
  });

  it('metadata, text chunks and their credential text are dropped: only the rebuilt image is written', async () => {
    const tampered = pngImage({ beforeIdat: [pngChunk('tEXt', SECRET)] });
    const { gateway } = fakeGateway({ p: { path: 'photos/file_1.jpg', bytes: tampered } });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('p', 'photo.jpg', 'image/jpeg', tampered.length)]);
    const image = result.attachments[0] as Extract<InboundAttachment, { kind: 'image' }>;
    expect(image.kind).toBe('image');
    expect((await fs.readFile(image.imageRef)).includes(SECRET)).toBe(false);
    await result.release();
  });

  it.each([
    ['a valid PNG with credential text appended', Buffer.concat([pngImage(), SECRET]), 'INVALID_IMAGE'],
    ['the PNG signature followed by credential text', Buffer.concat([PNG_SIGNATURE, SECRET]), 'INVALID_IMAGE'],
    ['a GIF declared as JPEG', Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1'), 'UNSUPPORTED_TYPE'],
    ['an empty body', Buffer.alloc(0), 'UNSUPPORTED_TYPE'],
  ])('refuses %s, writing nothing', async (_label, bytes, reason) => {
    const { gateway } = fakeGateway({ p: { path: 'photos/file_1.jpg', bytes } });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('p', 'photo.jpg', 'image/jpeg', bytes.length)]);
    expect(reasons(result.attachments)).toEqual([reason]);
    expect(await filesUnder(tempRoot)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('a foreign-owned or symlinked temp root is refused (the image is DOWNLOAD_FAILED TEMP_WRITE_FAILED)', async () => {
    await fs.mkdir(path.join(scratch, 'real'), { mode: 0o700 });
    await fs.symlink(path.join(scratch, 'real'), tempRoot);
    const { gateway } = fakeGateway({ p: { path: 'photos/file_1.jpg', bytes: PNG } });
    const result = await new TelegramAttachmentIntake(gateway, { tempRoot }).intake([doc('p', 'photo.jpg', 'image/jpeg', PNG.length)]);
    expect(result.diagnostics.map((d) => d.detail)).toEqual(['TEMP_WRITE_FAILED']);
    expect(await fs.readdir(path.join(scratch, 'real'))).toEqual([]);
  });

  it('sweep removes intake files older than 10 minutes; dispose removes the live ones', async () => {
    const { gateway } = fakeGateway({ p: { path: 'photos/file_1.jpg', bytes: PNG }, q: { path: 'photos/file_2.jpg', bytes: PNG } });
    let clock = Date.now();
    const intake = new TelegramAttachmentIntake(gateway, { tempRoot, nowMs: () => clock });
    const first = await intake.intake([doc('p', 'photo.jpg', 'image/jpeg', PNG.length)]);
    const firstRef = (first.attachments[0] as Extract<InboundAttachment, { kind: 'image' }>).imageRef;
    expect(await intake.sweep()).toBe(0);
    clock += 11 * 60_000;
    expect(await intake.sweep()).toBe(1);
    await expect(fs.stat(firstRef)).rejects.toThrow();
    const second = await intake.intake([doc('q', 'photo.jpg', 'image/jpeg', PNG.length)]);
    const secondRef = (second.attachments[0] as Extract<InboundAttachment, { kind: 'image' }>).imageRef;
    await intake.dispose();
    await expect(fs.stat(secondRef)).rejects.toThrow();
  });
});

describe('Telegram attachment intake note (ADR-0111 D2): plain text, names each refused file and why', () => {
  it('is absent when everything was taken in and never echoes content', () => {
    expect(renderAttachmentIntakeNote([{ name: 'a.log', sizeBytes: 1, kind: 'text', text: 'secret-ish content', trust: 'UNTRUSTED' }])).toBeUndefined();
    const note = renderAttachmentIntakeNote([
      { name: 'big.png', sizeBytes: 1, kind: 'unsupported', reason: 'TOO_LARGE' },
      { name: 'voice', sizeBytes: 1, kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' },
    ]);
    expect(note).toBe(
      [
        '첨부 파일 중 읽지 않은 것이 있어요.',
        '- "big.png" — 너무 커서 받지 않았어요. 텍스트 파일은 256KiB, 이미지는 8MiB까지예요.',
        '- "voice" — 지원하지 않는 형식이에요. 텍스트 파일(.txt·.log·.md·.json 등)과 PNG·JPEG·WebP 이미지만 받아요.',
      ].join('\n'),
    );
  });
});

// ── The adapter end to end (fake Bot API only; the real API is never called) ────────────────────────────────────────

interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields;
}

function recordingLogger(lines: LogLine[]): Logger {
  return {
    info: (message, fields) => void lines.push({ level: 'info', message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => void lines.push({ level: 'warn', message, ...(fields ? { fields } : {}) }),
    error: (message, fields) => void lines.push({ level: 'error', message, ...(fields ? { fields } : {}) }),
  };
}

interface Harness {
  readonly adapter: TelegramPlatformAdapter;
  readonly fake: FakeTelegram;
  readonly logs: LogLine[];
  readonly received: InboundMessage[];
  /** The bytes of every image file as the handler saw it (the file is deleted after the turn). */
  readonly seenImages: Buffer[];
}

const running: TelegramPlatformAdapter[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

function harness(fake: FakeTelegram, options: TelegramAdapterOptions = {}): Harness {
  const logs: LogLine[] = [];
  const received: InboundMessage[] = [];
  const seenImages: Buffer[] = [];
  const token = TelegramBotToken.from(FAKE_TOKEN);
  if (!token) throw new Error('fixture token');
  const adapter = new TelegramPlatformAdapter({ token, expectedBotId: FAKE_BOT_ID, ownerIds: [String(OWNER_ID)] }, recordingLogger(logs), {
    fetch: fake.fetch,
    startupCallTimeoutMs: 50,
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
    attachments: { tempRoot },
    ...options,
  });
  adapter.onMessage(async (message) => {
    for (const attachment of message.attachments ?? []) {
      if (attachment.kind === 'image') seenImages.push(await fs.readFile(attachment.imageRef));
    }
    received.push(message);
  });
  running.push(adapter);
  return { adapter, fake, logs, received, seenImages };
}

const offsets = (fake: FakeTelegram) => fake.callsTo('getUpdates').map((call) => call.params.offset as number | undefined);
const fileCalls = (fake: FakeTelegram) => fake.calls.filter((call) => call.method === 'getFile' || call.method === 'downloadFile');

describe('Telegram adapter attachments (TG-2): admission before any file call, the guarded download, captions', () => {
  it('a photo with a caption: getFile then one GET from the pinned host, the caption is the text, the image is canonical', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(70, { ...photoField({ fileId: 'small', size: 100 }, { fileId: 'large', size: PNG.length }), caption: '이 화면 뭐야?' })]))
      .queue('getFile', fileReply('photos/file_7.jpg', PNG.length))
      .queue('downloadFile', bytesReply(PNG));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 1);
    expect(h.received[0]).toMatchObject({ id: '700', text: '이 화면 뭐야?', context: { platform: 'telegram', channelId: String(OWNER_ID), direct: true } });
    expect(h.received[0]?.attachments).toEqual([
      expect.objectContaining({ kind: 'image', mimeType: 'image/png', name: 'photo.jpg', trust: 'UNTRUSTED' }),
    ]);
    expect(fake.callsTo('getFile').map((call) => call.params)).toEqual([{ file_id: 'large' }]);
    const [download] = fake.callsTo('downloadFile');
    expect(download?.url).toBe(`${TELEGRAM_API_ORIGIN}/file/bot${FAKE_TOKEN}/photos/file_7.jpg`);
    expect(download?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    const canonical = canonicalizeImage(PNG, 'image/png');
    expect(canonical.ok && h.seenImages[0]?.equals(canonical.bytes)).toBe(true);
    // The temp file lived only for the turn.
    await until(() => true);
    await flush(20);
    const ref = (h.received[0]?.attachments?.[0] as Extract<InboundAttachment, { kind: 'image' }>).imageRef;
    await expect(fs.stat(ref)).rejects.toThrow();
    // No intake note (everything was taken in), and nothing about the file reaches the log.
    expect(fake.callsTo('sendMessage')).toHaveLength(0);
    for (const leaked of ['photos/file_7', 'large', '이 화면', FAKE_TOKEN_SECRET]) expect(JSON.stringify(h.logs)).not.toContain(leaked);
  });

  it('an attachment-only text file is an empty-text turn with UNTRUSTED text; a caption-less photo has empty text', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(71, documentField('d', 'build.log', 'text/plain', 12))]))
      .queue('getFile', fileReply('documents/file_1.log', 12))
      .queue('downloadFile', bytesReply(Buffer.from('build ok\nall')));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 1);
    expect(h.received[0]).toMatchObject({ text: '', attachments: [{ kind: 'text', text: 'build ok\nall', trust: 'UNTRUSTED', name: 'build.log' }] });
  });

  it('oversized metadata means no getFile and no download; the owner gets one note naming the file', async () => {
    const fake = new FakeTelegram().queue(
      'getUpdates',
      okReply([mediaUpdate(72, { ...documentField('d', 'huge.png', 'image/png', IMAGE_ATTACHMENT_MAX_BYTES + 1), caption: '봐 줘' })]),
    );
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 1 && fake.callsTo('sendMessage').length === 1);
    expect(fileCalls(fake)).toEqual([]);
    expect(h.received[0]?.attachments).toEqual([{ name: 'huge.png', mimeType: 'image/png', sizeBytes: IMAGE_ATTACHMENT_MAX_BYTES + 1, kind: 'unsupported', reason: 'TOO_LARGE' }]);
    expect(fake.callsTo('sendMessage')[0]?.params).toMatchObject({ chat_id: String(OWNER_ID), text: expect.stringContaining('"huge.png" — 너무 커서') });
    expect(fake.callsTo('sendMessage')[0]?.params.parse_mode).toBeUndefined();
    expect(h.logs.find((line) => line.message === 'attachment refused')?.fields).toMatchObject({ reason: 'TOO_LARGE', detail: 'DECLARED_SIZE' });
  });

  it('a sticker is named as unsupported and never fetched', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([mediaUpdate(73, { sticker: { file_id: 's', file_unique_id: 'u', file_size: 10 } })]));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 1 && fake.callsTo('sendMessage').length === 1);
    expect(fileCalls(fake)).toEqual([]);
    expect(h.received[0]?.attachments).toEqual([expect.objectContaining({ name: 'sticker', kind: 'unsupported', reason: 'UNSUPPORTED_TYPE' })]);
  });

  it('admission before download: a stranger’s, a group’s, a forwarded or a stale file is never fetched and gets no reply', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const forwarded = mediaUpdate(83, { ...photoField({ fileId: 'p3', size: 10 }), forward_origin: { type: 'hidden_user', date: old, sender_user_name: 'x' } });
    const fake = new FakeTelegram().queue(
      'getUpdates',
      okReply([
        mediaUpdate(80, photoField({ fileId: 'p0', size: 10 }), { from: STRANGER_ID }),
        mediaUpdate(81, documentField('d1', 'a.txt', 'text/plain', 1), { chatId: -100 }),
        { update_id: 82, message: { ...(mediaUpdate(82, photoField({ fileId: 'p2', size: 10 })) as { message: Record<string, unknown> }).message, chat: { id: -1001, type: 'supergroup' } } },
        forwarded,
      ]),
    );
    const h = harness(fake);
    await h.adapter.start();
    await until(() => offsets(fake).includes(84));
    await flush(10);
    expect(fileCalls(fake)).toEqual([]);
    expect(h.received).toEqual([]);
    expect(fake.callsTo('sendMessage')).toEqual([]);
    expect(h.adapter.status().droppedUpdates).toMatchObject({ 'not-owner': 1, 'not-private': 2, forwarded: 1 });
  });

  it('nothing is fetched while the identity gate is closed (and the offset stays put)', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([mediaUpdate(85, photoField({ fileId: 'p', size: 10 }))]));
    const h = harness(fake);
    h.adapter.gateInbound(Promise.resolve(false));
    await h.adapter.start();
    await until(() => fake.callsTo('getUpdates').length >= 2);
    await flush(10);
    expect(fileCalls(fake)).toEqual([]);
    expect(h.received).toEqual([]);
    expect(offsets(fake)).not.toContain(86);
  });

  it('a download that fails with an error quoting the token URL leaves the token nowhere (log, note, message)', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(86, documentField('d', 'a.txt', 'text/plain', 5))]))
      .queue('getFile', fileReply('documents/file_1.txt', 5))
      .queue('downloadFile', { throws: new TypeError(`fetch failed: ${TELEGRAM_API_ORIGIN}/file/bot${FAKE_TOKEN}/documents/file_1.txt`) });
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 1 && fake.callsTo('sendMessage').length === 1);
    expect(h.received[0]?.attachments).toEqual([expect.objectContaining({ kind: 'unsupported', reason: 'DOWNLOAD_FAILED' })]);
    expect(h.logs.find((line) => line.message === 'attachment refused')?.fields).toMatchObject({ detail: 'DOWNLOAD_FAILED', failure: 'UNAVAILABLE' });
    const observable = JSON.stringify([h.logs, h.received, fake.callsTo('sendMessage').map((call) => call.params)]);
    for (const leaked of [FAKE_TOKEN_SECRET, FAKE_TOKEN, '/file/bot', 'documents/file_1']) expect(observable).not.toContain(leaked);
  });

  it('a download HTTP failure and an oversized streamed body are refused with fixed codes', async () => {
    const big = Buffer.alloc(TEXT_ATTACHMENT_MAX_BYTES + 10, 'a');
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(87, documentField('a', 'a.txt', 'text/plain', 5)), mediaUpdate(88, documentField('b', 'b.txt', 'text/plain', undefined))]))
      .queue('getFile', fileReply('documents/file_1.txt'), fileReply('documents/file_2.txt'))
      .queue('downloadFile', errorReply(500), bytesReply(big));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 2);
    const byId = new Map(h.received.map((message) => [message.id, message.attachments?.[0]]));
    expect(byId.get('870')).toMatchObject({ kind: 'unsupported', reason: 'DOWNLOAD_FAILED' });
    expect(byId.get('880')).toMatchObject({ kind: 'unsupported', reason: 'TOO_LARGE' });
  });

  it.each(['../secret', 'a//b', '/etc/passwd', 'photos/../../x', `https://evil.example/x`, 'a b'])(
    'an unsafe file_path from getFile (%s) is never put into a download URL',
    async (filePath) => {
      const fake = new FakeTelegram()
        .queue('getUpdates', okReply([mediaUpdate(89, documentField('d', 'a.txt', 'text/plain', 5))]))
        .queue('getFile', okReply({ file_id: 'd', file_unique_id: 'u', file_path: filePath }));
      const h = harness(fake);
      await h.adapter.start();
      await until(() => h.received.length === 1);
      expect(fake.callsTo('downloadFile')).toEqual([]);
      expect(h.received[0]?.attachments).toEqual([expect.objectContaining({ reason: 'DOWNLOAD_FAILED' })]);
    },
  );

  it('a stop during the download aborts it: no turn, no note, nothing more fetched or sent', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(90, documentField('d', 'a.txt', 'text/plain', 5))]))
      .queue('getFile', fileReply('documents/file_1.txt', 5))
      .queue('downloadFile', { hang: true });
    const h = harness(fake);
    await h.adapter.start();
    await until(() => fake.callsTo('downloadFile').length === 1);
    await h.adapter.stop();
    // Codex P2: once stop() resolved, no handler call and no temp file; nothing follows later either.
    expect(h.received).toEqual([]);
    expect(await filesUnder(tempRoot)).toEqual([]);
    await flush(10);
    expect(h.received).toEqual([]);
    expect(fake.callsTo('sendMessage')).toEqual([]);
  });
});

/** An offset store that survives "restarts" (one value, every save recorded). */
function memoryStore(initial: number) {
  const store = { value: initial, saves: [] as number[] };
  return {
    store,
    offsetStore: {
      load: () => store.value,
      save: (offset: number) => {
        store.value = offset;
        store.saves.push(offset);
      },
    },
  };
}

describe('Telegram adapter offsets with attachments (Codex P1): saved only after the turn was handed over', () => {
  it('the handler is called BEFORE the offset moves past the update; after it, the offset is saved', async () => {
    const { store, offsetStore } = memoryStore(150);
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(150, documentField('d', 'a.txt', 'text/plain', 2))]))
      .queue('getFile', fileReply('documents/file_1.txt', 2))
      .queue('downloadFile', bytesReply(Buffer.from('ok')));
    const savedAtHandover: number[][] = [];
    const h = harness(fake, { offsetStore });
    h.adapter.onMessage(async () => void savedAtHandover.push([...store.saves]));
    await h.adapter.start();
    await until(() => store.saves.includes(151));
    expect(savedAtHandover).toEqual([[]]);
  });

  it('a stop during the intake leaves the saved offset where it was; the restart delivers the update again, once', async () => {
    const { store, offsetStore } = memoryStore(160);
    const update = mediaUpdate(160, documentField('d', 'a.txt', 'text/plain', 2));
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([update]), okReply([update]))
      .queue('getFile', fileReply('documents/file_1.txt', 2), fileReply('documents/file_1.txt', 2))
      .queue('downloadFile', { hang: true }, bytesReply(Buffer.from('ok')));
    const first = harness(fake, { offsetStore });
    await first.adapter.start();
    await until(() => fake.callsTo('downloadFile').length === 1);
    await first.adapter.stop();
    expect(first.received).toEqual([]);
    expect(store.saves).toEqual([]);
    expect(store.value).toBe(160);
    // The "restart": a new adapter over the same store sees the update again and hands it over exactly once.
    const second = harness(fake, { offsetStore });
    await second.adapter.start();
    await until(() => second.received.length === 1 && store.saves.includes(161));
    expect(second.received[0]?.attachments).toEqual([expect.objectContaining({ kind: 'text', text: 'ok' })]);
  });

  it('the same for an album: a stop during its intake confirms none of its parts, and the restart hands it over as one turn', async () => {
    const { store, offsetStore } = memoryStore(170);
    const album = [170, 171].map((id, index) =>
      mediaUpdate(id, { ...photoField({ fileId: `p${index}`, size: PNG.length }), media_group_id: 'g', ...(index === 0 ? { caption: '둘 다' } : {}) }),
    );
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply(album), okReply(album), okReply(album), okReply(album))
      .queue('getFile', fileReply('photos/a.jpg'), fileReply('photos/b.jpg'), fileReply('photos/a.jpg'), fileReply('photos/b.jpg'))
      .queue('downloadFile', { hang: true }, { hang: true }, bytesReply(PNG), bytesReply(PNG));
    const first = harness(fake, { offsetStore });
    await first.adapter.start();
    await until(() => fake.callsTo('downloadFile').length === 2);
    await first.adapter.stop();
    expect(first.received).toEqual([]);
    expect(store.saves).toEqual([]);
    const second = harness(fake, { offsetStore });
    await second.adapter.start();
    await until(() => second.received.length === 1 && store.saves.includes(172));
    expect(second.received[0]).toMatchObject({ text: '둘 다' });
    expect(second.received[0]?.attachments?.map((a) => a.kind)).toEqual(['image', 'image']);
  });

  it('an admission refusal hands nothing over, so its offset may advance at once (nothing would ever be handed over)', async () => {
    const { store, offsetStore } = memoryStore(180);
    const fake = new FakeTelegram().queue('getUpdates', okReply([mediaUpdate(180, photoField({ fileId: 'p', size: 10 }), { from: STRANGER_ID })]));
    const h = harness(fake, { offsetStore });
    await h.adapter.start();
    await until(() => store.saves.includes(181));
    expect(h.received).toEqual([]);
    expect(fileCalls(fake)).toEqual([]);
  });

  it('a bounds rejection still hands the turn over (with the refused attachment named) before the offset moves', async () => {
    const { store, offsetStore } = memoryStore(190);
    const fake = new FakeTelegram().queue('getUpdates', okReply([mediaUpdate(190, documentField('d', 'big.png', 'image/png', IMAGE_ATTACHMENT_MAX_BYTES + 1))]));
    const savedAtHandover: number[][] = [];
    const h = harness(fake, { offsetStore });
    h.adapter.onMessage(async (message) => {
      savedAtHandover.push([...store.saves]);
      h.received.push(message);
    });
    await h.adapter.start();
    await until(() => store.saves.includes(191));
    expect(savedAtHandover).toEqual([[]]);
    expect(h.received[0]?.attachments).toEqual([expect.objectContaining({ reason: 'TOO_LARGE' })]);
    expect(fileCalls(fake)).toEqual([]);
  });
});

describe('Telegram adapter albums (TG-2): the parts of one media group are one turn, within the count bound', () => {
  const part = (updateId: number, fileId: string, extra: Record<string, unknown> = {}) =>
    mediaUpdate(updateId, { ...photoField({ fileId, size: PNG.length }), media_group_id: 'album-1', ...extra });

  it('three photos and a caption arrive as one turn with three images; the offset moves past them only then', async () => {
    const batch = [part(100, 'a', { caption: '셋 다 비교해 줘' }), part(101, 'b'), part(102, 'c')];
    const fake = new FakeTelegram()
      // First poll: the album. Re-poll (offset held at its first part): the same three again, nothing new.
      .queue('getUpdates', okReply(batch), okReply(batch))
      .queue('getFile', fileReply('photos/file_a.jpg'), fileReply('photos/file_b.jpg'), fileReply('photos/file_c.jpg'))
      .queue('downloadFile', bytesReply(PNG), bytesReply(PNG), bytesReply(PNG));
    const saved: number[] = [];
    const h = harness(fake, { offsetStore: { load: () => 100, save: (offset) => void saved.push(offset) } });
    await h.adapter.start();
    await until(() => h.received.length === 1);
    await until(() => offsets(fake).includes(103));
    await flush(10);
    expect(h.received).toHaveLength(1);
    expect(h.received[0]).toMatchObject({ id: '1000', text: '셋 다 비교해 줘' });
    expect(h.received[0]?.attachments?.map((attachment) => attachment.kind)).toEqual(['image', 'image', 'image']);
    // probe, first poll, the re-poll held at the album's first part, then past it; nothing was persisted before.
    expect(offsets(fake).slice(0, 4)).toEqual([undefined, 100, 100, 103]);
    expect(saved).toEqual([103]);
  });

  it('a part that arrives on the re-poll joins the album; a fourth part is TOO_MANY and never fetched', async () => {
    const first = [part(110, 'a', { caption: '봐 줘' }), part(111, 'b')];
    const all = [...first, part(112, 'c'), part(113, 'd')];
    const fake = new FakeTelegram().queue('getUpdates', okReply(first), okReply(all), okReply(all));
    for (const id of ['a', 'b', 'c']) fake.queue('getFile', fileReply(`photos/file_${id}.jpg`)).queue('downloadFile', bytesReply(PNG));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 1);
    await flush(10);
    expect(reasons(h.received[0]?.attachments ?? [])).toEqual(['image', 'image', 'image', 'TOO_MANY']);
    expect(fake.callsTo('getFile').map((call) => call.params.file_id)).toEqual(['a', 'b', 'c']);
    expect(h.received).toHaveLength(1);
  });

  it('anything else after the parts completes the album first, in order', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([part(120, 'a'), part(121, 'b'), textUpdate(122, '다음 질문')]));
    fake.queue('getFile', fileReply('photos/file_a.jpg'), fileReply('photos/file_b.jpg')).queue('downloadFile', bytesReply(PNG), bytesReply(PNG));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => h.received.length === 2);
    expect(h.received.map((message) => message.id).sort()).toEqual(['1200', '1220']);
    expect(h.received.find((message) => message.id === '1200')?.attachments).toHaveLength(2);
    await until(() => offsets(fake).includes(123));
  });

  it('a stop while an album is being collected hands nothing over and never confirms its parts', async () => {
    const fake = new FakeTelegram().queue('getUpdates', okReply([part(130, 'a')]));
    let release: () => void = () => undefined;
    const h = harness(fake, {
      offsetStore: { load: () => 130, save: () => undefined },
      // The settle wait lasts until the test stops the adapter.
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          release = () => resolve();
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    await h.adapter.start();
    await until(() => fake.callsTo('getUpdates').length >= 2);
    await flush(5);
    await h.adapter.stop();
    release();
    expect(h.received).toEqual([]);
    expect(fileCalls(fake)).toEqual([]);
    // The stop confirm (if any) never moved past the held part.
    expect(offsets(fake).every((offset) => offset === undefined || offset <= 130)).toBe(true);
  });
});

/**
 * A fake whose download of `slowPath` streams one chunk per pull and only when the test lets it, counting pulls; an abort
 * of the request errors the body (as `fetch` does). Everything else is the scripted fake.
 */
function slowDownloadFetch(fake: FakeTelegram, slowPath: string) {
  const state = { pulls: 0, release: () => undefined as void };
  const fetchImpl: typeof fake.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith(`/${slowPath}`)) return fake.fetch(input, init);
    fake.calls.push({ url, method: 'downloadFile', params: { file_path: slowPath }, init });
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      async pull(controller) {
        state.pulls += 1;
        if (state.pulls > 1) await new Promise<void>((resolve) => (state.release = resolve));
        controller.enqueue(new Uint8Array(16));
      },
    });
    init.signal?.addEventListener('abort', () => stream.error(new DOMException('This operation was aborted', 'AbortError')), { once: true });
    return new Response(body, { status: 200 });
  };
  return { state, fetchImpl };
}

describe('Telegram adapter halts and stops during intake (Codex P1/P2)', () => {
  const album = () =>
    [200, 201].map((id, index) => mediaUpdate(id, { ...photoField({ fileId: `p${index}`, size: PNG.length }), media_group_id: 'h' }));

  it('a halt cuts off a download that is already streaming: no more bytes are read, no turn, no temp file left', async () => {
    const parts = album();
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply(parts), okReply(parts))
      .queue('getFile', fileReply('photos/a.jpg'), fileReply('photos/b.jpg'))
      .queue('downloadFile', bytesReply(PNG));
    const slow = slowDownloadFetch(fake, 'photos/b.jpg');
    const h = harness(fake, { fetch: slow.fetchImpl });
    await h.adapter.start();
    // The first part is written (canonical temp file), the second is mid-stream.
    await until(() => slow.state.pulls === 2);
    await until(() => fake.callsTo('downloadFile').length === 2);
    for (let i = 0; i < 200 && (await filesUnder(tempRoot)).length === 0; i += 1) await flush(1);
    expect(await filesUnder(tempRoot)).toHaveLength(1);
    // A halt (as a 401 or a poll conflict would raise it).
    (h.adapter as unknown as { halt(code: string): void }).halt('TELEGRAM_AUTH_REJECTED');
    await until(() => h.adapter.status().polling === false);
    slow.state.release();
    await flush(20);
    expect(slow.state.pulls).toBe(2);
    expect(h.received).toEqual([]);
    expect(await filesUnder(tempRoot)).toEqual([]);
    expect(fake.callsTo('sendMessage')).toEqual([]);
    expect(h.adapter.status().halted).toBe('TELEGRAM_AUTH_REJECTED');
  });

  /** Holds the next canonical image write until `release()` (a slow disk), then lets it complete. */
  function holdNextImageWrite() {
    const gate = { release: () => undefined as void, started: false };
    const real = fs.writeFile.bind(fs);
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      // Only the FIRST intake write is held; later ones (a restarted run's) go straight through.
      if (!String(args[0]).includes('intake-') || gate.started) return real(...args);
      gate.started = true;
      await new Promise<void>((resolve) => (gate.release = resolve));
      return real(...args);
    });
    return { gate, spy };
  }

  it('stop during the canonical image write waits for it, then leaves no handler call and no temp file', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(210, photoField({ fileId: 'p', size: PNG.length }))]))
      .queue('getFile', fileReply('photos/a.jpg'))
      .queue('downloadFile', bytesReply(PNG));
    const { gate, spy } = holdNextImageWrite();
    try {
      const h = harness(fake);
      await h.adapter.start();
      await until(() => gate.started);
      const stopping = h.adapter.stop();
      // The write lands while stop() is still waiting (within its bound).
      setTimeout(() => gate.release(), 20);
      await stopping;
      expect(h.received).toEqual([]);
      expect(await filesUnder(tempRoot)).toEqual([]);
      await flush(20);
      expect(h.received).toEqual([]);
      expect(await filesUnder(tempRoot)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a write stuck past the stop bound: stop() returns, no handler is ever called, and the file is deleted as it lands', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([mediaUpdate(220, photoField({ fileId: 'p', size: PNG.length }))]))
      .queue('getFile', fileReply('photos/a.jpg'))
      .queue('downloadFile', bytesReply(PNG));
    const { gate, spy } = holdNextImageWrite();
    try {
      const h = harness(fake, { stopSettleMs: 20 });
      await h.adapter.start();
      await until(() => gate.started);
      await h.adapter.stop();
      expect(h.received).toEqual([]);
      expect(h.logs.some((line) => line.message === 'telegram stop: attachment intake did not settle in time')).toBe(true);
      gate.release();
      for (let i = 0; i < 200 && (await filesUnder(tempRoot)).length > 0; i += 1) await flush(1);
      await flush(20);
      expect(h.received).toEqual([]);
      expect(await filesUnder(tempRoot)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('Codex delta P2: an earlier run finishing after a restart never touches the new run (polling, offset, turns)', async () => {
    const { store, offsetStore } = memoryStore(400);
    const photo = mediaUpdate(400, photoField({ fileId: 'p', size: PNG.length }));
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([photo]), okReply([photo, textUpdate(401, '다음')]), okReply([textUpdate(402, '그 다음')]))
      .queue('getFile', fileReply('photos/a.jpg'), fileReply('photos/a.jpg'))
      .queue('downloadFile', bytesReply(PNG), bytesReply(PNG));
    const { gate, spy } = holdNextImageWrite();
    try {
      const h = harness(fake, { offsetStore, stopSettleMs: 20 });
      await h.adapter.start();
      await until(() => gate.started);
      // The first run's intake is stuck past the stop bound.
      await h.adapter.stop();
      expect(h.adapter.status().polling).toBe(false);
      expect(store.saves).toEqual([]);
      // Restart: the new run takes in 400 again (its write is not held) and 401.
      await h.adapter.start();
      await until(() => h.received.length === 2 && store.saves.includes(402));
      expect(h.adapter.status().polling).toBe(true);
      // Now the first run's stuck write lands and its loop finishes.
      gate.release();
      await flush(30);
      expect(h.adapter.status().polling).toBe(true);
      // Only the new run saved: strictly increasing (the old run handing 400 over would write 401 again, out of order).
      expect(store.saves.every((offset, index) => index === 0 || offset > (store.saves[index - 1] as number))).toBe(true);
      // The old run handed nothing over: 400 arrived once, from the new run. (The harness handler reads an image before
      // recording it, so arrival order is not asserted.)
      expect(h.received.filter((message) => message.id === '4000')).toHaveLength(1);
      expect(h.logs.filter((line) => line.message === 'attachment turn not handed over: telegram stopping')).toHaveLength(1);
      // The new run keeps working.
      await until(() => h.received.length === 3);
      expect(h.received.map((message) => message.id).sort()).toEqual(['4000', '4010', '4020']);
      await until(() => store.saves.includes(403));
      expect(store.saves).toEqual([401, 402, 403]);
      expect(h.adapter.status().polling).toBe(true);
      expect(await filesUnder(tempRoot)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a restart after a stop takes attachments in again (the intake reopens)', async () => {
    const fake = new FakeTelegram()
      .queue('getUpdates', okReply([]), okReply([mediaUpdate(230, photoField({ fileId: 'p', size: PNG.length }))]))
      .queue('getFile', fileReply('photos/a.jpg'))
      .queue('downloadFile', bytesReply(PNG));
    const h = harness(fake);
    await h.adapter.start();
    await until(() => fake.callsTo('getUpdates').length >= 2);
    await h.adapter.stop();
    await h.adapter.start();
    await until(() => h.received.length === 1);
    expect(h.received[0]?.attachments).toEqual([expect.objectContaining({ kind: 'image' })]);
  });
});

describe('Telegram adapter: a stop from inside a handler ends the batch (Codex delta P2)', () => {
  it('a stop() from the attachment handler: no later update of the batch is handed over and the offset stays past the last one that was', async () => {
    const { store, offsetStore } = memoryStore(300);
    const fake = new FakeTelegram()
      .queue(
        'getUpdates',
        okReply([
          mediaUpdate(300, documentField('d', 'a.txt', 'text/plain', 2)),
          textUpdate(301, '다음 질문'),
          mediaUpdate(302, documentField('e', 'b.txt', 'text/plain', 2)),
          reactionUpdate(303),
        ]),
      )
      .queue('getFile', fileReply('documents/file_1.txt', 2))
      .queue('downloadFile', bytesReply(Buffer.from('ok')));
    const h = harness(fake, { offsetStore });
    const feedback: unknown[] = [];
    h.adapter.onFeedback(async (signal) => void feedback.push(signal));
    let stopping: Promise<void> | undefined;
    h.adapter.onMessage(async (message) => {
      h.received.push(message);
      if ((message.attachments ?? []).length > 0) stopping = h.adapter.stop();
    });
    await h.adapter.start();
    await until(() => stopping !== undefined);
    await stopping;
    await flush(10);
    expect(h.received.map((message) => message.id)).toEqual(['3000']);
    expect(feedback).toEqual([]);
    expect(fake.callsTo('getFile').map((call) => call.params.file_id)).toEqual(['d']);
    expect(store.saves).toEqual([301]);
    expect(store.value).toBe(301);
  });

  it('a stop() from a text handler: the next attachment message is not even taken in', async () => {
    const { store, offsetStore } = memoryStore(310);
    const fake = new FakeTelegram().queue('getUpdates', okReply([textUpdate(310, '첫 질문'), mediaUpdate(311, documentField('d', 'a.txt', 'text/plain', 2))]));
    const h = harness(fake, { offsetStore });
    let stopping: Promise<void> | undefined;
    h.adapter.onMessage(async (message) => {
      h.received.push(message);
      stopping ??= h.adapter.stop();
    });
    await h.adapter.start();
    await until(() => stopping !== undefined);
    await stopping;
    await flush(10);
    expect(h.received.map((message) => message.id)).toEqual(['3100']);
    expect(fileCalls(fake)).toEqual([]);
    expect(store.value).toBe(311);
  });
});


describe('Telegram adapter: the per-batch intake budget (Codex delta, accepted residual)', () => {
  it('once a batch spent 60 s on intake, later attachment messages are still handed over in order, files not fetched', async () => {
    const { store, offsetStore } = memoryStore(500);
    let clock = Date.now();
    const fake = new FakeTelegram()
      .queue(
        'getUpdates',
        okReply([
          mediaUpdate(500, documentField('a', 'a.txt', 'text/plain', 2)),
          mediaUpdate(501, { ...documentField('b', 'b.txt', 'text/plain', 2), caption: '두 번째' }),
          mediaUpdate(502, documentField('c', 'huge.png', 'image/png', IMAGE_ATTACHMENT_MAX_BYTES + 1)),
        ]),
      )
      .queue('getFile', fileReply('documents/file_1.txt', 2))
      .queue('downloadFile', bytesReply(Buffer.from('ok')));
    const h = harness(fake, { offsetStore, nowMs: () => clock });
    h.adapter.onMessage(async (message) => {
      h.received.push(message);
      // The first turn's intake "took" 61 s.
      if (message.id === '5000') clock += 61_000;
    });
    await h.adapter.start();
    await until(() => store.saves.includes(503));
    expect(h.received.map((message) => message.id)).toEqual(['5000', '5010', '5020']);
    expect(h.received[0]?.attachments).toEqual([expect.objectContaining({ kind: 'text', text: 'ok' })]);
    expect(h.received[1]).toMatchObject({ text: '두 번째', attachments: [expect.objectContaining({ kind: 'unsupported', reason: 'DOWNLOAD_FAILED' })] });
    expect(h.received[2]?.attachments).toEqual([expect.objectContaining({ reason: 'TOO_LARGE' })]);
    expect(fake.callsTo('getFile').map((call) => call.params.file_id)).toEqual(['a']);
    expect(h.logs.find((line) => line.message === 'attachment refused' && line.fields?.detail === 'BATCH_BUDGET')).toBeDefined();
    await until(() => fake.callsTo('sendMessage').length === 2);
    expect(String(fake.callsTo('sendMessage')[0]?.params.text)).toContain('"b.txt" — 파일을 내려받지 못했어요.');
    expect(store.saves).toEqual([501, 502, 503]);
  });
});
