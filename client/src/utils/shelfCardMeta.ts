import { formatReadingPosition } from './readingProgress.js';

export function formatShelfBookMeta(author: string | null | undefined, progress: number | null | undefined): string {
  const presentation = formatReadingPosition(progress);
  const position = presentation.state === 'finished'
    ? '已读完'
    : presentation.state === 'reading'
      ? presentation.percent === 0 ? '已开始' : presentation.label
      : null;
  return [author?.trim(), position].filter(Boolean).join(' · ');
}
