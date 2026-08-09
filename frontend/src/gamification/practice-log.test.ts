import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStorageFallbackForTests,
  clearPracticeLog, countCompletedOn, loadPracticeLog, localDayKey,
  recordPracticeEntry, subscribePracticeLog, totalXp, type PracticeEntry,
} from './practice-log';

function entry(over: Partial<Omit<PracticeEntry, 'id'>> = {}): Omit<PracticeEntry, 'id'> {
  return {
    timestamp: new Date(2026, 7, 9, 12).toISOString(),
    exerciseId: 'note-hold-basic',
    exerciseKind: 'note-hold',
    accuracyPct: 80,
    durationMs: 18000,
    xpEarned: 25,
    minMidi: 55,
    maxMidi: 67,
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetStorageFallbackForTests();
  clearPracticeLog();
});

describe('practice log persistence', () => {
  it('starts empty', () => {
    expect(loadPracticeLog()).toEqual([]);
  });

  it('round-trips an entry and assigns an id', () => {
    const saved = recordPracticeEntry(entry());
    expect(saved.id).toBeTruthy();
    const [loaded] = loadPracticeLog();
    expect(loaded).toEqual(saved);
  });

  it('stores newest first', () => {
    recordPracticeEntry(entry({ exerciseId: 'older' }));
    recordPracticeEntry(entry({ exerciseId: 'newer' }));
    expect(loadPracticeLog().map((e) => e.exerciseId)).toEqual(['newer', 'older']);
  });

  it('ignores malformed stored data rather than throwing', () => {
    window.localStorage.setItem('warble.practice-log.v1', '{"not":"an array"}');
    expect(loadPracticeLog()).toEqual([]);
    window.localStorage.setItem('warble.practice-log.v1', 'not json at all');
    expect(loadPracticeLog()).toEqual([]);
  });

  it('drops entries that do not match the expected shape', () => {
    window.localStorage.setItem(
      'warble.practice-log.v1',
      JSON.stringify([{ id: 'x' }, { ...entry(), id: 'good' }]),
    );
    expect(loadPracticeLog().map((e) => e.id)).toEqual(['good']);
  });

  it('keeps working when localStorage throws (quota / private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => recordPracticeEntry(entry({ exerciseId: 'fallback' }))).not.toThrow();
    spy.mockRestore();
    // Falls back to in-memory, so the entry is still readable this session.
    expect(loadPracticeLog().some((e) => e.exerciseId === 'fallback')).toBe(true);
  });

  it('notifies subscribers immediately and on write', () => {
    const seen: number[] = [];
    const unsubscribe = subscribePracticeLog((entries) => seen.push(entries.length));
    expect(seen).toEqual([0]); // fires immediately with current state
    recordPracticeEntry(entry());
    expect(seen).toEqual([0, 1]);
    unsubscribe();
    recordPracticeEntry(entry());
    expect(seen).toEqual([0, 1]); // no longer notified
  });
});

describe('derived helpers', () => {
  it('sums XP across entries', () => {
    recordPracticeEntry(entry({ xpEarned: 10 }));
    recordPracticeEntry(entry({ xpEarned: 15 }));
    expect(totalXp()).toBe(25);
  });

  it('derives a local calendar day, not a UTC one', () => {
    // 23:30 local must map to that local date regardless of the UTC offset.
    const late = new Date(2026, 7, 9, 23, 30).toISOString();
    expect(localDayKey(late)).toBe('2026-08-09');
  });

  it('counts only entries falling on the given day', () => {
    recordPracticeEntry(entry({ timestamp: new Date(2026, 7, 9, 9).toISOString() }));
    recordPracticeEntry(entry({ timestamp: new Date(2026, 7, 9, 21).toISOString() }));
    recordPracticeEntry(entry({ timestamp: new Date(2026, 7, 8, 12).toISOString() }));
    expect(countCompletedOn(new Date(2026, 7, 9, 12))).toBe(2);
  });
});
