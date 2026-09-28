import type { ReactNode } from 'react';
import type { ReadingStatsDto } from '@lan-reader/shared';
import type { Book, RecentReadingItem } from '../../types/library.js';
import { BookCover } from '../bookshelf/BookCover.js';
import { findVisibleBookCoverRect } from '../../utils/coverOrigin.js';
import { formatTotalDuration } from '../../utils/readingStatsFormat.js';
import { HomeCard } from './HomeCard.js';

export interface CurrentReadingCardProps {
  error: string;
  hasLoaded: boolean;
  items: RecentReadingItem[];
  currentBook: ReadingStatsDto['currentBook'];
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onOpenRecent: () => void;
  onOpenShelf: () => void;
  onRetry: () => void;
}

export function CurrentReadingCard({ error, hasLoaded, items, currentBook, onOpenBook,
  onOpenRecent, onOpenShelf, onRetry }: CurrentReadingCardProps) {
  const item = items[0];
  const stats = currentBook?.bookId === item?.book.id ? currentBook : null;
  let content: ReactNode;
  if (item) {
    const { book, progress } = item;
    const percent = Math.max(0, Math.min(100, progress.progress * 100));
    const remaining = progress.chapterCount != null && progress.chapterIndex != null
      ? progress.progress === 1 ? 0 : progress.chapterCount - Math.max(0, progress.chapterIndex)
      : null;
    const open = () => onOpenBook(book, findVisibleBookCoverRect(book.id));
    content = <>
      <button type="button" className="current-reading-book" data-book-id={book.id}
        aria-label={`继续阅读《${book.title || '未命名书籍'}》`} onClick={open}>
        <span className="book-cover current-reading-cover"><BookCover book={book} priority /></span>
        <span className="current-reading-content">
          <span className="current-reading-title">{book.title || '未命名书籍'}</span>
          <span className="current-reading-author">{book.author || '未知作者'}</span>
          <span className="current-reading-meta">
            <span>已读 {percent.toFixed(1)}%</span>
            <span aria-label={remaining === null ? '暂无章节信息' : undefined}>剩余 {remaining ?? '—'} 章</span>
          </span>
          <span className="current-reading-track" aria-hidden="true"><span style={{ width: `${percent}%` }} /></span>
        </span>
      </button>
      <div className="current-reading-footer">
        <span>已读 {stats ? formatTotalDuration(stats.durationMs) : '—'}</span>
        <button type="button" onClick={open}>继续阅读 <span className="home-card-chevron" aria-hidden="true" /></button>
      </div>
    </>;
  } else if (error) {
    content = <div className="home-card-state" role="alert"><p>暂时无法加载阅读记录</p>
      <button className="home-card-action" type="button" onClick={onRetry}>重试</button></div>;
  } else if (!hasLoaded) {
    content = <div className="home-card-state" role="status"><p>正在加载阅读记录</p></div>;
  } else {
    content = <div className="home-card-state"><p>还没有阅读记录哦</p>
      <button className="home-card-action" type="button" onClick={onOpenShelf}>去书架选一本书</button></div>;
  }
  return <HomeCard className="current-reading-card" title="正在读" onTitleAction={onOpenRecent}
    titleActionLabel="正在读，打开继续阅读列表"
    actions={item ? <span className="current-reading-streak">连续阅读 {stats?.streakDays ?? '—'} 天</span> : null}>
    {content}
  </HomeCard>;
}
