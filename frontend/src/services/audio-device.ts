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
 * Returns null when nothing is stored, which /playback/start treats as
 * "use the backend's own default input device" — the right behaviour for
 * anyone who never opens Settings.
 */
export function loadBackendDeviceId(): number | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export function persistBackendDeviceId(deviceId: number | null): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    if (deviceId === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(deviceId));
  } catch {
    // Non-critical: falling back to the backend default is acceptable.
  }
}
