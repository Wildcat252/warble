/**
 * Backend capture-device selection.
 *
 * IMPORTANT: this is a different namespace from services/audio-preflight.ts's
 * stored device id. That one is a BROWSER navigator.mediaDevices deviceId (an
 * opaque hash string, used only for the preflight modal's own getUserMedia
 * level meter). This one is a `sounddevice`/PortAudio integer index from the
 * backend's own /audio/devices list, which is what /playback/start's
 * device_id parameter expects.
 *
 * Conflating the two previously caused the backend to crash opening a
 * nonexistent device (PortAudioError -9986), so they are kept deliberately
 * separate and named for the scheme they belong to.
 */
import { STORAGE_PREFIX } from '../branding';

const STORAGE_KEY = `${STORAGE_PREFIX}.backend-device-id.v1`;

export interface BackendAudioDevice {
  id: number;
  name: string;
  channels: number;
  host_api: string;
  default_sample_rate: number;
}

export interface BackendAudioDeviceList {
  default_device_id: number | null;
  devices: BackendAudioDevice[];
}

export interface PitchEngineInfo {
  active_engine: string;
  mode: string;
  switchable: boolean;
  cuda: boolean;
  device: string;
  force_cpu: boolean;
  xrun_count: number;
}

export async function fetchAudioDevices(): Promise<BackendAudioDeviceList> {
  const res = await fetch('/audio/devices');
  if (!res.ok) throw new Error(`/audio/devices HTTP ${res.status}`);
  return await res.json() as BackendAudioDeviceList;
}

export async function fetchPitchEngine(): Promise<PitchEngineInfo> {
  const res = await fetch('/audio/engine');
  if (!res.ok) throw new Error(`/audio/engine HTTP ${res.status}`);
  return await res.json() as PitchEngineInfo;
}

export async function setForceCpu(forceCpu: boolean): Promise<void> {
  const res = await fetch(`/audio/engine/force-cpu?force_cpu=${forceCpu ? 'true' : 'false'}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`/audio/engine/force-cpu HTTP ${res.status}`);
}

/**
 * What we remember about the chosen device.
 *
 * The NAME is stored alongside the index because a PortAudio index is not a
 * stable identifier. Connecting or removing a device renumbers everything
 * after it: with an iPhone attached, index 1 on this machine is "MacBook Air
 * Microphone"; unplug it and index 1 becomes "MacBook Air Speakers", an
 * output. A stored index therefore silently comes to mean a different
 * device — and pointing capture at an output raises PortAudio -9998, which
 * surfaced as an unexplained HTTP 500 at the start of an exercise.
 *
 * The name is what the user actually chose, so it is the better key; the
 * index is kept as a fast path and a tie-breaker between identically named
 * devices.
 */
interface StoredDevice {
  id: number;
  name: string;
}

function readStored(): StoredDevice | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return null;
    // Values written before names were stored are a bare integer.
    if (/^-?\d+$/.test(raw.trim())) {
      return { id: Number.parseInt(raw, 10), name: '' };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { id, name } = parsed as Partial<StoredDevice>;
    if (typeof id !== 'number' || Number.isNaN(id)) return null;
    return { id, name: typeof name === 'string' ? name : '' };
  } catch {
    return null;
  }
}

/**
 * Returns null when nothing is stored, which /playback/start treats as
 * "use the backend's own default input device" — the right behaviour for
 * anyone who never opens Settings.
 *
 * This is the RAW stored index and may be stale; anything about to open the
 * device should call resolveBackendDeviceId() against a fresh device list
 * instead. Kept for the Settings picker, which only needs to show the current
 * selection, and for the calibration check that compares "same device?".
 */
export function loadBackendDeviceId(): number | null {
  return readStored()?.id ?? null;
}

export interface ResolvedDevice {
  /** Index to send to /playback/start, or null to use the backend default. */
  id: number | null;
  /** True when the stored index had drifted and was recovered by name. */
  repaired: boolean;
  /** True when the stored device is gone entirely and the default is being used. */
  fellBack: boolean;
  name: string | null;
}

/**
 * Maps the stored choice onto the device list as it is RIGHT NOW.
 *
 * Order matters: the name is trusted over the index, because the name is what
 * the user picked and the index is only where it happened to sit that day.
 */
export function resolveBackendDeviceId(list: BackendAudioDeviceList): ResolvedDevice {
  const stored = readStored();
  if (!stored) return { id: null, repaired: false, fellBack: false, name: null };

  const byId = list.devices.find((d) => d.id === stored.id);
  if (byId && (stored.name === '' || byId.name === stored.name)) {
    return { id: byId.id, repaired: false, fellBack: false, name: byId.name };
  }

  const byName = stored.name === ''
    ? undefined
    : list.devices.find((d) => d.name === stored.name);
  if (byName) {
    return { id: byName.id, repaired: true, fellBack: false, name: byName.name };
  }

  // Gone: an index that now means something else, with no matching name.
  // Falling back beats failing to start at all.
  return { id: null, repaired: false, fellBack: true, name: stored.name || null };
}

export function persistBackendDeviceId(deviceId: number | null, name = ''): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    if (deviceId === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: deviceId, name }));
  } catch {
    // Non-critical: falling back to the backend default is acceptable.
  }
}
