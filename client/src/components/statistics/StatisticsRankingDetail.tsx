import type { StatisticsRankingDto } from '@lan-reader/shared';
import { STATISTICS_RANKING_LIMIT } from '@lan-reader/shared';
import { useId, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useModalDialog } from '../../hooks/useModalDialog.js';
import { usePageScrollLock } from '../../hooks/usePageScrollLock.js';
import { RANKING_MOTION_MS } from '../../hooks/useStatisticsRanking.js';
import { durationParts, joinValueParts, metricValueParts } from '../../utils/statisticsFormat.js';
import { formatSpokenDuration } from '../../utils/readingStatsFormat.js';
import { StatisticsRankingList } from './StatisticsRankingList.js';

export function StatisticsRankingDetail({ ranking, title, phase, onClose }: {
  ranking: StatisticsRankingDto;
  title: string;
  phase: 'preparing' | 'open' | 'closing';
  onClose: () => void;
}) {
  const titleId = useId();
  const back = useRef<HTMLButtonElement>(null);
  // The App owner restores the actual title button only after its inertness is removed.
  const { dialogRef, onKeyDown } = useModalDialog({ open: true, initialFocusRef: back, onRequestClose: onClose, restoreFocus: false });
  usePageScrollLock();
  return <div ref={dialogRef} className={`statistics-ranking-detail is-${phase}`} role="dialog" aria-modal="true"
    aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}
    style={{ '--ranking-motion-duration': `${RANKING_MOTION_MS}ms` } as CSSProperties}>
    <div className="statistics-ranking-detail-content">
      <header className="statistics-ranking-detail-header">
        <button ref={back} type="button" className="statistics-ranking-back" aria-label="返回阅读统计" onClick={onClose}>
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m14 5-7 7 7 7M7 12h14" /></svg>
        </button>
        <h1 id={titleId}>阅读时长排行榜</h1>
      </header>
      <p className="statistics-ranking-range">{title}</p>
      <section className="home-card statistics-ranking-summary" aria-label={`${title}全部书籍累计阅读`}>
        <span>累计阅读</span>
        <strong aria-label={formatSpokenDuration(ranking.totals.durationMs)}>{joinValueParts(durationParts(ranking.totals.durationMs))}</strong>
        <span>{ranking.totals.books} 本</span>
        <span aria-label={`${ranking.totals.characters} 字`}>{joinValueParts(metricValueParts('characters', ranking.totals.characters))}</span>
      </section>
      <StatisticsRankingList ranking={ranking} limit={STATISTICS_RANKING_LIMIT} />
    </div>
  </div>;
}
