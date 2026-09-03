/**
 * Optional spectral features for vocal-register estimation, present only when
 * the backend could measure the window (see backend/audio/register_features.py).
 *
 * Absent — not null — on frames where measurement failed, so a frame without
 * them is identical to the pre-register wire contract. Treat `undefined` as
 * "no register information for this frame", which is always valid: sub-threshold
 * frames, very low pitch, and suspected octave errors all produce it.
 */
export interface RegisterFeatures {
  /** dB difference between the first two harmonics. Low/negative = spectrally rich. */
  h1h2: number;
  /** dB spectral tilt across f0-relative bands. Higher = fundamental-dominated. */
  tilt: number;
  /** Fraction of in-band power inside the harmonic lobes — a validity gate, not a feature. */
  hfrac: number;
  /** Harmonics measured below Nyquist. */
  nh: number;
  /** RMS in relative dBFS — for spotting the loudness confound. */
  lvl: number;
}

export interface PitchFrame {
  t: number;
  midi: number;
  conf: number;
  features?: RegisterFeatures;
}

export type PitchSocketMessage =
  | { kind: 'frame'; frame: PitchFrame }
  | { kind: 'status'; registerFeatureVersion: number | null }
  | { kind: 'ping' }
  | { kind: 'unknown' };

export const PITCH_RECONNECT_BASE_MS = 500;
export const PITCH_RECONNECT_MAX_MS = 5000;

export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 0) return PITCH_RECONNECT_BASE_MS;
  return Math.min(PITCH_RECONNECT_BASE_MS * (2 ** (attempt - 1)), PITCH_RECONNECT_MAX_MS);
}

/**
 * Register features are all-or-nothing: a partial set means the backend and
 * frontend disagree about the contract, and half-measured features would be
 * worse than none. Returns undefined unless every field is present.
 */
function parseRegisterFeatures(payload: Record<string, unknown>): RegisterFeatures | undefined {
  const { h1h2, tilt, hfrac, nh, lvl } = payload;
  if (typeof h1h2 !== 'number' || typeof tilt !== 'number' || typeof hfrac !== 'number'
    || typeof nh !== 'number' || typeof lvl !== 'number') {
    return undefined;
  }
  return { h1h2, tilt, hfrac, nh, lvl };
}

export function parsePitchFrame(payload: unknown): PitchFrame | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const frame = payload as { t?: unknown; midi?: unknown; conf?: unknown };
  if (typeof frame.t !== 'number' || typeof frame.midi !== 'number' || typeof frame.conf !== 'number') {
    return null;
  }
  const features = parseRegisterFeatures(payload as Record<string, unknown>);
  // Omit the key entirely when absent rather than setting it undefined, so
  // deep-equality assertions against the legacy shape still hold.
  return features
    ? { t: frame.t, midi: frame.midi, conf: frame.conf, features }
    : { t: frame.t, midi: frame.midi, conf: frame.conf };
}

export function parsePitchSocketMessage(payload: unknown): PitchSocketMessage {
  if (typeof payload !== 'object' || payload === null) return { kind: 'unknown' };
  const message = payload as { status?: unknown; ping?: unknown; registerFeatureVersion?: unknown };

  if (message.status === 'connected') {
    // Version is null against a backend that predates register features —
    // stored calibration is then unusable, which is the correct outcome.
    return {
      kind: 'status',
      registerFeatureVersion: typeof message.registerFeatureVersion === 'number'
        ? message.registerFeatureVersion
        : null,
    };
  }
  if (message.ping === true) {
    return { kind: 'ping' };
  }

  const frame = parsePitchFrame(payload);
  if (frame) {
    return { kind: 'frame', frame };
  }

  return { kind: 'unknown' };
}
