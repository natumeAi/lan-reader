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
   * Size in px of the card the drag started from. The fixed preview uses DragOverlay's box
   * so its top-aligned content stays in place through the handoff.
   */
  width?: number | null;
  height?: number | null;
}


export function FixedDragPreview({ active, item, motion, width = null, height = null }: FixedDragPreviewProps) {
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

  // Only the size variables are React's; the transform is never part of this style object.
  const style = {
    '--drag-preview-width': width && width > 0 ? `${width}px` : undefined,
    '--drag-preview-height': height && height > 0 ? `${height}px` : undefined,
  } as CSSProperties;

  return (
    <div className="fixed-drag-preview" ref={elementRef} style={style}>
      <DragPreview item={item} />
    </div>
  );
}
