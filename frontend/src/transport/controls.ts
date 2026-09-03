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

/**
 * Pulls the human-readable reason out of a FastAPI error body.
 *
 * /playback/start answers a bad device with a 400 whose `detail` carries the
 * PortAudio message and the currently valid devices. Reporting only the status
 * code turned a fixable "you picked a device that no longer exists" into an
 * opaque "HTTP 500" the singer could do nothing with.
 */
async function describeFailure(res: Response, path: string): Promise<string> {
  try {
    const body: unknown = await res.json();
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') {
      const { message } = detail as { message?: unknown };
      if (typeof message === 'string') return message;
    }
  } catch {
    // Non-JSON body (a bare 500 from an unhandled error): fall through.
  }
  return `Playback command failed: ${path} (HTTP ${res.status})`;
}

async function postPlaybackCommand(path: string): Promise<PlaybackCommandResponse> {
  const res = await fetch(path, { method: 'POST' });
  if (!res.ok) throw new Error(await describeFailure(res, path));
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
