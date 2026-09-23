import type { ReadingStatsDto } from '@lan-reader/shared';
import type { Book, RecentReadingItem } from '../../types/library.js';
import type { GoalKind } from '../../utils/readingStatsFormat.js';
import { findVisibleBookCoverRect } from '../../utils/coverOrigin.js';
import { AnnualBooksCard } from './AnnualBooksCard.js';
import { CurrentReadingCard } from './CurrentReadingCard.js';
import { ReadingGoalDialog } from './ReadingGoalDialog.js';
import { ReadingSummaryCard } from './ReadingSummaryCard.js';
import { TodayGoalCard } from './TodayGoalCard.js';

export interface ReadingHomeProps {
  /** Open goal editor, owned by the dashboard hook so App can block navigation. */
  goalDialog: GoalKind | null;
  /** False until a cached or network library snapshot has been applied. */
  hasLoadedRecentReading: boolean;
  onCloseGoalDialog: () => void;
  onEditGoal: (kind: GoalKind) => void;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
  onOpenShelf: () => void;
  onRetryReadingStats: () => void;
  onRetryRecentReading: () => void;
  /** Persists one goal; rejects with a user-facing Error. */
  onSaveGoal: (kind: GoalKind, value: number) => Promise<void>;
  /** Delivery warning from the activity outbox, or `''`. */
  readingActivityNotice: string;
  /** Latest statistics request failure, or `''`. */
  readingStatsError: string;
  /** Last valid statistics; `null` until loaded. */
  readingStats: ReadingStatsDto | null;
  /** Library load failure; shown only when no recent-reading data is available. */
  recentReadingError: string;
  recentReadingItems: RecentReadingItem[];
}

/**
 * 首页: a vertical stack of home cards in the reference order 正在读 → 今日目标 →
 * 近 7 日/totals → 今年读完的书. Cards are presentational; data and actions come from App.
 */
export function ReadingHome({
  goalDialog,
  hasLoadedRecentReading,
  onCloseGoalDialog,
  onEditGoal,
  onOpenBook,
  onOpenShelf,
  onRetryReadingStats,
  onRetryRecentReading,
  onSaveGoal,
  readingActivityNotice,
  readingStats,
  readingStatsError,
  recentReadingError,
  recentReadingItems,
}: ReadingHomeProps) {
  // 开始阅读 resumes the most recent in-progress Book, or opens 书架 when there is none.
  const handleStartReading = () => {
    const first = recentReadingItems[0];
    if (!first) {
      onOpenShelf();
      return;
    }
    onOpenBook(first.book, findVisibleBookCoverRect(first.book.id));
  };

  // Refresh failures keep the last valid numbers visible and say so; they are never zeroed.
  const staleNotice = readingStats && readingStatsError;

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
        {staleNotice || readingActivityNotice ? (
          <div className="reading-stats-notice" role="status">
            {staleNotice ? (
              <p>
                <span>统计未能刷新，显示的是上次加载的数据</span>
                <button type="button" onClick={onRetryReadingStats}>重试</button>
              </p>
            ) : null}
            {readingActivityNotice ? <p>{readingActivityNotice}</p> : null}
          </div>
        ) : null}
        <TodayGoalCard
          error={readingStatsError}
          onEditGoal={() => onEditGoal('daily')}
          onRetry={onRetryReadingStats}
          onStartReading={handleStartReading}
          stats={readingStats}
        />
        <ReadingSummaryCard error={readingStatsError} onRetry={onRetryReadingStats} stats={readingStats} />
        <AnnualBooksCard
          error={readingStatsError}
          onEditGoal={() => onEditGoal('annual')}
          onOpenBook={onOpenBook}
          onRetry={onRetryReadingStats}
          stats={readingStats}
        />
      </div>
      {goalDialog && readingStats ? (
        <ReadingGoalDialog
          key={goalDialog}
          currentValue={goalDialog === 'daily' ? readingStats.goals.dailyMinutes : readingStats.goals.annualBooks}
          kind={goalDialog}
          onClose={onCloseGoalDialog}
          onSave={(value) => onSaveGoal(goalDialog, value)}
        />
      ) : null}
    </section>
  );
}
