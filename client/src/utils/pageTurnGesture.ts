export const PAGE_TURN_RULES = Object.freeze({
  directionLockPx: 10,
  horizontalRatio: 1.2,
  distanceRatio: 0.28,
  distanceMinPx: 72,
  distanceMaxPx: 160,
  velocityThresholdPxPerMs: 0.45,
  velocityWindowMs: 100,
  /** Rubber band: initial slope and asymptotic limit of the boundary distance. */
  edgeRubberCoefficient: 0.35,
  edgeRubberScalePx: 60,
  tapDurationMs: 420,
  /** Settle launch slope (start speed / average speed) of taps and slow releases. */
  turnLaunch: 1.3,
  /** Highest monotone launch slope; equals ease-out cubic. */
  settleLaunchMax: 3,
  settleFlickMinMs: 120,
  dragCatchUpDurationMs: 80,
  settleDurationMinMs: 260,
  settleDurationMaxMs: 420,
  relocatedTimeoutMs: 1200,
});

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function classifyDirection(dx: number, dy: number) {
  const horizontal = Math.abs(dx);
  const vertical = Math.abs(dy);
  if (Math.max(horizontal, vertical) < PAGE_TURN_RULES.directionLockPx) {
    return 'pending';
  }
  return horizontal >= vertical * PAGE_TURN_RULES.horizontalRatio
    ? 'horizontal'
    : 'vertical';
}

export function getDistanceThreshold(pageWidth: number) {
  const width = Number(pageWidth);
  if (!Number.isFinite(width) || width <= 0) return PAGE_TURN_RULES.distanceMinPx;
  return Math.round(clamp(
    width * PAGE_TURN_RULES.distanceRatio,
    PAGE_TURN_RULES.distanceMinPx,
    PAGE_TURN_RULES.distanceMaxPx,
  ));
}

export function getRecentVelocity(samples: { x: number; time: number }[]) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  const cutoff = last.time - PAGE_TURN_RULES.velocityWindowMs;
  const first = samples.find((sample) => sample.time >= cutoff) || samples[0]!;
  const elapsed = last.time - first.time;
  return elapsed > 0 ? (last.x - first.x) / elapsed : 0;
}

export function decidePageDelta({ distanceX, velocityX, pageWidth }: { distanceX: number; velocityX: number; pageWidth: number }) {
  const distanceReached = Math.abs(distanceX) >= getDistanceThreshold(pageWidth);
  const velocityReached =
    Math.abs(velocityX) >= PAGE_TURN_RULES.velocityThresholdPxPerMs;
  if (!distanceReached && !velocityReached) return 0;

  const decidingMotion = distanceReached ? distanceX : velocityX;
  if (decidingMotion < 0) return 1;
  if (decidingMotion > 0) return -1;
  return 0;
}

export function clampDragDistance(distanceX: number, pageWidth: number) {
  const width = Number(pageWidth);
  if (!Number.isFinite(width) || width <= 0) return 0;
  return clamp(distanceX, -width, width);
}

export function dampBoundaryDistance(distanceX: number) {
  const scale = PAGE_TURN_RULES.edgeRubberScalePx;
  const stretch = Math.abs(distanceX) * PAGE_TURN_RULES.edgeRubberCoefficient / scale;
  return Math.sign(distanceX) * (1 - 1 / (stretch + 1)) * scale;
}

export function getSettleDuration(remainingDistance: number, pageWidth: number) {
  const width = Number(pageWidth);
  const ratio = width > 0 ? clamp(Math.abs(remainingDistance) / width, 0, 1) : 1;
  const durationRange =
    PAGE_TURN_RULES.settleDurationMaxMs - PAGE_TURN_RULES.settleDurationMinMs;
  return Math.round(PAGE_TURN_RULES.settleDurationMinMs + durationRange * ratio);
}

/**
 * Settle duration and launch slope that continue the release velocity
 * (px/ms, already projected onto the settle direction). A flick the longest
 * monotone launch cannot match shortens the settle instead.
 */
export function getSettleMotion({ remaining, width, velocity }: { remaining: number; width: number; velocity: number }) {
  const speed = Number.isFinite(velocity) && velocity > 0 ? velocity : 0;
  const distance = Math.abs(remaining);
  const duration = getSettleDuration(distance, width);
  if (!Number.isFinite(distance) || distance <= 0) return { duration, launch: PAGE_TURN_RULES.turnLaunch };
  const matched = speed * duration / distance;
  if (matched > PAGE_TURN_RULES.settleLaunchMax) {
    return {
      duration: Math.max(PAGE_TURN_RULES.settleFlickMinMs, Math.round(PAGE_TURN_RULES.settleLaunchMax * distance / speed)),
      launch: PAGE_TURN_RULES.settleLaunchMax,
    };
  }
  return { duration, launch: Math.max(PAGE_TURN_RULES.turnLaunch, matched) };
}

export function getTapZone(clientX: number, left: number, width: number) {
  const ratio = width > 0 ? (clientX - left) / width : 0.5;
  if (ratio < 1 / 3) return 'prev';
  if (ratio > 2 / 3) return 'next';
  return 'center';
}

/**
 * Cubic Hermite ease from 0 to 1 with start slope `launch` and end slope 0.
 * Monotone without overshoot for launch in [0, 3]; launch 3 is ease-out cubic.
 */
export function hermiteEase(launch: number, progress: number) {
  const v = clamp(Number.isFinite(launch) ? launch : PAGE_TURN_RULES.settleLaunchMax, 0, PAGE_TURN_RULES.settleLaunchMax);
  const p = clamp(progress, 0, 1);
  return v * (p ** 3 - 2 * p ** 2 + p) + 3 * p ** 2 - 2 * p ** 3;
}

export function easeOutCubic(progress: number) {
  const value = clamp(progress, 0, 1);
  return 1 - ((1 - value) ** 3);
}

/** Adaptive linear keyframes of `hermiteEase(launch, ·)` within `maxErrorRatio`. */
export function sampleEaseKeyframes(launch: number = PAGE_TURN_RULES.settleLaunchMax, maxErrorRatio = 0.0025) {
  const tolerance = Number.isFinite(maxErrorRatio) && maxErrorRatio > 0
    ? maxErrorRatio
    : 0.0025;
  const ease = (progress: number) => hermiteEase(launch, progress);
  const points = [{ offset: 0, value: ease(0) }];
  const appendSegment = (left: number, right: number, depth: number): void => {
    const leftValue = ease(left);
    const rightValue = ease(right);
    const exceedsTolerance = [0.25, 0.5, 0.75].some((ratio) => {
      const offset = left + (right - left) * ratio;
      const linearValue = leftValue + (rightValue - leftValue) * ratio;
      return Math.abs(ease(offset) - linearValue) > tolerance;
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

export function sampleEaseOutCubicKeyframes(maxErrorRatio = 0.0025) {
  return sampleEaseKeyframes(PAGE_TURN_RULES.settleLaunchMax, maxErrorRatio);
}
