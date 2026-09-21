import { request, jsonBody } from './transport.js';
import { decodeBooks, decodeCatalog, decodeBookResponse } from './decoders.js';
export const listBooks = () => request('/api/books', decodeBooks, { errorMessage: '无法加载书架' });
export const listBookCatalog = () => request('/api/books/catalog', decodeCatalog, { errorMessage: '搜索目录加载失败' });
export const getBook = (bookId: number) => request(`/api/books/${bookId}`, decodeBookResponse, { errorMessage: status => status === 404 ? '书籍不存在' : '无法加载书籍' });
export function uploadBook(file: File) {
  const body = new FormData();
  body.append('file', file);
  return request('/api/books', decodeBookResponse, { method: 'POST', body, serverErrorMessage: true, errorMessage: '上传失败' });
}
export const deleteBook = (bookId: number) => request(`/api/books/${bookId}`, decodeBookResponse, { method: 'DELETE', errorMessage: status => status === 404 ? '书籍不存在' : '无法删除书籍' });
export const updateBookOrder = (bookIds: number[]) => request('/api/books/order', decodeBooks, { method: 'PATCH', ...jsonBody({ bookIds }), errorMessage: status => status === 409 ? '书架已变化，请刷新后重试' : '无法保存书架顺序' });
