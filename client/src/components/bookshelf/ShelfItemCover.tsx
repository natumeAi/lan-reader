import type { ShelfItem } from '../../types/library.js';
import { BookCover, SHELF_COVER_SIZES } from './BookCover.js';
import { BookReadingPositionIndicator } from './BookReadingPositionIndicator.js';
import { FolderCover } from './FolderCover.js';

interface ShelfItemCoverProps {
  item: ShelfItem;
  disableNativeImageActions?: boolean;
  priority?: boolean;
  showReadingPosition?: boolean;
}


export function ShelfItemCover({
  disableNativeImageActions = false,
  item,
  priority = false,
  showReadingPosition = false,
}: ShelfItemCoverProps) {
  if (item.type === 'folder') {
    return (
      <FolderCover
        disableNativeImageActions={disableNativeImageActions}
        folder={item.folder}
      />
    );
  }

  return (
    <span className="book-cover">
      <BookCover
        book={item.book}
        disableNativeImageActions={disableNativeImageActions}
        priority={priority}
        sizes={SHELF_COVER_SIZES}
      />
      {showReadingPosition ? (
        <BookReadingPositionIndicator progress={item.book?.readingProgress} />
      ) : null}
    </span>
  );
}
