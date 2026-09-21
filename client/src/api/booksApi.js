export async function listBooks() {
  const response = await fetch('/api/books');

  if (!response.ok) {
    throw new Error('无法加载书架');
  }

  return response.json();
}

export async function listBookCatalog() {
  const response = await fetch('/api/books/catalog');

  if (!response.ok) {
    throw new Error('搜索目录加载失败');
  }

  return response.json();
}

export async function getBook(bookId) {
  const response = await fetch(`/api/books/${bookId}`);

  if (!response.ok) {
    throw new Error(response.status === 404 ? '书籍不存在' : '无法加载书籍');
  }

  return response.json();
}

export async function uploadBook(file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/books', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || '上传失败');
  }

  return response.json();
}

export async function deleteBook(bookId) {
  const response = await fetch(`/api/books/${bookId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    throw new Error(response.status === 404 ? '书籍不存在' : '无法删除书籍');
  }

  return response.json();
}

export async function updateBookOrder(bookIds) {
  const response = await fetch('/api/books/order', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bookIds }),
  });

  if (!response.ok) {
    throw new Error(response.status === 409 ? '书架已变化，请刷新后重试' : '无法保存书架顺序');
  }

  return response.json();
}
