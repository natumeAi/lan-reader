const minimumPanelScale = 0.08;

export function snapshotRect(rect) {
  if (!rect) return null;

  const values = [rect.left, rect.top, rect.width, rect.height];

  if (!values.every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function rectIntersectsViewport(rect, viewport) {
  const candidate = snapshotRect(rect);

  if (!candidate || !viewport || viewport.width <= 0 || viewport.height <= 0) {
    return false;
  }

  return (
    candidate.left + candidate.width > 0 &&
    candidate.left < viewport.width &&
    candidate.top + candidate.height > 0 &&
    candidate.top < viewport.height
  );
}

export function folderPanelMotion(originRect, panelRect) {
  const origin = snapshotRect(originRect);
  const panel = snapshotRect(panelRect);

  if (!origin || !panel) return null;

  const originCenterX = origin.left + origin.width / 2;
  const originCenterY = origin.top + origin.height / 2;
  const panelCenterX = panel.left + panel.width / 2;
  const panelCenterY = panel.top + panel.height / 2;

  return {
    translateX: originCenterX - panelCenterX,
    translateY: originCenterY - panelCenterY,
    scaleX: Math.max(minimumPanelScale, Math.min(1, origin.width / panel.width)),
    scaleY: Math.max(minimumPanelScale, Math.min(1, origin.height / panel.height)),
  };
}
