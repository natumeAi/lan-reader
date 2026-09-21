/**
 * Bookshelf item contracts.
 *
 * The Bookshelf is the ordered arrangement the reader sees; it is not the
 * Catalog of every Book. A Bookshelf position holds either a Book that is not
 * in a Folder, or a Folder.
 */
import type { BookDto } from './book.js';
import type { FolderDto } from './folder.js';

export type ShelfItemType = 'book' | 'folder';

interface ShelfItemBase {
  readonly id: number;
  readonly sortOrder: number;
}

/**
 * Snapshot Bookshelf entry: a reference resolved against the snapshot's own
 * `books` and `folders` arrays.
 */
export type ShelfItemRef =
  | (ShelfItemBase & { readonly type: 'book' })
  | (ShelfItemBase & { readonly type: 'folder' });

/** REST Bookshelf entry (`GET /api/folders/shelf`), with the record embedded. */
export type ShelfItemDto =
  | (ShelfItemBase & { readonly type: 'book'; readonly book: BookDto })
  | (ShelfItemBase & { readonly type: 'folder'; readonly folder: FolderDto });

/** Entry of the reorder request body (`PATCH /api/folders/shelf/order`). */
export interface ShelfOrderItem {
  readonly type: ShelfItemType;
  readonly id: number;
}

/** Narrows a Bookshelf entry of either flavour to its Book case. */
export function isShelfBookItem<T extends { type: ShelfItemType }>(
  item: T,
): item is T & { type: 'book' } {
  return item.type === 'book';
}

/** Narrows a Bookshelf entry of either flavour to its Folder case. */
export function isShelfFolderItem<T extends { type: ShelfItemType }>(
  item: T,
): item is T & { type: 'folder' } {
  return item.type === 'folder';
}
