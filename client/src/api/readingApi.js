export async function getReadingProgress(bookId) {
  const response = await fetch(`/api/reading/${bookId}`);

  if (!response.ok) {
    throw new Error('无法加载阅读进度');
  }

  return response.json();
}

export async function listRecentReading() {
  const response = await fetch('/api/reading/recent');

  if (!response.ok) {
    throw new Error('无法加载最近阅读');
  }

  return response.json();
}

export async function saveReadingProgress(
  bookId,
  { cfi, progress, chapterHref, chapterLabel },
  options = {},
) {
  const response = await fetch(`/api/reading/${bookId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cfi, progress, chapterHref, chapterLabel }),
    keepalive: Boolean(options.keepalive),
    signal: options.signal,
  });

  if (!response.ok) {
    const error = new Error('无法保存阅读进度');
    error.status = response.status;
    throw error;
  }

  return response.json();
}
