/** Folder wire contracts, mirroring the server formatter `formatFolder`. */
import type { BookDto } from './book.js';

/**
 * Maximum Folder name length accepted by the server.
 *
 * The server enforces it in `normalizeFolderName`; the rename input caps typing
 * at the same value. Both sides must read it from here.
 */
export const MAX_FOLDER_NAME_LENGTH = 80;

/** Full Folder payload returned by the REST folder endpoints. */
export interface FolderDto {
  readonly id: number;
  readonly name: string;
  readonly sortOrder: number;
  readonly bookCount: number;
  /** At most four Books used to draw the Folder cover. */
  readonly previewBooks: BookDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Folder payload carried by the library snapshot.
 *
 * The snapshot references Books by id instead of embedding them, so a Book that
 * appears in a Folder and in a preview is transferred once.
 */
export interface SnapshotFolderDto {
  readonly id: number;
  readonly name: string;
  readonly sortOrder: number;
  readonly bookCount: number;
  /** Contained Book ids, ordered by `sortOrder` then `id`. */
  readonly bookIds: number[];
  /** First four entries of `bookIds`. */
  readonly previewBookIds: number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
