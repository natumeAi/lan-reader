import type { LibrarySort, LibraryView } from '../../utils/libraryView.js';
import { LIBRARY_VIEW } from '../../utils/libraryView.js';

interface LibraryViewToolbarProps {
  controlsDisabled: boolean;
  editable: boolean;
  modeLabel: string;
  onSortChange: (sort: LibrarySort) => void;
  onViewChange: (view: LibraryView) => void;
  resultCount: number;
  sort: LibrarySort;
  sortOptions: readonly { value: LibrarySort; label: string }[];
  view: LibraryView;
}


const viewOptions = [
  { value: LIBRARY_VIEW.ALL, label: '全部' },
  { value: LIBRARY_VIEW.RECENT_ADDED, label: '最近添加' },
  { value: LIBRARY_VIEW.FOLDERS, label: '文件夹' },
];

export function LibraryViewToolbar({
  controlsDisabled,
  editable,
  modeLabel,
  onSortChange,
  onViewChange,
  resultCount,
  sort,
  sortOptions,
  view,
}: LibraryViewToolbarProps) {
  return (
    <section className="library-view-toolbar" aria-labelledby="library-view-title">
      <div className="library-view-heading">
        <h2 id="library-view-title">我的书架</h2>
        <span className="library-result-count">{resultCount} 项</span>
      </div>
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
          <select
            aria-label="排序方式"
            disabled={controlsDisabled}
            value={sort}
            onChange={(event) => {
              const option = sortOptions.find((entry) => entry.value === event.target.value);
              if (option) onSortChange(option.value);
            }}
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {!editable ? (
        <p className="library-read-only-hint">
          <span className="library-read-only-icon" aria-hidden="true">🔒</span>
          <span>只读视图，不会改变手动书架顺序</span>
        </p>
      ) : null}
      <p className="library-mode-status" role="status" aria-live="polite">
        {modeLabel}
      </p>
    </section>
  );
}
