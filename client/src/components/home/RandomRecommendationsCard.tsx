import { useState } from 'react';
import type { Book } from '../../types/library.js';
import { selectRecommendationIds } from '../../utils/homeRecommendations.js';
import { BookCover } from '../bookshelf/BookCover.js';
import { HomeCard } from './HomeCard.js';

interface RandomRecommendationsCardProps {
  books: Book[];
  hasLoaded: boolean;
  error: string;
  onRetry: () => void;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
}
export function RandomRecommendationsCard({ books, hasLoaded, error, onRetry, onOpenBook }: RandomRecommendationsCardProps) {
  const ids = books.map(book => book.id);
  const catalogKey = [...new Set(ids)].sort((a, b) => a - b).join(',');
  const [selection, setSelection] = useState(() => ({ key: catalogKey, ids: selectRecommendationIds(ids) }));
  // Membership changes are reconciled before commit; fresh objects never reshuffle surviving IDs.
  if (selection.key !== catalogKey) {
    setSelection({ key: catalogKey, ids: selectRecommendationIds(ids, selection.ids) });
  }
  const byId = new Map(books.map(book => [book.id, book]));
  const selected = selection.ids.flatMap(id => byId.get(id) ? [byId.get(id)!] : []);
  return <HomeCard className="recommendations-card" title="随机推荐" actions={
    <button type="button" className="home-card-icon-button" aria-label="重新推荐" disabled={books.length < 2}
      onClick={() => setSelection({ key: catalogKey, ids: selectRecommendationIds(ids, selection.ids, true) })}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <path d="M20 7v5h-5M4 17v-5h5M19 11a7 7 0 0 0-12-5L4 9m16 6-3 3A7 7 0 0 1 5 13" />
      </svg>
    </button>}>
    {selected.length ? <div className="recommendation-covers">{selected.map(book => <button key={book.id}
      type="button" className="recommendation-book" data-book-id={book.id} aria-label={`阅读《${book.title || '未命名书籍'}》`}
      onClick={event => onOpenBook(book, event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect() ?? null)}>
      <span className="book-cover recommendation-cover"><BookCover book={book} sizes="48px" /></span>
    </button>)}</div> : <div className="home-card-state" role={error ? 'alert' : !hasLoaded ? 'status' : undefined}>
      <p>{error ? '暂时无法加载推荐书籍' : !hasLoaded ? '正在加载推荐书籍' : '书库里还没有书籍'}</p>
      {error ? <button type="button" className="home-card-action" onClick={onRetry}>重试</button> : null}
    </div>}
  </HomeCard>;
}
