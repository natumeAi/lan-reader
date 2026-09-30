import { useEffect, useRef, useState } from 'react';

/** Distance in px from the viewport top at which a `position: sticky` element pins. */
function readStickyTop(element: HTMLElement) {
  // A computed `top` has already resolved `env(safe-area-inset-top)` to a length.
  const top = Number.parseFloat(window.getComputedStyle(element).top);

  return Number.isFinite(top) && top > 0 ? top : 0;
}

/**
 * Reports whether a `position: sticky; top: …` element is currently pinned.
 *
 * `sentinelRef` goes on a 1px element directly before the sticky one, so both start at the same
 * scroll offset. Once the sentinel has scrolled above the pin line the sticky element is
 * pinned. The observer's root margin is shrunk by the pin distance (plus 1px, because an
 * element that merely touches the boundary still counts as intersecting) and is rebuilt when
 * that distance changes, for example when a rotation changes the safe-area inset.
 *
 * Without `IntersectionObserver` nothing is ever reported as pinned. A view hidden with
 * `display: none` has no sentinel box and reads as pinned; the observer reports again as soon
 * as the view is laid out, which corrects that.
 */
export function useStuckState<
  Sentinel extends HTMLElement = HTMLDivElement,
  Sticky extends HTMLElement = HTMLDivElement,
>() {
  const sentinelRef = useRef<Sentinel>(null);
  const stickyRef = useRef<Sticky>(null);
  const [isStuck, setIsStuck] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const sticky = stickyRef.current;

    if (!sentinel || !sticky || typeof IntersectionObserver === 'undefined') {
      return undefined;
    }

    let observer: IntersectionObserver | null = null;
    let observedTop: number | null = null;

    const observe = () => {
      const top = readStickyTop(sticky);

      if (observer && top === observedTop) {
        return;
      }

      observer?.disconnect();
      observedTop = top;
      observer = new IntersectionObserver(
        (entries) => {
          const latest = entries[entries.length - 1];

          if (latest) {
            setIsStuck(!latest.isIntersecting);
          }
        },
        { rootMargin: `-${top + 1}px 0px 0px 0px`, threshold: 0 },
      );
      observer.observe(sentinel);
    };

    observe();
    window.addEventListener('resize', observe);

    return () => {
      window.removeEventListener('resize', observe);
      observer?.disconnect();
      observer = null;
    };
  }, []);

  return { isStuck, sentinelRef, stickyRef };
}
