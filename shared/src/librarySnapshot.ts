/**
 * Library snapshot contract (ADR-0003).
 *
 * One normalized payload describes the whole startup view: every Book once,
 * every Folder as id references, the Bookshelf order, and Continue Reading.
 */
import type { SnapshotBookDto } from './book.js';
import type { SnapshotFolderDto } from './folder.js';
import type { ShelfItemRef } from './shelf.js';
import type { SnapshotRecentEntry } from './reading.js';
import { WireDecodeError, isRecord, requireInteger } from './decode.js';

/**
 * Snapshot schema version. Bumping it is a breaking change: cached snapshots of
 * another version are discarded rather than migrated.
 */
export const LIBRARY_SNAPSHOT_SCHEMA_VERSION = 1;

export interface LibrarySnapshot {
  readonly schemaVersion: typeof LIBRARY_SNAPSHOT_SCHEMA_VERSION;
  /** Library revision the snapshot was built from; also drives the ETag. */
  readonly version: number;
  readonly books: SnapshotBookDto[];
  readonly folders: SnapshotFolderDto[];
  readonly shelf: ShelfItemRef[];
  readonly recent: SnapshotRecentEntry[];
}

function requireSnapshotArray(snapshot: Record<string, unknown>, property: string): unknown[] {
  if (!Array.isArray(snapshot[property])) {
    // Message kept identical to the pre-migration client so existing callers
    // and tests keep seeing the same failure text.
    throw new WireDecodeError(`Library snapshot is missing ${property}`);
  }
  return snapshot[property];
}

/**
 * Decodes a snapshot that arrived from HTTP or from the browser cache.
 *
 * This validates what the consumers actually index on: the schema version, the
 * four arrays, and the identity fields used to join them. Per-field validation
 * of every Book is intentionally not done here — the pre-migration client
 * accepted partial Book records, and tightening that is a behaviour change, not
 * a typing change.
 */
export function decodeLibrarySnapshot(value: unknown): LibrarySnapshot {
  if (!isRecord(value) || value['schemaVersion'] !== LIBRARY_SNAPSHOT_SCHEMA_VERSION) {
    throw new WireDecodeError('Library snapshot version is not supported');
  }

  const books = requireSnapshotArray(value, 'books');
  const folders = requireSnapshotArray(value, 'folders');
  const shelf = requireSnapshotArray(value, 'shelf');
  const recent = requireSnapshotArray(value, 'recent');

  books.forEach((book, index) => {
    requireInteger(requireEntry(book, `snapshot.books[${index}]`)['id'], `snapshot.books[${index}].id`);
  });
  folders.forEach((folder, index) => {
    requireInteger(
      requireEntry(folder, `snapshot.folders[${index}]`)['id'],
      `snapshot.folders[${index}].id`,
    );
  });
  shelf.forEach((item, index) => {
    const entry = requireEntry(item, `snapshot.shelf[${index}]`);
    const type = entry['type'];
    if (type !== 'book' && type !== 'folder') {
      throw new WireDecodeError(`snapshot.shelf[${index}].type must be "book" or "folder"`);
    }
    requireInteger(entry['id'], `snapshot.shelf[${index}].id`);
  });
  recent.forEach((entry, index) => {
    requireInteger(
      requireEntry(entry, `snapshot.recent[${index}]`)['bookId'],
      `snapshot.recent[${index}].bookId`,
    );
  });

  return {
    schemaVersion: LIBRARY_SNAPSHOT_SCHEMA_VERSION,
    version: requireInteger(value['version'], 'snapshot.version'),
    books: books as SnapshotBookDto[],
    folders: folders as SnapshotFolderDto[],
    shelf: shelf as ShelfItemRef[],
    recent: recent as SnapshotRecentEntry[],
  };
}

function requireEntry(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new WireDecodeError(`${context} must be an object`);
  }
  return value;
}

/** Reads the `snapshot` envelope of `GET /api/library/snapshot`. */
export function decodeLibrarySnapshotResponse(value: unknown): LibrarySnapshot {
  if (!isRecord(value)) {
    throw new WireDecodeError('Library snapshot response must be an object');
  }
  return decodeLibrarySnapshot(value['snapshot']);
}
