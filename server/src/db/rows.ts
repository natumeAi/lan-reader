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
