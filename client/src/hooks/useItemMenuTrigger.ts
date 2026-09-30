import { useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { ShelfItem } from '../types/library.js';
import type { ItemMenuRequest } from './useShelfItemMenu.js';

/** Shared input arbitration for all three card types. */
export function useItemMenuTrigger(key: string, onRequest?: (request: ItemMenuRequest) => void, item?: ShelfItem) {
  const lastPointerType = useRef('');
  const open = (element: HTMLButtonElement) => {
    if (!onRequest) return;
    element.focus({ preventScroll: true });
    onRequest({ key, item, anchorRect: element.querySelector('.book-cover, .folder-cover')?.getBoundingClientRect() ?? null });
  };
  return {
    open,
    onPointerDown(event: PointerEvent<HTMLButtonElement>) { lastPointerType.current = event.pointerType; },
    onContextMenu(event: MouseEvent<HTMLButtonElement>) {
      if (!onRequest) return;
      event.preventDefault();
      const native = event.nativeEvent;
      const pointerType = 'pointerType' in native && typeof native.pointerType === 'string' && native.pointerType
        ? native.pointerType : lastPointerType.current;
      if (pointerType !== 'touch') open(event.currentTarget);
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (!onRequest || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return false;
      event.preventDefault();
      event.stopPropagation();
      open(event.currentTarget);
      return true;
    },
  };
}
