import type { StatisticsRankingDto } from '@lan-reader/shared';
import { useRef } from 'react';
import { HomeCard } from '../home/HomeCard.js';
import { StatisticsRankingList } from './StatisticsRankingList.js';

export function StatisticsRankingCard({ ranking, onOpen }: {
  ranking: StatisticsRankingDto;
  onOpen: (opener: HTMLElement) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  return <div ref={container}><HomeCard title="阅读时长排行榜" className="statistics-ranking-card"
    onTitleAction={() => {
      const opener = container.current?.querySelector('button');
      if (opener) onOpen(opener);
    }}>
    <StatisticsRankingList ranking={ranking} limit={5} />
  </HomeCard></div>;
}
