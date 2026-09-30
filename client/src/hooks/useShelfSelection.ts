import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { ShelfItem } from '../types/library.js';

export interface ShelfSelection {
  active: boolean;
  keys: ReadonlySet<string>;
  enter(): void;
  toggle(key: string): void;
  selectAll(): void;
  clear(): void;
  exit(): void;
}

/** Only visible books belong to a selection; a pending projection keeps its original keys. */
export function useShelfSelection(items: ShelfItem[], suspended = false): ShelfSelection {
  const [active, setActive] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const visibleKeys = useMemo(() => new Set(items.flatMap(item => item.type === 'book' ? [item.key] : [])), [items]);
  const keys = useMemo(() => suspended ? selected : new Set([...selected].filter(key => visibleKeys.has(key))),
    [selected, suspended, visibleKeys]);
  useLayoutEffect(() => {
    if (keys.size !== selected.size) setSelected(keys);
  }, [keys, selected]);
  const clear = useCallback(() => setSelected(new Set()), []);
  const enter = useCallback(() => { setSelected(new Set()); setActive(true); }, []);
  const exit = useCallback(() => { setSelected(new Set()); setActive(false); }, []);
  const toggle = useCallback((key: string) => {
    if (!active || suspended || !visibleKeys.has(key)) return;
    setSelected(previous => {
      const next = new Set([...previous].filter(key => visibleKeys.has(key)));
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, [active, suspended, visibleKeys]);
  const selectAll = useCallback(() => {
    if (active && !suspended) setSelected(new Set(visibleKeys));
  }, [active, suspended, visibleKeys]);
  return useMemo(() => ({ active, keys, enter, toggle, selectAll, clear, exit }),
    [active, keys, enter, toggle, selectAll, clear, exit]);
}
