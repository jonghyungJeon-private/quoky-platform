import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { InboundAttachment } from '@quoky/core';
import { AttachmentIntake, renderAttachmentIntakeNote as discordNote } from '@quoky/adapter-discord';
import type { AttachmentSource } from '@quoky/adapter-discord';
import { renderAttachmentIntakeNote as telegramNote, TelegramAttachmentIntake } from '@quoky/adapter-telegram';
import type { TelegramFileGateway } from '@quoky/adapter-telegram';
// Test-only source import (precedent: personal-v3-acceptance.test.ts): the image builders are not a package export.
import { jpegImage, PNG_SIGNATURE, pngChunk, pngImage, riffChunk, riffWebp, vp8lPayload } from '../../../../packages/adapter-telegram/src/image-test-support';

/**
 * ADR-0114 acceptance "Attachment bounds and the credential guard behave as on Discord on one shared fixture set" (TG-2).
 *
 * Adapters share no code across packages, so the Telegram adapter carries a copy of the Discord adapter's #143 canonical
 * image module. This test (in the composition root, the one place that sees both packages) pins that:
 * 1. the copy is BYTE-IDENTICAL to the Discord source (a fix to one fails here until the other has it too);
 * 2. ONE fixture set taken in by both intakes (Discord: fake CDN fetch; Telegram: fake getFile/download gateway) gives
 *    the same kinds, refusal reasons, text and canonical image bytes, and the same refusal copy.
 */

const REPO = join(__dirname, '..', '..', '..', '..');
const VENDORED = ['image-canonical.ts', 'image-test-support.ts'];

describe('TG-2 parity — the vendored canonical image module is the Discord one, byte for byte', () => {
  it.each(VENDORED)('%s', (file) => {
    const discord = readFileSync(join(REPO, 'packages', 'adapter-discord', 'src', file));
    const telegram = readFileSync(join(REPO, 'packages', 'adapter-telegram', 'src', file));
    expect(telegram.equals(discord)).toBe(true);
  });
});

const SECRET = Buffer.from('pass' + 'word=SYNTHETIC_REVIEW_ONLY', 'latin1');
const GH_TOKEN = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');

interface Fixture {
  readonly label: string;
  readonly name: string;
  readonly mime: string | null;
  /** The declared size (defaults to the body length). */
  readonly size?: number;
  readonly body: Buffer;
}

const FIXTURES: readonly Fixture[] = [
  { label: 'UTF-8 log', name: 'build.log', mime: 'text/plain', body: Buffer.from('2026-10-08 INFO 빌드 완료\n') },
  { label: 'markdown by extension', name: 'notes.md', mime: null, body: Buffer.from('# 제목\n본문') },
  { label: 'credential-shaped text', name: 'token.txt', mime: 'text/plain', body: Buffer.from(`deploy token ${GH_TOKEN}\n`) },
  { label: 'credential file shape', name: 'app.json', mime: 'application/json', body: Buffer.concat([Buffer.from('{"'), SECRET, Buffer.from('"}')]) },
  { label: 'invalid UTF-8', name: 'bad.log', mime: 'text/plain', body: Buffer.from([0x66, 0xff, 0xfe]) },
  { label: 'binary text (NUL)', name: 'nul.txt', mime: 'text/plain', body: Buffer.from('a\u0000b') },
  { label: 'text over 256 KiB (declared)', name: 'big.log', mime: 'text/plain', size: 256 * 1024 + 1, body: Buffer.from('x') },
  { label: 'PNG', name: 'a.png', mime: 'image/png', body: pngImage() },
  { label: 'JPEG', name: 'b.jpg', mime: 'image/jpeg', body: jpegImage() },
  { label: 'WebP', name: 'c.webp', mime: 'image/webp', body: riffWebp([riffChunk('VP8L', vp8lPayload())]) },
  { label: 'PNG declared as JPEG', name: 'photo.jpg', mime: 'image/jpeg', body: pngImage({ width: 3 }) },
  { label: 'PNG with a tEXt credential (dropped)', name: 'meta.png', mime: 'image/png', body: pngImage({ beforeIdat: [pngChunk('tEXt', SECRET)] }) },
  { label: 'PNG with credential text appended', name: 'tail.png', mime: 'image/png', body: Buffer.concat([pngImage(), SECRET]) },
  { label: 'PNG signature then credential text', name: 'sig.png', mime: 'image/png', body: Buffer.concat([PNG_SIGNATURE, SECRET]) },
  { label: 'GIF declared as JPEG', name: 'g.jpg', mime: 'image/jpeg', body: Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1') },
  { label: 'image over 8 MiB (declared)', name: 'huge.png', mime: 'image/png', size: 8 * 1024 * 1024 + 1, body: pngImage() },
  { label: 'SVG', name: 'v.svg', mime: 'image/svg+xml', body: Buffer.from('<svg/>') },
  { label: 'ZIP', name: 'x.zip', mime: 'application/zip', body: Buffer.from('PK') },
];

const scratch = mkdtempSync(join(tmpdir(), 'quoky-tg2-parity-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const CDN = 'https://cdn.discordapp.com/attachments/1/2';

async function viaDiscord(fixtures: readonly Fixture[]) {
  const routes = new Map(fixtures.map((fixture, index) => [`${CDN}/${index}`, fixture.body]));
  const fetchImpl = (async (input: string | URL | Request) => {
    const body = routes.get(String(input));
    return body ? new Response(body, { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  const intake = new AttachmentIntake({ fetchImpl, tempRoot: join(scratch, 'discord'), imageRetryDelayMs: 0 });
  const sources: AttachmentSource[] = fixtures.map((fixture, index) => ({
    name: fixture.name,
    contentType: fixture.mime,
    size: fixture.size ?? fixture.body.length,
    url: `${CDN}/${index}`,
  }));
  return intake.intake(sources);
}

async function viaTelegram(fixtures: readonly Fixture[]) {
  const gateway: TelegramFileGateway = {
    getFile: async (fileId) => ({ file_id: fileId, file_unique_id: 'u', file_path: `documents/file_${fileId}` }),
    download: async (filePath) => fixtures[Number(filePath.slice('documents/file_'.length))]?.body ?? Buffer.alloc(0),
  };
  const intake = new TelegramAttachmentIntake(gateway, { tempRoot: join(scratch, 'telegram') });
  return intake.intake(
    fixtures.map((fixture, index) => ({
      kind: 'file' as const,
      fileId: String(index),
      name: fixture.name,
      contentType: fixture.mime ?? undefined,
      size: fixture.size ?? fixture.body.length,
    })),
  );
}

/** What must agree: kind, reason, name, MIME, text, and for images the type and the canonical bytes written. */
async function comparable(attachment: InboundAttachment): Promise<unknown> {
  if (attachment.kind === 'image') return { kind: 'image', name: attachment.name, mimeType: attachment.mimeType, bytes: (await fs.readFile(attachment.imageRef)).toString('base64') };
  if (attachment.kind === 'text') return { kind: 'text', name: attachment.name, text: attachment.text, trust: attachment.trust };
  return { kind: 'unsupported', name: attachment.name, reason: attachment.reason };
}

describe('TG-2 parity — one fixture set through both intakes (bounds, credential guard, canonical images)', () => {
  it.each(FIXTURES)('$label', async (fixture) => {
    const discord = await viaDiscord([fixture]);
    const telegram = await viaTelegram([fixture]);
    try {
      expect(await comparable(telegram.attachments[0] as InboundAttachment)).toEqual(await comparable(discord.attachments[0] as InboundAttachment));
    } finally {
      await discord.release();
      await telegram.release();
    }
  });

  it('the count bound: the 4th and 5th attachment are TOO_MANY on both', async () => {
    const five = FIXTURES.slice(0, 5);
    const discord = await viaDiscord(five);
    const telegram = await viaTelegram(five);
    const kinds = (attachments: readonly InboundAttachment[]) => attachments.map((a) => (a.kind === 'unsupported' ? a.reason : a.kind));
    expect(kinds(telegram.attachments)).toEqual(kinds(discord.attachments));
    expect(kinds(telegram.attachments).slice(3)).toEqual(['TOO_MANY', 'TOO_MANY']);
  });

  it('the refusal copy is the same sentence per reason (only the name quoting differs: Discord code span, Telegram quotes)', () => {
    const refused: InboundAttachment[] = (['UNSUPPORTED_TYPE', 'TOO_LARGE', 'TOO_MANY', 'CREDENTIAL_SHAPED', 'NOT_UTF8_TEXT', 'INVALID_IMAGE', 'DOWNLOAD_FAILED'] as const).map(
      (reason) => ({ name: 'f.bin', sizeBytes: 1, kind: 'unsupported', reason }),
    );
    expect(telegramNote(refused)?.replaceAll('"f.bin"', 'NAME')).toBe(discordNote(refused)?.replaceAll('`f.bin`', 'NAME'));
  });
});
