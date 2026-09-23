const sqliteUtcTimestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function normalizeRecentReadingTimestamp(updatedAt: string | null | undefined) {
  const value = String(updatedAt ?? '');
  return sqliteUtcTimestampPattern.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
}

export function formatRecentReadingTime(updatedAt: string | null | undefined, now = Date.now()) {
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
