import type { ReadingStatisticsDto } from '@lan-reader/shared';
import { StatisticsOverviewCard } from './StatisticsOverviewCard.js';
import { StatisticsTrendCard } from './StatisticsTrendCard.js';
import { StatisticsRankingCard } from './StatisticsRankingCard.js';
import { StatisticsCalendarCard } from './StatisticsCalendarCard.js';

interface StatisticsSectionsProps {
  /** The decoded response of exactly the selected range; every section reads only this. */
  statistics: ReadingStatisticsDto;
  onOpenRanking: (opener: HTMLElement) => void;
}

/**
 * Data sections of the 统计 page, in page order. Every section consumes the same snapshot,
 * so all of them always describe one range; none requests or decodes data itself.
 */
export function StatisticsSections({ statistics, onOpenRanking }: StatisticsSectionsProps) {
  return (
    <>
      <StatisticsOverviewCard statistics={statistics} />
      <StatisticsTrendCard statistics={statistics} />
      <StatisticsRankingCard ranking={statistics.ranking} onOpen={onOpenRanking} />
      <StatisticsCalendarCard statistics={statistics} />
    </>
  );
}
