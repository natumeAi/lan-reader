import type { KeyboardEvent } from 'react';
import type { StatisticsDimension } from '@lan-reader/shared';
import { useRef } from 'react';
import { STATISTICS_DIMENSIONS } from '@lan-reader/shared';

const DIMENSION_LABELS: Record<StatisticsDimension, string> = {
  day: '日',
  week: '周',
  month: '月',
  year: '年',
  all: '总',
};

interface StatisticsDimensionTabsProps {
  /** Id of the region every tab controls (the period title and its data). */
  panelId: string;
  selected: StatisticsDimension;
  onSelect: (dimension: StatisticsDimension) => void;
  /** Builds the id of one tab so the panel can be labelled by the selected tab. */
  tabId: (dimension: StatisticsDimension) => string;
}

/**
 * 日 / 周 / 月 / 年 / 总 segmented control with tab semantics: one tab stop, arrow keys,
 * Home and End move and select (automatic activation), like the reference segment.
 */
export function StatisticsDimensionTabs({ panelId, selected, onSelect, tabId }: StatisticsDimensionTabsProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const focusAndSelect = (dimension: StatisticsDimension) => {
    onSelect(dimension);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-dimension="${dimension}"]`)
      ?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = STATISTICS_DIMENSIONS.indexOf(selected);
    const last = STATISTICS_DIMENSIONS.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    const dimension = next === null ? undefined : STATISTICS_DIMENSIONS[next];
    if (!dimension) return;
    event.preventDefault();
    focusAndSelect(dimension);
  };

  return (
    <div ref={listRef} className="statistics-dimensions" role="tablist" aria-label="统计范围"
      onKeyDown={handleKeyDown}>
      {STATISTICS_DIMENSIONS.map((dimension) => {
        const isSelected = dimension === selected;
        return (
          <button
            key={dimension}
            id={tabId(dimension)}
            className={isSelected ? 'statistics-dimension is-selected' : 'statistics-dimension'}
            data-dimension={dimension}
            type="button"
            role="tab"
            aria-selected={isSelected}
            aria-controls={panelId}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(dimension)}
          >
            {DIMENSION_LABELS[dimension]}
          </button>
        );
      })}
    </div>
  );
}
