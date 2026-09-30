import type { BatchFolderImportRequest, BatchMoveToShelfRequest, ShelfOrderItem } from '@lan-reader/shared';
import { request, jsonBody } from './transport.js';
import { decodeBatchFolderImport, decodeBatchMoveToShelf, decodeBooks, decodeShelf, decodeFolderResponse, decodeFolderMutation, decodeMoveToShelf } from './decoders.js';
export const listShelfItems = () => request('/api/folders/shelf', decodeShelf, { errorMessage: '无法加载书架' });
export const createFolderFromBooks = (sourceBookId: number, targetBookId: number, name?: string) => request('/api/folders', decodeFolderMutation, { method: 'POST', ...jsonBody({ sourceBookId, targetBookId, ...(name === undefined ? {} : { name }) }), errorMessage: status => status === 409 ? '只能用书架上的两本书创建文件夹' : '无法创建文件夹' });
export const listFolderBooks = (folderId: number, options: { signal?: AbortSignal } = {}) => request(`/api/folders/${folderId}/books`, decodeBooks, { signal: options.signal, errorMessage: status => status === 404 ? '文件夹不存在' : '无法加载文件夹' });
export const renameFolder = (folderId: number, name: string) => request(`/api/folders/${folderId}`, decodeFolderResponse, { method: 'PATCH', ...jsonBody({ name }), errorMessage: status => status === 404 ? '文件夹不存在' : '无法重命名文件夹' });
export const moveShelfBookToFolder = (folderId: number, bookId: number, bookIds?: number[]) => request(`/api/folders/${folderId}/import-book/${bookId}`, decodeFolderMutation, { method: 'PATCH', ...(bookIds === undefined ? {} : jsonBody({ bookIds })), errorMessage: status => status === 409 ? '只能移动书架上的书籍' : '无法移入文件夹' });
export const moveFolderBookToShelf = (folderId: number, bookId: number, items?: ShelfOrderItem[]) => request(`/api/folders/${folderId}/books/${bookId}/move-to-shelf`, decodeMoveToShelf, { method: 'PATCH', ...(items ? jsonBody({ items }) : {}), errorMessage: status => status === 409 ? '文件夹已变化，请刷新后重试' : '无法移出书籍' });
export const updateShelfItemOrder = (items: ShelfOrderItem[]) => request('/api/folders/shelf/order', decodeShelf, { method: 'PATCH', ...jsonBody({ items }), errorMessage: status => status === 409 ? '书架已变化，请刷新后重试' : '无法保存书架顺序' });
export const updateFolderBookOrder = (folderId: number, bookIds: number[]) => request(`/api/folders/${folderId}/books/order`, decodeBooks, { method: 'PATCH', ...jsonBody({ bookIds }), errorMessage: status => status === 409 ? '文件夹已变化，请刷新后重试' : '无法保存文件夹顺序' });

export const batchImportBooksToFolder = (folderId: number, bookIds: number[]) => request(`/api/folders/${folderId}/books/batch-import`, decodeBatchFolderImport, {
  method: 'PATCH',
  ...jsonBody({ bookIds } satisfies BatchFolderImportRequest),
  errorMessage: status => status === 404 ? '文件夹或书籍不存在' : '无法批量移入文件夹',
});
export const batchMoveBooksToShelf = (bookIds: number[]) => request('/api/folders/shelf/batch-move-out', decodeBatchMoveToShelf, {
  method: 'PATCH',
  ...jsonBody({ bookIds } satisfies BatchMoveToShelfRequest),
  errorMessage: status => status === 404 ? '书籍不存在' : status === 409 ? '只能移出文件夹内的书籍' : '无法批量移出书籍',
});
