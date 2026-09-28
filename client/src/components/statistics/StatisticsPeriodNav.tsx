import type { StatisticsDimension } from '@lan-reader/shared';
import { periodNavigationLabels } from '../../utils/statisticsFormat.js';

interface StatisticsPeriodNavProps {
  dimension: StatisticsDimension;
  title: string;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d={direction === 'left' ? 'm14.5 5.5-6.5 6.5 6.5 6.5' : 'm9.5 5.5 6.5 6.5-6.5 6.5'}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

/**
 * Period title between previous/next buttons. `all` has no adjacent period, so it shows
 * only its title. The title is announced politely when the period changes.
 */
export function StatisticsPeriodNav({
  dimension,
  title,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
}: StatisticsPeriodNavProps) {
  const labels = dimension === 'all' ? null : periodNavigationLabels(dimension);
  return (
    <div className="statistics-period">
      {labels ? (
        <button className="statistics-period-button" type="button" aria-label={labels.previous}
          disabled={!canGoPrevious} onClick={onPrevious}>
          <Chevron direction="left" />
        </button>
      ) : <span className="statistics-period-spacer" aria-hidden="true" />}
      <h2 className="statistics-period-title" aria-live="polite">{title}</h2>
      {labels ? (
        <button className="statistics-period-button" type="button" aria-label={labels.next}
          disabled={!canGoNext} onClick={onNext}>
          <Chevron direction="right" />
        </button>
      ) : <span className="statistics-period-spacer" aria-hidden="true" />}
    </div>
  );
}
