import { useId } from 'react';
import { BookCover } from './BookCover.jsx';

const sqliteUtcTimestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function normalizeRecentReadingTimestamp(updatedAt) {
  const value = String(updatedAt ?? '');
  return sqliteUtcTimestampPattern.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
}

export function formatRecentReadingTime(updatedAt, now = Date.now()) {
  const normalizedUpdatedAt = normalizeRecentReadingTimestamp(updatedAt);
  const timestamp = Date.parse(normalizedUpdatedAt);
  if (!Number.isFinite(timestamp)) return '最近阅读';
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  if (elapsedMinutes < 60) return `${Math.max(1, elapsedMinutes)} 分钟前`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} 天前`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
}

export function ContinueReadingSection({ items, onOpenBook, searchMode }) {
  const descriptionIdPrefix = useId();

  if (searchMode || !items.length) {
    return null;
  }

  return (
    <section className="continue-reading" aria-labelledby="continue-reading-title">
      <div className="continue-reading-header">
        <h2 id="continue-reading-title">继续阅读</h2>
      </div>
      <div className="continue-reading-list">
        {items.map((item, index) => {
          const book = item.book;
          const metaId = `${descriptionIdPrefix}-book-${book.id}-meta`;
          const normalizedUpdatedAt = normalizeRecentReadingTimestamp(item.progress?.updatedAt);
          const rawProgressValue = item.progress?.progress;
          const progressValue = Number(rawProgressValue);
          const hasProgressValue = rawProgressValue != null && Number.isFinite(progressValue);
          const progressPercent = hasProgressValue
            ? Math.max(0, Math.min(100, Math.round(progressValue * 100)))
            : null;

          return (
            <button
              className="continue-book-button"
              key={book.id}
              type="button"
              data-book-id={book.id}
              onClick={(event) => {
                const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
                onOpenBook(book, rect || null);
              }}
              aria-describedby={metaId}
              aria-label={`继续阅读《${book.title || '未命名书籍'}》`}
            >
              <span className="book-cover continue-book-cover">
                <BookCover book={book} priority={index < 3} />
              </span>
              <span className="continue-card-content">
                <span className="continue-book-title">{book.title || '未命名书籍'}</span>
                <span className="continue-book-meta" id={metaId}>
                  {progressPercent !== null ? <span>{progressPercent}%</span> : null}
                  <time dateTime={normalizedUpdatedAt || undefined}>
                    {formatRecentReadingTime(normalizedUpdatedAt)}
                  </time>
                </span>
                {progressPercent !== null ? (
                  <span className="continue-progress-track" aria-hidden="true">
                    <span style={{ width: `${progressPercent}%` }} />
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
