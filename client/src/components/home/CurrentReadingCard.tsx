import type { ReactNode } from 'react';
import type { Book, RecentReadingItem } from '../../types/library.js';
import { useId } from 'react';
import { BookCover } from '../bookshelf/BookCover.js';
import {
  formatRecentReadingTime,
  normalizeRecentReadingTimestamp,
} from '../../utils/recentReadingTime.js';
import { HomeCard } from './HomeCard.js';

export interface CurrentReadingCardProps {
  error: string;
  hasLoaded: boolean;
  items: RecentReadingItem[];
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onOpenShelf: () => void;
  onRetry: () => void;
}

function progressPercentOf(item: RecentReadingItem) {
  const rawProgressValue = item.progress?.progress;
  const progressValue = Number(rawProgressValue);
  return rawProgressValue != null && Number.isFinite(progressValue)
    ? Math.max(0, Math.min(100, Math.round(progressValue * 100)))
    : null;
}

/** 正在读: the recent-reading list, in the server's order and limit, resuming saved positions. */
export function CurrentReadingCard({
  error,
  hasLoaded,
  items,
  onOpenBook,
  onOpenShelf,
  onRetry,
}: CurrentReadingCardProps) {
  const descriptionIdPrefix = useId();

  let content: ReactNode;
  if (items.length) {
    content = (
      <div className="current-reading-list">
        {items.map((item, index) => {
          const book = item.book;
          const title = book.title || '未命名书籍';
          const metaId = `${descriptionIdPrefix}-book-${book.id}-meta`;
          const normalizedUpdatedAt = normalizeRecentReadingTimestamp(item.progress?.updatedAt);
          const progressPercent = progressPercentOf(item);

          return (
            <button
              className="current-reading-book"
              key={book.id}
              type="button"
              data-book-id={book.id}
              onClick={(event) => {
                const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
                onOpenBook(book, rect || null);
              }}
              aria-describedby={metaId}
              aria-label={`继续阅读《${title}》`}
            >
              <span className="book-cover current-reading-cover">
                <BookCover book={book} priority={index < 3} />
              </span>
              <span className="current-reading-content">
                <span className="current-reading-title">{title}</span>
                <span className="current-reading-meta" id={metaId}>
                  {progressPercent !== null ? <span>{progressPercent}%</span> : null}
                  <time dateTime={normalizedUpdatedAt || undefined}>
                    {formatRecentReadingTime(normalizedUpdatedAt)}
                  </time>
                </span>
                {progressPercent !== null ? (
                  <span className="current-reading-track" aria-hidden="true">
                    <span style={{ width: `${progressPercent}%` }} />
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    );
  } else if (error) {
    // Unavailable data is not presented as an empty reading history.
    content = (
      <div className="home-card-state" role="alert">
        <p>暂时无法加载阅读记录</p>
        <button className="home-card-action" type="button" onClick={() => onRetry()}>
          重试
        </button>
      </div>
    );
  } else if (!hasLoaded) {
    content = (
      <div className="home-card-state" role="status" aria-live="polite">
        <p>正在加载阅读记录</p>
      </div>
    );
  } else {
    content = (
      <div className="home-card-state">
        <p>还没有阅读记录哦</p>
        <button className="home-card-action" type="button" onClick={() => onOpenShelf()}>
          去书架选一本书
        </button>
      </div>
    );
  }

  return (
    <HomeCard
      className="current-reading-card"
      onTitleAction={onOpenShelf}
      title="正在读"
      titleActionLabel="正在读，前往书架"
    >
      {content}
    </HomeCard>
  );
}
