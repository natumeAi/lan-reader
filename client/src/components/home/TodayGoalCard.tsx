import type { ReadingStatsDto } from '@lan-reader/shared';
import { formatClockDuration, formatSpokenDuration, goalProgressFraction } from '../../utils/readingStatsFormat.js';
import { HomeCard } from './HomeCard.js';

export interface TodayGoalCardProps {
  /** Initial-load failure message; only shown when there are no stats yet. */
  error: string;
  onEditGoal: () => void;
  onRetry: () => void;
  onStartReading: () => void;
  /** `null` until a valid response exists: unavailable is never drawn as a measured zero. */
  stats: ReadingStatsDto | null;
}

// Semicircle from the left end to the right end; `pathLength` makes dash lengths percentages.
const ARC_PATH = 'M 14 110 A 96 96 0 0 1 206 110';

function PencilIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 20h4.2L19.3 8.9a2.1 2.1 0 0 0 0-3L18.1 4.7a2.1 2.1 0 0 0-3 0L4 15.8V20Z M13.6 6.2l4.2 4.2 M13 20h7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

/** 今日目标: today's foreground time against the daily goal, and the 开始阅读 action. */
export function TodayGoalCard({ error, onEditGoal, onRetry, onStartReading, stats }: TodayGoalCardProps) {
  const today = stats?.days[stats.days.length - 1];
  const todayMs = today?.durationMs ?? 0;
  const goalMinutes = stats?.goals.dailyMinutes ?? null;
  const fraction = stats && goalMinutes !== null ? goalProgressFraction(todayMs, goalMinutes) : 0;
  // Floored like every other dashboard value: 100% is announced only once the goal is met.
  const percent = Math.floor(fraction * 100);

  return (
    <HomeCard
      className="today-goal-card"
      title="今日目标"
      actions={stats ? (
        <button className="home-card-icon-button" type="button" aria-label="编辑每日阅读目标" onClick={onEditGoal}>
          <PencilIcon />
        </button>
      ) : null}
    >
      <div className="today-goal-gauge">
        <svg className="today-goal-arc" viewBox="0 0 220 120" aria-hidden="true" focusable="false">
          <path className="today-goal-track" d={ARC_PATH} pathLength={100} />
          {fraction > 0 ? (
            <path
              className="today-goal-progress"
              d={ARC_PATH}
              pathLength={100}
              strokeDasharray={`${fraction * 100} 100`}
            />
          ) : null}
        </svg>
        <div className="today-goal-readout">
          <span className="today-goal-label">今日阅读进度</span>
          {stats && goalMinutes !== null ? (
            <>
              <span className="today-goal-time">
                <span aria-hidden="true">{formatClockDuration(todayMs)}</span>
                <span className="visually-hidden">
                  今日已阅读 {formatSpokenDuration(todayMs)}，完成目标的 {percent}%
                </span>
              </span>
              <button
                className="today-goal-target"
                type="button"
                aria-label={`目标 ${goalMinutes} 分钟，修改每日阅读目标`}
                onClick={onEditGoal}
              >
                <span>(目标 {goalMinutes} 分钟)</span>
                <span className="home-card-chevron" aria-hidden="true" />
              </button>
            </>
          ) : error ? (
            <span className="today-goal-unavailable" role="alert">
              <span>暂时无法加载今日阅读时间</span>
              <button className="home-card-action" type="button" onClick={onRetry}>重试</button>
            </span>
          ) : (
            <span className="today-goal-unavailable" role="status">正在加载</span>
          )}
        </div>
      </div>
      <button className="today-goal-start" type="button" onClick={onStartReading}>
        开始阅读
      </button>
    </HomeCard>
  );
}
