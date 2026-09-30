import { useId, useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useModalDialog } from '../../hooks/useModalDialog.js';
import { usePageScrollLock } from '../../hooks/usePageScrollLock.js';

interface ActionSheetProps {
  title: string;
  anchorRect: DOMRect | null;
  onClose: () => void;
  children: ReactNode;
  returnFocusElement?: HTMLElement | null;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/** Fallback removal if the exit copy never reports `animationend` (hidden tab, no frames). */
const EXIT_COPY_TIMEOUT_MS = 800;

/**
 * A closing sheet slides back down. Parents close it by unmounting it, often in the same step
 * as the chosen action (opening a book, asking to delete), so focus return and inertness stay
 * immediate: an inert copy of the sheet is left in the document to play the exit, then removes
 * itself. Only a sheet that slid in slides out; the anchored popover on wide screens and
 * reduced motion have no enter animation.
 */
function leaveExitCopy(overlay: HTMLElement) {
  const panel = overlay.querySelector('.action-sheet-panel');
  if (!panel || window.getComputedStyle(panel).animationName === 'none') return;
  const copy = overlay.cloneNode(true) as HTMLElement;
  for (const attribute of ['role', 'aria-modal', 'aria-labelledby', 'tabindex']) copy.removeAttribute(attribute);
  copy.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  copy.classList.add('is-leaving');
  queueMicrotask(() => {
    // StrictMode's rehearsal unmount keeps the node in place; only a real close removes it.
    if (overlay.isConnected) return;
    document.body.append(copy);
    const remove = () => copy.remove();
    copy.querySelector('.action-sheet-panel')?.addEventListener('animationend', remove, { once: true });
    window.setTimeout(remove, EXIT_COPY_TIMEOUT_MS);
  });
}

/** One modal lifetime, including when the action list changes into a picker. */
export function ActionSheet({ title, anchorRect, onClose, children, returnFocusElement, initialFocusRef }: ActionSheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  /**
   * Set only by a pointer press that starts on the backdrop. The press that opened the sheet
   * began on the page before the backdrop existed, so a click (and compatibility mousedown)
   * the browser synthesizes from its release can land on the backdrop without one and must not
   * dismiss the sheet.
   */
  const backdropPressRef = useRef(false);
  const { dialogRef, onKeyDown } = useModalDialog({ open: true, onRequestClose: onClose, returnFocusElement, initialFocusRef });
  usePageScrollLock();
  useLayoutEffect(() => {
    const overlay = dialogRef.current;
    return () => { if (overlay) leaveExitCopy(overlay); };
  }, [dialogRef]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const place = () => {
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const preferredLeft = anchorRect ? anchorRect.right + 8 : (window.innerWidth - width) / 2;
      const left = preferredLeft + width <= window.innerWidth - 12 ? preferredLeft
        : (anchorRect?.left ?? window.innerWidth) - width - 8;
      panel.style.setProperty('--sheet-left', `${Math.max(12, Math.min(left, window.innerWidth - width - 12))}px`);
      panel.style.setProperty('--sheet-top', `${Math.max(12, Math.min(anchorRect?.top ?? 12, window.innerHeight - height - 12))}px`);
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(panel);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [anchorRect]);
  return <div ref={dialogRef} className="action-sheet-overlay" role="dialog" aria-modal="true"
    aria-labelledby={titleId} tabIndex={-1} onKeyDown={event => {
      // A Folder beneath this sheet must never consume the same Escape.
      event.stopPropagation();
      onKeyDown(event);
    }}>
    <div className="action-sheet-backdrop" aria-hidden="true"
      onPointerDown={() => { backdropPressRef.current = true; }}
      onClick={() => {
        const pressed = backdropPressRef.current;
        backdropPressRef.current = false;
        if (pressed) onClose();
      }} />
    <section ref={panelRef} className="action-sheet-panel">
      <div className="action-sheet-handle" aria-hidden="true" />
      <header className="action-sheet-header"><h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="关闭操作菜单" onClick={onClose}>×</button>
      </header>
      <div className="action-sheet-actions">{children}</div>
    </section>
  </div>;
}
