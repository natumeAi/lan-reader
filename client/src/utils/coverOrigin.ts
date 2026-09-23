/**
 * Finds the rendered cover of a Book that a reader transition may fly to.
 *
 * Several mounted views can contain the same Book (the home 正在读 list, 今年读完的书, the
 * bookshelf and an open Folder). Covers inside a hidden or inert view, or without a laid-out
 * box, are not valid transition targets. Among the valid covers the first one intersecting
 * the viewport wins, so a cover scrolled out of view does not beat one the reader can see;
 * without any on-screen cover the first valid cover in document order is used.
 */
export function findVisibleBookCoverRect(bookId: number, root: ParentNode = document): DOMRect | null {
  if (!Number.isInteger(bookId) || bookId <= 0) return null;

  let firstLaidOut: DOMRect | null = null;
  const candidates = root.querySelectorAll(`[data-book-id="${bookId}"] .book-cover`);
  for (const candidate of candidates) {
    if (candidate.closest('[hidden], [inert]')) continue;
    const rect = candidate.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    if (intersectsViewport(rect, candidate.ownerDocument.defaultView)) return rect;
    firstLaidOut ??= rect;
  }
  return firstLaidOut;
}

function intersectsViewport(rect: DOMRect, view: Window | null): boolean {
  if (!view) return true;
  return rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight;
}
