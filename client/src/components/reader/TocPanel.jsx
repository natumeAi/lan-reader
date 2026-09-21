import { useLayoutEffect, useRef } from 'react';
import { centerTocEntry } from '../../utils/tocScrollPosition.js';

function hrefDocument(href) {
  if (typeof href !== 'string') return '';

  const documentHref = href.split('#')[0];
  try {
    return decodeURIComponent(documentHref);
  } catch {
    return documentHref;
  }
}

function formatStartProgress(progress) {
  if (!Number.isFinite(progress)) return '…';
  return `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
}

export function TocPanel({ currentChapterId, currentHref, onSelect, toc }) {
  const currentEntryRef = useRef(null);
  const tocListRef = useRef(null);

  useLayoutEffect(() => {
    centerTocEntry(tocListRef.current, currentEntryRef.current);
  }, [currentChapterId, currentHref, toc]);

  return (
    <div className="reader-panel reader-panel-toc" role="dialog" aria-label="章节目录">
      <div className="reader-panel-handle" aria-hidden="true" />
      <h2 className="reader-panel-title">目录</h2>
      <ul ref={tocListRef} className="reader-toc-list">
        {toc.length === 0 && <li className="reader-toc-empty">无目录信息</li>}
        {toc.map((item) => (
          <TocItem
            key={item.chapterId || item.href || item.id || item.label}
            item={item}
            currentChapterId={currentChapterId}
            currentEntryRef={currentEntryRef}
            currentHref={currentHref}
            depth={0}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function TocItem({
  currentChapterId,
  currentEntryRef,
  currentHref,
  depth,
  item,
  onSelect,
}) {
  const href = item.href || '';
  const active = currentChapterId
    ? item.chapterId === currentChapterId
    : Boolean(currentHref && href && hrefDocument(currentHref) === hrefDocument(href));
  const progressLabel = formatStartProgress(item.startProgress);

  return (
    <li>
      <button
        ref={active ? currentEntryRef : null}
        type="button"
        className={`reader-toc-entry${depth > 0 ? ' reader-toc-subentry' : ''}${active ? ' is-current' : ''}`}
        style={{ paddingLeft: `${20 + depth * 16}px` }}
        onClick={() => onSelect(href)}
        aria-current={active ? 'location' : undefined}
      >
        <span className="reader-toc-entry-label">
          {item.label || '未命名章节'}
        </span>
        <span
          className="reader-toc-entry-progress"
          aria-label={Number.isFinite(item.startProgress)
            ? `章节起始进度 ${progressLabel}`
            : '正在计算章节起始进度'}
        >
          {progressLabel}
        </span>
      </button>
      {Array.isArray(item.subitems) && item.subitems.length > 0 && (
        <ul className="reader-toc-sublist">
          {item.subitems.map((subitem) => (
            <TocItem
              key={subitem.chapterId || subitem.href || subitem.id || subitem.label}
              item={subitem}
              currentChapterId={currentChapterId}
              currentEntryRef={currentEntryRef}
              currentHref={currentHref}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
