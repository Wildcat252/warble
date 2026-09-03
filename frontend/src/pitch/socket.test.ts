import { describe, expect, it } from 'vitest';
import { parsePitchFrame, parsePitchSocketMessage, reconnectDelayMs } from './socket';

describe('reconnectDelayMs', () => {
  it('uses exponential backoff capped at max delay', () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(500);
    expect(reconnectDelayMs(2)).toBe(1000);
    expect(reconnectDelayMs(3)).toBe(2000);
    expect(reconnectDelayMs(4)).toBe(4000);
    expect(reconnectDelayMs(5)).toBe(5000);
    expect(reconnectDelayMs(8)).toBe(5000);
  });
});

describe('parsePitchFrame', () => {
  it('accepts valid numeric frames', () => {
    expect(parsePitchFrame({ t: 0.1, midi: 60, conf: 0.8 })).toEqual({ t: 0.1, midi: 60, conf: 0.8 });
  });

  it('rejects malformed payloads', () => {
    expect(parsePitchFrame(null)).toBeNull();
    expect(parsePitchFrame({})).toBeNull();
    expect(parsePitchFrame({ t: '0.1', midi: 60, conf: 0.8 })).toBeNull();
    expect(parsePitchFrame({ t: 0.1, midi: 60 })).toBeNull();
  });
});

describe('parsePitchSocketMessage', () => {
  it('classifies control messages', () => {
    // The handshake now also carries the backend's register DSP version;
    // null when talking to a backend that predates register features.
    expect(parsePitchSocketMessage({ status: 'connected' }))
      .toEqual({ kind: 'status', registerFeatureVersion: null });
    expect(parsePitchSocketMessage({ status: 'connected', registerFeatureVersion: 1 }))
      .toEqual({ kind: 'status', registerFeatureVersion: 1 });
    expect(parsePitchSocketMessage({ ping: true })).toEqual({ kind: 'ping' });
  });

  it('returns frame messages for valid pitch payloads', () => {
    expect(parsePitchSocketMessage({ t: 100, midi: 60.2, conf: 0.9 })).toEqual({
      kind: 'frame',
      frame: { t: 100, midi: 60.2, conf: 0.9 },
    });
  });

  it('classifies malformed payloads as unknown', () => {
    expect(parsePitchSocketMessage('abc')).toEqual({ kind: 'unknown' });
    expect(parsePitchSocketMessage({ ping: 'true' })).toEqual({ kind: 'unknown' });
    expect(parsePitchSocketMessage({ status: 'ok' })).toEqual({ kind: 'unknown' });
  });
});

describe('register features on the wire', () => {
  const base = { t: 10, midi: 60, conf: 0.5 };
  const feats = { h1h2: 6.2, tilt: 1.4, hfrac: 0.88, nh: 8, lvl: -27.3 };

  it('parses features when every field is present', () => {
    const frame = parsePitchFrame({ ...base, ...feats });
    expect(frame?.features).toEqual(feats);
  });

  it('omits the key entirely for a legacy frame, preserving the old shape', () => {
    // Deep equality against the pre-register shape must still hold — that is
    // what makes the wire change backward compatible in both directions.
    expect(parsePitchFrame(base)).toEqual(base);
    expect(parsePitchFrame(base)).not.toHaveProperty('features');
  });

  it('ignores a partial feature set rather than half-populating it', () => {
    const frame = parsePitchFrame({ ...base, h1h2: 6.2, tilt: 1.4 });
    expect(frame).not.toBeNull();
    expect(frame?.features).toBeUndefined();
  });

  it('ignores features whose fields are the wrong type', () => {
    const frame = parsePitchFrame({ ...base, ...feats, nh: 'eight' });
    expect(frame?.features).toBeUndefined();
  });

  it('still rejects a frame missing the core pitch fields', () => {
    expect(parsePitchFrame({ ...feats, midi: 60, conf: 0.5 })).toBeNull();
  });
});
