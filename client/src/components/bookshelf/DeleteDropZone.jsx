import { useDroppable } from '@dnd-kit/core';

export const DELETE_DROPZONE_ID = 'book-delete-dropzone';

export function DeleteDropZone({ visible }) {
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
      className={`delete-drop-zone${isOver ? ' is-over' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="delete-drop-zone-icon" aria-hidden="true" />
      <span>删除</span>
    </div>
  );
}
