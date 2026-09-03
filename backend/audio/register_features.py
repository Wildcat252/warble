"""
Per-frame spectral features for vocal register estimation (chest / mix / head).

WHAT THIS IS AND IS NOT
-----------------------
This module measures acoustic quantities. It does NOT decide a register — the
frontend does that, because classification needs the singer's own calibration
anchors, which live in browser storage (the backend is stateless per user).

The physiology, briefly: chest (modal) voice has thick, fully adducted folds
with an abrupt glottal closure, which puts lots of energy into the upper
harmonics. Head voice / falsetto has thinner, less adducted folds and a more
sinusoidal glottal flow, so the fundamental dominates. H1-H2 (the amplitude
difference between the first two harmonics) tracks that difference and is the
best cue available from a single microphone.

It is a cue, not a measurement of the larynx. Known confounds, all real:
  - FORMANTS. H1 and H2 are source amplitudes filtered by the vocal tract. If
    F1 lands near f0 or 2*f0 the reading reflects the vowel, not the register.
    Proper correction (Iseli-Alwan H1*-H2*) needs LPC formant tracking, which
    is fragile at high f0 and out of scope here. Mitigation is to hold the
    vowel constant between calibration and use — hence the calibration prompts
    specify "ah".
  - LOUDNESS. H1-H2 falls with subglottal pressure within a single register,
    so a belted high note and a sighed low note can invert. `level_db` is
    emitted so the caller can at least detect the situation.
  - MIC AND ROOM response. Roughly constant per user, so per-user calibration
    absorbs it — as long as the microphone does not change.

Everything returned is a RATIO (dB differences, fractions), never an absolute
level, so no calibration of window gain, ADC scaling or mic sensitivity is
needed and none should be attempted.

numpy only — deliberately no scipy.signal and no librosa.feature, per the
Application Control note in CLAUDE.md.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

# Bumped whenever the numbers this module produces change meaning. Stored
# calibration anchors record the version they were captured under and are
# refused if it no longer matches — otherwise a DSP tweak would silently
# invalidate every user's calibration while still looking plausible.
REGISTER_FEATURE_VERSION: int = 1

# Zero-pad factor for the analysis FFT (2048 -> 8192).
#
# NOT for frequency resolution: H1 and H2 are separated by f0 itself (>= 49Hz
# at the pipeline's FMIN_HZ) against a ~21.5Hz Hann resolution limit, so they
# are never in danger of merging.
#
# It is for SCALLOPING LOSS. A partial landing between two bins reads up to
# 1.42 dB below its true amplitude with a Hann window. H1 and H2 scallop
# independently, so H1-H2 can carry ~2.8 dB of pure quantisation error —
# a large fraction of the 3-10 dB effect being measured. 4x padding puts that
# under 0.1 dB. Costs ~100us against a 46ms hop, so it is effectively free.
FFT_ZERO_PAD_FACTOR: int = 4

# Below this, H1 sits within a few bins of DC, where mean-removal residue,
# mic rumble and Hann leakage from low-frequency room noise contaminate it.
# Nobody sings head voice down here, so refusing to guess costs nothing.
MIN_F0_HZ: float = 70.0

# Harmonic search half-width: the larger of 3% of the harmonic's frequency
# (~half a semitone, covering f0 estimation error and vibrato smearing) and a
# floor of 1.5 raw bins, which keeps the band from collapsing to sub-bin width
# for low harmonics.
HARMONIC_SEARCH_REL: float = 0.03
HARMONIC_SEARCH_MIN_BINS: float = 1.5

# Half-width of a Hann main lobe, in raw (un-padded) bins. Power is summed
# across the lobe rather than read from a single bin, which removes the
# residual sensitivity to exactly where the peak falls.
HANN_HALF_LOBE_BINS: float = 2.0

# Highest harmonic we bother measuring. Beyond ~8 the partials of a high note
# are above Nyquist anyway, and low ones contribute little to the ratios.
MAX_HARMONICS: int = 8

# Upper edge of the spectral-tilt high band. Above this is mostly sibilance
# and microphone hiss, which would dominate the band at low signal levels.
TILT_MAX_HZ: float = 5000.0

# Spectral tilt band split, as a multiple of f0. Deliberately f0-RELATIVE
# rather than the literature's fixed 1kHz "alpha ratio" split: at f0=880Hz a
# fixed 1kHz boundary leaves only H1 in the low band, so the feature would
# measure something structurally different at high pitch than at low pitch.
# That is fatal here, because the chest anchor is captured low and the head
# anchor high. f0-relative makes it "energy above the first two harmonics",
# which is comparable across the range.
TILT_SPLIT_HARMONIC: float = 2.5
TILT_LOW_START_HARMONIC: float = 0.5

# A pYIN octave error (f0 reported an octave low) puts the assumed H1 where
# there is no partial at all, so the measured H1-H2 collapses to a large
# negative value that looks maximally "chest". `harmonic_fraction` does NOT
# catch this — the assumed harmonics still land on real partials. Frames below
# this floor are reported as invalid rather than as very confident chest.
# Provisional: real singing rarely goes below about -8 dB, so -12 leaves
# margin. Confirm against captured data before relying on it.
OCTAVE_ERROR_H1H2_FLOOR_DB: float = -12.0

# Guards log10 of a silent band.
_EPS: float = 1e-12


@dataclass(frozen=True)
class RegisterFeatures:
    """Acoustic features for one analysis window. All ratios, no absolute levels."""

    # 20*log10(A1/A2). Low or negative => spectrally rich (chest-like);
    # high => fundamental-dominated (head-like).
    h1h2_db: float
    # 10*log10(P_low/P_high) across f0-relative bands. Higher => more
    # fundamental-dominated. Integrated over many bins, so unlike h1h2_db it
    # survives any single harmonic being mangled by a formant.
    tilt_db: float
    # Fraction of in-band power falling inside the measured harmonic lobes.
    # A VALIDITY GATE, not a classification feature: low values mean breathy,
    # noisy or barely-voiced audio whose h1h2_db is meaningless.
    harmonic_fraction: float
    # How many harmonics were actually measurable below Nyquist.
    harmonics_measured: int
    # RMS in relative dBFS. Not for classification — it exists so the caller
    # can spot the loudness confound and so calibration can record the level
    # its anchors were captured at.
    level_db: float

    def to_payload(self) -> dict[str, float]:
        """Compact form for the pitch WebSocket. Keys are short — one per frame at ~21fps."""
        return {
            "h1h2": round(self.h1h2_db, 2),
            "tilt": round(self.tilt_db, 2),
            "hfrac": round(self.harmonic_fraction, 3),
            "nh": self.harmonics_measured,
            "lvl": round(self.level_db, 1),
        }


def _harmonic_amplitude(
    mag: np.ndarray,
    hz_per_bin: float,
    target_hz: float,
    raw_hz_per_bin: float,
) -> tuple[float, tuple[int, int]] | None:
    """
    Power of the partial nearest `target_hz`, plus the bin span it occupied.

    Locates the peak inside a tolerance band and then sums power across one
    Hann main lobe around it, rather than reading a single bin — see
    FFT_ZERO_PAD_FACTOR for why single-bin reads are not good enough.
    """
    half_hz = max(HARMONIC_SEARCH_REL * target_hz, HARMONIC_SEARCH_MIN_BINS * raw_hz_per_bin)
    lo = math.floor((target_hz - half_hz) / hz_per_bin)
    hi = math.ceil((target_hz + half_hz) / hz_per_bin)
    lo = max(lo, 0)
    hi = min(hi, mag.size - 1)
    if hi <= lo:
        return None

    band = mag[lo : hi + 1]
    peak = lo + int(np.argmax(band))

    lobe_bins = math.ceil((HANN_HALF_LOBE_BINS * raw_hz_per_bin) / hz_per_bin)
    p_lo = max(peak - lobe_bins, 0)
    p_hi = min(peak + lobe_bins, mag.size - 1)

    power = float(np.sum(mag[p_lo : p_hi + 1] ** 2))
    return power, (p_lo, p_hi)


def _band_power(mag: np.ndarray, hz_per_bin: float, lo_hz: float, hi_hz: float) -> float:
    lo = max(math.floor(lo_hz / hz_per_bin), 0)
    hi = min(math.ceil(hi_hz / hz_per_bin), mag.size - 1)
    if hi <= lo:
        return 0.0
    return float(np.sum(mag[lo : hi + 1] ** 2))


def compute_register_features(
    window: np.ndarray,
    f0_hz: float,
    sample_rate: int,
) -> RegisterFeatures | None:
    """
    Spectral features for one analysis window whose fundamental is already known.

    `f0_hz` comes from the pitch engine, which makes this far easier than blind
    harmonic analysis: partials are never searched for, only measured at
    predicted locations.

    Returns None — never raises — when the frame cannot be measured honestly:
    non-finite or empty input, f0 below MIN_F0_HZ, silence, or a suspected
    octave error. Callers treat None as "no register information for this
    frame", which is always a valid outcome.
    """
    if window is None or window.size < 16:
        return None
    if not math.isfinite(f0_hz) or f0_hz < MIN_F0_HZ:
        return None

    samples = np.asarray(window, dtype=np.float64)
    if not np.all(np.isfinite(samples)):
        return None

    nyquist = sample_rate / 2.0
    if f0_hz * 2.0 >= nyquist:
        # Without H2 there is no h1h2_db at all.
        return None

    rms = float(np.sqrt(np.mean(samples**2)))
    if rms <= _EPS:
        return None

    # Remove DC before windowing: microphone DC offset otherwise leaks into
    # the H1 measurement, which sits only a handful of bins from 0 Hz.
    centred = samples - float(np.mean(samples))

    n = centred.size
    windowed = centred * np.hanning(n)
    fft_size = int(n * FFT_ZERO_PAD_FACTOR)
    mag = np.abs(np.fft.rfft(windowed, n=fft_size))

    hz_per_bin = sample_rate / fft_size
    raw_hz_per_bin = sample_rate / n

    # --- Harmonic amplitudes -------------------------------------------------
    harmonic_power: list[float] = []
    lobe_spans: list[tuple[int, int]] = []
    for k in range(1, MAX_HARMONICS + 1):
        target = k * f0_hz
        if target >= nyquist * 0.9:
            break
        found = _harmonic_amplitude(mag, hz_per_bin, target, raw_hz_per_bin)
        if found is None:
            break
        power, span = found
        harmonic_power.append(power)
        lobe_spans.append(span)

    if len(harmonic_power) < 2:
        return None

    a1 = harmonic_power[0]
    a2 = harmonic_power[1]
    if a1 <= _EPS or a2 <= _EPS:
        return None

    # Powers, so 10*log10 gives the same value 20*log10 would on amplitudes.
    h1h2_db = 10.0 * math.log10(a1 / a2)

    # Suspected octave error — see OCTAVE_ERROR_H1H2_FLOOR_DB.
    if h1h2_db < OCTAVE_ERROR_H1H2_FLOOR_DB:
        return None

    # --- Spectral tilt -------------------------------------------------------
    split_hz = TILT_SPLIT_HARMONIC * f0_hz
    low_start_hz = TILT_LOW_START_HARMONIC * f0_hz
    high_end_hz = min(TILT_MAX_HZ, nyquist)
    if split_hz >= high_end_hz:
        # f0 so high that there is no meaningful "above the first harmonics"
        # band left. Report tilt as 0 rather than inventing a ratio; the
        # frontend drops a feature whose anchors do not separate anyway.
        tilt_db = 0.0
    else:
        p_low = _band_power(mag, hz_per_bin, low_start_hz, split_hz)
        p_high = _band_power(mag, hz_per_bin, split_hz, high_end_hz)
        tilt_db = 10.0 * math.log10((p_low + _EPS) / (p_high + _EPS))

    # --- Harmonic fraction (validity gate) -----------------------------------
    total_power = _band_power(mag, hz_per_bin, low_start_hz, high_end_hz)
    if total_power <= _EPS:
        return None
    covered = 0.0
    last_hi = -1
    for lo, hi in lobe_spans:
        # Spans can touch at high harmonic numbers; do not double count.
        start = max(lo, last_hi + 1)
        if hi >= start:
            covered += float(np.sum(mag[start : hi + 1] ** 2))
            last_hi = hi
    harmonic_fraction = min(1.0, covered / total_power)

    level_db = 20.0 * math.log10(rms + _EPS)

    return RegisterFeatures(
        h1h2_db=h1h2_db,
        tilt_db=tilt_db,
        harmonic_fraction=harmonic_fraction,
        harmonics_measured=len(harmonic_power),
        level_db=level_db,
    )
