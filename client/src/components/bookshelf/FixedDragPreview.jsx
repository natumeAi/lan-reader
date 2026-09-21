import { DragPreview } from './DragPreview.jsx';

export function FixedDragPreview({ item, point }) {
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
