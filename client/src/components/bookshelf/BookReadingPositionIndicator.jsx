import { formatReadingPosition } from '../../utils/readingProgress.js';

export function BookReadingPositionIndicator({ progress }) {
  const presentation = formatReadingPosition(progress);
  if (presentation.state === 'unread') return null;

  return (
    <span className="book-reading-position" aria-hidden="true">
      <span
        className={`book-reading-position-track is-${presentation.state}`}
      >
        <span style={{ width: `${presentation.barWidth}%` }} />
      </span>
      {presentation.state === 'finished' ? (
        <span className="book-reading-position-finished">✓</span>
      ) : (
        <span className="book-reading-position-percent">{presentation.label}</span>
      )}
    </span>
  );
}
