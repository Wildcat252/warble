/**
 * XP and level maths. Pure functions — no storage, no DOM.
 */

/**
 * Even a poor attempt earns something: showing up is the habit being
 * rewarded, and zero-XP attempts make a bad day feel punishing enough to
 * break a streak on purpose. Floor is 20% of base, the remaining 80% scales
 * with accuracy.
 */
const ATTEMPT_FLOOR = 0.2;
/** Accuracy at/above this earns a bonus, so near-perfect runs feel distinct from merely good ones. */
export const PERFECT_ACCURACY_PCT = 98;
const PERFECT_BONUS = 0.25;

export function computeXp(exerciseXpBase: number, accuracyPct: number): number {
  const clamped = Math.max(0, Math.min(100, accuracyPct));
  const scaled = ATTEMPT_FLOOR + (1 - ATTEMPT_FLOOR) * (clamped / 100);
  const base = Math.round(exerciseXpBase * scaled);
  const bonus = clamped >= PERFECT_ACCURACY_PCT ? Math.round(exerciseXpBase * PERFECT_BONUS) : 0;
  return base + bonus;
}

/**
 * Total XP required to REACH a given level (level 1 = 0 XP).
 * Each level costs 25 XP more than the previous one:
 *   L1->L2 = 100, L2->L3 = 125, L3->L4 = 150, ...
 * Closed form so this never needs a loop or a lookup table.
 */
export function totalXpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level)) - 1;
  return 100 * n + 25 * ((n * (n - 1)) / 2);
}

export interface LevelProgress {
  level: number;
  /** XP accumulated inside the current level. */
  xpIntoLevel: number;
  /** XP span of the current level (xpIntoLevel / xpForNextLevel = progress bar fill). */
  xpForNextLevel: number;
}

export function levelForTotalXp(xp: number): LevelProgress {
  const total = Math.max(0, xp);
  let level = 1;
  while (totalXpForLevel(level + 1) <= total) level += 1;
  const floor = totalXpForLevel(level);
  return {
    level,
    xpIntoLevel: total - floor,
    xpForNextLevel: totalXpForLevel(level + 1) - floor,
  };
}
