interface ScrollPage { documentElement?: { style?: Pick<CSSStyleDeclaration, 'overflow' | 'overscrollBehavior'> }; body?: { style?: Pick<CSSStyleDeclaration, 'overflow' | 'overscrollBehavior'> } }
interface ScrollLockState { count: number; previousBodyOverflow: string; previousBodyOverscroll: string; previousRootOverflow: string; previousRootOverscroll: string }
const pageLockStates = new WeakMap<ScrollPage, ScrollLockState>();

export function acquirePageScrollLock(page: ScrollPage | null | undefined) {
  const root = page?.documentElement;
  const body = page?.body;

  if (!page || !root?.style || !body?.style) {
    return () => {};
  }

  const rootStyle = root.style;
  const bodyStyle = body.style;
  let state = pageLockStates.get(page);

  if (!state) {
    state = {
      count: 0,
      previousBodyOverflow: bodyStyle.overflow,
      previousBodyOverscroll: bodyStyle.overscrollBehavior,
      previousRootOverflow: rootStyle.overflow,
      previousRootOverscroll: rootStyle.overscrollBehavior,
    };
    pageLockStates.set(page, state);

    rootStyle.overflow = 'hidden';
    rootStyle.overscrollBehavior = 'none';
    bodyStyle.overflow = 'hidden';
    bodyStyle.overscrollBehavior = 'none';
  }

  state.count += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;

    const currentState = pageLockStates.get(page);
    if (!currentState) return;

    currentState.count -= 1;
    if (currentState.count > 0) return;

    rootStyle.overflow = currentState.previousRootOverflow;
    rootStyle.overscrollBehavior = currentState.previousRootOverscroll;
    bodyStyle.overflow = currentState.previousBodyOverflow;
    bodyStyle.overscrollBehavior = currentState.previousBodyOverscroll;
    pageLockStates.delete(page);
  };
}
