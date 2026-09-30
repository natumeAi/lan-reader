import { useEffect, useState } from 'react';
import { isEpubFile } from './useUploadBooks.js';

export function useFileDropImport({ enabled, onFiles }: {
  enabled: boolean;
  onFiles: (files: File[]) => unknown;
}) {
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const [rejection, setRejection] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const isFileEvent = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => {
      if (!isFileEvent(event)) return;
      event.preventDefault();
      depth += 1;
      setRejection('');
      setIsFileDragOver(true);
    };
    const over = (event: DragEvent) => {
      if (!isFileEvent(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setIsFileDragOver(true);
    };
    const leave = (event: DragEvent) => {
      if (!isFileEvent(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setIsFileDragOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!isFileEvent(event)) return;
      event.preventDefault();
      depth = 0;
      setIsFileDragOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      const accepted = files.filter(isEpubFile);
      setRejection(accepted.length < files.length || !accepted.length ? '只支持 EPUB 文件' : '');
      if (accepted.length) void onFiles(accepted);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      setIsFileDragOver(false);
      setRejection('');
    };
  }, [enabled, onFiles]);

  return { isFileDragOver: enabled && isFileDragOver, rejection: enabled ? rejection : '' };
}
