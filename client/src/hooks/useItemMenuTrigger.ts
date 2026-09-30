import { useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { ShelfItem } from '../types/library.js';
import type { ItemMenuRequest } from './useShelfItemMenu.js';

/**
 * Shared menu input for all three card types: the ⋯ button, a mouse right-click and the menu
 * key. A touch long press belongs to dragging and never opens the menu.
 */
export function useItemMenuTrigger(key: string, onRequest?: (request: ItemMenuRequest) => void, item?: ShelfItem) {
  const lastPointerType = useRef('');
  // The focused element becomes the menu's opener, so focus returns to it when the menu closes.
  const request = (opener: HTMLElement, anchor: Element | null | undefined) => {
    if (!onRequest) return;
    opener.focus({ preventScroll: true });
    onRequest({ key, item, anchorRect: anchor?.getBoundingClientRect() ?? null });
  };
  const openFromCard = (card: HTMLButtonElement) => request(card, card.querySelector('.book-cover, .folder-cover'));
  return {
    enabled: Boolean(onRequest),
    onMoreClick(event: MouseEvent<HTMLButtonElement>) { request(event.currentTarget, event.currentTarget); },
    onPointerDown(event: PointerEvent<HTMLButtonElement>) { lastPointerType.current = event.pointerType; },
    onContextMenu(event: MouseEvent<HTMLButtonElement>) {
      if (!onRequest) return;
      event.preventDefault();
      const native = event.nativeEvent;
      const pointerType = 'pointerType' in native && typeof native.pointerType === 'string' && native.pointerType
        ? native.pointerType : lastPointerType.current;
      if (pointerType !== 'touch') openFromCard(event.currentTarget);
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (!onRequest || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return false;
      event.preventDefault();
      event.stopPropagation();
      openFromCard(event.currentTarget);
      return true;
    },
  };
}
