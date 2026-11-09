/**
 * ADR-0124 Part L slice C5a: the S3 whole-item summary, arm L (LOCAL only). Unwired: no handler calls it yet
 * (DECISIONS ADR-0124 section 17).
 */
export {
  CHUNK_ITEMS_MODES,
  S3_LIMITS,
  parseChunkItemsMode,
  runS3ItemSummary,
} from './s3-item-summary';
export type { ChunkItemsMode, S3Audit, S3ItemSummaryDeps, S3ItemSummaryInput, S3ItemSummaryOutcome, S3PartialReason } from './s3-item-summary';
export {
  DOCUMENT_MAP_NOTE_LINE_MAX_CODE_POINTS,
  DOCUMENT_MAP_NOTE_MAX_LINES,
  DOCUMENT_MAP_OUTPUT_MAX_BYTES,
  DOCUMENT_MAP_PROMPT_VERSION,
  buildDocumentMapRequest,
  composeDocumentMapPrompt,
  parseDocumentMapNote,
} from './document-map-prompt';
export type { DocumentMapNoteFailure, DocumentMapNoteResult, DocumentMapPart } from './document-map-prompt';
