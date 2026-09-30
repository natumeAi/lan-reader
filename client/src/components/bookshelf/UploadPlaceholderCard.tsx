import type { UploadEntry } from '../../hooks/useUploadBooks.js';
import { ShelfItemLabel } from './ShelfItemLabel.js';

export interface UploadPlaceholderActions {
  onRetryUpload?: (id: string) => unknown;
  onRemoveUpload?: (id: string) => void;
}

export function UploadPlaceholderCard({ entry, onRetryUpload, onRemoveUpload }: {
  entry: UploadEntry;
} & UploadPlaceholderActions) {
  const status = entry.status === 'queued' ? '排队中' : entry.status === 'failed' ? '上传失败'
    : entry.status === 'uploaded' ? '正在更新书架' : '上传中';
  return (
    <div className={`upload-placeholder is-${entry.status}`} data-upload-id={entry.id}>
      <div className="book-cover upload-placeholder-cover">
        <span className="upload-placeholder-status" role="status" aria-live="polite" aria-label={`${entry.fileName}，${status}`}>{status}</span>
        {entry.status === 'uploading' ? <span className="upload-placeholder-progress" aria-hidden="true" /> : null}
        {entry.status === 'failed' ? <>
          <p className="upload-placeholder-error">{entry.error}</p>
        </> : null}
      </div>
      <ShelfItemLabel name={entry.fileName} meta={status} />
      {entry.status === 'failed' ? <div className="upload-placeholder-actions">
        <button type="button" onClick={() => void onRetryUpload?.(entry.id)} aria-label={`重试上传 ${entry.fileName}`}>重试</button>
        <button type="button" onClick={() => onRemoveUpload?.(entry.id)} aria-label={`移除 ${entry.fileName}`}>移除</button>
      </div> : null}
    </div>
  );
}
