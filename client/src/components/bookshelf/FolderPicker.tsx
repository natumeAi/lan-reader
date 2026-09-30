import { useEffect, useRef } from 'react';
import type { Folder } from '../../types/library.js';
import { FolderCover } from './FolderCover.js';

export function FolderPicker({ folders, disabled, onSelect }: {
  folders: Folder[]; disabled: boolean; onSelect: (folder: Folder) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector('button')?.focus({ preventScroll: true }); }, []);
  return <div className="folder-picker" ref={listRef}>
    {folders.map(folder => <button className="folder-picker-row" type="button" key={folder.id}
      disabled={disabled} onClick={() => onSelect(folder)}>
      <FolderCover folder={folder} disableNativeImageActions />
      <span><span className="folder-picker-name">{folder.name || '文件夹'}</span>
        <span className="folder-picker-count">{folder.bookCount} 本</span></span>
    </button>)}
  </div>;
}
