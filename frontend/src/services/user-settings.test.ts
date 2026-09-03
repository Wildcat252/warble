import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadInstrumentId, persistInstrumentId,
  loadToneLeadMs, persistToneLeadMs,
  loadLeadInMs, persistLeadInMs,
} from './user-settings';
import { DEFAULT_INSTRUMENT } from '../audio/instruments';

beforeEach(() => {
  window.localStorage.clear();
});

describe('instrument setting', () => {
  it('defaults to the sampled piano when nothing is stored', () => {
    expect(loadInstrumentId()).toBe('piano');
    expect(DEFAULT_INSTRUMENT).toBe('piano');
  });

  it('round-trips a stored choice', () => {
    persistInstrumentId('piano');
    expect(loadInstrumentId()).toBe('piano');
  });

  it('migrates a retired synth voice id onto the sampled piano', () => {
    // The oscillator voices were removed when the recorded piano landed;
    // anyone who had chosen one must still get an audible cue.
    window.localStorage.setItem('warble.instrument.v1', 'violin-solo');
    expect(loadInstrumentId()).toBe('piano');
  });

  it('falls back to the default for an unrecognised stored value', () => {
    // e.g. an instrument removed in a later build — the player must still
    // have an audible cue rather than silence.
    window.localStorage.setItem('warble.instrument.v1', 'theremin');
    expect(loadInstrumentId()).toBe(DEFAULT_INSTRUMENT);
  });
});

describe('tone lead and lead-in', () => {
  it('default to 500ms and 2000ms', () => {
    expect(loadToneLeadMs()).toBe(500);
    expect(loadLeadInMs()).toBe(2000);
  });

  it('round-trip stored values', () => {
    persistToneLeadMs(250);
    persistLeadInMs(1000);
    expect(loadToneLeadMs()).toBe(250);
    expect(loadLeadInMs()).toBe(1000);
  });

  it('clamp values written out of range', () => {
    persistToneLeadMs(99999);
    expect(loadToneLeadMs()).toBe(1000);
    persistToneLeadMs(-500);
    expect(loadToneLeadMs()).toBe(0);
  });

  it('clamp values already sitting out of range in storage', () => {
    window.localStorage.setItem('warble.tone-lead-ms.v1', '99999');
    expect(loadToneLeadMs()).toBe(1000);
  });

  it('fall back to the default for unparseable stored values', () => {
    window.localStorage.setItem('warble.tone-lead-ms.v1', 'soon');
    expect(loadToneLeadMs()).toBe(500);
  });
});
