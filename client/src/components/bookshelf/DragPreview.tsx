import type { DragPreviewItem } from '../../hooks/useLibraryDrag.js';
import { BookCover } from './BookCover.js';
import { ShelfItemCover } from './ShelfItemCover.js';

export function DragPreview({ item }: { item: DragPreviewItem | null }) {
  if (!item) {
    return null;
  }

  const label =
    item.type === 'folder'
      ? item.folder?.name || '文件夹'
      : item.book?.title || '未命名书籍';
  const isCoverOnly = item.type === 'folder-book';

  return (
    <div className={isCoverOnly ? 'drag-preview is-cover-only' : 'drag-preview'}>
      {isCoverOnly ? (
        <span className="book-cover">
          <BookCover book={item.book} />
        </span>
      ) : (
        <>
          <ShelfItemCover item={item} />
          <span className="shelf-item-label">{label}</span>
        </>
      )}
    </div>
  );
}
