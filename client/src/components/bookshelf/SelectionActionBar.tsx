import type { Book } from '../../types/library.js';
import type { MouseEvent } from 'react';

export function SelectionActionBar({ books, hasFolders, disabled, onMoveToFolder, onMoveToShelf, onDelete }: {
  books: Book[];
  hasFolders: boolean;
  disabled: boolean;
  onMoveToFolder: (event: MouseEvent<HTMLButtonElement>) => void;
  onMoveToShelf: () => void;
  onDelete: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const empty = !books.length;
  return <div className="selection-action-bar" role="group" aria-label="批量操作">
    <button type="button" disabled={disabled || empty || !hasFolders} onClick={onMoveToFolder}
      title={!hasFolders ? '还没有文件夹' : undefined}>移到文件夹…</button>
    <button type="button" disabled={disabled || !books.some(book => book.folderId != null)}
      onClick={onMoveToShelf}>移到书架</button>
    <button type="button" className="is-danger" disabled={disabled || empty} onClick={onDelete}>删除</button>
  </div>;
}
