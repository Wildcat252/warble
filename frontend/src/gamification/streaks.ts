/**
 * Streak maths. Pure functions over timestamps — no storage, no DOM.
 *
 * All comparisons are on LOCAL calendar days, never UTC: an 11pm session
 * must count as "today" for the person who sang it, regardless of timezone.
 */
import { localDayKey } from './practice-log';

export interface StreakSummary {
  currentStreak: number;
  longestStreak: number;
  lastPracticeDay: string | null;
  /** True when the streak is alive but today has no entry yet — drives the "keep it going" nudge. */
  atRiskToday: boolean;
}

function addDays(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function computeStreak(
  entries: { timestamp: string }[],
  today: Date = new Date(),
): StreakSummary {
  const days = [...new Set(entries.map((e) => localDayKey(e.timestamp)).filter(Boolean))].sort();
  if (days.length === 0) {
    return { currentStreak: 0, longestStreak: 0, lastPracticeDay: null, atRiskToday: false };
  }

  // Longest consecutive run anywhere in history.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i += 1) {
    run = days[i] === addDays(days[i - 1], 1) ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const todayKey = localDayKey(today.toISOString());
  const yesterdayKey = addDays(todayKey, -1);
  const lastDay = days[days.length - 1];

  // A streak only counts as CURRENT if it reaches today or yesterday. Yesterday
  // still counts so the streak isn't lost the moment midnight passes — the user
  // gets the rest of today to keep it (atRiskToday).
  let current = 0;
  if (lastDay === todayKey || lastDay === yesterdayKey) {
    current = 1;
    for (let i = days.length - 1; i > 0; i -= 1) {
      if (days[i - 1] === addDays(days[i], -1)) current += 1;
      else break;
    }
  }

  return {
    currentStreak: current,
    longestStreak: longest,
    lastPracticeDay: lastDay,
    atRiskToday: current > 0 && lastDay !== todayKey,
  };
}
