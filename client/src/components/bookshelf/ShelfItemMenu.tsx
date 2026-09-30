import { useState } from 'react';
import type { Book, Folder, ShelfItem } from '../../types/library.js';
import type { ItemMenuTarget } from '../../hooks/useShelfItemMenu.js';
import type { ShelfOperations } from '../../hooks/useShelfOperations.js';
import { ActionSheet } from '../common/ActionSheet.js';
import { FolderPicker } from './FolderPicker.js';

export function ShelfItemMenu({ target, anchorRect, opener, shelfItems, readOnly = false, isSaving, operations, onClose, onOpenBook,
  onOpenFolder, onDelete }: {
  target: ItemMenuTarget; anchorRect: DOMRect | null; opener: HTMLElement | null; shelfItems: ShelfItem[];
  isSaving: boolean; operations: ShelfOperations; onClose: () => void;
  readOnly?: boolean;
  onOpenBook: (book: Book, rect: DOMRect | null) => void;
  onOpenFolder: (folder: Folder, rect: DOMRect | null, options?: { startRename?: boolean }) => void;
  onDelete: (book: Book) => void;
}) {
  const [picking, setPicking] = useState(false);
  const folders = shelfItems.flatMap(item => item.type === 'folder' ? [item.folder] : []);
  const book = target.type === 'book' ? target.item.book : target.type === 'folder-book' ? target.book : null;
  const title = picking ? '移到文件夹' : target.type === 'folder' ? target.folder.name || '文件夹' : book?.title || '未命名书籍';
  const moveReason = isSaving ? '正在保存' : !folders.length ? '还没有文件夹' : '';
  return <ActionSheet title={title} anchorRect={anchorRect} onClose={onClose} returnFocusElement={opener}>
    {readOnly ? <p className="action-sheet-note">当前视图不能拖动整理</p> : null}
    {picking ? <FolderPicker folders={folders} disabled={isSaving} onSelect={folder => {
      if (target.type !== 'book' || isSaving) return;
      onClose();
      void operations.moveShelfBookToFolder(target.item, folder);
    }} /> : <>
      <button type="button" onClick={() => {
        onClose();
        if (target.type === 'folder') onOpenFolder(target.folder, anchorRect);
        else if (book) onOpenBook(book, anchorRect);
      }}>打开</button>
      {target.type === 'folder' ? <button type="button" onClick={() => {
        onClose();
        onOpenFolder(target.folder, anchorRect, { startRename: true });
      }}>重命名</button> : <>
        {target.type === 'book' ? <button type="button" disabled={Boolean(moveReason)} onClick={() => setPicking(true)}>
          移到文件夹…{moveReason ? <span className="action-sheet-explanation">{moveReason}</span> : null}
        </button> : <button type="button" disabled={isSaving} onClick={() => {
          if (isSaving) return;
          onClose();
          void operations.moveFolderBookToShelf(target.book, target.folder);
        }}>移出到书架{isSaving ? <span className="action-sheet-explanation">正在保存</span> : null}</button>}
        <button type="button" className="is-danger" onClick={() => { if (book) { onClose(); onDelete(book); } }}>删除</button>
      </>}
    </>}
  </ActionSheet>;
}
