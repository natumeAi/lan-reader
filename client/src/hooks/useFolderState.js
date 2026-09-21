import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listFolderBooks,
  renameFolder,
} from '../api/foldersApi.js';
import { snapshotRect } from '../utils/folderMotion.js';
import { normalizeFolderBook } from '../utils/libraryItems.js';
import { useReducedMotion } from './useReducedMotion.js';

const FOLDER_CLOSE_ANIM_MS = 200;
const REDUCED_MOTION_CLOSE_ANIM_MS = 100;

export function useFolderState({ onFolderRenamed } = {}) {
  const reducedMotion = useReducedMotion();
  const folderCloseTimeoutRef = useRef(null);
  const folderRequestRef = useRef({
    controller: null,
    folderId: null,
    requestId: 0,
  });
  const [openFolder, setOpenFolder] = useState(null);
  const [isFolderClosing, setIsFolderClosing] = useState(false);
  const [folderBooks, setFolderBooks] = useState([]);
  const [isFolderLoading, setIsFolderLoading] = useState(false);
  const [isRenamingFolder, setIsRenamingFolder] = useState(false);
  const [isSavingFolderName, setIsSavingFolderName] = useState(false);
  const [isSavingFolderOrder, setIsSavingFolderOrder] = useState(false);
  const [folderNameDraft, setFolderNameDraft] = useState('');
  const [folderError, setFolderError] = useState('');
  const [folderOriginRect, setFolderOriginRect] = useState(null);
  const [folderCloseVersion, setFolderCloseVersion] = useState(0);

  const invalidateFolderRequest = useCallback(() => {
    const current = folderRequestRef.current;
    current.controller?.abort();
    folderRequestRef.current = {
      controller: null,
      folderId: null,
      requestId: current.requestId + 1,
    };
  }, []);

  const beginFolderRequest = useCallback((folderId) => {
    invalidateFolderRequest();
    const controller = new AbortController();
    const request = {
      controller,
      folderId,
      requestId: folderRequestRef.current.requestId,
    };
    folderRequestRef.current = request;
    return request;
  }, [invalidateFolderRequest]);

  const isCurrentFolderRequest = useCallback((request) => (
    folderRequestRef.current.requestId === request.requestId &&
    folderRequestRef.current.folderId === request.folderId &&
    folderRequestRef.current.controller === request.controller
  ), []);

  const finishCloseFolder = useCallback(() => {
    invalidateFolderRequest();
    setOpenFolder(null);
    setIsFolderClosing(false);
    setFolderBooks([]);
    setFolderError('');
    setIsFolderLoading(false);
    setIsRenamingFolder(false);
    setIsSavingFolderName(false);
    setIsSavingFolderOrder(false);
    setFolderNameDraft('');
    setFolderOriginRect(null);
    setFolderCloseVersion((version) => version + 1);
  }, [invalidateFolderRequest]);

  const handleOpenFolder = useCallback((folder, options = {}) => {
    const ignoreUntil = options.ignoreUntil || 0;

    if (!folder || options.isShelfBusy || performance.now() < ignoreUntil) {
      return;
    }

    if (folderCloseTimeoutRef.current) {
      clearTimeout(folderCloseTimeoutRef.current);
      folderCloseTimeoutRef.current = null;
    }

    invalidateFolderRequest();
    setIsFolderClosing(false);
    setOpenFolder(folder);
    setFolderOriginRect(snapshotRect(options.originRect));
    setFolderBooks(
      (Array.isArray(options.books) ? options.books : []).map(normalizeFolderBook),
    );
    setFolderError('');
    setFolderNameDraft('');
    setIsRenamingFolder(false);
    setIsFolderLoading(false);
  }, [invalidateFolderRequest]);

  const handleCloseFolder = useCallback((options = {}) => {
    if (isSavingFolderName || isFolderClosing) {
      return;
    }

    invalidateFolderRequest();
    if (Object.hasOwn(options, 'originRect')) {
      setFolderOriginRect(snapshotRect(options.originRect));
    }
    setIsFolderClosing(true);
    folderCloseTimeoutRef.current = setTimeout(() => {
      folderCloseTimeoutRef.current = null;
      finishCloseFolder();
    }, reducedMotion ? REDUCED_MOTION_CLOSE_ANIM_MS : FOLDER_CLOSE_ANIM_MS);
  }, [
    finishCloseFolder,
    invalidateFolderRequest,
    isFolderClosing,
    isSavingFolderName,
    reducedMotion,
  ]);

  const handleStartFolderRename = useCallback(() => {
    if (!openFolder || isSavingFolderName) {
      return;
    }

    setFolderNameDraft(openFolder.name || '文件夹');
    setFolderError('');
    setIsRenamingFolder(true);
  }, [isSavingFolderName, openFolder]);

  const handleCancelFolderRename = useCallback(() => {
    if (isSavingFolderName) {
      return;
    }

    setIsRenamingFolder(false);
    setFolderNameDraft('');
  }, [isSavingFolderName]);

  const handleSubmitFolderRename = useCallback(
    async (event) => {
      event.preventDefault();

      if (!openFolder || isSavingFolderName) {
        return;
      }

      setIsSavingFolderName(true);
      setFolderError('');

      try {
        const data = await renameFolder(openFolder.id, folderNameDraft.trim());
        const renamedFolder = data.folder;

        setOpenFolder(renamedFolder);
        onFolderRenamed?.(renamedFolder);
        setIsRenamingFolder(false);
        setFolderNameDraft('');
      } catch (err) {
        setFolderError(err.message || '无法重命名文件夹');
      } finally {
        setIsSavingFolderName(false);
      }
    },
    [folderNameDraft, isSavingFolderName, onFolderRenamed, openFolder],
  );

  const refreshOpenFolderBooksOrClose = useCallback(async () => {
    if (!openFolder) return;
    const request = beginFolderRequest(openFolder.id);

    try {
      const data = await listFolderBooks(openFolder.id, { signal: request.controller.signal });
      if (!isCurrentFolderRequest(request)) return;
      const nextFolderBooks = (data.books || []).map(normalizeFolderBook);
      if (nextFolderBooks.length) setFolderBooks(nextFolderBooks);
      else finishCloseFolder();
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrentFolderRequest(request)) return;
      finishCloseFolder();
    }
  }, [beginFolderRequest, finishCloseFolder, isCurrentFolderRequest, openFolder]);

  useEffect(
    () => () => {
      if (folderCloseTimeoutRef.current) {
        clearTimeout(folderCloseTimeoutRef.current);
      }
      invalidateFolderRequest();
    },
    [invalidateFolderRequest],
  );

  return {
    finishCloseFolder,
    folderBooks,
    folderCloseVersion,
    folderError,
    folderNameDraft,
    folderOriginRect,
    handleCancelFolderRename,
    handleCloseFolder,
    handleOpenFolder,
    handleStartFolderRename,
    handleSubmitFolderRename,
    isFolderClosing,
    isFolderLoading,
    isRenamingFolder,
    isSavingFolderName,
    isSavingFolderOrder,
    openFolder,
    refreshOpenFolderBooksOrClose,
    setFolderBooks,
    setFolderError,
    setFolderNameDraft,
    setIsFolderLoading,
    setIsRenamingFolder,
    setIsSavingFolderOrder,
    setOpenFolder,
  };
}
