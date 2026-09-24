import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Book, RecentReadingItem } from '../../types/library.js';
import { useModalDialog } from '../../hooks/useModalDialog.js';
import { usePageScrollLock } from '../../hooks/usePageScrollLock.js';
import { BookCover } from '../bookshelf/BookCover.js';

interface RecentReadingSheetProps {
  items: RecentReadingItem[];
  onClose: () => void;
  onOpenBook: (book: Book, originRect: DOMRect | null) => void;
}

export function RecentReadingSheet({ items, onClose, onOpenBook }: RecentReadingSheetProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(0);
  const { dialogRef, onKeyDown } = useModalDialog({ open: true, onRequestClose: onClose, initialFocusRef: closeRef });
  usePageScrollLock();
  useLayoutEffect(() => {
    const list = listRef.current;
    const probe = probeRef.current;
    if (!list || !probe) return;
    const measure = () => {
      const height = list.getBoundingClientRect().height;
      const rowHeight = probe.getBoundingClientRect().height;
      const gap = Number.parseFloat(window.getComputedStyle(list).rowGap) || 0;
      setCapacity(rowHeight > 0 ? Math.max(0, Math.floor((height + gap) / (rowHeight + gap))) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(list);
    observer?.observe(probe);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, []);
  return <div ref={dialogRef} className="recent-sheet-overlay" role="dialog" aria-modal="true"
    aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
    <div className="recent-sheet-backdrop" aria-hidden="true" onClick={onClose} />
    <div className="recent-sheet-panel">
      <div className="recent-sheet-handle" aria-hidden="true" />
      <header className="recent-sheet-header"><h2 id={titleId}>继续阅读</h2>
        <button ref={closeRef} type="button" aria-label="关闭继续阅读" onClick={onClose}>×</button>
      </header>
      <div className="recent-sheet-list" ref={listRef}>
        <div ref={probeRef} className="recent-sheet-row recent-sheet-probe" aria-hidden="true" />
        {items.slice(0, capacity).map(({ book, progress }) => <button type="button" className="recent-sheet-row"
          key={book.id} data-book-id={book.id} aria-label={`继续阅读《${book.title || '未命名书籍'}》`}
          onClick={event => onOpenBook(book, event.currentTarget.querySelector('.book-cover')?.getBoundingClientRect() ?? null)}>
          <span className="book-cover recent-sheet-cover"><BookCover book={book} sizes="44px" /></span>
          <span className="recent-sheet-book-info"><span className="recent-sheet-book-title">{book.title || '未命名书籍'}</span>
            <span>{book.author || '未知作者'}</span>
            <span>已读 {Number((progress.progress * 100).toFixed(2))}%</span>
          </span><span className="home-card-chevron" aria-hidden="true" />
        </button>)}
        {!items.length ? <p className="recent-sheet-empty">还没有阅读记录哦</p> : capacity === 0
          ? <p className="recent-sheet-empty">屏幕空间不足，请旋转屏幕查看书籍</p> : null}
      </div>
    </div>
  </div>;
}
