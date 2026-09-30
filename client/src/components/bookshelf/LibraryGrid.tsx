import type { ShelfItem } from '../../types/library.js';
import type { LibraryView } from '../../utils/libraryView.js';
import type { DragIntent, ShelfMutationFeedback } from '../../hooks/useLibraryDrag.js';
import type { ShelfItemActions } from './ReadOnlyShelfItem.js';
import type { ShelfSelection } from '../../hooks/useShelfSelection.js';
import type { UploadEntry } from '../../hooks/useUploadBooks.js';
import type { UploadPlaceholderActions } from './UploadPlaceholderCard.js';
import { UploadPlaceholderCard } from './UploadPlaceholderCard.js';
import { memo } from 'react';
import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { LIBRARY_VIEW } from '../../utils/libraryView.js';
import { ReadOnlyShelfItem } from './ReadOnlyShelfItem.js';
import { SortableShelfItem } from './SortableShelfItem.js';

interface LibraryGridProps extends ShelfItemActions, UploadPlaceholderActions {
  uploadEntries?: readonly UploadEntry[];
  landingKeys?: readonly string[];
  dragIntent: DragIntent;
  editable: boolean;
  selection?: ShelfSelection;
  /** Key of the card that just arrived from a Folder, while it settles into place. */
  landingKey: string | null;
  mutationFeedback: ShelfMutationFeedback;
  hasLoadedShelf: boolean;
  isLoading: boolean;
  isSavingOrder: boolean;
  items: ShelfItem[];
  onClearSearch: () => void;
  onImport: () => void;
  query: string;
  searchMode?: boolean;
  view: LibraryView;
}


/** Memoized so pointer-only drag activity never re-renders the whole grid. */
export const LibraryGrid = memo(function LibraryGrid({
  dragIntent,
  editable,
  selection,
  uploadEntries = [],
  onRetryUpload,
  onRemoveUpload,
  landingKeys,
  hasLoadedShelf,
  isLoading,
  isSavingOrder,
  items,
  landingKey,
  mutationFeedback,
  onClearSearch,
  onImport,
  onOpenBook,
  onOpenFolder,
  onRequestItemMenu,
  query,
  searchMode = false,
  view,
}: LibraryGridProps) {
  const placeholders = view === LIBRARY_VIEW.ALL && !query && !searchMode && !selection?.active
    ? uploadEntries.map(entry => <UploadPlaceholderCard key={entry.id} entry={entry}
      onRetryUpload={onRetryUpload} onRemoveUpload={onRemoveUpload} />) : [];

  if (isLoading && !hasLoadedShelf) {
    return (
      <div className="shelf-grid" aria-label="书架加载中">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="book-shell" key={index}>
            <div className="book-cover skeleton-cover" />
            <div className="shelf-item-label skeleton-label" />
          </div>
        ))}
        {placeholders}
      </div>
    );
  }

  const feedbackKeys = mutationFeedback.status === 'idle' ? null : mutationFeedback.keys;
  const isPendingSave = (key: string) =>
    mutationFeedback.status === 'pending' && Boolean(feedbackKeys?.includes(key));
  const isSaveFailed = (key: string) =>
    mutationFeedback.status === 'failed' && Boolean(feedbackKeys?.includes(key));

  if (items.length || placeholders.length) {
    return editable && !selection?.active ? (
      <div className="shelf-grid" aria-label="可编辑书架列表">
        <SortableContext items={items.map((item) => item.key)} strategy={rectSortingStrategy}>
          {items.map((item, index) => (
            <SortableShelfItem
              disabled={isSavingOrder}
              dragIntent={dragIntent}
              isLanding={landingKeys?.includes(item.key) || landingKey === item.key}
              isPendingSave={isPendingSave(item.key)}
              isSaveFailed={isSaveFailed(item.key)}
              item={item}
              key={item.key}
              onOpenBook={onOpenBook}
              onOpenFolder={onOpenFolder}
              onRequestItemMenu={onRequestItemMenu}
              priority={index < 8}
            />
          ))}
        </SortableContext>
        {placeholders}
      </div>
    ) : (
      <div className="shelf-grid read-only-grid" aria-label="只读书架列表">
        {items.map((item, index) => (
          <ReadOnlyShelfItem
            isLanding={!selection?.active && (landingKeys?.includes(item.key) || landingKey === item.key)}
            isPendingSave={isPendingSave(item.key) || item.type === 'book' && isPendingSave(`folder-book:${item.id}`)}
            isSaveFailed={isSaveFailed(item.key) || item.type === 'book' && isSaveFailed(`folder-book:${item.id}`)}
            selection={selection?.active ? {
              selected: selection.keys.has(item.key), disabled: isSavingOrder, onToggle: selection.toggle,
            } : undefined}
            item={item}
            key={item.key}
            onOpenBook={onOpenBook}
            onOpenFolder={onOpenFolder}
            onRequestItemMenu={onRequestItemMenu}
            priority={index < 8}
          />
        ))}
        {placeholders}
      </div>
    );
  }

  if (query) {
    return (
      <div className="empty-state" role="status">
        <div className="empty-cover" aria-hidden="true" />
        <p>没有找到“{query}”</p>
        <p>尝试书名、作者或文件夹名称</p>
        <button type="button" onClick={onClearSearch} aria-label="清空搜索结果">
          清空搜索
        </button>
      </div>
    );
  }

  if (view === LIBRARY_VIEW.FOLDERS) {
    return (
      <div className="empty-state" role="status">
        <div className="empty-cover" aria-hidden="true" />
        <p>还没有文件夹</p>
        <p>可通过拖动两本根层书籍创建文件夹</p>
      </div>
    );
  }

  return (
    <div className="empty-state" role="status">
      <div className="empty-cover" aria-hidden="true" />
      <p>书架是空的</p>
      <button type="button" onClick={onImport}>导入 EPUB</button>
    </div>
  );
});
