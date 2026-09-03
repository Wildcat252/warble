"""
Tests for the register feature extractor.

IMPORTANT — what these tests do and do not establish.

They verify that the extractor recovers KNOWN harmonic amplitudes from
synthetic signals. That is a claim about DSP correctness and nothing else.
They establish nothing about human voices: no synthetic tone is "chest voice",
and there is no way to write one. Whether these features separate a real
singer's registers can only be answered by recording a real singer.

Fixtures are therefore named `spectrally_rich` / `fundamental_dominated`, in
terms of what they actually are, so no future reader mistakes a signal
generator for validated physiology.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from backend.audio.register_features import (
    MIN_F0_HZ,
    OCTAVE_ERROR_H1H2_FLOOR_DB,
    REGISTER_FEATURE_VERSION,
    RegisterFeatures,
    compute_register_features,
)

SAMPLE_RATE = 22050
WINDOW = 2048


def synth(
    f0: float,
    amplitudes: list[float],
    *,
    n: int = WINDOW,
    sample_rate: int = SAMPLE_RATE,
    phases: list[float] | None = None,
    noise: float = 0.0,
    seed: int = 0,
) -> np.ndarray:
    """Sum of harmonics k*f0 with the given linear amplitudes."""
    t = np.arange(n) / sample_rate
    rng = np.random.default_rng(seed)
    if phases is None:
        phases = [0.0] * len(amplitudes)
    out = np.zeros(n, dtype=np.float64)
    for k, (amp, phase) in enumerate(zip(amplitudes, phases), start=1):
        freq = k * f0
        if freq >= sample_rate / 2:
            continue
        out += amp * np.sin(2 * np.pi * freq * t + phase)
    if noise > 0:
        out += rng.normal(0.0, noise, size=n)
    return out.astype(np.float32)


def amps_for_h1h2_db(db: float, n_harmonics: int = 6) -> list[float]:
    """Amplitudes whose H1/H2 ratio is exactly `db`, with a plain 1/k tail."""
    a1 = 1.0
    a2 = a1 / (10 ** (db / 20.0))
    return [a1, a2] + [a2 / k for k in range(2, n_harmonics)]


class TestH1H2Recovery:
    """The core claim: a known H1/H2 amplitude ratio is recovered in dB."""

    @pytest.mark.parametrize("target_db", [-6.0, -3.0, 0.0, 3.0, 6.0, 9.0, 12.0])
    def test_recovers_known_ratio(self, target_db: float) -> None:
        sig = synth(220.0, amps_for_h1h2_db(target_db))
        feats = compute_register_features(sig, 220.0, SAMPLE_RATE)
        assert feats is not None
        # Tolerance is tight on purpose: scalloping loss alone would blow
        # past 0.3 dB if the zero-padding were removed, so this is the test
        # that catches that regression.
        assert feats.h1h2_db == pytest.approx(target_db, abs=0.3)

    @pytest.mark.parametrize("f0", [80.0, 110.0, 165.0, 220.0, 330.0, 440.0, 660.0, 900.0])
    def test_is_pitch_independent(self, f0: float) -> None:
        """
        The single most valuable test here: at a FIXED amplitude ratio the
        recovered value must not drift with f0.

        This pins the extractor's pitch-independence, which is a completely
        separate claim from any physiological one — and the property the
        frontend's cross-pitch comparison depends on.
        """
        sig = synth(f0, amps_for_h1h2_db(6.0))
        feats = compute_register_features(sig, f0, SAMPLE_RATE)
        assert feats is not None
        assert feats.h1h2_db == pytest.approx(6.0, abs=0.5)

    def test_is_phase_invariant(self) -> None:
        """Catches real-part-instead-of-magnitude and windowing mistakes."""
        rng = np.random.default_rng(7)
        results = []
        for _ in range(6):
            phases = list(rng.uniform(0, 2 * np.pi, size=6))
            sig = synth(220.0, amps_for_h1h2_db(6.0), phases=phases)
            feats = compute_register_features(sig, 220.0, SAMPLE_RATE)
            assert feats is not None
            results.append(feats.h1h2_db)
        assert max(results) - min(results) < 0.5

    def test_is_level_invariant(self) -> None:
        """Features are ratios, so scaling the signal must not change them."""
        base = synth(220.0, amps_for_h1h2_db(6.0))
        loud = compute_register_features(base * 4.0, 220.0, SAMPLE_RATE)
        quiet = compute_register_features(base * 0.05, 220.0, SAMPLE_RATE)
        assert loud is not None and quiet is not None
        assert loud.h1h2_db == pytest.approx(quiet.h1h2_db, abs=0.1)
        assert loud.tilt_db == pytest.approx(quiet.tilt_db, abs=0.1)
        # level_db, by contrast, SHOULD move — that is its whole job.
        assert loud.level_db > quiet.level_db + 20

    def test_tolerates_f0_estimation_error(self) -> None:
        """A 20-cent f0 error must still find the partials (±3% search band)."""
        f0 = 220.0
        sig = synth(f0, amps_for_h1h2_db(6.0))
        wrong = f0 * (2 ** (20 / 1200))
        feats = compute_register_features(sig, wrong, SAMPLE_RATE)
        assert feats is not None
        assert feats.h1h2_db == pytest.approx(6.0, abs=0.6)


class TestSpectralTilt:
    def test_monotonic_in_harmonic_rolloff(self) -> None:
        """Steeper rolloff (fewer upper harmonics) => higher tilt_db."""
        f0 = 220.0
        values = []
        for alpha in (0.5, 1.0, 2.0, 3.0):
            amps = [1.0 / (k**alpha) for k in range(1, 9)]
            feats = compute_register_features(synth(f0, amps), f0, SAMPLE_RATE)
            assert feats is not None
            values.append(feats.tilt_db)
        assert values == sorted(values), f"tilt should rise with alpha, got {values}"

    def test_spectrally_rich_vs_fundamental_dominated(self) -> None:
        """
        A signal with strong upper harmonics reads lower on both features than
        one dominated by its fundamental.

        NOTE: this is a statement about these two synthetic signals, NOT about
        chest and head voice. See the module docstring.
        """
        f0 = 220.0
        rich = compute_register_features(
            synth(f0, [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]), f0, SAMPLE_RATE
        )
        dominated = compute_register_features(
            synth(f0, [1.0, 0.15, 0.05, 0.02, 0.01, 0.005]), f0, SAMPLE_RATE
        )
        assert rich is not None and dominated is not None
        assert dominated.h1h2_db > rich.h1h2_db
        assert dominated.tilt_db > rich.tilt_db


class TestValidityGates:
    def test_harmonic_fraction_falls_with_noise(self) -> None:
        f0 = 220.0
        amps = amps_for_h1h2_db(6.0)
        clean = compute_register_features(synth(f0, amps), f0, SAMPLE_RATE)
        noisy = compute_register_features(synth(f0, amps, noise=0.30), f0, SAMPLE_RATE)
        assert clean is not None and noisy is not None
        assert clean.harmonic_fraction > noisy.harmonic_fraction

    def test_octave_error_is_rejected(self) -> None:
        """
        Halving f0 puts the assumed H1 where no partial exists, so h1h2_db
        collapses. That must read as "cannot measure", not as confident chest.
        """
        f0 = 220.0
        sig = synth(f0, amps_for_h1h2_db(6.0))
        assert compute_register_features(sig, f0 / 2.0, SAMPLE_RATE) is None

    def test_rejects_f0_below_floor(self) -> None:
        sig = synth(60.0, amps_for_h1h2_db(6.0))
        assert compute_register_features(sig, 60.0, SAMPLE_RATE) is None
        assert MIN_F0_HZ > 60.0

    def test_rejects_f0_whose_second_harmonic_exceeds_nyquist(self) -> None:
        sig = synth(440.0, amps_for_h1h2_db(6.0))
        assert compute_register_features(sig, 8000.0, SAMPLE_RATE) is None

    def test_counts_measurable_harmonics(self) -> None:
        """
        High f0 pushes upper harmonics past Nyquist, so fewer are measurable.
        1500Hz is chosen because 7*1500 already exceeds the 0.9*Nyquist cutoff,
        whereas at 900Hz all 8 still fit and nothing truncates.
        """
        low = compute_register_features(synth(110.0, amps_for_h1h2_db(6.0)), 110.0, SAMPLE_RATE)
        high = compute_register_features(synth(1500.0, amps_for_h1h2_db(6.0)), 1500.0, SAMPLE_RATE)
        assert low is not None and high is not None
        assert low.harmonics_measured > high.harmonics_measured


class TestDegenerateInputs:
    """None is always an acceptable answer. An exception never is."""

    @pytest.mark.parametrize(
        "window,f0",
        [
            (np.zeros(WINDOW, dtype=np.float32), 220.0),
            (np.zeros(4, dtype=np.float32), 220.0),
            (np.full(WINDOW, np.nan, dtype=np.float32), 220.0),
            (np.full(WINDOW, np.inf, dtype=np.float32), 220.0),
            (synth(220.0, [1.0, 0.5]), 0.0),
            (synth(220.0, [1.0, 0.5]), -100.0),
            (synth(220.0, [1.0, 0.5]), float("nan")),
        ],
    )
    def test_returns_none_without_raising(self, window: np.ndarray, f0: float) -> None:
        assert compute_register_features(window, f0, SAMPLE_RATE) is None

    def test_handles_empty_window(self) -> None:
        assert compute_register_features(np.array([], dtype=np.float32), 220.0, SAMPLE_RATE) is None


class TestPayload:
    def test_payload_keys_and_rounding(self) -> None:
        feats = RegisterFeatures(
            h1h2_db=6.789,
            tilt_db=-1.234,
            harmonic_fraction=0.87654,
            harmonics_measured=7,
            level_db=-27.34,
        )
        assert feats.to_payload() == {
            "h1h2": 6.79,
            "tilt": -1.23,
            "hfrac": 0.877,
            "nh": 7,
            "lvl": -27.3,
        }

    def test_feature_version_is_positive(self) -> None:
        assert REGISTER_FEATURE_VERSION >= 1


class TestPerformance:
    def test_stays_well_under_the_hop_budget(self) -> None:
        """
        Frames arrive every ~46ms. Guards against an O(n^2) peak search
        creeping in — this should be well under 1ms per call.
        """
        import time

        sig = synth(220.0, amps_for_h1h2_db(6.0))
        start = time.perf_counter()
        for _ in range(200):
            compute_register_features(sig, 220.0, SAMPLE_RATE)
        per_call_ms = (time.perf_counter() - start) / 200 * 1000
        assert per_call_ms < 5.0, f"{per_call_ms:.2f}ms per call"


def test_octave_floor_constant_is_negative() -> None:
    """A positive floor would reject ordinary head voice."""
    assert OCTAVE_ERROR_H1H2_FLOOR_DB < 0
    assert math.isfinite(OCTAVE_ERROR_H1H2_FLOOR_DB)


class TestPipelineIntegration:
    """
    The wiring, not the DSP: features must reach PitchFrame and the WS payload
    without disturbing the pre-existing three-key contract.
    """

    def test_infer_attaches_features_to_frame(self) -> None:
        from backend.audio.pitch import Engine, PitchPipeline

        pipeline = PitchPipeline(engine=Engine.PYIN)
        sig = synth(220.0, amps_for_h1h2_db(6.0))
        frame = pipeline._infer(sig, capture_time_ms=123.0)

        assert frame is not None, "a clean 220Hz tone should be detected"
        assert frame.features is not None
        assert isinstance(frame.features, RegisterFeatures)
        assert frame.features.h1h2_db == pytest.approx(6.0, abs=0.5)

    def test_infer_survives_feature_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """
        A register bug must never cost us a pitch frame — the whole reason the
        extraction call is wrapped separately from _worker's handler.
        """
        import backend.audio.pitch as pitch_mod
        from backend.audio.pitch import Engine, PitchPipeline

        def boom(*_args, **_kwargs):
            raise RuntimeError("synthetic DSP failure")

        monkeypatch.setattr(pitch_mod, "compute_register_features", boom)

        pipeline = PitchPipeline(engine=Engine.PYIN)
        frame = pipeline._infer(synth(220.0, amps_for_h1h2_db(6.0)), capture_time_ms=1.0)

        assert frame is not None, "pitch must survive a register failure"
        assert frame.features is None

    def test_payload_omits_keys_when_features_absent(self) -> None:
        """
        Absent features means the keys are MISSING, not null — that is what
        keeps the frame wire contract byte-identical for older clients.
        """
        from backend.models.transcription import PitchFrame

        frame = PitchFrame(time_ms=10.0, midi=60.0, confidence=0.5)
        assert frame.features is None
        assert frame.to_dict() == {"time_ms": 10.0, "midi": 60.0, "confidence": 0.5}

    def test_to_dict_excludes_features(self) -> None:
        """to_dict() is the transcription contract and stays dict[str, float]."""
        from backend.models.transcription import PitchFrame

        feats = RegisterFeatures(
            h1h2_db=6.0, tilt_db=1.0, harmonic_fraction=0.9, harmonics_measured=8, level_db=-20.0
        )
        frame = PitchFrame(time_ms=10.0, midi=60.0, confidence=0.5, features=feats)
        assert frame.to_dict() == {"time_ms": 10.0, "midi": 60.0, "confidence": 0.5}
