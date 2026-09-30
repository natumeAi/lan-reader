import { useItemMenuTrigger } from '../../hooks/useItemMenuTrigger.js';
import type { ItemMenuRequest } from '../../hooks/useShelfItemMenu.js';
import type { MouseEvent } from 'react';
import type { Book, Folder, ShelfItem } from '../../types/library.js';
import { memo } from 'react';
import { ShelfItemCover } from './ShelfItemCover.js';
import { ShelfItemLabel } from './ShelfItemLabel.js';
import { ShelfItemMoreButton } from './ShelfItemMoreButton.js';
import { formatShelfBookMeta } from '../../utils/shelfCardMeta.js';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';

export interface ShelfItemActions {
  onRequestItemMenu?: (request: ItemMenuRequest) => void;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onOpenFolder: (folder: Folder, originRect: DOMRect | null) => void;
}
interface ReadOnlyShelfItemProps extends ShelfItemActions {
  isLanding?: boolean;
  isPendingSave?: boolean;
  isSaveFailed?: boolean;
  selection?: { selected: boolean; disabled: boolean; onToggle: (key: string) => void };
  item: ShelfItem;
  priority?: boolean;
}


/** Read-only cards never subscribe to dnd-kit, so stable props keep them out of drag renders. */
export const ReadOnlyShelfItem = memo(function ReadOnlyShelfItem({ selection, item, isLanding = false, isPendingSave = false, isSaveFailed = false, onOpenBook, onOpenFolder, onRequestItemMenu, priority = false }: ReadOnlyShelfItemProps) {
  // Selecting owns every tap on the card, so it has no menu.
  const menuTrigger = useItemMenuTrigger(item.key, selection ? undefined : onRequestItemMenu, item);
  const name = item.type === 'folder'
    ? item.folder?.name || '文件夹'
    : item.book?.title || '未命名书籍';
  const contextLabel = item.type === 'book' && item.folderName
    ? `${name}，位于“${item.folderName}”`
    : name;
  const label = item.type === 'book'
    ? formatBookCardAriaLabel(contextLabel, item.book.readingProgress)
    : `文件夹 ${name}，${item.folder.bookCount} 本`;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (selection) {
      if (item.type === 'book' && !selection.disabled) selection.onToggle(item.key);
      return;
    }
    if (item.type === 'folder') {
      const rect = event.currentTarget.querySelector('.folder-cover')?.getBoundingClientRect();
      onOpenFolder(item.folder, rect || null);
      return;
    }

    const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
    onOpenBook(item.book, rect || null);
  };

  return (
    <div
      className={`book-shell shelf-item read-only-shelf-item${isLanding ? ' is-landing' : ''}${isPendingSave ? ' is-pending-save' : ''}${isSaveFailed ? ' is-save-failed' : ''}${selection ? ' selection-shelf-item' : ''}${selection?.selected ? ' is-selected' : ''}`}
      data-readonly="true"
      data-book-id={item.type === 'book' ? item.book?.id : undefined}
      data-folder-id={item.type === 'folder' ? item.folder?.id : undefined}
    >
      <button
        className="shelf-item-button"
        aria-busy={isPendingSave || undefined}
        aria-pressed={selection && item.type === 'book' ? selection.selected : undefined}
        disabled={selection ? selection.disabled || item.type === 'folder' : undefined}
        type="button"
        aria-label={label}
        onPointerDown={selection ? undefined : menuTrigger.onPointerDown}
        onContextMenu={selection ? event => event.preventDefault() : menuTrigger.onContextMenu}
        onKeyDown={selection ? undefined : menuTrigger.onKeyDown}
        onClick={handleClick}
      >
        <ShelfItemCover item={item} priority={priority} showReadingPosition disableNativeImageActions />
        {selection && item.type === 'book' ? <span className="shelf-selection-badge" aria-hidden="true">
          {selection.selected ? '✓' : ''}
        </span> : null}
        <ShelfItemLabel name={name} meta={item.type === 'folder'
          ? `${item.folder.bookCount} 本`
          : formatShelfBookMeta(item.book.readingProgress)} />
        <span className="shelf-item-context">
          {item.type === 'book' && item.folderName ? `位于“${item.folderName}”` : null}
        </span>
      </button>
      {menuTrigger.enabled ? <ShelfItemMoreButton name={name} onClick={menuTrigger.onMoreClick} /> : null}
    </div>
  );
});
