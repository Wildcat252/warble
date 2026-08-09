/**
 * Thin REST wrappers over the backend's /playback/* endpoints.
 *
 * Trimmed during the Warble rework: the tempo/transpose/beat helpers that
 * used to live here only made sense with a MusicXML score driving playback,
 * and were removed alongside the score-following UI. What remains is
 * score-independent capture control — start/pause/resume/stop the backend's
 * microphone pipeline.
 */

export interface PlaybackCommandResponse {
  state: string;
  t_ms: number;
  [key: string]: unknown;
}

async function postPlaybackCommand(path: string): Promise<PlaybackCommandResponse> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) throw new Error(`Playback command failed: ${path} (HTTP ${res.status})`);
  return await res.json() as PlaybackCommandResponse;
}

/**
 * @param deviceId Backend PortAudio device index (see services/audio-device.ts),
 *   or null to let the backend pick its own default input.
 */
export async function startPlayback(deviceId: number | null): Promise<PlaybackCommandResponse> {
  const query = deviceId === null ? '' : `?device_id=${encodeURIComponent(String(deviceId))}`;
  return await postPlaybackCommand(`/playback/start${query}`);
}

export async function postPlayback(path: string): Promise<PlaybackCommandResponse> {
  return await postPlaybackCommand(path);
}

export async function seekPlayback(tMs: number): Promise<PlaybackCommandResponse> {
  return await postPlaybackCommand(`/playback/seek?t_ms=${encodeURIComponent(tMs.toFixed(1))}`);
}
