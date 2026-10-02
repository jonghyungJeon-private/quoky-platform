/**
 * Code-work expansion (ADR-0099) — application sub-barrel.
 *
 * Pre-registered stub (SEAM-1, ADR-0096 D8). The track's tasks add their modules to this folder and export them
 * from this sub-barrel only; the root application barrel is not edited after wave 1. A dropped track's stub is
 * removed in INT-1 or DOC-B.
 */
export * from './branch-name-policy';
