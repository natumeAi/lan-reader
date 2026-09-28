import type { StatisticsDimension } from '@lan-reader/shared';
import type { ReadingStatisticsState } from '../../hooks/useReadingStatistics.js';
import { useCallback, useId } from 'react';
import { StatisticsDimensionTabs } from './StatisticsDimensionTabs.js';
import { StatisticsPeriodNav } from './StatisticsPeriodNav.js';
import { StatisticsSections } from './StatisticsSections.js';

interface ReadingStatisticsProps {
  /** State and actions of the App-owned `useReadingStatistics`. */
  model: ReadingStatisticsState;
  onOpenRanking: (opener: HTMLElement) => void;
}

/**
 * 统计 page: range tabs, the period title with previous/next, then the data sections of the
 * selected range. Data belonging to another range is never shown under the current title:
 * without a matching response the page shows loading or a retryable error instead.
 */
export function ReadingStatistics({ model, onOpenRanking }: ReadingStatisticsProps) {
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = useCallback((dimension: StatisticsDimension) => `${baseId}-tab-${dimension}`, [baseId]);
  const {
    canGoNext,
    canGoPrevious,
    deliveryNotice,
    error,
    goNext,
    goPrevious,
    retry,
    selectDimension,
    selection,
    statistics,
    status,
    title,
  } = model;
  // A failed background refresh keeps the matching data and says so.
  const staleNotice = statistics && error;

  return (
    <section className="reading-statistics" aria-labelledby={`${baseId}-title`}>
      <header className="reading-statistics-header">
        <h1 id={`${baseId}-title`}>阅读统计</h1>
      </header>
      <StatisticsDimensionTabs panelId={panelId} selected={selection.dimension}
        onSelect={selectDimension} tabId={tabId} />
      <div className="reading-statistics-panel" id={panelId} role="tabpanel"
        aria-labelledby={tabId(selection.dimension)}>
        <StatisticsPeriodNav
          dimension={selection.dimension}
          title={title}
          canGoPrevious={canGoPrevious}
          canGoNext={canGoNext}
          onPrevious={goPrevious}
          onNext={goNext}
        />
        {staleNotice || deliveryNotice ? (
          <div className="reading-stats-notice" role="status">
            {staleNotice ? (
              <p>
                <span>统计未能刷新，显示的是上次加载的数据</span>
                <button type="button" onClick={retry}>重试</button>
              </p>
            ) : null}
            {deliveryNotice ? <p>{deliveryNotice}</p> : null}
          </div>
        ) : null}
        <div className="reading-statistics-cards" aria-busy={status === 'loading'}>
          {statistics ? <StatisticsSections statistics={statistics} onOpenRanking={onOpenRanking} /> : null}
          {status === 'loading' ? (
            <div className="home-card statistics-state" role="status">
              <p>正在加载阅读统计</p>
            </div>
          ) : null}
          {status === 'error' ? (
            <div className="home-card statistics-state" role="alert">
              <p>{error || '无法加载阅读统计'}</p>
              <button className="home-card-action" type="button" onClick={retry}>重试</button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
