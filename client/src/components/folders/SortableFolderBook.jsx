import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BookCover } from '../bookshelf/BookCover.jsx';
import { BookReadingPositionIndicator } from '../bookshelf/BookReadingPositionIndicator.jsx';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';

const shelfSortTransition = {
  duration: 460,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
};

export function SortableFolderBook({ book, disabled, onOpenBook, priority = false }) {
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
    transition: shelfSortTransition,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const className = ['folder-book-shell', isDragging ? 'is-dragging' : '']
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
