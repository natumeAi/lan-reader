import type { Book } from '../../types/library.js';
import { useRef } from 'react';
import { useModalDialog } from '../../hooks/useModalDialog.js';

interface DeleteConfirmDialogProps {
  book: Book | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}


export function DeleteConfirmDialog({ book, isDeleting, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, onKeyDown } = useModalDialog({
    initialFocusRef: cancelButtonRef,
    onRequestClose: onCancel,
    open: Boolean(book),
  });

  if (!book) return null;
  const title = book.title || '这本书';

  return (
    <div
      ref={dialogRef}
      className="delete-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div className="delete-confirm-backdrop" />
      <section className="delete-confirm-panel">
        <h2 id="delete-confirm-title">删除《{title}》？</h2>
        <p>这会从书架和服务器中移除 EPUB 文件。</p>
        <div className="delete-confirm-actions">
          <button ref={cancelButtonRef} type="button" onClick={onCancel} disabled={isDeleting}>
            取消
          </button>
          <button className="is-danger" type="button" onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? '正在删除' : '删除'}
          </button>
        </div>
      </section>
    </div>
  );
}
