/**
 * Removes the full-size covers that the WebP thumbnails have replaced.
 *
 * Only Books whose small *and* large thumbnail files are both present on disk
 * are considered, so a Book can never lose its last image. The script reports
 * what it would free and changes nothing until it is run with `--apply`;
 * rolling back to the legacy covers afterwards is not supported, hence the
 * explicit second step.
 */
import { existsSync, statSync } from 'node:fs';
import { createDatabase } from '../db/database.js';
import type { BookRow } from '../db/rows.js';
import { deleteStoredCover } from '../services/coverStorage.js';
import { toAbsoluteStoragePath } from '../services/fileStorage.js';

/** The columns this script reads; the rest of the Book row is irrelevant here. */
type LegacyCoverBook = Pick<
  BookRow,
  'id' | 'cover_path' | 'cover_thumbnail_small_path' | 'cover_thumbnail_large_path'
>;

const applyChanges = process.argv.includes('--apply');
const db = createDatabase();

try {
  const candidates = db.prepare<[], LegacyCoverBook>(`
    SELECT id,
           cover_path,
           cover_thumbnail_small_path,
           cover_thumbnail_large_path
    FROM books
    WHERE cover_path IS NOT NULL
      AND cover_thumbnail_small_path IS NOT NULL
      AND cover_thumbnail_large_path IS NOT NULL
    ORDER BY id ASC
  `).all().filter((book) => {
    const smallPath = toAbsoluteStoragePath(book.cover_thumbnail_small_path);
    const largePath = toAbsoluteStoragePath(book.cover_thumbnail_large_path);
    return existsSync(smallPath) && existsSync(largePath);
  });
  let totalBytes = 0;

  for (const book of candidates) {
    const coverPath = toAbsoluteStoragePath(book.cover_path);
    if (existsSync(coverPath)) {
      totalBytes += statSync(coverPath).size;
    }
  }

  const totalMiB = (totalBytes / (1024 * 1024)).toFixed(1);

  if (!applyChanges) {
    console.log(
      `Dry run: ${candidates.length} legacy covers (${totalMiB} MiB) can be removed.`,
    );
    console.log('Back up the data volume, then rerun with --apply to delete them.');
    process.exitCode = 0;
  } else {
    const clearCoverPath = db.prepare<[number, string | null]>(
      'UPDATE books SET cover_path = NULL WHERE id = ? AND cover_path = ?',
    );
    const removeCover = db.transaction((book: LegacyCoverBook) => {
      deleteStoredCover(book.cover_path);
      clearCoverPath.run(book.id, book.cover_path);
    });

    for (const book of candidates) {
      removeCover(book);
    }

    console.log(
      `Removed ${candidates.length} legacy covers and released ${totalMiB} MiB.`,
    );
    console.log('Rollback to images that require legacy covers is no longer supported.');
  }
} finally {
  db.close();
}
