import type { ReactNode } from 'react';
import type { ReadingStatisticsDto, StatisticsMetricKey } from '@lan-reader/shared';
import { HomeCard } from '../home/HomeCard.js';
import { formatMetricChange, joinValueParts, metricValueParts, statisticsCoverageNotices } from '../../utils/statisticsFormat.js';

function LineIcon({ children }: { children: ReactNode }) {
  return (
    <svg className="statistics-metric-icon" viewBox="0 0 24 24" width="18" height="18"
      aria-hidden="true" focusable="false" fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">
      {children}
    </svg>
  );
}

const METRIC_ICONS: Record<StatisticsMetricKey, ReactNode> = {
  durationMs: (
    <LineIcon>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l2.6 1.8M4.5 5.2 7 3.2m12.5 2L17 3.2" />
    </LineIcon>
  ),
  readingDays: (
    <LineIcon>
      <rect x="3.8" y="5" width="16.4" height="15" rx="2.4" />
      <path d="M3.8 9.6h16.4M8 3v4m8-4v4" />
    </LineIcon>
  ),
  averageDailyMs: (
    <LineIcon>
      <circle cx="12" cy="13.2" r="7.2" />
      <path d="M12 13.2V9.6M10 2.8h4M12 2.8V6" />
    </LineIcon>
  ),
  longestDayMs: (
    <LineIcon>
      <path d="M7.5 4h9v5.2a4.5 4.5 0 0 1-9 0Z" />
      <path d="M7.5 6H4.4a3 3 0 0 0 3.3 4.4M16.5 6h3.1a3 3 0 0 1-3.3 4.4M12 13.7V17m-3.4 3h6.8M9.6 17h4.8" />
    </LineIcon>
  ),
  booksRead: (
    <LineIcon>
      <path d="M6 3.8h11.4a1 1 0 0 1 1 1v14.6H7a2 2 0 0 1-2-2V4.8a1 1 0 0 1 1-1Z" />
      <path d="M5 17.4a2 2 0 0 1 2-2h11.4" />
    </LineIcon>
  ),
  booksCompleted: (
    <LineIcon>
      <circle cx="12" cy="12" r="8.2" />
      <path d="m8.4 12.2 2.4 2.4 4.8-4.9" />
    </LineIcon>
  ),
  booksInProgress: (
    <LineIcon>
      <path d="M12 6.6C10.3 5.3 7.9 4.8 4 5v13c3.9-.2 6.3.3 8 1.6m0-13c1.7-1.3 4.1-1.8 8-1.6v13c-3.9-.2-6.3.3-8 1.6m0-13v13" />
    </LineIcon>
  ),
  characters: (
    <LineIcon>
      <path d="M4.5 6.5h15m-15 5.5h15m-15 5.5h9" />
    </LineIcon>
  ),
  charactersPerMinute: (
    <LineIcon>
      <path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" />
      <path d="m12 13.4 3.6-3.6M12 13.4h.01" />
    </LineIcon>
  ),
};

const METRIC_LABELS: Record<StatisticsMetricKey, string> = {
  durationMs: '阅读时间',
  readingDays: '阅读天数',
  averageDailyMs: '日均阅读时长',
  longestDayMs: '单日阅读最久',
  booksRead: '累计读过',
  booksCompleted: '读完书籍',
  booksInProgress: '在读书籍',
  characters: '阅读字数',
  charactersPerMinute: '阅读速度',
};

/** Reference pairs; 在读书籍 occupies a full row. There is intentionally no 记录笔记. */
const METRIC_ORDER: readonly StatisticsMetricKey[] = [
  'durationMs',
  'readingDays',
  'averageDailyMs',
  'longestDayMs',
  'booksRead',
  'booksCompleted',
  'booksInProgress',
  'characters',
  'charactersPerMinute',
];

interface StatisticsOverviewCardProps {
  statistics: ReadingStatisticsDto;
}

/**
 * Nine overview metrics of the selected range. Values and deltas come straight from the
 * period response; nothing is recomputed from the bookshelf or the elapsed part of a
 * period. `all` has no comparison, so it shows no change lines. Metrics are not links.
 */
export function StatisticsOverviewCard({ statistics }: StatisticsOverviewCardProps) {
  const { overview, comparison } = statistics;
  return (
    <HomeCard className="statistics-overview-card" title="阅读概览" titleHidden>
      <ul className="statistics-metrics">
        {METRIC_ORDER.map((key) => {
          const parts = metricValueParts(key, overview[key]);
          const change = comparison ? formatMetricChange(key, comparison.metrics[key]) : null;
          return (
            <li key={key} className={key === 'booksInProgress' ? 'statistics-metric is-wide' : 'statistics-metric'}
              data-metric={key}>
              <p className="statistics-metric-value" aria-hidden="true">
                {parts.map((part, index) => (
                  <span key={index}>
                    <span className="statistics-metric-number">{part.value}</span>
                    {part.unit ? <span className="statistics-metric-unit">{part.unit}</span> : null}
                  </span>
                ))}
              </p>
              <p className="statistics-metric-label">
                {METRIC_ICONS[key]}
                <span>{METRIC_LABELS[key]}</span>
                <span className="visually-hidden">：{joinValueParts(parts)}</span>
              </p>
              {change ? (
                <p className={`statistics-metric-change is-${change.symbol === '↑' ? 'up' : change.symbol === '↓' ? 'down' : 'flat'}`}>
                  <span aria-hidden="true">{change.symbol} {change.text}</span>
                  <span className="visually-hidden">{change.spoken}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="statistics-footnote">字数与速度按去重后的新读正文估算，重读的内容不重复计入。</p>
      {statisticsCoverageNotices(statistics).map(notice => (
        <p key={notice} className="statistics-footnote statistics-coverage-note">{notice}</p>
      ))}
    </HomeCard>
  );
}
