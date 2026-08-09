/**
 * User voice preferences.
 *
 * Previously lived in services/audio-preflight.ts, back when the mic-setup
 * modal owned a voice-type picker. That picker moved to the Settings screen
 * and the modal is now purely a level test, so keeping this here under the
 * preflight name would have been actively misleading about who owns it.
 */
import { STORAGE_PREFIX } from '../branding';
import { DEFAULT_INSTRUMENT, normalizeInstrumentId, type InstrumentId } from '../audio/instruments';

const VOICE_TYPE_KEY = `${STORAGE_PREFIX}.voice-type.v1`;
const INSTRUMENT_KEY = `${STORAGE_PREFIX}.instrument.v1`;
const TONE_LEAD_KEY = `${STORAGE_PREFIX}.tone-lead-ms.v1`;
const LEAD_IN_KEY = `${STORAGE_PREFIX}.lead-in-ms.v1`;

/**
 * How far AHEAD of a note its reference tone sounds. Hearing the pitch only
 * at the moment you're meant to already be singing it leaves no time to
 * place the note; a lead gives the singer a beat to pitch against.
 */
export const DEFAULT_TONE_LEAD_MS = 500;
export const MIN_TONE_LEAD_MS = 0;
export const MAX_TONE_LEAD_MS = 1000;

/**
 * Silence before the FIRST note of every exercise. Exercises used to begin on
 * target zero at t=0, which meant the first note was always half-missed —
 * capture, the graph and the singer all started at once.
 */
export const DEFAULT_LEAD_IN_MS = 2000;
export const MIN_LEAD_IN_MS = 0;
export const MAX_LEAD_IN_MS = 5000;

/** Reads a clamped integer setting, falling back to `fallback` for anything unusable. */
function loadClampedMs(key: string, fallback: number, min: number, max: number): number {
  const storage = getStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  } catch {
    return fallback;
  }
}

function persistMs(key: string, value: number, min: number, max: number): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(key, String(Math.max(min, Math.min(max, Math.round(value)))));
  } catch {
    // Non-critical: the player falls back to the default.
  }
}

export function loadToneLeadMs(): number {
  return loadClampedMs(TONE_LEAD_KEY, DEFAULT_TONE_LEAD_MS, MIN_TONE_LEAD_MS, MAX_TONE_LEAD_MS);
}

export function persistToneLeadMs(ms: number): void {
  persistMs(TONE_LEAD_KEY, ms, MIN_TONE_LEAD_MS, MAX_TONE_LEAD_MS);
}

export function loadLeadInMs(): number {
  return loadClampedMs(LEAD_IN_KEY, DEFAULT_LEAD_IN_MS, MIN_LEAD_IN_MS, MAX_LEAD_IN_MS);
}

export function persistLeadInMs(ms: number): void {
  persistMs(LEAD_IN_KEY, ms, MIN_LEAD_IN_MS, MAX_LEAD_IN_MS);
}
/** Unprefixed key used before this moved out of audio-preflight; read once so nobody loses their setting. */
const LEGACY_VOICE_TYPE_KEY = 'userVoiceType';

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadUserVoiceTypeId(): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(VOICE_TYPE_KEY);
    if (value && value.trim() !== '') return value;

    const legacy = storage.getItem(LEGACY_VOICE_TYPE_KEY);
    if (legacy && legacy.trim() !== '') {
      storage.setItem(VOICE_TYPE_KEY, legacy);
      storage.removeItem(LEGACY_VOICE_TYPE_KEY);
      return legacy;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Which voice sounds the reference cue during exercises. Falls back to the
 * default for anything unrecognised, so a value left behind by an older build
 * can never leave the player with no audible cue at all.
 */
export function loadInstrumentId(): InstrumentId {
  const storage = getStorage();
  if (!storage) return DEFAULT_INSTRUMENT;
  try {
    const value = storage.getItem(INSTRUMENT_KEY);
    return normalizeInstrumentId(value) ?? DEFAULT_INSTRUMENT;
  } catch {
    return DEFAULT_INSTRUMENT;
  }
}

export function persistInstrumentId(instrument: InstrumentId): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(INSTRUMENT_KEY, instrument);
  } catch {
    // Non-critical: the player falls back to the default instrument.
  }
}

export function persistUserVoiceTypeId(voiceTypeId: string | null): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (!voiceTypeId) storage.removeItem(VOICE_TYPE_KEY);
    else storage.setItem(VOICE_TYPE_KEY, voiceTypeId);
  } catch {
    // Non-critical: exercises fall back to a default anchor pitch.
  }
}
