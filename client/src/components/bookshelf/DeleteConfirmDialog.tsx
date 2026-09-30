import type { Book } from '../../types/library.js';
import { useRef } from 'react';
import { useModalDialog } from '../../hooks/useModalDialog.js';

interface DeleteConfirmDialogProps {
  book?: Book | null;
  books?: Book[];
  error?: string;
  returnFocusElement?: HTMLElement | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}


export function DeleteConfirmDialog({ book, books, error, returnFocusElement, isDeleting, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, onKeyDown } = useModalDialog({
    initialFocusRef: cancelButtonRef,
    onRequestClose: onCancel,
    open: Boolean(book || books?.length),
    returnFocusElement,
  });

  if (!book && !books?.length) return null;
  const title = book?.title || '这本书';

  return (
    <div
      ref={dialogRef}
      className="delete-confirm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
      onKeyDown={event => { event.stopPropagation(); onKeyDown(event); }}
      tabIndex={-1}
    >
      <div className="delete-confirm-backdrop" />
      <section className="delete-confirm-panel">
        <h2 id="delete-confirm-title">{books ? `删除 ${books.length} 本书？` : `删除《${title}》？`}</h2>
        <p>这会从书架和服务器中移除 EPUB 文件。</p>
        {error ? <p className="delete-confirm-error" role="alert" tabIndex={0}>{error}</p> : null}
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
