import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordDiagnosticFrame, diagnosticSummary, diagnosticJson, clearDiagnostics,
  diagnosticCount, backendSupportsRegisterFeatures, DIAGNOSTIC_CAPACITY,
} from './register-diagnostics';
import type { PitchFrame } from './socket';

function frame(h1h2: number, t = 0): PitchFrame {
  return { t, midi: 60, conf: 0.5, features: { h1h2, tilt: 1, hfrac: 0.9, nh: 8, lvl: -20 } };
}

beforeEach(() => {
  clearDiagnostics();
});

describe('register diagnostics buffer', () => {
  it('ignores frames without features', () => {
    recordDiagnosticFrame({ t: 0, midi: 60, conf: 0.5 });
    expect(diagnosticCount()).toBe(0);
  });

  it('records frames that carry features', () => {
    recordDiagnosticFrame(frame(6));
    expect(diagnosticCount()).toBe(1);
    expect(backendSupportsRegisterFeatures()).toBe(true);
  });

  it('reports the median, not the mean — outliers must not drag it', () => {
    [5, 6, 7, 200].forEach((v, i) => recordDiagnosticFrame(frame(v, i)));
    // mean would be ~54.5; median is 6.5
    expect(diagnosticSummary().medianH1h2).toBe(6.5);
  });

  it('keeps the newest sample as `latest`', () => {
    recordDiagnosticFrame(frame(1));
    recordDiagnosticFrame(frame(9));
    expect(diagnosticSummary().latest?.h1h2).toBe(9);
  });

  it('caps the buffer and keeps the NEWEST samples', () => {
    for (let i = 0; i < DIAGNOSTIC_CAPACITY + 50; i += 1) recordDiagnosticFrame(frame(i, i));
    expect(diagnosticCount()).toBe(DIAGNOSTIC_CAPACITY);
    // Oldest 50 dropped, so the newest value survives.
    expect(diagnosticSummary().latest?.h1h2).toBe(DIAGNOSTIC_CAPACITY + 49);
  });

  it('summarises an empty buffer without throwing', () => {
    const summary = diagnosticSummary();
    expect(summary.count).toBe(0);
    expect(summary.medianH1h2).toBeNull();
    expect(summary.latest).toBeNull();
  });

  it('exports parseable JSON carrying every sample', () => {
    recordDiagnosticFrame(frame(6, 100));
    const parsed = JSON.parse(diagnosticJson());
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.samples[0]).toMatchObject({ tMs: 100, h1h2: 6, nh: 8 });
    expect(typeof parsed.capturedAt).toBe('string');
  });
});
