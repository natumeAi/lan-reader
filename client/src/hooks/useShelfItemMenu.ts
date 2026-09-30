import { useCallback, useRef, useState } from 'react';
import type { Folder, FolderBook, ShelfItem } from '../types/library.js';

export interface ItemMenuRequest { key: string; anchorRect: DOMRect | null; item?: ShelfItem; readOnly?: boolean }
export type ItemMenuTarget =
  | { type: 'book'; item: Extract<ShelfItem, { type: 'book' }> }
  | { type: 'folder'; folder: Folder }
  | { type: 'folder-book'; book: FolderBook; folder: Folder };

export function useShelfItemMenu({ shelfItems, folderBooks, openFolder }: {
  shelfItems: ShelfItem[]; folderBooks: FolderBook[]; openFolder: Folder | null;
}) {
  const [menu, setMenu] = useState<{ target: ItemMenuTarget; anchorRect: DOMRect | null; opener: HTMLElement | null; readOnly: boolean } | null>(null);
  // Read at request time, so `request` keeps one identity across the memoized shelf cards.
  const latestRef = useRef({ shelfItems, folderBooks, openFolder });
  latestRef.current = { shelfItems, folderBooks, openFolder };
  const close = useCallback(() => setMenu(null), []);
  const request = useCallback(({ key, anchorRect, item: requestedItem, readOnly = false }: ItemMenuRequest) => {
    const latest = latestRef.current;
    const item = latest.shelfItems.find(candidate => candidate.key === key) ?? requestedItem;
    let target: ItemMenuTarget | null = null;
    if (item?.type === 'folder') target = { type: 'folder', folder: item.folder };
    else if (item?.type === 'book') {
      if (item.book.folderId != null) {
        const parent = latest.shelfItems.find(candidate => candidate.type === 'folder' && candidate.id === item.book.folderId);
        if (parent?.type === 'folder') target = { type: 'folder-book', book: { ...item.book, key: `folder-book:${item.id}` }, folder: parent.folder };
      } else target = { type: 'book', item };
    } else {
      const book = latest.folderBooks.find(candidate => candidate.key === key);
      if (book && latest.openFolder) target = { type: 'folder-book', book, folder: latest.openFolder };
    }
    if (target) setMenu({ target, anchorRect, readOnly, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
  }, []);
  return { menu, close, request };
}
