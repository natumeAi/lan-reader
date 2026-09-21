import { useEffect } from 'react';
import { acquirePageScrollLock } from '../utils/pageScrollLock.js';

export function usePageScrollLock(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    return acquirePageScrollLock(document);
  }, [active]);
}
