import { BookCover } from './BookCover.jsx';
import { BookReadingPositionIndicator } from './BookReadingPositionIndicator.jsx';
import { FolderCover } from './FolderCover.jsx';

export function ShelfItemCover({
  disableNativeImageActions = false,
  item,
  priority = false,
  showReadingPosition = false,
}) {
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
      />
      {showReadingPosition ? (
        <BookReadingPositionIndicator progress={item.book?.readingProgress} />
      ) : null}
    </span>
  );
}
