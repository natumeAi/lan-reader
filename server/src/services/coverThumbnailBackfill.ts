/**
 * Background conversion of stored covers into the current thumbnail version.
 *
 * It walks every Book once, skips the ones already rendered at the current
 * version, and yields between Books so an import or a request is never starved.
 * The work is resumable: a stop request is honoured between Books, and the
 * update is conditional on the Book still pointing at the same file.
 */
import { existsSync } from 'node:fs';
import type { BookRow, DatabaseHandle } from '../db/rows.js';
import { readErrorCode } from '../http/httpError.js';
import {
  ensureBookCoverThumbnails,
  isCurrentCoverThumbnailVersion,
  isStoredGeneratedFallbackCover,
  saveBookCoverAssets,
} from './coverStorage.js';
import type { CoverThumbnails } from './coverStorage.js';
import { parseEpubDetails } from './epubService.js';
import { toAbsoluteStoragePath } from './fileStorage.js';

const DEFAULT_START_DELAY_MS = 1500;
const DEFAULT_BETWEEN_BOOK_DELAY_MS = 100;

export interface BackfillCoverThumbnailsOptions {
  shouldStop?: () => boolean;
  betweenBookDelayMs?: number;
}

export interface StartCoverThumbnailBackfillOptions extends BackfillCoverThumbnailsOptions {
  startDelayMs?: number;
}

export interface CoverThumbnailBackfillResult {
  convertedCount: number;
  failedCount: number;
  stopped: boolean;
}

export interface CoverThumbnailBackfillHandle {
  done: Promise<CoverThumbnailBackfillResult>;
  close(): Promise<void>;
}

/**
 * A Book's cover assets after a backfill pass. `coverPath` keeps the Book's
 * existing cover when only the thumbnails had to be rendered.
 */
interface BackfilledCoverAssets extends CoverThumbnails {
  coverPath: string | null;
}

interface CoverAssetsUpdateParams extends BackfilledCoverAssets {
  id: number;
  filePath: string;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function storedFileExists(storedPath: string | null | undefined): boolean {
  if (!storedPath) return false;

  try {
    return existsSync(toAbsoluteStoragePath(storedPath));
  } catch {
    return false;
  }
}

function thumbnailsAreReady(book: BookRow): boolean {
  return (
    isCurrentCoverThumbnailVersion(book.cover_thumbnail_version) &&
    storedFileExists(book.cover_thumbnail_small_path) &&
    storedFileExists(book.cover_thumbnail_large_path)
  );
}

async function buildCoverAssets(book: BookRow): Promise<BackfilledCoverAssets> {
  const bookFilePath = toAbsoluteStoragePath(book.file_path);

  if (storedFileExists(book.cover_path)) {
    if (await isStoredGeneratedFallbackCover(book.cover_path)) {
      return saveBookCoverAssets({
        bookFilePath,
        coverImage: null,
        title: book.title,
        author: null,
      });
    }

    const thumbnails = await ensureBookCoverThumbnails({
      bookFilePath,
      storedCoverPath: book.cover_path,
    });

    return {
      coverPath: book.cover_path,
      ...thumbnails,
    };
  }

  const epubDetails = await parseEpubDetails(bookFilePath);
  return saveBookCoverAssets({
    bookFilePath,
    coverImage: epubDetails.coverImage,
    title: epubDetails.metadata.title || book.title,
    author: epubDetails.metadata.author || book.author,
  });
}

export async function backfillCoverThumbnails(
  db: DatabaseHandle,
  options: BackfillCoverThumbnailsOptions = {},
): Promise<CoverThumbnailBackfillResult> {
  const shouldStop = options.shouldStop || (() => false);
  const betweenBookDelayMs =
    options.betweenBookDelayMs ?? DEFAULT_BETWEEN_BOOK_DELAY_MS;
  const books = db.prepare<[], BookRow>(`
    SELECT *
    FROM books
    ORDER BY
      CASE WHEN folder_id IS NULL THEN 0 ELSE 1 END,
      sort_order ASC,
      id ASC
  `).all();
  const updateCoverAssets = db.prepare<CoverAssetsUpdateParams>(`
    UPDATE books
    SET cover_path = @coverPath,
        cover_thumbnail_small_path = @coverThumbnailSmallPath,
        cover_thumbnail_large_path = @coverThumbnailLargePath,
        cover_thumbnail_version = @coverThumbnailVersion
    WHERE id = @id
      AND file_path = @filePath
  `);
  let convertedCount = 0;
  let failedCount = 0;

  for (const book of books) {
    if (shouldStop()) break;
    if (thumbnailsAreReady(book)) continue;

    try {
      const assets = await buildCoverAssets(book);
      updateCoverAssets.run({
        id: book.id,
        filePath: book.file_path,
        ...assets,
      });
      convertedCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error(
        `Failed to backfill cover thumbnails for book ${book.id} [${readErrorCode(error) || 'UNEXPECTED_ERROR'}]`,
      );
    }

    if (!shouldStop() && betweenBookDelayMs > 0) {
      await delay(betweenBookDelayMs);
    }
  }

  return {
    convertedCount,
    failedCount,
    stopped: shouldStop(),
  };
}

export function startCoverThumbnailBackfill(
  db: DatabaseHandle,
  options: StartCoverThumbnailBackfillOptions = {},
): CoverThumbnailBackfillHandle {
  let stopped = false;
  const startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
  const done = (async (): Promise<CoverThumbnailBackfillResult> => {
    if (startDelayMs > 0) {
      await delay(startDelayMs);
    }

    if (stopped) {
      return {
        convertedCount: 0,
        failedCount: 0,
        stopped: true,
      };
    }

    const result = await backfillCoverThumbnails(db, {
      ...options,
      shouldStop: () => stopped,
    });

    if (result.convertedCount || result.failedCount) {
      console.log(
        `Cover thumbnail backfill finished: ${result.convertedCount} converted, ${result.failedCount} failed`,
      );
    }

    return result;
  })().catch((error: unknown) => {
    console.error('Cover thumbnail backfill failed:', error);
    return {
      convertedCount: 0,
      failedCount: 1,
      stopped,
    };
  });

  return {
    done,
    async close(): Promise<void> {
      stopped = true;
      await done;
    },
  };
}
