import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import { useModalDialog } from '../../hooks/useModalDialog.js';
import { prepareSvgContentImageSource } from '../../utils/contentImage.js';
import { IMAGE_VIEWER_TRANSITION_MS } from '../../utils/imageViewerMotion.js';
import {
  IMAGE_VIEWER_DOUBLE_TAP_SCALE,
  createImageViewerTransform,
  panImageViewerBy,
  resizeImageViewerTransform,
  settleImageViewerTransform,
  zoomImageViewerAt,
} from '../../utils/imageViewerTransform.js';

const DOUBLE_TAP_MAX_DELAY_MS = 320;
const DOUBLE_TAP_MAX_DISTANCE_PX = 32;
const TAP_MOVE_TOLERANCE_PX = 8;
const WHEEL_ZOOM_RATE = 0.002;

function initialSourceForContentImage(contentImage) {
  return contentImage?.kind === 'svg' ? '' : contentImage?.source || '';
}

function emptyTransform(contentImage) {
  return createImageViewerTransform({
    imageHeight: contentImage?.intrinsicHeight,
    imageWidth: contentImage?.intrinsicWidth,
    viewportHeight: 0,
    viewportWidth: 0,
  });
}

function pointerDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointerMidpoint(first, second) {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

export function ImageViewer({
  contentImage,
  isClosing = false,
  onRequestClose,
  reducedMotion = false,
}) {
  const viewportRef = useRef(null);
  const imageRef = useRef(null);
  const closeButtonRef = useRef(null);
  const pointersRef = useRef(new Map());
  const gestureRef = useRef(null);
  const lastTapRef = useRef(null);
  const [loadState, setLoadState] = useState('loading');
  const [isTransformAnimating, setIsTransformAnimating] = useState(false);
  const [transform, setTransform] = useState(() => emptyTransform(contentImage));
  const transformRef = useRef(transform);
  const transformAnimationTimerRef = useRef(null);
  const [imageSource, setImageSource] = useState(() => (
    initialSourceForContentImage(contentImage)
  ));
  const { dialogRef, onKeyDown: onDialogKeyDown } = useModalDialog({
    initialFocusRef: closeButtonRef,
    onRequestClose,
    open: true,
  });

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  const commitTransform = useCallback((nextOrUpdater) => {
    const next = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(transformRef.current)
      : nextOrUpdater;
    transformRef.current = next;
    setTransform(next);
    return next;
  }, []);

  const stopTransformAnimation = useCallback(() => {
    if (transformAnimationTimerRef.current !== null) {
      clearTimeout(transformAnimationTimerRef.current);
      transformAnimationTimerRef.current = null;
    }
    setIsTransformAnimating(false);
  }, []);

  const animateTransform = useCallback((next) => {
    stopTransformAnimation();
    commitTransform(next);
    if (reducedMotion) return;
    setIsTransformAnimating(true);
    transformAnimationTimerRef.current = setTimeout(() => {
      transformAnimationTimerRef.current = null;
      setIsTransformAnimating(false);
    }, IMAGE_VIEWER_TRANSITION_MS);
  }, [commitTransform, reducedMotion, stopTransformAnimation]);

  const measureViewport = useCallback((image = imageRef.current) => {
    const viewport = viewportRef.current;
    if (!viewport || !image) return;
    const viewportRect = viewport.getBoundingClientRect();
    const naturalWidth = Number(image.naturalWidth);
    const naturalHeight = Number(image.naturalHeight);
    const intrinsicWidth = Number(contentImage?.intrinsicWidth);
    const intrinsicHeight = Number(contentImage?.intrinsicHeight);
    const imageWidth = contentImage?.kind === 'url'
      ? naturalWidth || intrinsicWidth
      : intrinsicWidth || naturalWidth;
    const imageHeight = contentImage?.kind === 'url'
      ? naturalHeight || intrinsicHeight
      : intrinsicHeight || naturalHeight;
    commitTransform((current) => {
      if (!current.viewportWidth || !current.viewportHeight) {
        return createImageViewerTransform({
          imageHeight,
          imageWidth,
          viewportHeight: viewportRect.height,
          viewportWidth: viewportRect.width,
        });
      }
      return resizeImageViewerTransform({
        ...current,
        imageHeight,
        imageWidth,
      }, {
        viewportHeight: viewportRect.height,
        viewportWidth: viewportRect.width,
      });
    });
  }, [commitTransform, contentImage]);

  useEffect(() => {
    setLoadState('loading');
    commitTransform(emptyTransform(contentImage));
    pointersRef.current.clear();
    gestureRef.current = null;
    lastTapRef.current = null;
    stopTransformAnimation();
  }, [commitTransform, contentImage, stopTransformAnimation]);

  useEffect(() => {
    if (contentImage?.kind !== 'svg') {
      setImageSource(contentImage?.source || '');
      return undefined;
    }

    let canceled = false;
    let objectUrl = '';
    const controller = typeof globalThis.AbortController === 'function'
      ? new globalThis.AbortController()
      : null;
    setImageSource('');
    prepareSvgContentImageSource(contentImage, { signal: controller?.signal })
      .then((source) => {
        if (canceled) return;
        if (
          typeof globalThis.URL?.createObjectURL === 'function' &&
          typeof globalThis.Blob === 'function'
        ) {
          objectUrl = globalThis.URL.createObjectURL(
            new globalThis.Blob([source], { type: 'image/svg+xml' }),
          );
          setImageSource(objectUrl);
          return;
        }
        setImageSource(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`);
      })
      .catch((error) => {
        if (canceled || error?.name === 'AbortError') return;
        setLoadState('error');
      });

    return () => {
      canceled = true;
      controller?.abort();
      if (objectUrl && typeof globalThis.URL?.revokeObjectURL === 'function') {
        globalThis.URL.revokeObjectURL(objectUrl);
      }
    };
  }, [contentImage]);

  useEffect(() => () => {
    if (transformAnimationTimerRef.current !== null) {
      clearTimeout(transformAnimationTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const handleResize = () => measureViewport();
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [measureViewport]);

  const handleImageLoad = useCallback((event) => {
    setLoadState('ready');
    measureViewport(event.currentTarget);
  }, [measureViewport]);

  const pointInViewport = useCallback((clientX, clientY) => {
    const viewportRect = viewportRef.current?.getBoundingClientRect?.();
    return {
      x: clientX - (viewportRect?.left || 0),
      y: clientY - (viewportRect?.top || 0),
    };
  }, []);

  const handlePointerDown = useCallback((event) => {
    if (event.button !== 0 || (event.pointerType !== 'touch' && event.isPrimary === false)) {
      return;
    }
    const pointer = {
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startedOnImage: event.target === imageRef.current,
      x: event.clientX,
      y: event.clientY,
    };
    stopTransformAnimation();
    pointersRef.current.set(event.pointerId, pointer);
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an optimization; the gesture remains usable without it.
    }

    const pointers = [...pointersRef.current.values()];
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      const distance = pointerDistance(first, second);
      if (distance > 0) {
        gestureRef.current = {
          kind: 'pinch',
          startDistance: distance,
          startMidpoint: pointerMidpoint(first, second),
          startTransform: transformRef.current,
        };
        pointers.forEach((activePointer) => {
          activePointer.moved = true;
        });
        lastTapRef.current = null;
      }
    } else {
      gestureRef.current = transformRef.current.scale > 1
        ? {
            kind: 'pan',
            pointerId: event.pointerId,
            startTransform: transformRef.current,
          }
        : { kind: 'pending', pointerId: event.pointerId };
    }
  }, [stopTransformAnimation]);

  const handlePointerMove = useCallback((event) => {
    const pointer = pointersRef.current.get(event.pointerId);
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (
      Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >
      TAP_MOVE_TOLERANCE_PX
    ) {
      pointer.moved = true;
    }

    const gesture = gestureRef.current;
    if (gesture?.kind === 'pan' && gesture.pointerId === event.pointerId) {
      commitTransform(panImageViewerBy(
        gesture.startTransform,
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
        { resist: true },
      ));
      if (event.cancelable) event.preventDefault();
      return;
    }
    if (gesture?.kind !== 'pinch') return;
    const pointers = [...pointersRef.current.values()];
    if (pointers.length < 2) return;
    const [first, second] = pointers;
    const distance = pointerDistance(first, second);
    if (!gesture.startDistance || !distance) return;
    const midpoint = pointerMidpoint(first, second);
    const startPoint = pointInViewport(
      gesture.startMidpoint.x,
      gesture.startMidpoint.y,
    );
    const zoomed = zoomImageViewerAt(
      gesture.startTransform,
      gesture.startTransform.scale * (distance / gesture.startDistance),
      startPoint,
    );
    commitTransform(panImageViewerBy(
      zoomed,
      midpoint.x - gesture.startMidpoint.x,
      midpoint.y - gesture.startMidpoint.y,
      { resist: true },
    ));
    if (event.cancelable) event.preventDefault();
  }, [commitTransform, pointInViewport]);

  const handlePointerUp = useCallback((event) => {
    const pointer = pointersRef.current.get(event.pointerId);
    if (!pointer) return;
    const gesture = gestureRef.current;
    const wasPinching = gesture?.kind === 'pinch';
    pointersRef.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Browsers can release capture before pointerup.
    }
    if (wasPinching) {
      const settled = settleImageViewerTransform(transformRef.current);
      const remaining = [...pointersRef.current.values()];
      if (remaining.length === 1) {
        stopTransformAnimation();
        commitTransform(settled);
        const [activePointer] = remaining;
        activePointer.startX = activePointer.x;
        activePointer.startY = activePointer.y;
        activePointer.moved = true;
        gestureRef.current = settled.scale > 1
          ? {
              kind: 'pan',
              pointerId: activePointer.pointerId,
              startTransform: settled,
            }
          : {
              kind: 'pending',
              pointerId: activePointer.pointerId,
            };
      } else {
        animateTransform(settled);
        gestureRef.current = null;
      }
      return;
    }

    if (gesture?.kind === 'pan') {
      gestureRef.current = null;
      animateTransform(settleImageViewerTransform(transformRef.current));
      return;
    }

    gestureRef.current = null;
    if (pointer.moved) return;

    if (!pointer.startedOnImage) {
      if (transformRef.current.scale === 1) onRequestClose?.();
      return;
    }

    const now = Number(event.timeStamp) || performance.now();
    const previousTap = lastTapRef.current;
    const isDoubleTap = Boolean(
      previousTap &&
      now - previousTap.time <= DOUBLE_TAP_MAX_DELAY_MS &&
      Math.hypot(event.clientX - previousTap.x, event.clientY - previousTap.y) <=
        DOUBLE_TAP_MAX_DISTANCE_PX
    );
    if (!isDoubleTap) {
      lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
      return;
    }

    lastTapRef.current = null;
    const current = transformRef.current;
    const nextScale = current.scale > 1
      ? 1
      : IMAGE_VIEWER_DOUBLE_TAP_SCALE;
    animateTransform(zoomImageViewerAt(
      current,
      nextScale,
      pointInViewport(event.clientX, event.clientY),
    ));
  }, [animateTransform, commitTransform, onRequestClose, pointInViewport, stopTransformAnimation]);

  const handlePointerCancel = useCallback(() => {
    pointersRef.current.clear();
    gestureRef.current = null;
    animateTransform(settleImageViewerTransform(transformRef.current));
  }, [animateTransform]);

  const handleWheel = useCallback((event) => {
    const current = transformRef.current;
    const unit = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? current.viewportHeight
        : 1;
    const delta = event.deltaY * unit;
    if (!Number.isFinite(delta) || delta === 0) return;
    event.preventDefault();
    lastTapRef.current = null;
    stopTransformAnimation();
    commitTransform(zoomImageViewerAt(
      current,
      current.scale * Math.exp(-delta * WHEEL_ZOOM_RATE),
      pointInViewport(event.clientX, event.clientY),
    ));
  }, [commitTransform, pointInViewport, stopTransformAnimation]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const handleKeyDown = useCallback((event) => {
    onDialogKeyDown(event);
    if (event.key === 'Escape') event.stopPropagation();
  }, [onDialogKeyDown]);

  return createElement(
    'div',
    {
      'aria-label': '图片查看器',
      'aria-modal': 'true',
      className: [
        'image-viewer',
        transform.scale > 1 ? 'is-zoomed' : '',
        isTransformAnimating ? 'is-transform-animating' : '',
        isClosing ? 'is-closing' : '',
        reducedMotion ? 'is-reduced-motion' : '',
      ].filter(Boolean).join(' '),
      onKeyDown: handleKeyDown,
      ref: dialogRef,
      role: 'dialog',
      style: {
        '--image-viewer-transition-duration': `${IMAGE_VIEWER_TRANSITION_MS}ms`,
      },
    },
    createElement(
      'button',
      {
        'aria-label': '关闭图片查看器',
        autoFocus: true,
        className: 'image-viewer-close',
        onClick: onRequestClose,
        ref: closeButtonRef,
        type: 'button',
      },
      createElement('span', { 'aria-hidden': 'true' }),
    ),
    createElement(
      'div',
      {
        className: 'image-viewer-viewport',
        onPointerCancel: handlePointerCancel,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        ref: viewportRef,
      },
      createElement(
        'div',
        {
          className: 'image-viewer-pan-layer',
          style: {
            transform: `translate3d(${transform.offsetX}px, ${transform.offsetY}px, 0)`,
          },
        },
        createElement('img', {
          alt: contentImage?.alt || '',
          className: `image-viewer-image${loadState === 'ready' ? ' is-ready' : ''}`,
          draggable: false,
          onDragStart: (event) => event.preventDefault(),
          onError: () => setLoadState('error'),
          onLoad: handleImageLoad,
          ref: imageRef,
          src: imageSource || undefined,
          style: {
            height: transform.baseHeight ? `${transform.baseHeight}px` : undefined,
            transform: `translate(-50%, -50%) scale(${transform.scale})`,
            width: transform.baseWidth ? `${transform.baseWidth}px` : undefined,
          },
        }),
      ),
    ),
    loadState === 'loading' && createElement(
      'div',
      {
        'aria-live': 'polite',
        className: 'image-viewer-status',
        role: 'status',
      },
      createElement('span', {
        'aria-hidden': 'true',
        className: 'reader-loading-spinner',
      }),
      createElement('span', null, '正在加载图片'),
    ),
    loadState === 'error' && createElement(
      'p',
      { className: 'image-viewer-error', role: 'alert' },
      '图片无法加载',
    ),
  );
}

export default ImageViewer;
