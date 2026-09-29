import type { CSSProperties } from 'react';
import type { DragPreviewItem } from '../../hooks/useLibraryDrag.js';
import type { DragPreviewMotion } from '../../utils/dragPreviewMotion.js';
import { useLayoutEffect, useRef } from 'react';
import { DragPreview } from './DragPreview.js';

interface FixedDragPreviewProps {
  /** True only while a Folder book is being carried onto the shelf. */
  active: boolean;
  item: DragPreviewItem | null;
  motion: DragPreviewMotion;
  /**
   * Width in px of the card the drag started from. Cover width is fluid, so the preview takes
   * it from the picked-up card and stays the size the cover had under the finger.
   */
  width?: number | null;
}


export function FixedDragPreview({ active, item, motion, width = null }: FixedDragPreviewProps) {
  const elementRef = useRef<HTMLDivElement>(null);

  // Position is written by the motion writer, not by React, so this element re-renders
  // only when the preview appears or disappears.
  useLayoutEffect(() => {
    motion.attach(elementRef.current);

    return () => motion.attach(null);
  }, [active, item, motion]);

  if (!item || !active) {
    return null;
  }

  // Only the width variable is React's; the transform is never part of this style object.
  const style = width && width > 0
    ? ({ '--drag-preview-width': `${width}px` } as CSSProperties)
    : undefined;

  return (
    <div className="fixed-drag-preview" ref={elementRef} style={style}>
      <DragPreview item={item} />
    </div>
  );
}
