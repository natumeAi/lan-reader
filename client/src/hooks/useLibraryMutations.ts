import type { Dispatch, SetStateAction } from 'react';
import type { ShelfOrderItem } from '@lan-reader/shared';
import type { Folder, FolderBook, ShelfItem } from '../types/library.js';
import type { LoadShelfOptions, ShelfProjection } from './useShelfData.js';
import { errorMessage } from '../api/transport.js';

/**
 * Persistence and result ownership for the four bookshelf drag mutations.
 *
 * A mutation owns its result only while it is still the newest mutation of its scope, and a
 * Folder mutation additionally only while the Folder opening that started it is still current.
 * A stale completion never writes visible state, never reports an error and never clears a
 * newer operation's saving flag; because the server write did commit, it instead schedules an
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
}
export interface MoveFolderBookToShelfInput {
  book: FolderBook;
  folder: Folder;
  onOutcome?: (outcome: MutationOutcome) => void;
  onSettled?: () => void;
  orderItems: ShelfOrderItem[];
  previousFolderBooks: FolderBook[];
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
}
export interface CreateFolderInput {
  onOutcome?: (outcome: MutationOutcome) => void;
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
  sourceBookId: number;
  targetBookId: number;
}
export interface MoveShelfBookToFolderInput {
  bookId: number;
  folderId: number;
  onOutcome?: (outcome: MutationOutcome) => void;
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
}
export interface SaveShelfItemOrderInput {
  onOutcome?: (outcome: MutationOutcome) => void;
  orderedShelfItems: ShelfItem[];
  previousShelfItems: ShelfItem[];
  projection: ShelfProjection | null;
}
export interface SaveFolderBookOrderInput {
  folderId: number;
  onOutcome?: (outcome: MutationOutcome) => void;
  previousFolderBooks: FolderBook[];
  projection: ShelfProjection | null;
  reorderedFolderBooks: FolderBook[];
}
export interface LibraryMutations {
  createFolder(input: CreateFolderInput): Promise<void>;
  moveFolderBookToShelf(input: MoveFolderBookToShelfInput): Promise<void>;
  moveShelfBookToFolder(input: MoveShelfBookToFolderInput): Promise<void>;
  saveFolderBookOrder(input: SaveFolderBookOrderInput): Promise<void>;
  saveShelfItemOrder(input: SaveShelfItemOrderInput): Promise<void>;
}
interface ShelfMutationRun<T> {
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

import { useCallback, useMemo, useRef } from 'react';
import {
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
}: LibraryMutationOptions): LibraryMutations {
  const shelfMutationRef = useRef(0);
  const folderMutationRef = useRef(0);

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
    async <T>({ onOutcome, onSettled, projection, publish, request, rollback }: ShelfMutationRun<T>) => {
      const token = shelfMutationRef.current + 1;
      shelfMutationRef.current = token;
      projection?.discardPendingSnapshots();

      try {
        const data = await request();
        projection?.discardPendingSnapshots();

        if (shelfMutationRef.current !== token) {
          projection?.release();
          onOutcome?.('stale');
          // The write committed even though this result is stale; keep it discoverable.
          void refreshAuthoritatively();
          return;
        }

        publish(data);
        onOutcome?.('published');
        projection?.release();
        await refreshAuthoritatively();
      } catch (error) {
        const isOwned = shelfMutationRef.current === token;

        if (isOwned) {
          rollback(error);
        }

        // Released after the rollback, so a still-valid queued snapshot replaces the
        // restored array rather than the reverse; the write failed, so the server state
        // that snapshot describes is the authoritative one.
        projection?.release();
        onOutcome?.(isOwned ? 'failed' : 'stale');
      } finally {
        onSettled?.();

        if (shelfMutationRef.current === token) {
          setIsSavingOrder(false);
        }
      }
    },
    [refreshAuthoritatively, setIsSavingOrder],
  );

  const runFolderMutation = useCallback(
    async <T>({ onOutcome, onSettled, projection, publish, request, rollback, session }: FolderMutationRun<T>) => {
      const token = folderMutationRef.current + 1;
      folderMutationRef.current = token;
      const isCurrent = () => folderMutationRef.current === token && isFolderSessionStillCurrent(session);
      projection?.discardPendingSnapshots();

      try {
        const data = await request();
        projection?.discardPendingSnapshots();

        if (!isCurrent()) {
          projection?.release();
          onOutcome?.('stale');
          void refreshAuthoritatively();
          return;
        }

        publish(data);
        onOutcome?.('published');
        projection?.release();
        await refreshAuthoritatively();
      } catch (error) {
        const isOwned = isCurrent();

        if (isOwned) {
          rollback(error);
        }

        // Released after the rollback for the same reason as the shelf path above.
        projection?.release();
        onOutcome?.(isOwned ? 'failed' : 'stale');
      } finally {
        onSettled?.();

        if (isCurrent()) {
          setIsSavingFolderOrder(false);
        }
      }
    },
    [isFolderSessionStillCurrent, refreshAuthoritatively, setIsSavingFolderOrder],
  );

  const moveFolderBookToShelfMutation = useCallback(
    async ({
      book,
      folder,
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
        },
        rollback(error) {
          setShelfItems(previousShelfItems);

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
      setFolderBooks,
      setFolderError,
      setIsFolderLoading,
      setIsRenamingFolder,
      setOpenFolder,
      setShelfItems,
    ],
  );

  const createFolder = useCallback(
    async ({ onOutcome, previousShelfItems, projection, sourceBookId, targetBookId }: CreateFolderInput) => {
      await runShelfMutation({
        onOutcome,
        projection,
        request: () => createFolderFromBooks(sourceBookId, targetBookId),
        publish(data) {
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
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
    async ({ bookId, folderId, onOutcome, previousShelfItems, projection }: MoveShelfBookToFolderInput) => {
      await runShelfMutation({
        onOutcome,
        projection,
        request: () => moveShelfBookToFolder(folderId, bookId),
        publish(data) {
          setShelfItems((data.shelfItems || []).map(normalizeShelfItem));
        },
        rollback(error) {
          setShelfItems(previousShelfItems);
          setError(errorMessage(error, '无法移入文件夹'));
        },
      });
    },
    [runShelfMutation, setError, setShelfItems],
  );

  const saveShelfItemOrder = useCallback(
    async ({ onOutcome, orderedShelfItems, previousShelfItems, projection }: SaveShelfItemOrderInput) => {
      await runShelfMutation({
        onOutcome,
        projection,
        request: () => updateShelfItemOrder(orderedShelfItems.map(toShelfOrderItem)),
        publish(data) {
          setShelfItems((data.items || orderedShelfItems).map(normalizeShelfItem));
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
    async ({ folderId, onOutcome, previousFolderBooks, projection, reorderedFolderBooks }: SaveFolderBookOrderInput) => {
      await runFolderMutation({
        onOutcome,
        projection,
        session: readFolderSession(),
        request: () => updateFolderBookOrder(folderId, reorderedFolderBooks.map((book) => book.id)),
        publish(data) {
          setFolderBooks((data.books || reorderedFolderBooks).map(normalizeFolderBook));
        },
        rollback(error) {
          setFolderBooks(previousFolderBooks);
          setFolderError(errorMessage(error, '无法保存文件夹顺序'));
        },
      });
    },
    [readFolderSession, runFolderMutation, setFolderBooks, setFolderError],
  );

  return useMemo(
    () => ({
      createFolder,
      moveFolderBookToShelf: moveFolderBookToShelfMutation,
      moveShelfBookToFolder: moveShelfBookToFolderMutation,
      saveFolderBookOrder,
      saveShelfItemOrder,
    }),
    [
      createFolder,
      moveFolderBookToShelfMutation,
      moveShelfBookToFolderMutation,
      saveFolderBookOrder,
      saveShelfItemOrder,
    ],
  );
}
