import { request } from 'node:http';

/**
 * Test-only HTTP client for the OPS-1 listener (raw `node:http`, so `Host`, `Origin` and `Cookie` can be set exactly
 * as a browser or an attacker would). Not imported by production code.
 */

export interface TestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface TestRequest {
  readonly port: number;
  readonly method?: string;
  readonly path?: string;
  readonly host?: string;
  readonly origin?: string;
  readonly cookie?: string;
  readonly form?: Readonly<Record<string, string>>;
  readonly contentType?: string;
}

export function send(input: TestRequest): Promise<TestResponse> {
  const body = input.form ? new URLSearchParams({ ...input.form }).toString() : undefined;
  const headers: Record<string, string> = { Host: input.host ?? `127.0.0.1:${input.port}` };
  if (input.origin !== undefined) headers.Origin = input.origin;
  if (input.cookie !== undefined) headers.Cookie = input.cookie;
  if (body !== undefined) {
    headers['Content-Type'] = input.contentType ?? 'application/x-www-form-urlencoded';
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: input.port, method: input.method ?? 'GET', path: input.path ?? '/', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The `name=value` part of a `Set-Cookie` header. */
export function cookieFrom(response: TestResponse): string | undefined {
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.split(';')[0];
}
