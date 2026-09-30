import { useLongPress } from '../../hooks/useLongPress.js';
import { useItemMenuTrigger } from '../../hooks/useItemMenuTrigger.js';
import type { ItemMenuRequest } from '../../hooks/useShelfItemMenu.js';
import type { MouseEvent } from 'react';
import type { Book, Folder, ShelfItem } from '../../types/library.js';
import { memo, useCallback } from 'react';
import { ShelfItemCover } from './ShelfItemCover.js';
import { ShelfItemLabel } from './ShelfItemLabel.js';
import { formatShelfBookMeta } from '../../utils/shelfCardMeta.js';
import { formatBookCardAriaLabel } from '../../utils/readingProgress.js';

export interface ShelfItemActions {
  onRequestItemMenu?: (request: ItemMenuRequest) => void;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onOpenFolder: (folder: Folder, originRect: DOMRect | null) => void;
}
interface ReadOnlyShelfItemProps extends ShelfItemActions {
  isPendingSave?: boolean;
  isSaveFailed?: boolean;
  item: ShelfItem;
  priority?: boolean;
}


/** Read-only cards never subscribe to dnd-kit, so stable props keep them out of drag renders. */
export const ReadOnlyShelfItem = memo(function ReadOnlyShelfItem({ item, isPendingSave = false, isSaveFailed = false, onOpenBook, onOpenFolder, onRequestItemMenu, priority = false }: ReadOnlyShelfItemProps) {
  const requestReadOnlyMenu = useCallback((request: ItemMenuRequest) => {
    onRequestItemMenu?.({ ...request, readOnly: true });
  }, [onRequestItemMenu]);
  const menuTrigger = useItemMenuTrigger(item.key, onRequestItemMenu ? requestReadOnlyMenu : undefined, item);
  const longPress = useLongPress(menuTrigger.open);
  const name = item.type === 'folder'
    ? item.folder?.name || '文件夹'
    : item.book?.title || '未命名书籍';
  const contextLabel = item.type === 'book' && item.folderName
    ? `${name}，位于“${item.folderName}”`
    : name;
  const label = item.type === 'book'
    ? formatBookCardAriaLabel(contextLabel, item.book.readingProgress, item.book.author)
    : `文件夹 ${name}，${item.folder.bookCount} 本`;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (item.type === 'folder') {
      const rect = event.currentTarget.querySelector('.folder-cover')?.getBoundingClientRect();
      onOpenFolder(item.folder, rect || null);
      return;
    }

    const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
    onOpenBook(item.book, rect || null);
  };

  return (
    <button
      className={`book-shell shelf-item read-only-shelf-item${isPendingSave ? ' is-pending-save' : ''}${isSaveFailed ? ' is-save-failed' : ''}`}
      aria-busy={isPendingSave || undefined}
      type="button"
      aria-label={label}
      data-readonly="true"
      data-book-id={item.type === 'book' ? item.book?.id : undefined}
      data-folder-id={item.type === 'folder' ? item.folder?.id : undefined}
      {...longPress}
      onPointerDown={event => { menuTrigger.onPointerDown(event); longPress.onPointerDown(event); }}
      onContextMenu={menuTrigger.onContextMenu}
      onKeyDown={menuTrigger.onKeyDown}
      onClick={handleClick}
    >
      <ShelfItemCover item={item} priority={priority} showReadingPosition />
      <ShelfItemLabel name={name} meta={item.type === 'folder'
        ? `${item.folder.bookCount} 本`
        : formatShelfBookMeta(item.book.author, item.book.readingProgress)} />
      <span className="shelf-item-context">
        {item.type === 'book' && item.folderName ? `位于“${item.folderName}”` : null}
      </span>
    </button>
  );
});
