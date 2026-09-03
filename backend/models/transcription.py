"""Shared acoustic-domain models for transcription pipeline data."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PitchFrame:
    """Single pitch detection frame emitted by the analysis engine."""

    time_ms: float
    midi: float
    confidence: float
    # Optional spectral features for vocal-register estimation, attached by
    # the live pipeline only (see backend/audio/register_features.py). Kept
    # LAST and defaulted because pitch_track.py and note_segmentation.py
    # construct PitchFrame positionally.
    #
    # Typed loosely to keep this module dependency-free — it is imported by
    # the offline transcription path, which has no interest in registers.
    features: object | None = None

    def to_dict(self) -> dict[str, float]:
        """
        Transcription-domain serialisation. Deliberately EXCLUDES `features`:
        this is the MusicXML/transcription contract and is typed
        dict[str, float]. The live WebSocket payload is a separate,
        hand-built contract in backend/audio/pipeline.py.
        """
        return {
            "time_ms": self.time_ms,
            "midi": self.midi,
            "confidence": self.confidence,
        }


@dataclass(frozen=True)
class NoteEvent:
    """Detected monophonic note event before notation quantization."""

    start_time: float
    end_time: float
    pitch: float
    confidence: float

    @property
    def duration_seconds(self) -> float:
        return max(0.0, self.end_time - self.start_time)


@dataclass(frozen=True)
class RestEvent:
    """Detected silence event before notation quantization."""

    start_time: float
    end_time: float

    @property
    def duration_seconds(self) -> float:
        return max(0.0, self.end_time - self.start_time)


@dataclass(frozen=True)
class TranscriptionOptions:
    """Optional user-provided hints used during transcription."""

    tempo_bpm: float | None = None
    time_signature: str | None = None


@dataclass(frozen=True)
class TranscriptionSummary:
    """Summary statistics describing a transcription run."""

    note_count: int
    duration_seconds: float
    average_confidence: float
