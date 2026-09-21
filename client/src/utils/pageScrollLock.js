const pageLockStates = new WeakMap();

export function acquirePageScrollLock(page) {
  const root = page?.documentElement;
  const body = page?.body;

  if (!root?.style || !body?.style) {
    return () => {};
  }

  let state = pageLockStates.get(page);

  if (!state) {
    state = {
      count: 0,
      previousBodyOverflow: body.style.overflow,
      previousBodyOverscroll: body.style.overscrollBehavior,
      previousRootOverflow: root.style.overflow,
      previousRootOverscroll: root.style.overscrollBehavior,
    };
    pageLockStates.set(page, state);

    root.style.overflow = 'hidden';
    root.style.overscrollBehavior = 'none';
    body.style.overflow = 'hidden';
    body.style.overscrollBehavior = 'none';
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

    root.style.overflow = currentState.previousRootOverflow;
    root.style.overscrollBehavior = currentState.previousRootOverscroll;
    body.style.overflow = currentState.previousBodyOverflow;
    body.style.overscrollBehavior = currentState.previousBodyOverscroll;
    pageLockStates.delete(page);
  };
}
