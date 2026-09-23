/**
 * SQLite row shapes.
 *
 * These mirror the tables produced by `db/migrations/*.sql` column for column
 * and therefore stay snake_case. They are an internal database contract: they
 * must never reach an HTTP response. Response bodies are built from the
 * camelCase DTOs exported by `@lan-reader/shared`.
 */
import type BetterSqlite3 from 'better-sqlite3';

/** An open `better-sqlite3` connection, as handed to every service. */
export type DatabaseHandle = BetterSqlite3.Database;

/**
 * `books`, created by `001_initial_library_schema.sql` and extended by
 * `003_add_book_file_mtime.sql` and
 * `005_add_cover_thumbnails_and_library_revision.sql`.
 */
export interface BookRow {
  id: number;
  folder_id: number | null;
  title: string;
  author: string | null;
  description: string | null;
  publisher: string | null;
  language: string | null;
  identifier: string | null;
  file_name: string;
  file_path: string;
  file_size: number;
  cover_path: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  file_mtime_ms: number | null;
  cover_thumbnail_small_path: string | null;
  cover_thumbnail_large_path: string | null;
  cover_thumbnail_version: string | null;
}

/** `folders`, created by `001_initial_library_schema.sql`. */
export interface FolderRow {
  id: number;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * `reading_progress`, created by `001_initial_library_schema.sql`.
 *
 * One row per Book: a Reading Position, not a furthest-read marker.
 */
export interface ReadingProgressRow {
  book_id: number;
  cfi: string | null;
  progress: number;
  chapter_href: string | null;
  chapter_label: string | null;
  updated_at: string;
}

/** `schema_migrations`, created by the migration runner itself. */
export interface SchemaMigrationRow {
  name: string;
}

/** `GET /api/books/catalog`: books joined with their Folder and Reading Position. */
export type CatalogBookRow = BookRow & {
  folder_name: string | null;
  reading_progress: number | null;
  reading_updated_at: string | null;
};

/** Library snapshot books: joined with their Reading Position only. */
export type SnapshotBookRow = BookRow & {
  reading_progress: number | null;
  reading_updated_at: string | null;
};

/** `GET /api/reading/recent`: reading progress joined with its Book. */
export type RecentReadingRow = BookRow & {
  progress_book_id: number;
  progress_cfi: string | null;
  progress_value: number;
  progress_chapter_href: string | null;
  progress_chapter_label: string | null;
  progress_updated_at: string;
};

/** A Folder with the number of Books it holds. */
export type FolderCountRow = FolderRow & {
  book_count: number;
};

/** A Folder's cover preview candidates, ranked by shelf order. */
export type FolderPreviewRow = BookRow & {
  preview_rank: number;
};

/** Single-column scalar result of `... AS value` aggregates. */
export interface CountRow {
  value: number;
}

/** `library_revision`, created by `005_add_cover_thumbnails_and_library_revision.sql`. */
export interface RevisionRow {
  revision: number;
}

/** `reading_stats_settings`, created by `006_add_reading_statistics.sql`. Singleton. */
export interface ReadingStatsSettingsRow {
  id: number;
  daily_goal_minutes: number;
  annual_book_goal: number;
  tracking_started_at: string;
  updated_at: string;
}

/**
 * `reading_activity_events`, created by `006_add_reading_statistics.sql`.
 *
 * One acknowledgment per accepted activity event id. `skipped_sections` is the
 * JSON-encoded skipped-coverage list returned on every identical retry.
 */
export interface ReadingActivityEventRow {
  id: string;
  book_id: number;
  payload_hash: string;
  local_date: string;
  duration_ms: number;
  characters_added: number;
  skipped_sections: string;
  accepted_at: string;
}

/** `reading_daily_activity`, created by `006_add_reading_statistics.sql`. */
export interface ReadingDailyActivityRow {
  book_id: number;
  local_date: string;
  duration_ms: number;
  characters: number;
}

/**
 * `reading_section_coverage`, created by `006_add_reading_statistics.sql`.
 *
 * `intervals` is the JSON-encoded merged `[start, end)` list.
 */
export interface ReadingSectionCoverageRow {
  book_id: number;
  normalization_version: number;
  section_index: number;
  signature: string;
  section_length: number;
  intervals: string;
  covered_characters: number;
  updated_at: string;
}

/** `reading_completions`, created by `006_add_reading_statistics.sql`. */
export interface ReadingCompletionRow {
  book_id: number;
  year: number;
  local_date: string;
  occurred_at: string;
  event_id: string;
}

/** Seven-day chart: activity summed over every Book for one local date. */
export interface ReadingDayTotalRow {
  local_date: string;
  duration_ms: number;
  characters: number;
}

/** Lifetime duration and character totals. */
export interface ReadingLifetimeTotalRow {
  duration_ms: number;
  characters: number;
}

/** Annual completion list: completion joined with its Book. */
export type CompletedBookRow = BookRow & {
  completion_local_date: string;
  completion_occurred_at: string;
};
