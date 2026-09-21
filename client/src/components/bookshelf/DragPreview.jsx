import { BookCover } from './BookCover.jsx';
import { ShelfItemCover } from './ShelfItemCover.jsx';

export function DragPreview({ item }) {
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
