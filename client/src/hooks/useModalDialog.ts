import type { KeyboardEvent, RefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { requestFrameOrTimeout } from '../utils/animationFrame.js';

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(element: HTMLElement) {
  if (
    !element.isConnected ||
    element.hidden ||
    element.closest('[hidden], [aria-hidden="true"]')
  ) {
    return false;
  }

  for (let current: HTMLElement | null = element; current instanceof HTMLElement; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  return true;
}

function focusableElements(dialog: HTMLElement) {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(isVisible);
}

export function useModalDialog({
  initialFocusRef,
  onRequestClose,
  open,
  restoreFocus = true,
  returnFocusElement,
}: { returnFocusElement?: HTMLElement | null; initialFocusRef?: RefObject<HTMLElement | null>; onRequestClose?: () => void; open: boolean; restoreFocus?: boolean | (() => boolean) }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = returnFocusElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // Bounded: a visible page that delivers no frames must still move focus
    // into the dialog, or Escape/Tab containment never engage.
    const cancelInitialFocus = requestFrameOrTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initialTarget = initialFocusRef?.current;
      const target = initialTarget && !initialTarget.matches(':disabled') && isVisible(initialTarget)
        ? initialTarget
        : focusableElements(dialog)[0] || dialog;
      target.focus({ preventScroll: true });
    });

    return () => {
      cancelInitialFocus();
      const previousFocus = previousFocusRef.current;
      const shouldRestore = typeof restoreFocus === 'function' ? restoreFocus() : restoreFocus;
      if (shouldRestore && previousFocus?.isConnected) previousFocus.focus();
      previousFocusRef.current = null;
    };
  }, [initialFocusRef, open, restoreFocus, returnFocusElement]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onRequestClose?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const elements = focusableElements(dialog);
    if (!elements[0]) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = elements[0];
    const last = elements[elements.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last?.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }, [onRequestClose]);

  return { dialogRef, onKeyDown };
}
