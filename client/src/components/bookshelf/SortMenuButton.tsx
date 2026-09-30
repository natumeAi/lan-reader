import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LibrarySort } from '../../utils/libraryView.js';
import { ActionSheet } from '../common/ActionSheet.js';

interface SortMenuButtonProps {
  disabled: boolean;
  onChange: (sort: LibrarySort) => void;
  onOpenChange?: (open: boolean) => void;
  sort: LibrarySort;
  options: readonly { value: LibrarySort; label: string }[];
}

export function SortMenuButton({ disabled, onChange, onOpenChange, sort, options }: SortMenuButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const currentLabel = options.find(option => option.value === sort)?.label ?? '';
  const close = useCallback(() => {
    setAnchorRect(null);
    onOpenChange?.(false);
  }, [onOpenChange]);

  useEffect(() => {
    if (disabled || !options.length) close();
  }, [close, disabled, options.length]);
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);

  function open() {
    if (disabled || !options.length || !buttonRef.current) return;
    setAnchorRect(buttonRef.current.getBoundingClientRect());
    onOpenChange?.(true);
  }

  function select(value: LibrarySort) {
    if (disabled) return;
    close();
    onChange(value);
  }

  return <>
    <button ref={buttonRef} type="button" className="library-sort-button" disabled={disabled}
      aria-label={`排序方式：${currentLabel}`} aria-haspopup="menu" aria-expanded={Boolean(anchorRect)}
      onClick={open} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          open();
        }
      }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h12M4 12h8M4 18h4M18 10v10m-3-3 3 3 3-3" />
      </svg>
      <span className="library-sort-label">{currentLabel}</span>
    </button>
    {anchorRect ? createPortal(
      <ActionSheet title="排序方式" anchorRect={anchorRect} onClose={close}
        returnFocusElement={buttonRef.current} initialFocusRef={initialFocusRef}>
        <div className="library-sort-menu" role="menu" aria-label="排序方式" onKeyDown={event => {
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const index = items.findIndex(item => item === document.activeElement);
          let nextIndex: number;
          switch (event.key) {
            case 'ArrowDown': case 'ArrowRight': nextIndex = (index + 1) % items.length; break;
            case 'ArrowUp': case 'ArrowLeft': nextIndex = (index - 1 + items.length) % items.length; break;
            case 'Home': nextIndex = 0; break;
            case 'End': nextIndex = items.length - 1; break;
            case 'Enter': case ' ':
              event.preventDefault();
              items[index]?.click();
              return;
            default: return;
          }
          event.preventDefault();
          items[nextIndex]?.focus({ preventScroll: true });
        }}>
          {options.map((option, index) => <button key={option.value} type="button" role="menuitemradio"
            aria-checked={sort === option.value} disabled={disabled}
            ref={sort === option.value || (!currentLabel && index === 0) ? initialFocusRef : undefined}
            onClick={() => select(option.value)}>
            <span className="library-sort-check" aria-hidden="true">{sort === option.value ? '✓' : ''}</span>
            {option.label}
          </button>)}
        </div>
      </ActionSheet>, document.body,
    ) : null}
  </>;
}
