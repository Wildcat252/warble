/**
 * Practice log — the single source of truth for gamification.
 *
 * XP total, level, and streak are always DERIVED from this log at read time
 * (see xp.ts / streaks.ts) rather than stored alongside it. Storing them
 * separately would mean two things that can disagree; deriving means a
 * corrupted or partially-written entry degrades the numbers rather than
 * permanently desyncing them.
 *
 * Same module-singleton + callback-list + localStorage shape as the older
 * services/progress-history.ts it supersedes, including that file's
 * in-memory fallback for environments where localStorage throws (Safari
 * private mode, quota exceeded).
 */
import { STORAGE_PREFIX } from '../branding';
import type { ExerciseKind } from '../exercises/types';

/** 'range-test' is not an ExerciseKind — the vocal range test is logged here too. */
export type PracticeEntryKind = ExerciseKind | 'range-test';

/**
 * Per-target detail for one exercise. Optional and added late, so entries
 * written before this existed stay valid — isEntry() validates only the
 * required fields and does not reject unknown ones.
 */
export interface PracticeTargetResult {
  midi: number;
  achievedMidi: number | null;
  hit: boolean;
  register?: 'chest' | 'mix' | 'head';
  /** 0 = chest, 1 = head. Kept alongside the label so a borderline note reads as borderline. */
  registerPosition?: number;
  /** False when the singer changed register mid-note — genuinely interesting information. */
  registerStable?: boolean;
}

export interface PracticeEntry {
  id: string;
  /** ISO timestamp. Streak math converts these to LOCAL calendar days — see streaks.ts. */
  timestamp: string;
  exerciseId: string;
  exerciseKind: PracticeEntryKind;
  accuracyPct: number;
  durationMs: number;
  xpEarned: number;
  minMidi: number | null;
  maxMidi: number | null;
  /**
   * Only stored for recent entries — see MAX_PER_TARGET_ENTRIES. A per-note
   * array on all 1000 entries would be a few hundred kB of localStorage for
   * detail nobody scrolls back that far to read.
   */
  perTarget?: PracticeTargetResult[];
}

const STORAGE_KEY = `${STORAGE_PREFIX}.practice-log.v1`;
/** Exercises are short and frequent, so this holds far more history than the old 250-session cap. */
const MAX_ENTRIES = 1000;
/**
 * Entries older than this keep their summary but lose their per-note detail.
 * Bounds localStorage growth without touching the streak/XP history, which is
 * derived from the summary fields only.
 */
const MAX_PER_TARGET_ENTRIES = 50;

const listeners = new Set<(entries: PracticeEntry[]) => void>();
const memoryStorage = new Map<string, string>();
/**
 * Sticky: once a write has failed we must also READ from memory, or the
 * fallback is write-only and every read silently returns the stale
 * pre-failure localStorage value. (The older services/progress-history.ts
 * this supersedes had exactly that bug.)
 */
let useMemoryFallback = false;

function storageUnavailable(): boolean {
  return typeof window === 'undefined' || typeof window.localStorage === 'undefined';
}

function getStoredRaw(): string | null {
  if (useMemoryFallback || storageUnavailable()) {
    return memoryStorage.get(STORAGE_KEY) ?? null;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    useMemoryFallback = true;
    return memoryStorage.get(STORAGE_KEY) ?? null;
  }
}

function setStoredRaw(value: string): void {
  if (useMemoryFallback || storageUnavailable()) {
    memoryStorage.set(STORAGE_KEY, value);
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // QuotaExceededError / private-mode denial — fall back to in-memory so
    // the current session still works and listeners still fire.
    useMemoryFallback = true;
    memoryStorage.set(STORAGE_KEY, value);
  }
}

/** Test-only: reset the sticky fallback so cases can run independently. */
export function __resetStorageFallbackForTests(): void {
  useMemoryFallback = false;
  memoryStorage.clear();
}

function isEntry(value: unknown): value is PracticeEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<PracticeEntry>;
  return (
    typeof e.id === 'string'
    && typeof e.timestamp === 'string'
    && typeof e.exerciseId === 'string'
    && typeof e.exerciseKind === 'string'
    && typeof e.accuracyPct === 'number'
    && typeof e.durationMs === 'number'
    && typeof e.xpEarned === 'number'
    && (typeof e.minMidi === 'number' || e.minMidi === null)
    && (typeof e.maxMidi === 'number' || e.maxMidi === null)
  );
}

/**
 * Newest first, sorted by TIMESTAMP rather than insertion order.
 *
 * Writes prepend, so insertion order usually matches chronological order —
 * but only because you can't normally complete an exercise in the past.
 * Anything that imports, backfills, or writes out of order (and any consumer
 * that slices "the N most recent") would silently get a wrong answer from
 * insertion order alone. Sorting here makes the documented contract real for
 * every caller instead of each one having to re-sort defensively.
 */
export function loadPracticeLog(): PracticeEntry[] {
  const raw = getStoredRaw();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  } catch {
    return [];
  }
}

function write(entries: PracticeEntry[]): void {
  setStoredRaw(JSON.stringify(entries));
  for (const listener of listeners) listener(entries);
}

function newId(): string {
  // crypto.randomUUID is unavailable in some older/embedded webviews.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function recordPracticeEntry(entry: Omit<PracticeEntry, 'id'>): PracticeEntry {
  const complete: PracticeEntry = { ...entry, id: newId() };
  const next = [complete, ...loadPracticeLog()]
    .slice(0, MAX_ENTRIES)
    // Strip per-note detail from older entries rather than dropping the
    // entries themselves — streaks and XP derive from the summary fields and
    // must keep the full history.
    .map((e, i) => (i < MAX_PER_TARGET_ENTRIES || e.perTarget === undefined
      ? e
      : { ...e, perTarget: undefined }));
  write(next);
  return complete;
}

export function subscribePracticeLog(listener: (entries: PracticeEntry[]) => void): () => void {
  listeners.add(listener);
  listener(loadPracticeLog());
  return () => {
    listeners.delete(listener);
  };
}

export function clearPracticeLog(): void {
  write([]);
}

export function totalXp(entries: PracticeEntry[] = loadPracticeLog()): number {
  return entries.reduce((sum, e) => sum + e.xpEarned, 0);
}

/** Local-calendar-day key (NOT UTC) — a 11pm session must count as today for the user. */
export function localDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function countCompletedOn(day: Date, entries: PracticeEntry[] = loadPracticeLog()): number {
  const key = localDayKey(day.toISOString());
  return entries.filter((e) => localDayKey(e.timestamp) === key).length;
}
