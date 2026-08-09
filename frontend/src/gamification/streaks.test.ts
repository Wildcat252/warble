import { describe, expect, it } from 'vitest';
import { computeStreak } from './streaks';

/** Local-noon timestamps, so these tests can't flip a day boundary via UTC conversion. */
function day(y: number, m: number, d: number): { timestamp: string } {
  return { timestamp: new Date(y, m - 1, d, 12, 0, 0).toISOString() };
}
const TODAY = new Date(2026, 7, 9, 12, 0, 0); // 9 Aug 2026, local noon

describe('computeStreak', () => {
  it('returns zeroes for an empty log', () => {
    expect(computeStreak([], TODAY)).toEqual({
      currentStreak: 0, longestStreak: 0, lastPracticeDay: null, atRiskToday: false,
    });
  });

  it('counts a run ending today', () => {
    const s = computeStreak([day(2026, 8, 7), day(2026, 8, 8), day(2026, 8, 9)], TODAY);
    expect(s.currentStreak).toBe(3);
    expect(s.atRiskToday).toBe(false);
  });

  it('keeps the streak alive when the last day is yesterday, and flags it at risk', () => {
    const s = computeStreak([day(2026, 8, 7), day(2026, 8, 8)], TODAY);
    expect(s.currentStreak).toBe(2);
    expect(s.atRiskToday).toBe(true);
  });

  it('breaks the streak once the gap exceeds one day', () => {
    const s = computeStreak([day(2026, 8, 5), day(2026, 8, 6)], TODAY);
    expect(s.currentStreak).toBe(0);
    expect(s.atRiskToday).toBe(false);
    expect(s.longestStreak).toBe(2); // history is still remembered
  });

  it('does not double-count multiple sessions on the same day', () => {
    const s = computeStreak([day(2026, 8, 8), day(2026, 8, 9), day(2026, 8, 9), day(2026, 8, 9)], TODAY);
    expect(s.currentStreak).toBe(2);
  });

  it('spans a month boundary', () => {
    const s = computeStreak(
      [day(2026, 7, 30), day(2026, 7, 31), day(2026, 8, 1)],
      new Date(2026, 7, 1, 12, 0, 0),
    );
    expect(s.currentStreak).toBe(3);
  });

  it('spans a leap day', () => {
    const s = computeStreak(
      [day(2024, 2, 28), day(2024, 2, 29), day(2024, 3, 1)],
      new Date(2024, 2, 1, 12, 0, 0),
    );
    expect(s.currentStreak).toBe(3);
  });

  it('reports the longest historical run even when the current streak is broken', () => {
    const s = computeStreak(
      [day(2026, 7, 1), day(2026, 7, 2), day(2026, 7, 3), day(2026, 7, 4), day(2026, 8, 1)],
      TODAY,
    );
    expect(s.longestStreak).toBe(4);
    expect(s.currentStreak).toBe(0);
  });

  it('handles unsorted input', () => {
    const s = computeStreak([day(2026, 8, 9), day(2026, 8, 7), day(2026, 8, 8)], TODAY);
    expect(s.currentStreak).toBe(3);
  });
});
