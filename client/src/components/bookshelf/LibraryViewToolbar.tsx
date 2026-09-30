import type { LibrarySort, LibraryView } from '../../utils/libraryView.js';
import { LIBRARY_SORT, LIBRARY_VIEW } from '../../utils/libraryView.js';
import { SortMenuButton } from './SortMenuButton.js';

interface LibraryViewToolbarProps {
  controlsDisabled: boolean;
  /** Selecting hides the read-only hint; the selection controls live in the shelf header. */
  selecting?: boolean;
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
  selecting = false,
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
      {!editable && !selecting ? (
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
