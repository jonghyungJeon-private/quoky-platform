/**
 * @quoky/connector-gdrive — the read-only Google Drive adapter for the `DriveReader` port (ADR-0118 D2/D3, DRV-1): scope
 * `drive.readonly` only, GET to the pinned `files.list`, `files.get` and `files.export` endpoints only, and a bounded
 * text export of Google Docs and Sheets only (no file is ever downloaded). No upload, create, edit, copy, move, rename, trash, delete, share or permission
 * code exists. Depends only on `@quoky/core` and Node built-ins.
 */
export * from './errors';
export * from './oauth';
export * from './token-file';
export * from './text';
export * from './gdrive-reader';
