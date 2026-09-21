/**
 * Book wire contracts.
 *
 * Field names and nullability mirror the server formatter `formatBook` and the
 * SQL columns it reads (`001_initial_library_schema.sql`,
 * `003_add_book_file_mtime.sql`, `005_add_cover_thumbnails_and_library_revision.sql`).
 * Columns that are never sent over the wire (`file_path`, `file_mtime_ms`) are
 * deliberately absent: they belong to the server's row types, not to this contract.
 */

/** Full Book payload returned by every REST endpoint that serves books. */
export interface BookDto {
  readonly id: number;
  /** `null` when the Book sits directly on the Bookshelf rather than in a Folder. */
  readonly folderId: number | null;
  readonly title: string;
  readonly author: string | null;
  readonly description: string | null;
  readonly publisher: string | null;
  readonly language: string | null;
  /** EPUB identifier. Duplicate imports share it and still stay independent Books. */
  readonly identifier: string | null;
  readonly fileName: string;
  readonly fileSize: number;
  /** Storage path such as `data/covers/<name>.webp`; `null` when no cover exists. */
  readonly coverPath: string | null;
  /** `null` when `coverPath` is absent or outside the served covers prefix. */
  readonly coverUrl: string | null;
  readonly coverThumbnailSmallPath: string | null;
  readonly coverThumbnailLargePath: string | null;
  readonly coverThumbnailUrl: string | null;
  readonly coverThumbnail2xUrl: string | null;
  readonly coverThumbnailVersion: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Catalog Book payload returned by `GET /api/books/catalog`.
 *
 * The Catalog is the flat list of every Book, Bookshelf or Folder alike, so it
 * adds the Folder name and the joined Reading Position that the search view
 * renders. All three fields are `null` when the join found nothing; a
 * `readingProgress` of `0` means opened at the start and is not the same as
 * `null`.
 */
export interface CatalogBookDto extends BookDto {
  readonly folderName: string | null;
  readonly readingProgress: number | null;
  readonly readingUpdatedAt: string | null;
}

/**
 * Trimmed Book payload carried by the library snapshot.
 *
 * The snapshot drops fields the Bookshelf never renders and folds the joined
 * reading position in, so it stays small for large catalogs.
 */
export interface SnapshotBookDto {
  readonly id: number;
  readonly folderId: number | null;
  readonly title: string;
  readonly author: string | null;
  readonly identifier: string | null;
  readonly fileName: string;
  readonly fileSize: number;
  readonly coverPath: string | null;
  readonly coverUrl: string | null;
  readonly coverThumbnailUrl: string | null;
  readonly coverThumbnail2xUrl: string | null;
  readonly coverThumbnailVersion: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Reading Position progress for this Book, or `null` when the Book was never
   * opened. `0` means opened at the start and is not the same as `null`.
   */
  readonly readingProgress: number | null;
  readonly readingUpdatedAt: string | null;
}
