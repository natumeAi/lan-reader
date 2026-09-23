/**
 * Cross-process contracts shared by the client and the server.
 *
 * This package is browser-safe: it must never import Node builtins, database
 * drivers, React, or epub.js. Anything that only one side needs — SQLite row
 * shapes, React state, EPUB instances — stays in that side's workspace.
 */
export type {
  BookDto,
  CatalogBookDto,
  SnapshotBookDto,
} from './book.js';
export type { FolderDto, SnapshotFolderDto } from './folder.js';
export { MAX_FOLDER_NAME_LENGTH } from './folder.js';
export type { ShelfItemDto, ShelfItemRef, ShelfItemType, ShelfOrderItem } from './shelf.js';
export { isShelfBookItem, isShelfFolderItem } from './shelf.js';
export type {
  ReadingPositionDto,
  ReadingPositionUpdate,
  RecentReadingEntryDto,
  SnapshotRecentEntry,
} from './reading.js';
export type {
  AcceptedActivityOutcome,
  CharacterInterval,
  CompletedBookDto,
  ReadingActivityBatchRequest,
  ReadingActivityBatchResponse,
  ReadingActivityEvent,
  ReadingActivityOutcome,
  ReadingActivityRejectionReason,
  ReadingCompletionObservation,
  ReadingDayDto,
  ReadingGoalsDto,
  ReadingGoalsResponse,
  ReadingGoalsUpdate,
  ReadingLifetimeDto,
  ReadingStatsDto,
  ReadingStatsResponse,
  ReadingYearDto,
  RejectedActivityOutcome,
  SkippedCoverageReason,
  SkippedSectionCoverage,
  ViewedSectionCoverage,
} from './readingStats.js';
export {
  ACTIVITY_EVENT_ID_PATTERN,
  DEFAULT_ANNUAL_BOOK_GOAL,
  DEFAULT_DAILY_GOAL_MINUTES,
  MAX_ACTIVITY_BATCH_EVENTS,
  MAX_ACTIVITY_DURATION_MS,
  MAX_ACTIVITY_SECTIONS,
  MAX_ANNUAL_BOOK_GOAL,
  MAX_DAILY_GOAL_MINUTES,
  MAX_SECTION_INDEX,
  MAX_SECTION_INTERVALS,
  MAX_SECTION_LENGTH,
  MIN_ANNUAL_BOOK_GOAL,
  MIN_DAILY_GOAL_MINUTES,
  READING_STATS_DAY_COUNT,
  READING_TEXT_NORMALIZATION_VERSION,
  TEXT_SIGNATURE_PATTERN,
  countIntervalCharacters,
  decodeCharacterIntervals,
  decodeReadingActivityBatchEntries,
  decodeReadingActivityBatchResponse,
  decodeReadingActivityEvent,
  decodeReadingGoals,
  decodeReadingGoalsResponse,
  decodeReadingGoalsUpdate,
  decodeReadingStatsResponse,
  decodeSkippedSections,
  formatLocalDate,
  isIsoInstant,
  isLocalDate,
  localDateYear,
  mergeCharacterIntervals,
  readActivityEventId,
  shiftLocalDate,
} from './readingStats.js';
export type { LibrarySnapshot } from './librarySnapshot.js';
export {
  LIBRARY_SNAPSHOT_SCHEMA_VERSION,
  decodeLibrarySnapshot,
  decodeLibrarySnapshotResponse,
} from './librarySnapshot.js';
export type {
  ApiErrorResponse,
  BookResponse,
  BooksResponse,
  CatalogBooksResponse,
  FolderBooksResponse,
  FolderMutationResponse,
  FolderResponse,
  FoldersResponse,
  LibrarySnapshotResponse,
  MoveFolderBookToShelfResponse,
  ReadingPositionResponse,
  RecentReadingResponse,
  ShelfItemsResponse,
} from './api.js';
export {
  WireDecodeError,
  isRecord,
  requireArray,
  requireInteger,
  requireNumber,
  requireRecord,
} from './decode.js';
