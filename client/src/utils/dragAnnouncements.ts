import type { Announcements, ScreenReaderInstructions } from '@dnd-kit/core';
import type { DragIntent } from '../hooks/useLibraryDrag.js';
import { DELETE_DROPZONE_ID } from '../components/bookshelf/DeleteDropZone.js';

type Lookup = (key: string) => string | null;
export interface DragAnnouncementContext { isFolderExitPending: boolean; hasFolderExitHandoff?: boolean }

export const DRAG_SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable: '按空格拿起；拿起后用方向键移动，再按空格放下，按 Esc 取消。回车打开。',
};

export function createDragAnnouncements(
  lookup: Lookup,
  context: () => DragAnnouncementContext = () => ({ isFolderExitPending: false }),
): Announcements {
  const name = (key: string | number) => lookup(String(key)) ?? '这本书';
  let awaitingInitialOver = false;
  let awaitingHandoffOver = true;
  return {
    onDragStart: ({ active }) => {
      awaitingInitialOver = true;
      awaitingHandoffOver = true;
      return `已拿起${name(active.id)}`;
    },
    onDragOver: ({ active, over }) => {
      // dnd-kit immediately reports the active card after pickup. Preserve the pickup
      // announcement instead of replacing it before a screen reader can speak it.
      const initialOver = awaitingInitialOver;
      awaitingInitialOver = false;
      if (initialOver && (!over || over.id === active.id)) return undefined;
      // The panel hint owns the pending exit message.
      const exitContext = context();
      if (exitContext.isFolderExitPending) return undefined;
      // Unregistering the panel reports a redundant no-target over at handoff.
      // Preserve the completed message; a later shelf no-target over is still spoken.
      if (exitContext.hasFolderExitHandoff && awaitingHandoffOver) {
        awaitingHandoffOver = false;
        if (!over || over.id === active.id) return undefined;
      }
      // The delete zone owns its own status message; it is not a sorting position.
      if (over?.id === DELETE_DROPZONE_ID) return undefined;
      // A drop takes the index of `over` (arrayMove), so moving forwards lands after it and
      // backwards before it; "its position" is the phrasing that is true in both directions.
      return over && over.id !== active.id ? `将移到${name(over.id)}的位置` : '位置未变';
    },
    onDragEnd: ({ active }) => {
      awaitingInitialOver = false;
      awaitingHandoffOver = false;
      return `已放下${name(active.id)}`;
    },
    onDragCancel: ({ active }) => {
      awaitingInitialOver = false;
      awaitingHandoffOver = false;
      return `已取消，${name(active.id)}回到原位`;
    },
  };
}

/** Intent has its own live region because merge/absorb collisions stay on the active card. */
export function dragIntentAnnouncement(intent: DragIntent, lookup: Lookup, hasFolderExitHandoff = false): string {
  if (intent.type === 'merge') {
    const name = lookup(intent.targetKey) ?? '这本书';
    return intent.armed ? `松手将与${name}合并为文件夹` : `继续停留以合并${name}`;
  }
  if (intent.type === 'absorb') {
    const name = lookup(intent.targetKey) ?? '这个文件夹';
    return intent.armed ? `松手移入文件夹${name}` : `继续停留以移入文件夹${name}`;
  }
  return hasFolderExitHandoff ? '已移到书架，继续拖动选择位置' : '';
}
