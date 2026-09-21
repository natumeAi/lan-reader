import { useCallback, useEffect, useRef, useState } from 'react';
import { IMAGE_VIEWER_TRANSITION_MS } from '../utils/imageViewerMotion.js';
import {
  hasImageViewerHistoryState,
  readerBookIdFromHistoryState,
  withImageViewerHistoryState,
} from '../utils/readerHistoryState.js';

export function useImageViewerSession({ bookId, reducedMotion = false }) {
  const [contentImage, setContentImage] = useState(null);
  const [isClosing, setIsClosing] = useState(false);
  const [viewerKey, setViewerKey] = useState(0);
  const contentImageRef = useRef(null);
  const lastContentImageRef = useRef(null);
  const closeTimerRef = useRef(null);
  const closingRef = useRef(false);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const finishClose = useCallback(() => {
    clearCloseTimer();
    contentImageRef.current = null;
    closingRef.current = false;
    setContentImage(null);
    setIsClosing(false);
  }, [clearCloseTimer]);

  const beginClose = useCallback(() => {
    if (!contentImageRef.current || closingRef.current) return false;
    if (reducedMotion) {
      finishClose();
      return true;
    }

    closingRef.current = true;
    setIsClosing(true);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      finishClose();
    }, IMAGE_VIEWER_TRANSITION_MS);
    return true;
  }, [finishClose, reducedMotion]);

  const showImage = useCallback((image) => {
    clearCloseTimer();
    contentImageRef.current = image;
    closingRef.current = false;
    setContentImage(image);
    setIsClosing(false);
    setViewerKey((key) => key + 1);
  }, [clearCloseTimer]);

  const reopenLastImage = useCallback(() => {
    const image = lastContentImageRef.current;
    if (!image) return false;
    showImage(image);
    return true;
  }, [showImage]);

  const openImage = useCallback((image) => {
    if (!image?.source) return false;
    lastContentImageRef.current = image;
    showImage(image);

    try {
      if (!hasImageViewerHistoryState(window.history.state)) {
        window.history.pushState(
          withImageViewerHistoryState(window.history.state),
          '',
          window.location.href,
        );
      }
    } catch {
      // The viewer remains usable when browser history is unavailable.
    }
    return true;
  }, [showImage]);

  const requestClose = useCallback(() => {
    if (!contentImageRef.current) return false;
    if (!beginClose()) return true;
    if (hasImageViewerHistoryState(window.history.state)) {
      try {
        window.history.back();
      } catch {
        // The already-started close still completes without history support.
      }
    }
    return true;
  }, [beginClose]);

  useEffect(() => {
    const handlePopState = (event) => {
      if (readerBookIdFromHistoryState(event.state) !== Number(bookId)) return;

      if (hasImageViewerHistoryState(event.state)) {
        if (!contentImageRef.current || closingRef.current) reopenLastImage();
        return;
      }

      if (contentImageRef.current) beginClose();
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [beginClose, bookId, reopenLastImage]);

  useEffect(() => () => {
    clearCloseTimer();
  }, [clearCloseTimer]);

  return {
    contentImage,
    isClosing,
    openImage,
    requestClose,
    viewerKey,
  };
}
