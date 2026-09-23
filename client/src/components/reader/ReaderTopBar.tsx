export function ReaderTopBar({ onClose, title }: { onClose: () => void; title?: string }) {
  return (
    <header className="reader-header">
      <button
        className="reader-close-button"
        type="button"
        aria-label="返回"
        onClick={onClose}
      >
        <span aria-hidden="true" />
      </button>
      <span className="reader-title">{title || ''}</span>
    </header>
  );
}
