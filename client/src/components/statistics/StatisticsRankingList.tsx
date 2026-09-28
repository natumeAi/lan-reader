import type { StatisticsRankingDto } from '@lan-reader/shared';
import { BookCover } from '../bookshelf/BookCover.js';
import { durationParts, joinValueParts, metricValueParts } from '../../utils/statisticsFormat.js';
import { formatSpokenDuration } from '../../utils/readingStatsFormat.js';

export function StatisticsRankingList({ ranking, limit }: { ranking: StatisticsRankingDto; limit: number }) {
  const leader = ranking.entries[0]?.durationMs ?? 0;
  if (!ranking.entries.length) return <p className="statistics-ranking-empty">本期暂无阅读时长排行</p>;
  return <ol className="statistics-ranking-list" aria-label="阅读时长排名">
    {ranking.entries.slice(0, limit).map(entry => {
      const ratio = leader > 0 ? entry.durationMs / leader * 100 : 0;
      const title = entry.book.title || '未命名书籍';
      return <li className="statistics-ranking-row" key={entry.book.id} data-ranking-book-id={entry.book.id}>
        <span className={`statistics-ranking-position${entry.rank === 1 ? ' is-first' : ''}`}>
          {entry.rank === 1 ? <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m3 5 5 5 4-7 4 7 5-5-3 13H6L3 5Zm3 17h12" /></svg> : null}
          <span aria-label={`第 ${entry.rank} 名`}>{entry.rank}</span>
        </span>
        <span className="book-cover statistics-ranking-cover"><BookCover book={entry.book} sizes="48px" /></span>
        <div className="statistics-ranking-info">
          <span className="statistics-ranking-title" title={title}>{title}</span>
          <span className="statistics-ranking-duration" aria-label={entry.durationMs < 1000 ? '不足 1 秒' : formatSpokenDuration(entry.durationMs)}>
            {entry.durationMs < 1000 ? '<1 秒' : joinValueParts(durationParts(entry.durationMs))}
          </span>
          <span className="statistics-ranking-author" title={entry.book.author || '未知作者'}>{entry.book.author || '未知作者'}</span>
          <span className="statistics-ranking-characters" aria-label={`${entry.characters} 字`}>{joinValueParts(metricValueParts('characters', entry.characters))}</span>
          <span className="statistics-ranking-bar" role="img" aria-label={`相对榜首 ${Number(ratio.toFixed(1))}%`}>
            <span style={{ width: `${ratio}%` }} />
          </span>
        </div>
      </li>;
    })}
  </ol>;
}
