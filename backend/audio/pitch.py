"""
backend/audio/pitch.py

Real-time pitch detection pipeline.

Primary engine:  torchcrepe (PyTorch + CUDA) — RTX 5070, ~5-15ms inference
CPU fallback:    librosa pYIN — ships with torchcrepe, no extra install needed

Output per frame:
    {"time_ms": float, "midi": float, "confidence": float}

Frames below CONFIDENCE_THRESHOLD are dropped, not emitted.
"""

from __future__ import annotations

import logging
import os
import queue
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace
from enum import Enum, auto

import numpy as np

from backend.audio.register_features import RegisterFeatures, compute_register_features
from backend.models.transcription import PitchFrame

try:
    import torch
except ImportError:  # pragma: no cover - exercised by thin installer runtime
    torch = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

SAMPLE_RATE: int = 22050
# Chosen from measured separation between real singing and an ambient room,
# captured through this exact pipeline (see the center=False note in
# _infer_pyin for the companion fix — both were needed):
#
#                     median conf   max conf   fraction >= 0.25
#   ambient room         0.010        0.109          0%
#   real singing         0.280        0.485        ~58%
#
# pYIN's voiced_prob is quantised to discrete HMM posterior levels
# (0.010, 0.109, 0.207, 0.280, 0.372, 0.426, 0.485, 0.549, ...), and real
# voice through a laptop mic tops out around 0.485 — so the previous 0.6,
# and even 0.5, accepted literally 0% of real singing while ambient noise
# was never above 0.109. 0.25 sits with margin on both sides.
#
# Deliberately NOT paired with an absolute amplitude gate: pYIN's confidence
# is a periodicity measure and is essentially level-independent (synthetic
# tones at peak 0.2 and 0.03 score identically), so gating on loudness would
# add a new failure mode for quiet mics without improving noise rejection.
CONFIDENCE_THRESHOLD: float = 0.25

# torchcrepe expects 16 kHz — we resample on the fly
CREPE_SAMPLE_RATE: int = 16000

# pYIN frequency range — human singing voice
# FMIN_HZ was 65.0 (C2) — lowered after a live diagnostic session (range
# test "glide down" phase) showed the detected frequency pin exactly to
# 65.0Hz with confidence collapsing to ~0.01 as the singer's real voice
# went below the search floor: pYIN can't represent a pitch below fmin, so
# it clamps to the boundary and (correctly) reports near-zero confidence
# for that clamped, not-actually-real reading. 49.0Hz (G1) gives headroom
# for genuinely low/bass voices without extending so far that mic rumble
# or room hum starts getting picked up as a candidate pitch.
FMIN_HZ: float = 49.0    # G1
FMAX_HZ: float = 2093.0  # C7


# ── Engine selection ───────────────────────────────────────────────────────────


class Engine(Enum):
    TORCHCREPE = auto()
    PYIN = auto()


@dataclass(frozen=True)
class EngineRuntimeInfo:
    engine: Engine
    cuda: bool
    device: str
    mode: str


@dataclass(frozen=True)
class QueuedWindow:
    window: np.ndarray
    capture_time_ms: float


def resolve_engine_runtime(force_cpu: bool = False) -> EngineRuntimeInfo:
    """Resolve active engine from env + runtime override + CUDA availability."""
    env_engine = os.getenv("PITCH_ENGINE", "").strip().lower()
    env_forces_cpu = env_engine in {"aubio", "pyin", "cpu"}
    cuda_available = bool(torch and torch.cuda.is_available())

    if force_cpu or env_forces_cpu:
        reason = "runtime override" if force_cpu else "PITCH_ENGINE"
        log.info("CPU mode forced via %s — using librosa pYIN (CPU)", reason)
        return EngineRuntimeInfo(
            engine=Engine.PYIN,
            cuda=cuda_available,
            device="CPU",
            mode="forced_cpu",
        )

    if cuda_available and torch is not None:
        device_name = torch.cuda.get_device_name(0)
        log.info("CUDA available — using torchcrepe (GPU: %s)", device_name)
        return EngineRuntimeInfo(
            engine=Engine.TORCHCREPE,
            cuda=True,
            device=device_name,
            mode="auto",
        )

    log.info("No CUDA — using librosa pYIN (CPU)")
    return EngineRuntimeInfo(
        engine=Engine.PYIN,
        cuda=False,
        device="CPU",
        mode="auto",
    )


def select_engine() -> Engine:
    """
    Auto-select pitch engine based on hardware availability.
    torchcrepe on CPU is ~200ms/frame — too slow for real-time; fall back to pYIN.
    """
    return resolve_engine_runtime().engine


# ── Conversion helpers ─────────────────────────────────────────────────────────


def hz_to_midi(freq_hz: float) -> float:
    """Convert frequency in Hz to MIDI float (cent-accurate)."""
    if freq_hz <= 0:
        return 0.0
    return 12.0 * np.log2(freq_hz / 440.0) + 69.0


def midi_to_hz(midi: float) -> float:
    """Convert MIDI float to frequency in Hz."""
    return 440.0 * (2.0 ** ((midi - 69.0) / 12.0))


# ── torchcrepe engine ──────────────────────────────────────────────────────────


def _infer_torchcrepe(
    window: np.ndarray,
    device,
    capture_time_ms: float,
) -> PitchFrame | None:
    """
    Run torchcrepe inference on a single 2048-sample window.

    Uses weighted_argmax decoder to avoid the scipy.signal dependency
    that Viterbi requires (blocked by Application Control on some machines).
    Returns None if confidence < threshold or no pitch detected.
    """
    if torch is None:
        raise RuntimeError("PyTorch is not installed. Install full-fat build for torchcrepe")

    try:
        import torchcrepe
    except ImportError:
        raise RuntimeError("torchcrepe is not installed. Run: uv pip install torchcrepe")

    import torchaudio.functional as F

    audio_tensor = torch.from_numpy(window).unsqueeze(0)  # (1, N)
    audio_16k = F.resample(audio_tensor, SAMPLE_RATE, CREPE_SAMPLE_RATE).to(device)

    with torch.no_grad():
        frequency, confidence = torchcrepe.predict(
            audio_16k,
            CREPE_SAMPLE_RATE,
            hop_length=audio_16k.shape[-1],  # single frame
            fmin=FMIN_HZ,
            fmax=FMAX_HZ,
            model="full",
            decoder=torchcrepe.decode.weighted_argmax,  # avoids scipy.signal
            return_periodicity=True,
            device=device,
        )

    freq_hz = frequency[0, 0].item()
    conf = confidence[0, 0].item()

    if conf < CONFIDENCE_THRESHOLD or freq_hz <= 0:
        return None

    return PitchFrame(
        time_ms=capture_time_ms,
        midi=hz_to_midi(freq_hz),
        confidence=conf,
    )


# ── librosa pYIN engine ────────────────────────────────────────────────────────


def _infer_pyin(
    window: np.ndarray,
    capture_time_ms: float,
) -> PitchFrame | None:
    """
    Run librosa pYIN on a single window.
    librosa is already installed as a torchcrepe dependency — no extra install.
    Returns None if no pitch detected above threshold.
    """
    import librosa

    # librosa.pyin returns (f0, voiced_flag, voiced_prob) arrays.
    # hop_length = frame_length = window length gives us a single frame.
    #
    # center=False is REQUIRED here, not a tuning preference. With librosa's
    # default center=True the signal is zero-padded by frame_length//2 and
    # frame 0 is centred at sample 0 — so half of the frame we then read
    # (f0[0]/voiced_prob[0]) is analysing zero-padding, not audio. pYIN's
    # voiced_prob comes from an HMM that has also accumulated no evidence at
    # frame 0, so it reads out near its ~0.01 floor no matter how clean the
    # input is. Measured on synthetic voice-like tones at realistic level:
    # a 118Hz note scored 0.128 with center=True vs 0.827 with center=False,
    # and only 3/10 tones across G1-C5 cleared threshold vs 9/10.
    # Low pitches were hit worst (fewer periods per window => less evidence),
    # which is exactly how this surfaced: "can't detect low pitch".
    # Pure noise still scores ~0.010 either way, so this does not trade
    # accuracy for false positives. Cost is ~+2ms/frame, well inside budget.
    f0, voiced_flag, voiced_prob = librosa.pyin(
        window,
        fmin=FMIN_HZ,
        fmax=FMAX_HZ,
        sr=SAMPLE_RATE,
        hop_length=len(window),
        frame_length=len(window),
        center=False,
    )

    if f0 is None or len(f0) == 0:
        return None

    freq_hz = float(f0[0]) if not np.isnan(f0[0]) else 0.0
    conf = float(voiced_prob[0]) if voiced_prob is not None else 0.0
    voiced = bool(voiced_flag[0]) if voiced_flag is not None else False

    if not voiced or conf < CONFIDENCE_THRESHOLD or freq_hz <= 0:
        # Diagnostic for "detection feels weak / drops out" reports. Logs the
        # window's peak amplitude alongside the rejected reading, which is
        # what separates "mic is delivering silence" (peak ~= noise floor,
        # conf at pYIN's ~0.010 floor) from "real voice present but scored
        # under threshold" (healthy peak, mid-range conf). Kept at debug so
        # it costs nothing normally; enable with LOG_LEVEL=DEBUG.
        if log.isEnabledFor(logging.DEBUG) and freq_hz > 0:
            peak = float(np.max(np.abs(window))) if window.size else 0.0
            log.debug(
                "pYIN dropped frame: freq=%.1fHz midi=%.1f conf=%.3f voiced=%s peak=%.5f (need conf>=%.2f)",
                freq_hz, hz_to_midi(freq_hz), conf, voiced, peak, CONFIDENCE_THRESHOLD,
            )
        return None

    return PitchFrame(
        time_ms=capture_time_ms,
        midi=hz_to_midi(freq_hz),
        confidence=conf,
    )


# ── Pipeline ───────────────────────────────────────────────────────────────────


class PitchPipeline:
    """
    Receives audio windows from MicCapture's ring buffer and runs pitch
    detection in a dedicated worker thread.

    Usage:
        pipeline = PitchPipeline(on_frame=my_callback)
        pipeline.start()
        cap = MicCapture(on_window=pipeline.push)
        cap.start()
        ...
        cap.stop()
        pipeline.stop()

    The on_frame callback fires from the worker thread — keep it fast.
    """

    _QUEUE_MAXSIZE: int = 32

    def __init__(
        self,
        engine: Engine | None = None,
        on_frame: Callable[[PitchFrame], None] | None = None,
    ) -> None:
        self._engine = engine or select_engine()
        if self._engine == Engine.TORCHCREPE and torch is None:
            log.warning("torchcrepe engine requested but PyTorch is unavailable; falling back to pYIN")
            self._engine = Engine.PYIN
        self._on_frame = on_frame
        self._device = "cuda" if self._engine == Engine.TORCHCREPE else "cpu"
        self._queue: queue.Queue[QueuedWindow | None] = queue.Queue(
            maxsize=self._QUEUE_MAXSIZE
        )
        self._thread: threading.Thread | None = None
        self._running = False
        self._dropped_frames = 0
        # Register extraction logs at most once — it runs ~21x/sec and a
        # persistent failure would otherwise flood the log.
        self._register_error_logged = False

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._worker, daemon=True, name="pitch-worker")
        self._thread.start()
        log.info("PitchPipeline started — engine=%s device=%s", self._engine.name, self._device)

    def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        self._queue.put(None)  # sentinel
        if self._thread:
            self._thread.join(timeout=2.0)
        log.info("PitchPipeline stopped (dropped frames: %d)", self._dropped_frames)

    def push(self, window: np.ndarray, capture_time_ms: float | None = None) -> None:
        """Non-blocking: drops window if worker is falling behind."""
        queued_window = QueuedWindow(
            window=window,
            capture_time_ms=(
                time.monotonic() * 1000.0 if capture_time_ms is None else capture_time_ms
            ),
        )
        try:
            self._queue.put_nowait(queued_window)
        except queue.Full:
            self._dropped_frames += 1

    @property
    def engine(self) -> Engine:
        return self._engine

    @property
    def device(self) -> str:
        return self._device

    @property
    def dropped_frames(self) -> int:
        return self._dropped_frames

    def _worker(self) -> None:
        self._warmup()
        while True:
            queued_window = self._queue.get()
            if queued_window is None:
                break
            try:
                t0 = time.monotonic()
                frame = self._infer(
                    queued_window.window,
                    queued_window.capture_time_ms,
                )
                elapsed_ms = (time.monotonic() - t0) * 1000.0
                if elapsed_ms > 80.0:
                    log.warning("Inference took %.1f ms (target <80ms)", elapsed_ms)
                if frame is not None and self._on_frame:
                    self._on_frame(frame)
            except Exception:
                log.exception("Pitch inference error")

    def _infer(self, window: np.ndarray, capture_time_ms: float) -> PitchFrame | None:
        if self._engine == Engine.TORCHCREPE:
            frame = _infer_torchcrepe(window, self._device, capture_time_ms)
        else:
            frame = _infer_pyin(window, capture_time_ms)
        if frame is None:
            return None
        return replace(frame, features=self._register_features(window, frame))

    def _register_features(
        self, window: np.ndarray, frame: PitchFrame
    ) -> RegisterFeatures | None:
        """
        Spectral features for vocal-register estimation.

        Computed HERE rather than inside the engine functions for two reasons:
        this seam sees the original 22050Hz window for both engines (torchcrepe
        resamples internally), making the features engine-independent; and
        _infer_pyin has a second caller in transcription_service.py whose
        signature stays untouched this way.

        Failures are swallowed deliberately. _worker's own except would drop
        the entire pitch frame, and a nice-to-have must never be able to break
        pitch detection.
        """
        try:
            return compute_register_features(window, midi_to_hz(frame.midi), SAMPLE_RATE)
        except Exception:
            if not self._register_error_logged:
                log.exception("Register feature extraction failed (pitch unaffected)")
                self._register_error_logged = True
            return None

    def _warmup(self) -> None:
        try:
            silence = np.zeros(2048, dtype=np.float32)
            self._infer(silence, 0.0)
            log.info("PitchPipeline warmup complete")
        except Exception:
            log.exception("PitchPipeline warmup failed (non-fatal)")
