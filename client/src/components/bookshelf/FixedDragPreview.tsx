import type { DragPreviewItem } from '../../hooks/useLibraryDrag.js';
import type { DragPreviewMotion } from '../../utils/dragPreviewMotion.js';
import { useLayoutEffect, useRef } from 'react';
import { DragPreview } from './DragPreview.js';

interface FixedDragPreviewProps {
  /** True only while a Folder book is being carried onto the shelf. */
  active: boolean;
  item: DragPreviewItem | null;
  motion: DragPreviewMotion;
}


export function FixedDragPreview({ active, item, motion }: FixedDragPreviewProps) {
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

  return (
    <div className="fixed-drag-preview" ref={elementRef}>
      <DragPreview item={item} />
    </div>
  );
}
