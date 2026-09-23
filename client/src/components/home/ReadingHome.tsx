import type { Book, RecentReadingItem } from '../../types/library.js';
import { CurrentReadingCard } from './CurrentReadingCard.js';

export interface ReadingHomeProps {
  /** False until a cached or network library snapshot has been applied. */
  hasLoadedRecentReading: boolean;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onOpenShelf: () => void;
  onRetryRecentReading: () => void;
  /** Library load failure; shown only when no recent-reading data is available. */
  recentReadingError: string;
  recentReadingItems: RecentReadingItem[];
}

/**
 * 首页: a vertical stack of home cards. 正在读 is first; later dashboard cards are appended
 * to `.reading-home-cards` in the reference order, reusing `HomeCard`.
 */
export function ReadingHome({
  hasLoadedRecentReading,
  onOpenBook,
  onOpenShelf,
  onRetryRecentReading,
  recentReadingError,
  recentReadingItems,
}: ReadingHomeProps) {
  return (
    <section className="reading-home" aria-labelledby="reading-home-title">
      <header className="reading-home-header">
        <h1 id="reading-home-title">首页</h1>
      </header>
      <div className="reading-home-cards">
        <CurrentReadingCard
          error={recentReadingError}
          hasLoaded={hasLoadedRecentReading}
          items={recentReadingItems}
          onOpenBook={onOpenBook}
          onOpenShelf={onOpenShelf}
          onRetry={onRetryRecentReading}
        />
      </div>
    </section>
  );
}
