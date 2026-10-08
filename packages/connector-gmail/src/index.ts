/**
 * @quoky/connector-gmail — the read-only Gmail adapter for the `MailReader` port (ADR-0118 D2/D3, GML-1): scope
 * `gmail.readonly` only, GET to the pinned `messages.list` / `messages.get` endpoints only. No send, draft, label,
 * modify, trash or delete code exists. Depends only on `@quoky/core` and Node built-ins.
 */
export * from './errors';
export * from './oauth';
export * from './token-file';
export * from './mime';
export * from './gmail-mail-reader';
