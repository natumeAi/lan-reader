import type { DragPreviewItem } from '../../hooks/useLibraryDrag.js';
import { BookCover, SHELF_COVER_SIZES } from './BookCover.js';
import { ShelfItemCover } from './ShelfItemCover.js';
import { ShelfItemLabel } from './ShelfItemLabel.js';
import { BookReadingPositionIndicator } from './BookReadingPositionIndicator.js';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';
import { formatShelfBookMeta } from '../../utils/shelfCardMeta.js';

export function DragPreview({ item }: { item: DragPreviewItem | null }) {
  if (!item) {
    return null;
  }

  const label =
    item.type === 'folder'
      ? item.folder?.name || '文件夹'
      : item.book?.title || '未命名书籍';
  const isFolderBook = item.type === 'folder-book';
  const meta = item.type === 'folder' ? `${item.folder.bookCount} 本`
    : formatShelfBookMeta(item.book.author, item.book.readingProgress);
  const ariaLabel = item.type === 'folder' ? `文件夹 ${label}，${item.folder.bookCount} 本`
    : formatBookCardAriaLabel(label, item.book.readingProgress, item.book.author);

  return (
    <div className={isFolderBook ? 'drag-preview is-cover-only' : 'drag-preview'} role="img" aria-label={ariaLabel}>
      {isFolderBook ? (
        <span className="book-cover">
          <BookCover book={item.book} sizes={SHELF_COVER_SIZES} />
          <BookReadingPositionIndicator progress={item.book.readingProgress} />
        </span>
      ) : (
        <ShelfItemCover item={item} showReadingPosition />
      )}
      <ShelfItemLabel name={label} meta={meta} />
    </div>
  );
}
