import type { CSSProperties } from 'react';
import type { ReadingStatisticsDto, StatisticsTrendUnit } from '@lan-reader/shared';
import { HomeCard } from '../home/HomeCard.js';
import {
  buildTrendAxis,
  formatAxisDuration,
  hourlyGapNotice,
  trendBucketLabels,
} from '../../utils/statisticsFormat.js';

const UNIT_NAMES: Record<StatisticsTrendUnit, string> = {
  hour: '每小时',
  day: '每天',
  month: '每月',
  year: '每年',
};

interface StatisticsTrendCardProps {
  statistics: ReadingStatisticsDto;
}

/**
 * 阅读时间趋势: one bar per decoded bucket (24 hours, 7 weekdays, every day of the month,
 * 12 months or every year). The value axis follows only the largest bucket. Labels may be
 * sparse, but every bucket is drawn and has its exact value in the accessible list.
 */
export function StatisticsTrendCard({ statistics }: StatisticsTrendCardProps) {
  const { range, trend, overview } = statistics;
  const buckets = trend.buckets;
  const bucketTotal = buckets.reduce((sum, bucket) => sum + bucket.durationMs, 0);
  const axis = buildTrendAxis(Math.max(0, ...buckets.map((bucket) => bucket.durationMs)));
  const labels = trendBucketLabels(range.dimension, buckets);
  const gapNotice = range.dimension === 'day' ? hourlyGapNotice(trend.unknownDurationMs, bucketTotal) : null;
  const isEmpty = overview.durationMs === 0;

  return (
    <HomeCard className="statistics-trend-card" title="阅读时间趋势">
      <div className="statistics-trend-chart"
        style={{ '--statistics-bucket-count': buckets.length } as CSSProperties}>
        <div className="statistics-trend-axis" aria-hidden="true">
          {axis.ticks.map((tick) => (
            <span key={tick} className="statistics-trend-tick"
              style={{ bottom: `${(tick / axis.maxMs) * 100}%` }}>
              {formatAxisDuration(tick)}
            </span>
          ))}
        </div>
        <div className="statistics-trend-plot">
          <div className="statistics-trend-grid" aria-hidden="true">
            {axis.ticks.map((tick) => (
              <span key={tick} className={tick === 0 ? 'statistics-trend-line is-base' : 'statistics-trend-line'}
                style={{ bottom: `${(tick / axis.maxMs) * 100}%` }} />
            ))}
          </div>
          <ol className="statistics-trend-bars" aria-label={`${UNIT_NAMES[trend.unit]}阅读时长`}>
            {buckets.map((bucket, index) => {
              const label = labels[index];
              const height = bucket.durationMs > 0 ? Math.min(100, (bucket.durationMs / axis.maxMs) * 100) : 0;
              return (
                <li key={bucket.key} className={bucket.durationMs > 0 ? 'statistics-trend-bucket' : 'statistics-trend-bucket is-zero'}
                  data-bucket={bucket.key}>
                  <span className="statistics-trend-slot" aria-hidden="true">
                    {height > 0 ? <span className="statistics-trend-bar" style={{ height: `${height}%` }} /> : null}
                  </span>
                  <span className="statistics-trend-label" aria-hidden="true">
                    {label?.visible ? label.text : ''}
                  </span>
                  <span className="visually-hidden">{label?.accessible}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      {gapNotice ? <p className="statistics-trend-note">{gapNotice}</p> : null}
      {isEmpty && !gapNotice ? <p className="statistics-trend-note">本期没有阅读记录</p> : null}
    </HomeCard>
  );
}
