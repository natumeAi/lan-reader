import type { ReadingStatisticsDto } from '@lan-reader/shared';
import { BookCover } from '../bookshelf/BookCover.js';
import { HomeCard } from '../home/HomeCard.js';
import { buildCalendarWeeks, durationParts, formatStatisticsTitle } from '../../utils/statisticsFormat.js';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;
const COMPACT_UNITS: Record<string, string> = { 秒: 's', 分钟: 'm', 分: 'm', 小时: 'h' };

/** A presentation of the shared monthly snapshot; champions already include all Books. */
export function StatisticsCalendarCard({ statistics }: { statistics: ReadingStatisticsDto }) {
  const { range, calendar } = statistics;
  if (range.dimension !== 'month' || !calendar) return null;
  const title = `日历 ${formatStatisticsTitle('month', range)}`;
  const weeks = buildCalendarWeeks(calendar.days);

  return (
    <HomeCard title={title} className="statistics-calendar-card">
      <table className="statistics-calendar" aria-label={title}>
        <thead>
          <tr>{WEEKDAYS.map(day => <th scope="col" key={day} aria-label={`星期${day}`}>{day}</th>)}</tr>
        </thead>
        <tbody>
          {weeks.map((week, index) => (
            <tr key={index}>
              {week.map((cell, column) => {
                if (!cell) return <td key={`blank-${column}`} aria-hidden="true" />;
                const { day, dayNumber, accessible } = cell;
                const champion = day.champion;
                return (
                  <td key={day.date} data-calendar-date={day.date}>
                    <span className="visually-hidden">{accessible}</span>
                    <div className={`statistics-calendar-day${champion ? ' has-reading' : ''}`} aria-hidden="true">
                      {champion ? (
                        <span className="book-cover statistics-calendar-cover" data-calendar-book-id={champion.book.id}>
                          <BookCover key={champion.book.id} book={champion.book}
                            sizes="(max-width: 374px) 36px, (max-width: 719px) 48px, 80px" />
                        </span>
                      ) : null}
                      <time className="statistics-calendar-date" dateTime={day.date}>{dayNumber}</time>
                      {champion ? (
                        <span className="statistics-calendar-duration">
                          {champion.durationMs < 1000 ? '<1s' : durationParts(champion.durationMs).map(part => (
                            <span key={part.unit}>{part.value}{COMPACT_UNITS[part.unit] ?? part.unit}</span>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </HomeCard>
  );
}
