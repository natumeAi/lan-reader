import { rectSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { LIBRARY_VIEW } from '../../utils/libraryView.js';
import { ReadOnlyShelfItem } from './ReadOnlyShelfItem.jsx';
import { SortableShelfItem } from './SortableShelfItem.jsx';

export function LibraryGrid({
  dragIntent,
  editable,
  hasLoadedShelf,
  isLoading,
  isSavingOrder,
  items,
  onClearSearch,
  onImport,
  onOpenBook,
  onOpenFolder,
  query,
  view,
}) {
  if (isLoading && !hasLoadedShelf) {
    return (
      <div className="shelf-grid" aria-label="书架加载中">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="book-shell" key={index}>
            <div className="book-cover skeleton-cover" />
            <div className="shelf-item-label skeleton-label" />
          </div>
        ))}
      </div>
    );
  }

  if (items.length) {
    return editable ? (
      <SortableContext items={items.map((item) => item.key)} strategy={rectSortingStrategy}>
        <div className="shelf-grid" aria-label="可编辑书架列表">
          {items.map((item, index) => (
            <SortableShelfItem
              disabled={isSavingOrder}
              dragIntent={dragIntent}
              item={item}
              key={item.key}
              onOpenBook={onOpenBook}
              onOpenFolder={onOpenFolder}
              priority={index < 8}
            />
          ))}
        </div>
      </SortableContext>
    ) : (
      <div className="shelf-grid read-only-grid" aria-label="只读书架列表">
        {items.map((item, index) => (
          <ReadOnlyShelfItem
            item={item}
            key={item.key}
            onOpenBook={onOpenBook}
            onOpenFolder={onOpenFolder}
            priority={index < 8}
          />
        ))}
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
}
