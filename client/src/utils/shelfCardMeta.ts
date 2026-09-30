import { formatReadingPosition } from './readingProgress.js';

/** A shelf card shows the book's reading progress only; it has no author line. */
export function formatShelfBookMeta(progress: number | null | undefined): string {
  const presentation = formatReadingPosition(progress);
  if (presentation.state === 'finished') return '已读完';
  if (presentation.state === 'unread') return '未读';
  return presentation.percent === 0 ? '已开始' : presentation.label ?? '';
}
