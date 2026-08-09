import { describe, expect, it } from 'vitest';
import { computeXp, levelForTotalXp, totalXpForLevel, PERFECT_ACCURACY_PCT } from './xp';

describe('computeXp', () => {
  it('awards the attempt floor (20% of base) even at 0% accuracy', () => {
    expect(computeXp(50, 0)).toBe(10);
  });

  it('scales between the floor and full base with accuracy', () => {
    expect(computeXp(50, 50)).toBe(30); // 0.2 + 0.8*0.5 = 0.6 -> 30
  });

  it('adds a bonus at/above the perfect-accuracy cutoff', () => {
    const justUnder = computeXp(100, PERFECT_ACCURACY_PCT - 1);
    const atCutoff = computeXp(100, PERFECT_ACCURACY_PCT);
    expect(atCutoff - justUnder).toBeGreaterThan(20);
    expect(computeXp(100, 100)).toBe(125); // full base + 25% bonus
  });

  it('clamps out-of-range accuracy instead of extrapolating', () => {
    expect(computeXp(50, -20)).toBe(computeXp(50, 0));
    expect(computeXp(50, 150)).toBe(computeXp(50, 100));
  });
});

describe('totalXpForLevel', () => {
  it('starts level 1 at zero XP', () => {
    expect(totalXpForLevel(1)).toBe(0);
  });

  it('costs 25 XP more for each successive level', () => {
    expect(totalXpForLevel(2)).toBe(100);
    expect(totalXpForLevel(3)).toBe(225); // +125
    expect(totalXpForLevel(4)).toBe(375); // +150
    expect(totalXpForLevel(5)).toBe(550); // +175
  });
});

describe('levelForTotalXp', () => {
  it('reports level 1 with no XP', () => {
    expect(levelForTotalXp(0)).toEqual({ level: 1, xpIntoLevel: 0, xpForNextLevel: 100 });
  });

  it('levels up exactly at the threshold, not before', () => {
    expect(levelForTotalXp(99).level).toBe(1);
    expect(levelForTotalXp(100).level).toBe(2);
    expect(levelForTotalXp(224).level).toBe(2);
    expect(levelForTotalXp(225).level).toBe(3);
  });

  it('reports progress within the current level', () => {
    const p = levelForTotalXp(150); // level 2 spans 100..225
    expect(p.level).toBe(2);
    expect(p.xpIntoLevel).toBe(50);
    expect(p.xpForNextLevel).toBe(125);
  });

  it('treats negative XP as zero rather than going below level 1', () => {
    expect(levelForTotalXp(-50).level).toBe(1);
  });

  it('round-trips against totalXpForLevel across many levels', () => {
    for (let lvl = 1; lvl <= 20; lvl += 1) {
      expect(levelForTotalXp(totalXpForLevel(lvl)).level).toBe(lvl);
      expect(levelForTotalXp(totalXpForLevel(lvl) - 1).level).toBe(Math.max(1, lvl - 1));
    }
  });
});
