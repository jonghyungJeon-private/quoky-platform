/**
 * @quoky/core — the framework-agnostic heart of Quoky.
 *
 * Contains ONLY: domain models, port interfaces, application services, and
 * pure utilities. It has NO runtime dependency on NestJS, a chat platform SDK, SQLite, or
 * any concrete provider. Everything outside depends inward on this package;
 * this package depends on nothing in the workspace.
 */
export * from './domain';
export * from './ports';
export * from './application';
export * from './errors';
export { newId } from './util/id';
export { now } from './util/clock';
