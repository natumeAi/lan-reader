import type { KeyboardEvent, MouseEvent } from 'react';
import type { ShelfItem } from '../../types/library.js';
import type { DragIntent } from '../../hooks/useLibraryDrag.js';
import type { ShelfItemActions } from './ReadOnlyShelfItem.js';
import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ShelfItemCover } from './ShelfItemCover.js';
import { SHELF_SORT_TRANSITION } from '../../utils/dragMotion.js';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';

interface SortableShelfItemProps extends ShelfItemActions {
  disabled?: boolean;
  dragIntent?: DragIntent;
  /** The card has just replaced a temporary Folder item and is settling into place. */
  isLanding?: boolean;
  isPendingSave?: boolean;
  isSaveFailed?: boolean;
  item: ShelfItem;
  priority?: boolean;
}
interface ShelfItemContentProps {
  item: ShelfItem;
  name: string;
  priority: boolean;
}

/**
 * Cover and label of a sortable card. The shell subscribes to dnd-kit and re-renders on
 * every drag update; this content depends only on the item itself, so it is memoized and
 * a drag no longer re-renders every cover on the shelf.
 */
const ShelfItemContent = memo(function ShelfItemContent({ item, name, priority }: ShelfItemContentProps) {
  return (
    <>
      <ShelfItemCover
        disableNativeImageActions
        item={item}
        priority={priority}
        showReadingPosition
      />
      <span className="shelf-item-label">{name}</span>
    </>
  );
});

export function SortableShelfItem({
  disabled,
  dragIntent,
  isLanding = false,
  isPendingSave = false,
  isSaveFailed = false,
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
    transition: SHELF_SORT_TRANSITION,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  const isIntentTarget = dragIntent?.targetKey === item.key;
  // Sorting inserts before its target, so it reads as an opening gap rather than as the
  // merge ring, which means "this card will be consumed".
  const isSortTarget = dragIntent?.type === 'sort' && dragIntent.sortTargetKey === item.key;
  const className = [
    'book-shell',
    'shelf-item',
    item.type === 'folder' ? 'is-folder-item' : '',
    isDragging ? 'is-dragging' : '',
    isIntentTarget && dragIntent?.type === 'absorb' ? 'is-absorb-target' : '',
    isIntentTarget && dragIntent?.type === 'merge' ? 'is-merge-target' : '',
    isSortTarget ? 'is-sort-target' : '',
    isPendingSave ? 'is-pending-save' : '',
    isSaveFailed ? 'is-save-failed' : '',
    isLanding ? 'is-landing' : '',
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
      aria-busy={isPendingSave || undefined}
      aria-label={label}
      data-book-id={item.type === 'book' ? item.book?.id : undefined}
      data-folder-id={item.type === 'folder' ? item.folder?.id : undefined}
      onClick={handleClick}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
    >
      <ShelfItemContent item={item} name={name} priority={priority} />
    </button>
  );
}
