import type { Book, FolderBook } from '../../types/library.js';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BookCover } from '../bookshelf/BookCover.js';
import { BookReadingPositionIndicator } from '../bookshelf/BookReadingPositionIndicator.js';
import { SHELF_SORT_TRANSITION } from '../../utils/dragMotion.js';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';

interface SortableFolderBookProps {
  book: FolderBook;
  disabled?: boolean;
  isPendingSave?: boolean;
  isSaveFailed?: boolean;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  priority?: boolean;
}

export function SortableFolderBook({
  book,
  disabled,
  isPendingSave = false,
  isSaveFailed = false,
  onOpenBook,
  priority = false,
}: SortableFolderBookProps) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: book.key,
    data: {
      book,
      type: 'folder-book',
    },
    disabled,
    transition: SHELF_SORT_TRANSITION,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const className = [
    'folder-book-shell',
    isDragging ? 'is-dragging' : '',
    isPendingSave ? 'is-pending-save' : '',
    isSaveFailed ? 'is-save-failed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const label = book.title || '未命名书籍';
  const ariaLabel = formatBookCardAriaLabel(label, book.readingProgress);

  return (
    <div
      ref={setNodeRef}
      className={className}
      style={style}
    >
      <button
        ref={setActivatorNodeRef}
        className="folder-book-cover-button"
        disabled={disabled}
        type="button"
        aria-busy={isPendingSave || undefined}
        aria-label={ariaLabel}
        onClick={(event) => {
          const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
          onOpenBook(book, rect || null);
        }}
        {...attributes}
        {...listeners}
      >
        <span className="book-cover">
          <BookCover book={book} disableNativeImageActions priority={priority} />
          <BookReadingPositionIndicator progress={book.readingProgress} />
        </span>
        <span className="shelf-item-label">{label}</span>
      </button>
    </div>
  );
}
