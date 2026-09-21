import type { KeyboardEvent, MouseEvent } from 'react';
import type { ShelfItem } from '../../types/library.js';
import type { DragIntent } from '../../hooks/useLibraryDrag.js';
import type { ShelfItemActions } from './ReadOnlyShelfItem.js';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ShelfItemCover } from './ShelfItemCover.js';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';

interface SortableShelfItemProps extends ShelfItemActions {
  disabled?: boolean;
  dragIntent?: DragIntent;
  item: ShelfItem;
  priority?: boolean;
}


const shelfSortTransition = {
  duration: 460,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
};

export function SortableShelfItem({
  disabled,
  dragIntent,
  item,
  onOpenBook,
  onOpenFolder,
  priority = false,
}: SortableShelfItemProps) {
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: item.key,
    data: {
      item,
      type: item.type,
    },
    disabled,
    transition: shelfSortTransition,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const isIntentTarget = dragIntent?.targetKey === item.key;
  const className = [
    'book-shell',
    'shelf-item',
    item.type === 'folder' ? 'is-folder-item' : '',
    isDragging ? 'is-dragging' : '',
    isIntentTarget && dragIntent?.type === 'absorb' ? 'is-absorb-target' : '',
    isIntentTarget && dragIntent?.type === 'merge' ? 'is-merge-target' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const name =
    item.type === 'folder'
      ? item.folder?.name || '文件夹'
      : item.book?.title || '未命名书籍';
  const label = item.type === 'book'
    ? formatBookCardAriaLabel(name, item.book?.readingProgress)
    : name;
  const handleClick = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (item.type === 'folder') {
      const rect = event.currentTarget.querySelector('.folder-cover')?.getBoundingClientRect();
      onOpenFolder(item.folder, rect || null);
    } else if (item.type === 'book') {
      const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
      onOpenBook(item.book, rect || null);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleClick(event);
      return;
    }

    listeners?.onKeyDown?.(event);
  };

  return (
    <button
      ref={setNodeRef}
      className={className}
      style={style}
      type="button"
      aria-label={label}
      data-book-id={item.type === 'book' ? item.book?.id : undefined}
      data-folder-id={item.type === 'folder' ? item.folder?.id : undefined}
      onClick={handleClick}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
    >
      <ShelfItemCover
        disableNativeImageActions
        item={item}
        priority={priority}
        showReadingPosition
      />
      <span className="shelf-item-label">{name}</span>
    </button>
  );
}
