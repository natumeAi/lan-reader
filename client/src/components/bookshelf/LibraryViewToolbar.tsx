import type { LibrarySort, LibraryView } from '../../utils/libraryView.js';
import { LIBRARY_SORT, LIBRARY_VIEW } from '../../utils/libraryView.js';
import type { ShelfSelection } from '../../hooks/useShelfSelection.js';
import { SortMenuButton } from './SortMenuButton.js';

interface LibraryViewToolbarProps {
  controlsDisabled: boolean;
  selection?: ShelfSelection;
  selectionDisabled?: boolean;
  visibleBookCount?: number;
  editable: boolean;
  modeLabel: string;
  onSortChange: (sort: LibrarySort) => void;
  onViewChange: (view: LibraryView) => void;
  onSortMenuOpenChange?: (open: boolean) => void;
  searchMode: boolean;
  sort: LibrarySort;
  sortOptions: readonly { value: LibrarySort; label: string }[];
  view: LibraryView;
}


const viewOptions = [
  { value: LIBRARY_VIEW.ALL, label: '书架' },
  { value: LIBRARY_VIEW.RECENT_ADDED, label: '全部书籍' },
  { value: LIBRARY_VIEW.FOLDERS, label: '文件夹' },
];

export function LibraryViewToolbar({
  controlsDisabled,
  selection,
  selectionDisabled = false,
  visibleBookCount = 0,
  editable,
  modeLabel,
  onSortChange,
  onViewChange,
  onSortMenuOpenChange,
  searchMode,
  sort,
  sortOptions,
  view,
}: LibraryViewToolbarProps) {
  const sortLabel = sortOptions.find(option => option.value === sort)?.label ?? '';
  return (
    <section className="library-view-toolbar" aria-label="书架视图">
      {selection ? <div className="library-selection-controls" tabIndex={-1}>
        {selection.active ? <>
          <span role="status" aria-live="polite" aria-atomic="true">已选 {selection.keys.size} 本</span>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={selection.selectAll} disabled={selectionDisabled || !visibleBookCount}>全选</button>
          <span aria-hidden="true">·</span>
          <button type="button" onClick={selection.exit} disabled={selectionDisabled}>完成</button>
        </> : <button type="button" onClick={selection.enter} disabled={selectionDisabled}>选择</button>}
      </div> : null}
      <div className="library-view-controls">
        <div className="library-view-options">
          {viewOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={view === option.value}
              disabled={controlsDisabled && option.value !== LIBRARY_VIEW.ALL}
              onClick={() => onViewChange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {sortOptions.length ? (
          <SortMenuButton disabled={controlsDisabled} sort={sort} options={sortOptions}
            onChange={onSortChange} onOpenChange={onSortMenuOpenChange} />
        ) : null}
      </div>
      {!editable && !selection?.active ? (
        searchMode ? <p className="library-read-only-hint">搜索结果不能拖动整理</p>
          : view === LIBRARY_VIEW.ALL ? (
            <button type="button" className="library-read-only-hint" disabled={controlsDisabled}
              onClick={() => onSortChange(LIBRARY_SORT.MANUAL)}>
              按「{sortLabel}」排序 · <span>恢复手动顺序</span>
            </button>
          ) : (
            <button type="button" className="library-read-only-hint" onClick={() => onViewChange(LIBRARY_VIEW.ALL)}>
              此视图不能拖动整理 · <span>回到书架</span>
            </button>
          )
      ) : null}
      <p className="library-mode-status" role="status" aria-live="polite">
        {modeLabel}
      </p>
    </section>
  );
}
