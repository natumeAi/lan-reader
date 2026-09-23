import type { ReadingStatsDto } from '@lan-reader/shared';
import { useId } from 'react';
import {
  buildReadingChart,
  formatCharacterCount,
  formatTotalDuration,
} from '../../utils/readingStatsFormat.js';
import { HomeCard } from './HomeCard.js';

export interface ReadingSummaryCardProps {
  error: string;
  onRetry: () => void;
  stats: ReadingStatsDto | null;
}

/** 近 7 日 bars plus the 累计时长 / 累计字数 / 读过 / 今年 summary. */
export function ReadingSummaryCard({ error, onRetry, stats }: ReadingSummaryCardProps) {
  const chartLabelId = useId();

  if (!stats) {
    return (
      <HomeCard className="reading-summary-card" title="阅读统计" titleHidden>
        {error ? (
          <div className="home-card-state" role="alert">
            <p>暂时无法加载阅读统计</p>
            <button className="home-card-action" type="button" onClick={onRetry}>重试</button>
          </div>
        ) : (
          <div className="home-card-state" role="status">
            <p>正在加载阅读统计</p>
          </div>
        )}
      </HomeCard>
    );
  }

  const bars = buildReadingChart(stats.days, stats.date, stats.goals.dailyMinutes);
  const summary = [
    { label: '累计时长', value: formatTotalDuration(stats.lifetime.durationMs) },
    { label: '累计字数', value: formatCharacterCount(stats.lifetime.characters) },
    { label: '读过', value: `${stats.lifetime.completedBooks} 本` },
    { label: '今年', value: `${stats.year.completedCount}/${stats.goals.annualBooks}` },
  ];

  return (
    <HomeCard className="reading-summary-card" title="阅读统计" titleHidden>
      <div className="reading-week">
        <span className="reading-week-label" id={chartLabelId}>近 7 日</span>
        <ol className="reading-week-bars" aria-labelledby={chartLabelId}>
          {bars.map((bar) => (
            <li
              key={bar.date}
              className={[
                'reading-week-day',
                bar.isToday ? 'is-today' : '',
                bar.heightFraction > 0 ? '' : 'is-zero',
              ].filter(Boolean).join(' ')}
              aria-current={bar.isToday ? 'date' : undefined}
            >
              <span className="reading-week-plot" aria-hidden="true">
                <span
                  className="reading-week-bar"
                  style={bar.heightFraction > 0 ? { height: `${Math.max(8, bar.heightFraction * 100)}%` } : undefined}
                />
              </span>
              <span className="reading-week-day-label" aria-hidden="true">{bar.shortLabel}</span>
              <span className="visually-hidden">{bar.accessibleLabel}</span>
            </li>
          ))}
        </ol>
      </div>
      <dl className="reading-summary-grid">
        {summary.map((item) => (
          <div className="reading-summary-item" key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
    </HomeCard>
  );
}
