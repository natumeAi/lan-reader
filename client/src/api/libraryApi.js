export async function getLibrarySnapshot(options = {}) {
  const headers = {};
  if (options.etag) {
    headers['If-None-Match'] = options.etag;
  }

  const response = await fetch('/api/library/snapshot', {
    cache: 'no-store',
    headers,
    signal: options.signal,
  });

  if (response.status === 304) {
    return {
      etag: options.etag,
      notModified: true,
      snapshot: null,
    };
  }

  if (!response.ok) {
    throw new Error('无法加载书库');
  }

  const data = await response.json();
  return {
    etag: response.headers.get('ETag'),
    notModified: false,
    snapshot: data.snapshot,
  };
}
