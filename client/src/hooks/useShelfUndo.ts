import { useCallback, useMemo, useRef, useState } from 'react';
import type { LibraryMutations, MutationOutcome } from './useLibraryMutations.js';
import type { ShelfOperationsOptions, ShelfMutationIntent } from './useShelfOperations.js';
import type { Folder, FolderBook, ShelfItem } from '../types/library.js';
import { normalizeFolderBook, normalizeShelfItem, toShelfOrderItem } from '../utils/libraryItems.js';

export interface ShelfToastNotice {
  createdFolder?: Folder;
  token: number;
  message: string;
  light?: boolean;
  duration?: number;
}
interface UndoEntry {
  token: number;
  isApplicable(): boolean;
  run(): Promise<MutationOutcome>;
  intent: ShelfMutationIntent;
  keys: string[];
}
type FolderSnapshot = ShelfOperationsOptions['folderBooksByFolderId'];
const sameKeys = (a: readonly { key: string }[], b: readonly { key: string }[]) => {
  const keys = new Set(b.map(item => item.key));
  return a.length === b.length && a.every(item => keys.has(item.key));
};

/** Undo decorates the shared mutations; inverse calls bypass the decorator, never ownership. */
export function useShelfUndo(
  raw: LibraryMutations,
  options: ShelfOperationsOptions,
  getToken: () => number,
  beginFeedback: (intent: ShelfMutationIntent, keys: readonly string[]) => (outcome: MutationOutcome) => void,
) {
  const latest = useRef(options);
  latest.current = options;
  const entry = useRef<UndoEntry | null>(null);
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null);
  const [toast, setToast] = useState<ShelfToastNotice | null>(null);
  const dismissToast = useCallback(() => {
    entry.current = null;
    setUndoEntry(null);
    setToast(null);
  }, []);
  const register = useCallback((notice: ShelfToastNotice, undo: UndoEntry | null) => {
    if (getToken() !== notice.token) return;
    entry.current = undo;
    setUndoEntry(undo);
    setToast(notice);
  }, [getToken]);
  // A notice can outlive a background snapshot. Resolve its Folder at click time,
  // and reject callbacks invalidated synchronously by dismissal or a newer operation.
  const getCreatedFolder = useCallback((token: number): Folder | null => {
    if (entry.current?.token !== token || getToken() !== token || toast?.token !== token) return null;
    const item = latest.current.shelfItems.find(item => item.type === 'folder' && item.id === toast.createdFolder?.id);
    return item?.type === 'folder' ? item.folder : null;
  }, [getToken, toast]);
  /** An undo is the newest operation of both scopes: every card and menu stays busy until it settles. */
  const setSaving = useCallback((saving: boolean) => {
    latest.current.setIsSavingOrder(saving);
    latest.current.setIsSavingFolderOrder(saving);
  }, []);

  const mutations = useMemo<LibraryMutations>(() => {
    const shelfMatches = (expected: ShelfItem[]) => sameKeys(latest.current.shelfItems, expected);
    const folderBooks = (id: number) => latest.current.openFolder?.id === id
      ? latest.current.folderBooks : latest.current.folderBooksByFolderId?.get(id);
    /**
     * Folder membership at click time. Until a snapshot newer than the one shown at publication
     * arrives, the published response is the newest membership (a created Folder is not in the old
     * snapshot at all, a moved book still is); afterwards the open panel or snapshot must match it.
     */
    const folderMatches = (id: number, expected: FolderBook[], published: FolderSnapshot) => {
      if (latest.current.folderBooksByFolderId === published) return true;
      const current = folderBooks(id);
      return current ? sameKeys(current, expected) : false;
    };
    const projection = () => latest.current.beginShelfProjection?.() ?? null;
    const currentState = () => ({ shelfItems: latest.current.shelfItems,
      catalogBooks: latest.current.catalogBooks, folderBooksByFolderId: latest.current.folderBooksByFolderId });
    // Every step owns a fresh mutation token and projection; stop before another step if
    // a newer operation took over during either the request or its reconciling refresh.
    const step = async (run: (report: (outcome: MutationOutcome) => void) => Promise<void>) => {
      const token = getToken();
      // A step's own `finally` releases its scope's flag; keep both held until runUndo settles.
      setSaving(true);
      const result: { outcome: MutationOutcome } = { outcome: 'stale' };
      await run(outcome => { result.outcome = outcome; });
      return getToken() === token ? result.outcome : 'stale';
    };
    return {
      async batchMoveToFolder(input) {
        const token = getToken();
        const fromRoot = input.books.every(book => book.folderId == null);
        await raw.batchMoveToFolder({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.shelfItems.map(normalizeShelfItem);
          const books = data.books.map(normalizeFolderBook);
          const snapshot = latest.current.folderBooksByFolderId;
          register({ token, message: `已将 ${input.books.length} 本书移入「${data.folder.name}」` }, !fromRoot ? null : {
            token, intent: 'move-out', keys: [...input.books.map(book => `book:${book.id}`), `folder:${data.folder.id}`],
            isApplicable: () => shelfMatches(expected) && folderMatches(data.folder.id, books, snapshot),
            async run() {
              const first = await step(onOutcome => raw.batchMoveToShelf({
                books: input.books.map(book => ({ ...book, folderId: data.folder.id })),
                previousState: currentState(), projection: projection(), onOutcome,
              }));
              if (first !== 'published') return first;
              const second = await step(onOutcome => raw.saveShelfItemOrder({
                orderedShelfItems: input.previousState.shelfItems, previousShelfItems: latest.current.shelfItems,
                projection: projection(), onOutcome,
              }));
              if (second === 'failed') latest.current.setError('已移回，书架顺序未恢复');
              return second;
            },
          });
        } });
      },
      async batchMoveToShelf(input) {
        const token = getToken();
        const sourceId = input.books[0]?.folderId;
        const previousBooks = sourceId == null ? undefined : input.previousState.folderBooksByFolderId?.get(sourceId);
        const singleSource = input.allowUndo !== false && sourceId != null
          && input.books.every(book => book.folderId === sourceId)
          && previousBooks && input.books.every(book => previousBooks.some(previous => previous.id === book.id));
        const source = input.previousState.shelfItems.find(item => item.type === 'folder' && item.id === sourceId);
        await raw.batchMoveToShelf({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.shelfItems.map(normalizeShelfItem);
          const remaining = previousBooks?.filter(book => !input.books.some(moved => moved.id === book.id)) ?? [];
          const snapshot = latest.current.folderBooksByFolderId;
          // The batch API deletes an emptied source; importing into that deleted id cannot undo it.
          const folder = source?.type === 'folder' && !data.removedFolderIds.includes(source.id) ? source.folder : null;
          register({ token, message: `已将 ${input.books.length} 本书移到书架` }, !singleSource || !folder || !previousBooks ? null : {
            token, intent: 'absorb', keys: [...input.books.map(book => `book:${book.id}`), `folder:${folder.id}`],
            isApplicable: () => shelfMatches(expected) && folderMatches(folder.id, remaining, snapshot),
            async run() {
              let restored = remaining;
              const first = await step(onOutcome => raw.batchMoveToFolder({
                books: input.books.map(book => ({ ...book, folderId: null })), folder,
                previousState: currentState(), projection: projection(), onOutcome,
                onPublished(result) { restored = result.books.map(normalizeFolderBook); },
              }));
              if (first !== 'published') return first;
              const second = await step(onOutcome => raw.saveFolderBookOrder({
                folderId: folder.id, reorderedFolderBooks: previousBooks, previousFolderBooks: restored,
                publishToFolder: latest.current.openFolder?.id === folder.id,
                projection: projection(), onOutcome,
              }));
              if (second === 'failed') latest.current.setError('已移回，文件夹顺序未恢复');
              return second;
            },
          });
        } });
      },
      async batchDelete(input) {
        const token = getToken();
        await raw.batchDelete({ ...input, onPublished(data) {
          input.onPublished?.(data);
          register({ token, message: data.failed.length
            ? `已删除 ${data.deleted.length} 本书，${data.failed.length} 本未能删除` : `已删除 ${data.deleted.length} 本书` }, null);
        } });
      },
      async saveShelfItemOrder(input) {
        const token = getToken();
        await raw.saveShelfItemOrder({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.items.map(normalizeShelfItem);
          register({ token, message: '已调整书架顺序', light: true }, {
            token, intent: 'sort', keys: expected.map(item => item.key),
            isApplicable: () => shelfMatches(expected),
            run: () => step(onOutcome => raw.saveShelfItemOrder({
              orderedShelfItems: input.previousShelfItems, previousShelfItems: latest.current.shelfItems,
              projection: projection(), onOutcome,
            })),
          });
        } });
      },
      async saveFolderBookOrder(input) {
        const token = getToken();
        const session = latest.current.getFolderSession?.();
        await raw.saveFolderBookOrder({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.books.map(normalizeFolderBook);
          const snapshot = latest.current.folderBooksByFolderId;
          register({ token, message: '已调整文件夹顺序', light: true }, {
            token, intent: 'sort', keys: expected.map(book => book.key),
            isApplicable: () => latest.current.openFolder?.id === input.folderId
              && latest.current.getFolderSession?.() === session && folderMatches(input.folderId, expected, snapshot),
            run: () => step(onOutcome => raw.saveFolderBookOrder({
              folderId: input.folderId, reorderedFolderBooks: input.previousFolderBooks,
              previousFolderBooks: latest.current.folderBooks, projection: projection(), onOutcome,
            })),
          });
        } });
      },
      async moveShelfBookToFolder(input) {
        const token = getToken();
        const item = input.previousShelfItems.find(item => item.type === 'book' && item.id === input.bookId);
        await raw.moveShelfBookToFolder({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.shelfItems.map(normalizeShelfItem);
          const books = data.books.map(normalizeFolderBook);
          const snapshot = latest.current.folderBooksByFolderId;
          register({ token, message: `已移入「${data.folder.name}」` }, item?.type !== 'book' ? null : {
            token, intent: 'move-out', keys: [`book:${input.bookId}`, `folder:${input.folderId}`],
            isApplicable: () => shelfMatches(expected) && folderMatches(input.folderId, books, snapshot),
            run: () => step(onOutcome => raw.moveFolderBookToShelf({
              folder: data.folder, book: normalizeFolderBook(item.book),
              publishMembership: input.bookIds !== undefined,
              orderItems: input.previousShelfItems.map(toShelfOrderItem), previousShelfItems: latest.current.shelfItems,
              previousFolderBooks: books, restoreFolderOnFailure: latest.current.openFolder?.id === input.folderId,
              projection: projection(), onOutcome,
            })),
          });
        } });
      },
      async moveFolderBookToShelf(input) {
        const token = getToken();
        // Drag handoff already closed its Folder; its input retains the complete original order.
        const previousBooks = input.previousFolderBooks.some(book => book.id === input.book.id)
          ? input.previousFolderBooks : folderBooks(input.folder.id) ?? [];
        // Without the complete original order the book could move back but never regain its place.
        const restorable = previousBooks.some(book => book.id === input.book.id);
        await raw.moveFolderBookToShelf({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.shelfItems.map(normalizeShelfItem);
          const remaining = data.books.map(normalizeFolderBook);
          const snapshot = latest.current.folderBooksByFolderId;
          register({ token, message: '已移到书架' }, !data.folder || !restorable ? null : {
            token, intent: 'absorb', keys: [`book:${input.book.id}`, `folder:${input.folder.id}`],
            isApplicable: () => shelfMatches(expected) && folderMatches(input.folder.id, remaining, snapshot),
            async run() {
              let restored = remaining;
              const first = await step(onOutcome => raw.moveShelfBookToFolder({
                folderId: input.folder.id, bookId: input.book.id, previousShelfItems: latest.current.shelfItems,
                projection: projection(), onOutcome, onPublished(result) { restored = result.books.map(normalizeFolderBook); },
              }));
              if (first !== 'published') return first;
              const second = await step(onOutcome => raw.saveFolderBookOrder({
                folderId: input.folder.id, previousFolderBooks: restored, reorderedFolderBooks: previousBooks,
                publishToFolder: latest.current.openFolder?.id === input.folder.id,
                projection: projection(), onOutcome,
              }));
              if (second === 'failed') latest.current.setError('已移回，顺序未恢复');
              return second;
            },
          });
        } });
      },
      async createFolder(input) {
        const token = getToken();
        await raw.createFolder({ ...input, onPublished(data) {
          input.onPublished?.(data);
          const expected = data.shelfItems.map(normalizeShelfItem);
          const books = data.books.map(normalizeFolderBook);
          const snapshot = latest.current.folderBooksByFolderId;
          register({ token, message: `已创建「${data.folder.name}」`, createdFolder: data.folder }, {
            token, intent: 'move-out', keys: [`folder:${data.folder.id}`, ...books.map(book => `book:${book.id}`)],
            isApplicable: () => shelfMatches(expected) && folderMatches(data.folder.id, books, snapshot),
            async run() {
              let previousShelfItems = latest.current.shelfItems;
              for (const bookId of [input.sourceBookId, input.targetBookId]) {
                const book = books.find(book => book.id === bookId);
                if (!book) return 'failed';
                const first = bookId === input.sourceBookId;
                const orderItems = input.previousShelfItems.map(item => first && item.type === 'book' && item.id === input.targetBookId
                  ? { type: 'folder' as const, id: data.folder.id } : toShelfOrderItem(item));
                const result = await step(onOutcome => raw.moveFolderBookToShelf({
                  folder: data.folder, book, orderItems, previousShelfItems,
                  previousFolderBooks: first ? books : [book], restoreFolderOnFailure: false,
                  projection: projection(), onOutcome,
                  onPublished(result) { previousShelfItems = result.shelfItems.map(normalizeShelfItem); },
                }));
                if (result !== 'published') return result;
              }
              return 'published';
            },
          });
        } });
      },
    };
  }, [getToken, raw, register, setSaving]);

  const runUndo = useCallback(async () => {
    const undo = entry.current;
    if (!undo || undo.token !== getToken()) return;
    const applicable = undo.isApplicable();
    // The click is the newest operation either way. It supersedes the registering mutation's
    // reconciliation, whose `finally` therefore no longer releases a saving flag: this does.
    const report = beginFeedback(undo.intent, undo.keys);
    const token = getToken();
    if (!applicable) {
      setSaving(false);
      report('stale');
      register({ token, message: '书架已变化，无法撤销' }, null);
      return;
    }
    latest.current.setError('');
    latest.current.setFolderError('');
    setSaving(true);
    const outcome = await undo.run();
    if (getToken() !== token) return;
    setSaving(false);
    report(outcome);
    if (outcome === 'stale') return;
    register({ token, message: outcome === 'published' ? '已撤销' : '撤销未完成',
      duration: outcome === 'published' ? 1500 : 5000 }, null);
    if (outcome === 'failed') void latest.current.loadShelf({ background: true, allowCached: false });
  }, [beginFeedback, getToken, register, setSaving]);

  return { mutations, undoEntry, toast, dismissToast, runUndo, getCreatedFolder };
}
