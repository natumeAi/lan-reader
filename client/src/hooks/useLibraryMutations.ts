import type { Dispatch, SetStateAction } from 'react';
import type { ShelfOrderItem } from '@lan-reader/shared';
import type { Book, CatalogBook, Folder, FolderBook, ShelfItem } from '../types/library.js';
import type { LoadShelfOptions, ShelfProjection } from './useShelfData.js';
import { errorMessage } from '../api/transport.js';
import { batchDeleteBooks } from '../api/booksApi.js';
import { projectShelfBatch } from '../utils/shelfBatchProjection.js';
import type { BatchShelfState } from '../utils/shelfBatchProjection.js';

/**
 * Persistence and result ownership for the four bookshelf drag mutations.
 *
 * A mutation owns its result only while it is still the newest mutation of its scope, no newer
 * operation of either scope has begun (`getMutationSession`, the shared operations generation),
 * and, for a Folder mutation, the Folder opening that started it is still current. Scopes share
 * state (a failed move-out restores the Folder panel) and an undo spans both, so a newer
 * operation in one scope supersedes an in-flight result in the other.
 * A stale completion never writes visible state, never reports an error and never clears a
 * saving flag; because the server write did commit, a stale success instead schedules an
 * authoritative refresh so the commit stays discoverable.
 */
/**
 * How a mutation settled, from the point of view of the operation that started it.
 *
 * `stale` means the request finished but a newer operation (or a newer Folder opening) owns
 * the result, so this caller must not publish anything, including visual feedback.
 */
export type MutationOutcome = 'published' | 'stale' | 'failed';

export interface LibraryMutationOptions {
  /** Shared operations generation also invalidates requests across shelf/folder scopes. */
  getMutationSession?: () => number;
  getFolderSession?: () => number;
  isFolderSessionCurrent?: (session: number) => boolean;
  loadShelf: (options?: LoadShelfOptions) => unknown;
  setError: (message: string) => void;
  setFolderBooks: Dispatch<SetStateAction<FolderBook[]>>;
  setFolderError: (message: string) => void;
  setIsFolderLoading: (value: boolean) => void;
  setIsRenamingFolder: (value: boolean) => void;
  setIsSavingFolderOrder: (value: boolean) => void;
  setIsSavingOrder: (value: boolean) => void;
  setOpenFolder: Dispatch<SetStateAction<Folder | null>>;
  setShelfItems: Dispatch<SetStateAction<ShelfItem[]>>;
  setCatalogBooks?: Dispatch<SetStateAction<CatalogBook[]>>;
  setFolderBooksByFolderId?: Dispatch<SetStateAction<Map<number, FolderBook[]>>>;
}
export interface MoveFolderBookToShelfInput {
  /** Spring move-in Undo keeps membership and the open panel valid without a successful refresh. */
  publishMembership?: boolean;
  onPublished?: (data: Awaited<ReturnType<typeof moveFolderBookToShelf>>) => void;
  /**
   * Whether a failure reopens the Folder with its previous books (the default, for moves started
   * inside that Folder). `false` reports the failure on the shelf instead, for moves started
   * while the Folder is not open, such as from a search result.
   */
  restoreFolderOnFailure?: boolean;
  book: FolderBook;
  folder: Folder;
  onOutcome?: (outcome: MutationOutcome) => void;
  onSettled?: () => void;
  /** Complete shelf order including the moved book; omitted, the server places it after the Folder. */
  orderItems?: ShelfOrderItem[];
  previousFolderBooks: FolderBook[];
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
}
export interface CreateFolderInput {
  name?: string;
  onPublished?: (data: Awaited<ReturnType<typeof createFolderFromBooks>>) => void;
  onOutcome?: (outcome: MutationOutcome) => void;
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
  sourceBookId: number;
  targetBookId: number;
}
export interface MoveShelfBookToFolderInput {
  bookIds?: number[];
  /** Present for a spring handoff; panel publication is guarded by its opening session. */
  previousFolderBooks?: FolderBook[];
  onPublished?: (data: Awaited<ReturnType<typeof moveShelfBookToFolder>>) => void;
  bookId: number;
  folderId: number;
  onOutcome?: (outcome: MutationOutcome) => void;
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
}
export interface SaveShelfItemOrderInput {
  onPublished?: (data: Awaited<ReturnType<typeof updateShelfItemOrder>>) => void;
  onOutcome?: (outcome: MutationOutcome) => void;
  orderedShelfItems: ShelfItem[];
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
}
export interface SaveFolderBookOrderInput {
  /** Closed-folder undo persists order without writing another Folder panel. */
  publishToFolder?: boolean;
  onPublished?: (data: Awaited<ReturnType<typeof updateFolderBookOrder>>) => void;
  folderId: number;
  onOutcome?: (outcome: MutationOutcome) => void;
  previousFolderBooks: FolderBook[];
  projection: ShelfProjection | null;
  reorderedFolderBooks: FolderBook[];
}
export interface BatchMoveToFolderInput {
  books: Book[];
  folder: Folder;
  previousState: BatchShelfState;
  projection: ShelfProjection | null;
  onOutcome?: (outcome: MutationOutcome) => void;
  onPublished?: (data: Awaited<ReturnType<typeof batchImportBooksToFolder>>) => void;
}
export interface BatchMoveToShelfInput extends Omit<BatchMoveToFolderInput, 'folder' | 'onPublished'> {
  /** A selection that also contained root books is a mixed source, even though only folder books move. */
  allowUndo?: boolean;
  onPublished?: (data: Awaited<ReturnType<typeof batchMoveBooksToShelf>>) => void;
}
export interface BatchDeleteInput extends Omit<BatchMoveToFolderInput, 'folder' | 'onPublished'> {
  onPublished?: (data: Awaited<ReturnType<typeof batchDeleteBooks>>) => void;
}
export interface LibraryMutations {
  batchMoveToFolder(input: BatchMoveToFolderInput): Promise<void>;
  batchMoveToShelf(input: BatchMoveToShelfInput): Promise<void>;
  batchDelete(input: BatchDeleteInput): Promise<void>;
  createFolder(input: CreateFolderInput): Promise<void>;
  moveFolderBookToShelf(input: MoveFolderBookToShelfInput): Promise<void>;
  moveShelfBookToFolder(input: MoveShelfBookToFolderInput): Promise<void>;
  saveFolderBookOrder(input: SaveFolderBookOrderInput): Promise<void>;
  saveShelfItemOrder(input: SaveShelfItemOrderInput): Promise<void>;
}
interface ShelfMutationRun<T> {
  /** Batches always reconcile; a spring move only refreshes a failure it still owns. */
  refreshOnFailure?: boolean | 'current';
  onOutcome?: (outcome: MutationOutcome) => void;
  onSettled?: () => void;
  projection: ShelfProjection | null;
  publish: (data: T) => void;
  request: () => Promise<T>;
  rollback: (error: unknown) => void;
}
interface FolderMutationRun<T> extends ShelfMutationRun<T> {
  session: number;
}

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  batchImportBooksToFolder,
  batchMoveBooksToShelf,
  createFolderFromBooks,
  moveFolderBookToShelf,
  moveShelfBookToFolder,
  updateFolderBookOrder,
  updateShelfItemOrder,
} from '../api/foldersApi.js';
import {
  normalizeFolderBook,
  normalizeShelfItem,
  toShelfOrderItem,
} from '../utils/libraryItems.js';

export function useLibraryMutations({
  getMutationSession,
  getFolderSession,
  isFolderSessionCurrent,
  loadShelf,
  setError,
  setFolderBooks,
  setFolderError,
  setIsFolderLoading,
  setIsRenamingFolder,
  setIsSavingFolderOrder,
  setIsSavingOrder,
  setOpenFolder,
  setShelfItems,
  setCatalogBooks,
  setFolderBooksByFolderId,
}: LibraryMutationOptions): LibraryMutations {
  const shelfMutationRef = useRef(0);
  const folderMutationRef = useRef(0);
  const projectionsRef = useRef(new Set<ShelfProjection>());
  const releaseProjection = useCallback((projection: ShelfProjection | null) => {
    if (projection && projectionsRef.current.delete(projection)) projection.release();
  }, []);
  useEffect(() => () => {
    shelfMutationRef.current += 1;
    folderMutationRef.current += 1;
    for (const projection of projectionsRef.current) projection.release();
    projectionsRef.current.clear();
  }, []);

  const readFolderSession = useCallback(() => getFolderSession?.() ?? 0, [getFolderSession]);

  const isFolderSessionStillCurrent = useCallback(
    (session: number) => (isFolderSessionCurrent ? isFolderSessionCurrent(session) : true),
    [isFolderSessionCurrent],
  );

  const refreshAuthoritatively = useCallback(
    () => loadShelf({ background: true, allowCached: false }),
    [loadShelf],
  );

  const runShelfMutation = useCallback(
    async <T>({ onOutcome, onSettled, projection, publish, request, rollback, refreshOnFailure }: ShelfMutationRun<T>) => {
      const operationSession = getMutationSession?.();
      const token = shelfMutationRef.current + 1;
      const isCurrent = () => shelfMutationRef.current === token && getMutationSession?.() === operationSession;
      shelfMutationRef.current = token;
      if (projection) projectionsRef.current.add(projection);
      projection?.discardPendingSnapshots();

      try {
        const data = await request();
        projection?.discardPendingSnapshots();

        if (!isCurrent()) {
          releaseProjection(projection);
          onOutcome?.('stale');
          // The write committed even though this result is stale; keep it discoverable.
          void refreshAuthoritatively();
          return;
        }

        publish(data);
        onOutcome?.('published');
        releaseProjection(projection);
        await refreshAuthoritatively();
      } catch (error) {
        const isOwned = isCurrent();

        if (isOwned) {
          rollback(error);
        }

        // Released after the rollback, so a still-valid queued snapshot replaces the
        // restored array rather than the reverse; the write failed, so the server state
        // that snapshot describes is the authoritative one.
        releaseProjection(projection);
        onOutcome?.(isOwned ? 'failed' : 'stale');
        if (refreshOnFailure && (isOwned || refreshOnFailure === true)) void refreshAuthoritatively();
      } finally {
        onSettled?.();

        if (isCurrent()) {
          setIsSavingOrder(false);
        }
      }
    },
    [getMutationSession, refreshAuthoritatively, releaseProjection, setIsSavingOrder],
  );

  const runFolderMutation = useCallback(
    async <T>({ onOutcome, onSettled, projection, publish, request, rollback, session }: FolderMutationRun<T>) => {
      const operationSession = getMutationSession?.();
      const token = folderMutationRef.current + 1;
      folderMutationRef.current = token;
      if (projection) projectionsRef.current.add(projection);
      const isCurrent = () => folderMutationRef.current === token && getMutationSession?.() === operationSession && isFolderSessionStillCurrent(session);
      projection?.discardPendingSnapshots();

      try {
        const data = await request();
        projection?.discardPendingSnapshots();

        if (!isCurrent()) {
          releaseProjection(projection);
          onOutcome?.('stale');
          void refreshAuthoritatively();
          return;
        }

        publish(data);
        onOutcome?.('published');
        releaseProjection(projection);
        await refreshAuthoritatively();
      } catch (error) {
        const isOwned = isCurrent();

        if (isOwned) {
          rollback(error);
        }

        // Released after the rollback for the same reason as the shelf path above.
        releaseProjection(projection);
        onOutcome?.(isOwned ? 'failed' : 'stale');
      } finally {
        onSettled?.();

        if (isCurrent()) {
          setIsSavingFolderOrder(false);
        }
      }
    },
    [getMutationSession, isFolderSessionStillCurrent, refreshAuthoritatively, releaseProjection, setIsSavingFolderOrder],
  );

  const moveFolderBookToShelfMutation = useCallback(
    async ({
      book,
      folder,
      restoreFolderOnFailure = true,
      publishMembership = false,
      onPublished,
      onOutcome,
      onSettled,
      orderItems,
      previousFolderBooks,
      previousShelfItems,
      projection,
    }: MoveFolderBookToShelfInput) => {
      const session = readFolderSession();

      await runShelfMutation({
        onOutcome,
        onSettled,
        projection,
        request: () => moveFolderBookToShelf(folder.id, book.id, orderItems),
        publish(data) {
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
          if (publishMembership) {
            const books = data.books.map(normalizeFolderBook);
            setFolderBooksByFolderId?.(previous => {
              const next = new Map(previous);
              if (data.folder) next.set(folder.id, books);
              else next.delete(folder.id);
              return next;
            });
            setCatalogBooks?.(previous => previous.map(candidate => candidate.id === book.id
              ? { ...candidate, ...data.book, folderName: null } : candidate));
            if (isFolderSessionStillCurrent(session)) {
              setOpenFolder(current => current?.id === folder.id ? data.folder : current);
              setFolderBooks(books);
            }
          }
          onPublished?.(data);
        },
        rollback(error) {
          setShelfItems(previousShelfItems);

          if (!restoreFolderOnFailure) {
            setError(errorMessage(error, '无法移出书籍'));
            return;
          }

          // Reopening the Folder is only correct while the user is still in that Folder session.
          if (!isFolderSessionStillCurrent(session)) {
            return;
          }

          setOpenFolder(folder);
          setFolderBooks(previousFolderBooks);
          setIsFolderLoading(false);
          setIsRenamingFolder(false);
          setFolderError(errorMessage(error, '无法移出书籍'));
        },
      });
    },
    [
      isFolderSessionStillCurrent,
      readFolderSession,
      runShelfMutation,
      setError,
      setFolderBooks,
      setFolderError,
      setIsFolderLoading,
      setIsRenamingFolder,
      setOpenFolder,
      setShelfItems,
      setFolderBooksByFolderId,
      setCatalogBooks,
    ],
  );

  const createFolder = useCallback(
    async ({ name, onPublished, onOutcome, previousShelfItems, projection, sourceBookId, targetBookId }: CreateFolderInput) => {
      await runShelfMutation({
        onOutcome,
        projection,
        request: () => name === undefined
          ? createFolderFromBooks(sourceBookId, targetBookId)
          : createFolderFromBooks(sourceBookId, targetBookId, name),
        publish(data) {
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
          onPublished?.(data);
        },
        rollback(error) {
          setShelfItems(previousShelfItems);
          setError(errorMessage(error, '无法创建文件夹'));
        },
      });
    },
    [runShelfMutation, setError, setShelfItems],
  );

  const moveShelfBookToFolderMutation = useCallback(
    async ({ bookId, bookIds, folderId, onPublished, onOutcome, previousShelfItems, previousFolderBooks, projection }: MoveShelfBookToFolderInput) => {
      const session = readFolderSession();
      await runShelfMutation({
        onOutcome,
        projection,
        refreshOnFailure: bookIds !== undefined ? 'current' : false,
        request: () => bookIds === undefined
          ? moveShelfBookToFolder(folderId, bookId)
          : moveShelfBookToFolder(folderId, bookId, bookIds),
        publish(data) {
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
          if (bookIds !== undefined) {
            // Publish membership as well as the visible panel: a failed refresh must not
            // let App's snapshot-to-panel effect restore the pre-import book set.
            setFolderBooksByFolderId?.(previous => {
              const next = new Map(previous);
              next.set(folderId, data.books.map(normalizeFolderBook));
              return next;
            });
            setCatalogBooks?.(books => books.map(book => book.id === bookId
              ? { ...book, folderId, folderName: data.folder.name } : book));
          }
          if (previousFolderBooks && isFolderSessionStillCurrent(session)) {
            setOpenFolder(data.folder);
            setFolderBooks(data.books.map(normalizeFolderBook));
          }
          onPublished?.(data);
        },
        rollback(error) {
          setShelfItems(previousShelfItems);
          if (previousFolderBooks && isFolderSessionStillCurrent(session)) {
            setFolderBooks(previousFolderBooks);
            setFolderError(errorMessage(error, '无法移入文件夹'));
          }
          setError(errorMessage(error, '无法移入文件夹'));
        },
      });
    },
    [isFolderSessionStillCurrent, readFolderSession, runShelfMutation, setError, setFolderBooks, setFolderError, setOpenFolder, setShelfItems, setFolderBooksByFolderId, setCatalogBooks],
  );

  const saveShelfItemOrder = useCallback(
    async ({ onPublished, onOutcome, orderedShelfItems, previousShelfItems, projection }: SaveShelfItemOrderInput) => {
      await runShelfMutation({
        onOutcome,
        projection,
        request: () => updateShelfItemOrder(orderedShelfItems.map(toShelfOrderItem)),
        publish(data) {
          setShelfItems((data.items || orderedShelfItems).map(normalizeShelfItem));
          onPublished?.(data);
        },
        rollback(error) {
          setShelfItems(previousShelfItems);
          setError(errorMessage(error, '无法保存书架顺序'));
        },
      });
    },
    [runShelfMutation, setError, setShelfItems],
  );

  const saveFolderBookOrder = useCallback(
    async ({ folderId, publishToFolder = true, onPublished, onOutcome, previousFolderBooks, projection, reorderedFolderBooks }: SaveFolderBookOrderInput) => {
      await runFolderMutation({
        onOutcome,
        projection,
        session: readFolderSession(),
        request: () => updateFolderBookOrder(folderId, reorderedFolderBooks.map((book) => book.id)),
        publish(data) {
          if (publishToFolder) setFolderBooks((data.books || reorderedFolderBooks).map(normalizeFolderBook));
          onPublished?.(data);
        },
        rollback(error) {
          if (publishToFolder) {
            setFolderBooks(previousFolderBooks);
            setFolderError(errorMessage(error, '无法保存文件夹顺序'));
          }
        },
      });
    },
    [readFolderSession, runFolderMutation, setFolderBooks, setFolderError],
  );

  const applyBatchState = useCallback((state: BatchShelfState) => {
    setShelfItems(state.shelfItems);
    if (state.catalogBooks) setCatalogBooks?.(state.catalogBooks);
    if (state.folderBooksByFolderId) setFolderBooksByFolderId?.(state.folderBooksByFolderId);
  }, [setCatalogBooks, setFolderBooksByFolderId, setShelfItems]);

  const batchMoveToFolder = useCallback(async (input: BatchMoveToFolderInput) => {
    const projected = projectShelfBatch(input.previousState, input.books, input.folder);
    applyBatchState(projected);
    await runShelfMutation({ ...input, refreshOnFailure: true,
      request: () => batchImportBooksToFolder(input.folder.id, input.books.map(book => book.id)),
      publish(data) {
        const map = projected.folderBooksByFolderId ? new Map(projected.folderBooksByFolderId) : undefined;
        map?.set(data.folder.id, data.books.map(normalizeFolderBook));
        for (const id of data.removedFolderIds) map?.delete(id);
        applyBatchState({ ...projected, shelfItems: data.shelfItems.map(normalizeShelfItem), folderBooksByFolderId: map });
        input.onPublished?.(data);
      },
      rollback(error) { applyBatchState(input.previousState); setError(errorMessage(error, '无法批量移入文件夹')); },
    });
  }, [applyBatchState, runShelfMutation, setError]);

  const batchMoveToShelf = useCallback(async (input: BatchMoveToShelfInput) => {
    const projected = projectShelfBatch(input.previousState, input.books, 'shelf');
    applyBatchState(projected);
    await runShelfMutation({ ...input, refreshOnFailure: true,
      request: () => batchMoveBooksToShelf(input.books.map(book => book.id)),
      publish(data) {
        applyBatchState({ ...projected, shelfItems: data.shelfItems.map(normalizeShelfItem) });
        input.onPublished?.(data);
      },
      rollback(error) { applyBatchState(input.previousState); setError(errorMessage(error, '无法批量移出书籍')); },
    });
  }, [applyBatchState, runShelfMutation, setError]);

  const batchDelete = useCallback(async (input: BatchDeleteInput) => {
    // Keep every candidate visible and pending until the per-book results are known.
    await runShelfMutation({ ...input, refreshOnFailure: true,
      request: () => batchDeleteBooks(input.books.map(book => book.id)),
      publish(data) {
        applyBatchState(projectShelfBatch(input.previousState, data.deleted, 'delete'));
        if (data.failed.length) setError(`未能删除：${data.failed.map(failure => {
          const title = input.books.find(book => book.id === failure.id)?.title || '未命名书籍';
          return `《${title}》（${failure.message}）`;
        }).join('、')}`);
        input.onPublished?.(data);
      },
      rollback(error) { applyBatchState(input.previousState); setError(errorMessage(error, '无法批量删除书籍')); },
    });
  }, [applyBatchState, runShelfMutation, setError]);

  return useMemo(
    () => ({
      batchMoveToFolder, batchMoveToShelf, batchDelete,
      createFolder,
      moveFolderBookToShelf: moveFolderBookToShelfMutation,
      moveShelfBookToFolder: moveShelfBookToFolderMutation,
      saveFolderBookOrder,
      saveShelfItemOrder,
    }),
    [
      batchMoveToFolder, batchMoveToShelf, batchDelete,
      createFolder,
      moveFolderBookToShelfMutation,
      moveShelfBookToFolderMutation,
      saveFolderBookOrder,
      saveShelfItemOrder,
    ],
  );
}
