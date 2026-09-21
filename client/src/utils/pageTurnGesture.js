export const PAGE_TURN_RULES = Object.freeze({
  directionLockPx: 10,
  horizontalRatio: 1.2,
  distanceRatio: 0.28,
  distanceMinPx: 72,
  distanceMaxPx: 160,
  velocityThresholdPxPerMs: 0.45,
  velocityWindowMs: 100,
  edgeDampingMaxPx: 28,
  edgeDampingFactor: 0.25,
  tapDurationMs: 240,
  settleDurationMinMs: 160,
  settleDurationMaxMs: 280,
  relocatedTimeoutMs: 1200,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function classifyDirection(dx, dy) {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < PAGE_TURN_RULES.directionLockPx) {
    return 'pending';
  }
  return horizontal >= vertical * PAGE_TURN_RULES.horizontalRatio
    ? 'horizontal'
    : 'vertical';
}

export function getDistanceThreshold(pageWidth) {
  const width = Number(pageWidth);
  if (!Number.isFinite(width) || width <= 0) return PAGE_TURN_RULES.distanceMinPx;
  return Math.round(clamp(
    width * PAGE_TURN_RULES.distanceRatio,
    PAGE_TURN_RULES.distanceMinPx,
    PAGE_TURN_RULES.distanceMaxPx,
  ));
}

export function getRecentVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const cutoff = last.time - PAGE_TURN_RULES.velocityWindowMs;
  const first = samples.find((sample) => sample.time >= cutoff) || samples[0];
  const elapsed = last.time - first.time;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

export function decidePageDelta({ distanceX, velocityX, pageWidth }) {
  const distanceReached = Math.abs(distanceX) >= getDistanceThreshold(pageWidth);
  const velocityReached =
    Math.abs(velocityX) >= PAGE_TURN_RULES.velocityThresholdPxPerMs;
  if (!distanceReached && !velocityReached) return 0;

  const decidingMotion = distanceReached ? distanceX : velocityX;
  if (decidingMotion < 0) return 1;
  if (decidingMotion > 0) return -1;
  return 0;
}

export function clampDragDistance(distanceX, pageWidth) {
  const width = Number(pageWidth);
  if (!Number.isFinite(width) || width <= 0) return 0;
  return clamp(distanceX, -width, width);
}

export function dampBoundaryDistance(distanceX) {
  const damped = Math.min(
    Math.abs(distanceX) * PAGE_TURN_RULES.edgeDampingFactor,
    PAGE_TURN_RULES.edgeDampingMaxPx,
  );
  return Math.sign(distanceX) * damped;
}

export function getSettleDuration(remainingDistance, pageWidth) {
  const width = Number(pageWidth);
  const ratio = width > 0 ? clamp(Math.abs(remainingDistance) / width, 0, 1) : 1;
  const durationRange =
    PAGE_TURN_RULES.settleDurationMaxMs - PAGE_TURN_RULES.settleDurationMinMs;
  return Math.round(PAGE_TURN_RULES.settleDurationMinMs + durationRange * ratio);
}

export function getTapZone(clientX, left, width) {
  const ratio = width > 0 ? (clientX - left) / width : 0.5;
  if (ratio < 1 / 3) return 'prev';
  if (ratio > 2 / 3) return 'next';
  return 'center';
}

export function easeOutCubic(progress) {
  const value = clamp(progress, 0, 1);
  return 1 - ((1 - value) ** 3);
}

export function sampleEaseOutCubicKeyframes(maxErrorRatio = 0.0025) {
  const tolerance = Number.isFinite(maxErrorRatio) && maxErrorRatio > 0
    ? maxErrorRatio
    : 0.0025;
  const points = [{ offset: 0, value: easeOutCubic(0) }];
  const appendSegment = (left, right, depth) => {
    const leftValue = easeOutCubic(left);
    const rightValue = easeOutCubic(right);
    const exceedsTolerance = [0.25, 0.5, 0.75].some((ratio) => {
      const offset = left + (right - left) * ratio;
      const linearValue = leftValue + (rightValue - leftValue) * ratio;
      return Math.abs(easeOutCubic(offset) - linearValue) > tolerance;
    });

    if (exceedsTolerance && depth < 12) {
      const midpoint = (left + right) / 2;
      appendSegment(left, midpoint, depth + 1);
      appendSegment(midpoint, right, depth + 1);
      return;
    }

    points.push({ offset: right, value: rightValue });
  };

  appendSegment(0, 1, 0);
  return points;
}
