import { useDroppable } from '@dnd-kit/core';

export const DELETE_DROPZONE_ID = 'book-delete-dropzone';

/**
 * `visible` only means a deletable item is being dragged. `armed` means the resolved drag
 * intent is deletion, so releasing now deletes; the two must not look the same.
 */
export function DeleteDropZone({ armed, visible }: { armed: boolean; visible: boolean }) {
  const { isOver, setNodeRef } = useDroppable({
    id: DELETE_DROPZONE_ID,
    data: {
      type: 'delete-zone',
    },
    disabled: !visible,
  });

  if (!visible) {
    return null;
  }

  return (
    <div
      ref={setNodeRef}
      className={[
        'delete-drop-zone',
        isOver ? 'is-over' : '',
        armed ? 'is-armed' : '',
      ].filter(Boolean).join(' ')}
      role="status"
      aria-live="polite"
    >
      <span className="delete-drop-zone-icon" aria-hidden="true" />
      <span>{armed ? '松手删除' : '删除'}</span>
    </div>
  );
}
