/**
 * Finds the rendered cover of a Book that a reader transition may fly to.
 *
 * Several mounted views can contain the same Book (the home 正在读 list, the bookshelf and
 * an open Folder). Covers inside a hidden or inert view, or without a laid-out box, are not
 * valid transition targets, so the first *visible* cover in document order wins.
 */
export function findVisibleBookCoverRect(bookId: number, root: ParentNode = document): DOMRect | null {
  if (!Number.isInteger(bookId) || bookId <= 0) return null;

  const candidates = root.querySelectorAll(`[data-book-id="${bookId}"] .book-cover`);
  for (const candidate of candidates) {
    if (candidate.closest('[hidden], [inert]')) continue;
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}
