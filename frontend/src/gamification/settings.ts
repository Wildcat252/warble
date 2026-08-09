/**
 * Gamification preferences (currently just the daily goal).
 *
 * Separate from practice-log.ts because this is user *intent*, not recorded
 * history — mixing the two would mean clearing history could silently reset
 * preferences, or vice versa.
 */
import { STORAGE_PREFIX } from '../branding';

const STORAGE_KEY = `${STORAGE_PREFIX}.gamification-settings.v1`;

/** One exercise a day — low enough to keep a streak alive on a bad day. */
export const DAILY_GOAL_DEFAULT = 1;
const DAILY_GOAL_MIN = 1;
const DAILY_GOAL_MAX = 10;

export function loadDailyGoal(): number {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return DAILY_GOAL_DEFAULT;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DAILY_GOAL_DEFAULT;
    const parsed = JSON.parse(raw) as { dailyGoal?: unknown };
    const goal = typeof parsed.dailyGoal === 'number' ? parsed.dailyGoal : Number.NaN;
    if (!Number.isFinite(goal)) return DAILY_GOAL_DEFAULT;
    return Math.min(DAILY_GOAL_MAX, Math.max(DAILY_GOAL_MIN, Math.round(goal)));
  } catch {
    return DAILY_GOAL_DEFAULT;
  }
}

export function persistDailyGoal(goal: number): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  const clamped = Math.min(DAILY_GOAL_MAX, Math.max(DAILY_GOAL_MIN, Math.round(goal)));
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ dailyGoal: clamped }));
  } catch {
    // Preference is non-critical; losing it just means falling back to the default.
  }
}
