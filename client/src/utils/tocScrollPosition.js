export function centerTocEntry(container, entry) {
  if (
    !container ||
    !entry ||
    typeof container.getBoundingClientRect !== 'function' ||
    typeof entry.getBoundingClientRect !== 'function'
  ) {
    return false;
  }

  const containerHeight = Number(container.clientHeight);
  const scrollHeight = Number(container.scrollHeight);
  const scrollTop = Number(container.scrollTop);
  const containerRect = container.getBoundingClientRect();
  const entryRect = entry.getBoundingClientRect();
  const containerTop = Number(containerRect?.top);
  const entryTop = Number(entryRect?.top);
  const entryHeight = Number(entryRect?.height);

  if (
    !Number.isFinite(containerHeight) ||
    containerHeight <= 0 ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(containerTop) ||
    !Number.isFinite(entryTop) ||
    !Number.isFinite(entryHeight)
  ) {
    return false;
  }

  const maximumScrollTop = Math.max(0, scrollHeight - containerHeight);
  const centeredScrollTop = scrollTop + entryTop - containerTop -
    ((containerHeight - entryHeight) / 2);
  container.scrollTop = Math.min(
    maximumScrollTop,
    Math.max(0, centeredScrollTop),
  );
  return true;
}
