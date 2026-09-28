import type { ReadingStatisticsDto } from '@lan-reader/shared';
import { StatisticsOverviewCard } from './StatisticsOverviewCard.js';
import { StatisticsTrendCard } from './StatisticsTrendCard.js';

interface StatisticsSectionsProps {
  /** The decoded response of exactly the selected range; every section reads only this. */
  statistics: ReadingStatisticsDto;
}

/**
 * Data sections of the 统计 page, in page order. Every section consumes the same snapshot,
 * so all of them always describe one range; none requests or decodes data itself.
 */
export function StatisticsSections({ statistics }: StatisticsSectionsProps) {
  return (
    <>
      <StatisticsOverviewCard statistics={statistics} />
      <StatisticsTrendCard statistics={statistics} />
      {/* Mount point: 阅读时长排行榜 preview (ranking subtask). Render it here from
          `statistics.ranking`; the detail view is owned by that subtask. */}
      {/* Mount point: 月度阅读日历 (calendar subtask). Render it here from
          `statistics.calendar`, which is non-null only for the month dimension. */}
    </>
  );
}
