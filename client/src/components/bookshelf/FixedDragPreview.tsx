import type { DragPreviewItem } from '../../hooks/useLibraryDrag.js';
import { DragPreview } from './DragPreview.js';

interface FixedDragPreviewProps {
  item: DragPreviewItem | null;
  point: { x: number; y: number } | null;
}


export function FixedDragPreview({ item, point }: FixedDragPreviewProps) {
  if (!item || !point) {
    return null;
  }

  return (
    <div
      className="fixed-drag-preview"
      style={{
        left: point.x,
        top: point.y,
      }}
    >
      <DragPreview item={item} />
    </div>
  );
}
