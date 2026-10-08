import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isSafeTelegramFilePath, TELEGRAM_API_ORIGIN, TelegramApiError, TelegramBotApi, TelegramFailureCode, failureCodeOfStatus } from './bot-api';
import { isWellFormedTelegramBotToken, redactTelegramToken, TelegramBotToken } from './bot-token';
import { bytesReply, FAKE_BOT_ID, FAKE_TOKEN, FAKE_TOKEN_SECRET, FakeTelegram, errorReply, okReply } from './test-support';

const token = (): TelegramBotToken => {
  const holder = TelegramBotToken.from(FAKE_TOKEN);
  if (!holder) throw new Error('fixture token is not well-formed');
  return holder;
};

/** Everything a value could leak through: JSON, inspect, string coercion, spread and own values. */
function leakSurfaces(value: unknown): string {
  return [
    JSON.stringify(value),
    inspect(value, { depth: 5, showHidden: true }),
    String(value),
    JSON.stringify({ ...(value as object) }),
    JSON.stringify(Object.values(value as object)),
  ].join('\n');
}

describe('TelegramBotToken (ADR-0114 D5)', () => {
  it('accepts only the BotFather shape and never echoes a value', () => {
    expect(isWellFormedTelegramBotToken(FAKE_TOKEN)).toBe(true);
    for (const bad of ['', FAKE_BOT_ID, `${FAKE_BOT_ID}:short`, ` ${FAKE_TOKEN}`, `${FAKE_TOKEN}\n`, `bot${FAKE_TOKEN}`, `0${FAKE_TOKEN}`, 42, null]) {
      expect(TelegramBotToken.from(bad), String(bad)).toBeNull();
    }
  });

  it('is redacted in JSON, inspect, string coercion, spread and a carrying config object', () => {
    const holder = token();
    expect(holder.reveal()).toBe(FAKE_TOKEN);
    expect(holder.botId).toBe(FAKE_BOT_ID);
    const config = { telegram: { token: holder, expectedBotId: FAKE_BOT_ID } };
    for (const surface of [leakSurfaces(holder), leakSurfaces(config), inspect(config, { depth: 10 })]) {
      expect(surface).not.toContain(FAKE_TOKEN_SECRET);
    }
    expect(JSON.stringify(holder)).toBe('"[REDACTED]"');
    expect(`${holder}`).toBe('[REDACTED]');
  });

  it('redactTelegramToken removes a token and a /bot<token>/ path, keeping the rest', () => {
    const text = `fetch failed: ${TELEGRAM_API_ORIGIN}/bot${FAKE_TOKEN}/getUpdates (cause ${FAKE_TOKEN})`;
    const redacted = redactTelegramToken(text);
    expect(redacted).not.toContain(FAKE_TOKEN_SECRET);
    expect(redacted).toBe(`fetch failed: ${TELEGRAM_API_ORIGIN}/bot[REDACTED]/getUpdates (cause [REDACTED])`);
  });
});

describe('TelegramBotApi — pinned host, bounded call, value-free failures', () => {
  it('posts JSON to the pinned origin with the token only in the path, refusing redirects', async () => {
    const fake = new FakeTelegram().queue('getMe', okReply({ id: 1 }));
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(api.call('getMe', {}, { timeoutMs: 1000 })).resolves.toEqual({ id: 1 });
    const call = fake.calls[0];
    expect(call?.url).toBe(`${TELEGRAM_API_ORIGIN}/bot${FAKE_TOKEN}/getMe`);
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.method).toBe('POST');
    expect(JSON.stringify(call?.init.headers)).not.toContain(FAKE_TOKEN_SECRET);
    expect(String(call?.init.body)).not.toContain(FAKE_TOKEN_SECRET);
  });

  it('a transport error that quotes the URL leaves only a fixed code (no token, no cause)', async () => {
    const fake = new FakeTelegram().queue('getUpdates', {
      throws: new TypeError(`fetch failed for ${TELEGRAM_API_ORIGIN}/bot${FAKE_TOKEN}/getUpdates`),
    });
    const api = new TelegramBotApi(token(), fake.fetch);
    const error = await api.call('getUpdates', {}, { timeoutMs: 1000 }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).code).toBe(TelegramFailureCode.UNAVAILABLE);
    expect((error as Error).message).toBe('telegram getUpdates: UNAVAILABLE');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const surfaces = [leakSurfaces(error), (error as Error).stack ?? ''].join('\n');
    expect(surfaces).not.toContain(FAKE_TOKEN_SECRET);
  });

  it.each([
    [401, TelegramFailureCode.AUTH],
    [404, TelegramFailureCode.AUTH],
    [403, TelegramFailureCode.FORBIDDEN],
    [409, TelegramFailureCode.CONFLICT],
    [429, TelegramFailureCode.RATE_LIMITED],
    [400, TelegramFailureCode.BAD_REQUEST],
    [502, TelegramFailureCode.UNAVAILABLE],
  ])('HTTP %i is %s, with no description text in the error', async (status, code) => {
    expect(failureCodeOfStatus(status)).toBe(code);
    const fake = new FakeTelegram().queue('sendMessage', errorReply(status));
    const api = new TelegramBotApi(token(), fake.fetch);
    const error = (await api.call('sendMessage', { chat_id: '1', text: 'x' }, { timeoutMs: 1000 }).catch((err: unknown) => err)) as TelegramApiError;
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.message).not.toContain('fake description');
  });

  it('a 429 carries only the bounded numeric retry_after', async () => {
    const fake = new FakeTelegram()
      .queue('sendMessage', errorReply(429, { retry_after: 7 }))
      .queue('sendMessage', errorReply(429, { retry_after: 999_999 }))
      .queue('sendMessage', errorReply(429, { retry_after: 'soon' }));
    const api = new TelegramBotApi(token(), fake.fetch);
    const retry = async (): Promise<number | undefined> =>
      ((await api.call('sendMessage', {}, { timeoutMs: 1000 }).catch((err: unknown) => err)) as TelegramApiError).retryAfterSeconds;
    expect(await retry()).toBe(7);
    expect(await retry()).toBe(3600);
    expect(await retry()).toBeUndefined();
  });

  it('a 2xx without the ok envelope is MALFORMED_RESPONSE; a body over the bound is refused', async () => {
    const fake = new FakeTelegram().queue('getMe', { json: { ok: false } }).queue('getMe', okReply('x'.repeat(4096)));
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(api.call('getMe', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: TelegramFailureCode.MALFORMED_RESPONSE });
    await expect(api.call('getMe', {}, { timeoutMs: 1000, maxResponseBytes: 64 })).rejects.toMatchObject({
      code: TelegramFailureCode.RESPONSE_TOO_LARGE,
    });
  });

  it('a response from another origin is refused', async () => {
    const api = new TelegramBotApi(token(), async () => {
      const response = new Response(JSON.stringify({ ok: true, result: 1 }), { status: 200 });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/botX/getMe' });
      return response;
    });
    await expect(api.call('getMe', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: TelegramFailureCode.UNAVAILABLE });
  });

  it('the call is bounded by its timer and cancelled by the caller signal', async () => {
    const fake = new FakeTelegram();
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(api.call('getUpdates', {}, { timeoutMs: 5 })).rejects.toMatchObject({ code: TelegramFailureCode.TIMEOUT });
    const controller = new AbortController();
    const pending = api.call('getUpdates', {}, { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: TelegramFailureCode.ABORTED });
  });

  it('refuses a method outside the fixed list before any request', async () => {
    const fake = new FakeTelegram();
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(api.call('deleteWebhook' as never, {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: TelegramFailureCode.BAD_REQUEST });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('TelegramBotApi.download (TG-2): the pinned file host, bounded, value-free failures', () => {
  const download = (api: TelegramBotApi, filePath: string, maxResponseBytes = 1024, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    api.download(filePath, { timeoutMs: extra.timeoutMs ?? 1000, maxResponseBytes, ...(extra.signal ? { signal: extra.signal } : {}) });

  it('GETs /file/bot<token>/<file_path> on the pinned origin, refusing redirects, and returns the bytes', async () => {
    const fake = new FakeTelegram().queue('downloadFile', bytesReply(Buffer.from('hello')));
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(download(api, 'documents/file_1.txt')).resolves.toEqual(Buffer.from('hello'));
    const [call] = fake.calls;
    expect(call?.url).toBe(`${TELEGRAM_API_ORIGIN}/file/bot${FAKE_TOKEN}/documents/file_1.txt`);
    expect(call?.init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(call?.init.body).toBeUndefined();
  });

  it('a declared or streamed body over the bound is RESPONSE_TOO_LARGE', async () => {
    const fake = new FakeTelegram()
      .queue('downloadFile', bytesReply(Buffer.alloc(10), { headers: { 'content-length': '5000' } }))
      .queue('downloadFile', bytesReply(Buffer.alloc(2048)));
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(download(api, 'a/b.txt')).rejects.toMatchObject({ code: TelegramFailureCode.RESPONSE_TOO_LARGE, method: 'downloadFile' });
    await expect(download(api, 'a/b.txt')).rejects.toMatchObject({ code: TelegramFailureCode.RESPONSE_TOO_LARGE });
  });

  it('a transport error quoting the token URL leaves only a fixed code; HTTP errors carry the status only', async () => {
    const fake = new FakeTelegram()
      .queue('downloadFile', { throws: new TypeError(`fetch failed for ${TELEGRAM_API_ORIGIN}/file/bot${FAKE_TOKEN}/a/b.txt`) })
      .queue('downloadFile', bytesReply(Buffer.from('nope'), { status: 404 }))
      .queue('downloadFile', bytesReply(Buffer.from('busy'), { status: 502 }));
    const api = new TelegramBotApi(token(), fake.fetch);
    const transport = await download(api, 'a/b.txt').catch((err: unknown) => err);
    expect(transport).toBeInstanceOf(TelegramApiError);
    expect((transport as Error).message).toBe('telegram downloadFile: UNAVAILABLE');
    expect((transport as { cause?: unknown }).cause).toBeUndefined();
    expect([leakSurfaces(transport), (transport as Error).stack ?? ''].join('\n')).not.toContain(FAKE_TOKEN_SECRET);
    await expect(download(api, 'a/b.txt')).rejects.toMatchObject({ code: TelegramFailureCode.AUTH, httpStatus: 404, message: 'telegram downloadFile: AUTH (HTTP 404)' });
    await expect(download(api, 'a/b.txt')).rejects.toMatchObject({ code: TelegramFailureCode.UNAVAILABLE, httpStatus: 502 });
  });

  it('a response from another origin is refused; the call is bounded and cancelled by the caller signal', async () => {
    const evil = new TelegramBotApi(token(), async () => {
      const response = new Response('x', { status: 200 });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/file/botX/a' });
      return response;
    });
    await expect(download(evil, 'a/b.txt')).rejects.toMatchObject({ code: TelegramFailureCode.UNAVAILABLE });
    const fake = new FakeTelegram().queue('downloadFile', { hang: true }, { hang: true });
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(download(api, 'a/b.txt', 1024, { timeoutMs: 5 })).rejects.toMatchObject({ code: TelegramFailureCode.TIMEOUT });
    const controller = new AbortController();
    const pending = download(api, 'a/b.txt', 1024, { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: TelegramFailureCode.ABORTED });
  });

  it.each(['', '../x', 'a/../b', 'a//b', '/abs', './a', 'a b', 'a?b', 'a#b', 'a%2e%2e', 'https://evil.example/x', 'x'.repeat(257)])(
    'refuses the unsafe file_path %j before any request',
    async (filePath) => {
      const fake = new FakeTelegram();
      const api = new TelegramBotApi(token(), fake.fetch);
      expect(isSafeTelegramFilePath(filePath)).toBe(false);
      await expect(download(api, filePath)).rejects.toMatchObject({ code: TelegramFailureCode.BAD_REQUEST });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('accepts Telegram’s own path shapes; call() refuses the download pseudo-method', async () => {
    for (const filePath of ['photos/file_12.jpg', 'documents/file_3.txt', 'stickers/file-1.webp', 'a']) expect(isSafeTelegramFilePath(filePath)).toBe(true);
    const fake = new FakeTelegram();
    const api = new TelegramBotApi(token(), fake.fetch);
    await expect(api.call('downloadFile', {}, { timeoutMs: 1000 })).rejects.toMatchObject({ code: TelegramFailureCode.BAD_REQUEST });
    expect(fake.calls).toHaveLength(0);
  });
});
