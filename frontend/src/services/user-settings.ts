/**
 * User voice preferences.
 *
 * Previously lived in services/audio-preflight.ts, back when the mic-setup
 * modal owned a voice-type picker. That picker moved to the Settings screen
 * and the modal is now purely a level test, so keeping this here under the
 * preflight name would have been actively misleading about who owns it.
 */
import { STORAGE_PREFIX } from '../branding';

const VOICE_TYPE_KEY = `${STORAGE_PREFIX}.voice-type.v1`;
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
