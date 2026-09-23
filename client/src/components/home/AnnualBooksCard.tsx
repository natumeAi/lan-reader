import type { ReadingStatsDto } from '@lan-reader/shared';
import type { Book } from '../../types/library.js';
import { BookCover } from '../bookshelf/BookCover.js';
import { HomeCard } from './HomeCard.js';

export interface AnnualBooksCardProps {
  error: string;
  onEditGoal: () => void;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onRetry: () => void;
  stats: ReadingStatsDto | null;
}

/** 今年读完的书: this year's completions (same membership as the 今年 count) and the annual goal. */
export function AnnualBooksCard({ error, onEditGoal, onOpenBook, onRetry, stats }: AnnualBooksCardProps) {
  const titleSuffix = stats ? (
    <span className="annual-books-count">
      {/* The goal button's name announces both numbers, so the visible pair is not read twice. */}
      <span aria-hidden="true">{stats.year.completedCount}</span>
      <span aria-hidden="true"> / </span>
      <button
        className="annual-books-goal"
        type="button"
        aria-label={`今年已读完 ${stats.year.completedCount} 本，目标 ${stats.goals.annualBooks} 本，修改年度目标`}
        onClick={onEditGoal}
      >
        {stats.goals.annualBooks}
      </button>
    </span>
  ) : null;

  let content;
  if (!stats) {
    content = error ? (
      <div className="home-card-state" role="alert">
        <p>暂时无法加载今年读完的书</p>
        <button className="home-card-action" type="button" onClick={onRetry}>重试</button>
      </div>
    ) : (
      <div className="home-card-state" role="status">
        <p>正在加载</p>
      </div>
    );
  } else if (!stats.year.books.length) {
    content = (
      <div className="home-card-state">
        <p>今年还没有读完的书，加油！</p>
      </div>
    );
  } else {
    content = (
      <ul className="annual-books-list">
        {stats.year.books.map(({ book, localDate }, index) => {
          const title = book.title || '未命名书籍';
          const [, month, day] = localDate.split('-').map(Number);
          return (
            <li key={book.id}>
              <button
                className="annual-book"
                type="button"
                data-book-id={book.id}
                aria-label={`打开《${title}》，${month}月${day}日读完`}
                onClick={(event) => {
                  const rect = event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect();
                  onOpenBook(book, rect || null);
                }}
              >
                <span className="book-cover annual-book-cover">
                  <BookCover book={book} priority={index < 4} sizes="84px" />
                </span>
                <span className="annual-book-title" aria-hidden="true">{title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <HomeCard className="annual-books-card" title="今年读完的书" titleSuffix={titleSuffix}>
      {content}
    </HomeCard>
  );
}
