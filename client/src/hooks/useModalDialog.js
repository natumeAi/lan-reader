import { useCallback, useEffect, useRef } from 'react';

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(element) {
  if (
    !element.isConnected ||
    element.hidden ||
    element.closest('[hidden], [aria-hidden="true"]')
  ) {
    return false;
  }

  for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  return true;
}

function focusableElements(dialog) {
  return [...dialog.querySelectorAll(focusableSelector)].filter(isVisible);
}

export function useModalDialog({
  initialFocusRef,
  onRequestClose,
  open,
  restoreFocus = true,
}) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    previousFocusRef.current = document.activeElement;
    const animationFrame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const initialTarget = initialFocusRef?.current;
      const target = initialTarget && !initialTarget.matches(':disabled') && isVisible(initialTarget)
        ? initialTarget
        : focusableElements(dialog)[0] || dialog;
      target.focus();
    });

    return () => {
      cancelAnimationFrame(animationFrame);
      const previousFocus = previousFocusRef.current;
      if (restoreFocus && previousFocus?.isConnected) previousFocus.focus();
      previousFocusRef.current = null;
    };
  }, [initialFocusRef, open, restoreFocus]);

  const onKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onRequestClose?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const elements = focusableElements(dialog);
    if (elements.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = elements[0];
    const last = elements[elements.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onRequestClose]);

  return { dialogRef, onKeyDown };
}
