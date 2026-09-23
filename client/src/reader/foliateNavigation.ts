import type { View } from 'foliate-js/view.js';
import type { FoliateBook, NavigationTarget } from './foliateTypes';


export type TurnDirection = 'next' | 'prev';
export function adjacentPageTarget(view: View, book: FoliateBook, direction: TurnDirection): NavigationTarget | null {
  const index = view.lastLocation?.section?.current ?? 0;
  const delta = direction === 'next' ? 1 : -1;
  const total = view.renderer.pages - 2;
  const page = view.renderer.page + delta;
  if (page >= 1 && page <= total) return { index, anchor: total > 1 ? (page - 1) / (total - 1) : 0 };
  let adjacent = index + delta;
  while (book.sections[adjacent]?.linear === 'no') adjacent += delta;
  return book.sections[adjacent] ? { index: adjacent, anchor: delta > 0 ? 0 : 1 } : null;
}

/** Foreground and preview use the same public navigation, including FXL spreads. */
export async function turnAdjacentView(view: View, book: FoliateBook, direction: TurnDirection) {
  if (view.isFixedLayout) {
    const before = view.lastLocation?.cfi;
    const beforeIndex = view.lastLocation?.section?.current;
    await view.renderer[direction]();
    const index = view.lastLocation?.section?.current;
    if (index !== undefined && book.sections[index]?.linear === 'no') {
      const delta = direction === 'next' ? 1 : -1;
      let target = index + delta;
      while (book.sections[target]?.linear === 'no') target += delta;
      // Keep native physical spreads and original section indices. Repeating
      // prev could skip a linear partner in the spread we just reached.
      if (book.sections[target]) await view.renderer.goTo({ index: target });
      else if (beforeIndex !== undefined) { await view.renderer.goTo({ index: beforeIndex }); return false; }
    }
    return view.lastLocation?.cfi !== before;
  }
  const target = adjacentPageTarget(view, book, direction);
  if (!target) return false;
  await view.renderer.goTo(target);
  return true;
}


