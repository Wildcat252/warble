"""Music-domain notation and score helpers."""

from .musicxml_export import (
    MusicXMLExportError,
    score_model_to_music21_score,
    score_model_to_musicxml_bytes,
    score_model_to_musicxml_string,
    write_score_model_musicxml,
)
from .notation_policy import (
    V1_NOTATION_POLICY,
    CrossBarNotePolicy,
    DottedVsTiedPolicy,
    NotationPolicy,
)
from .quantization import quantize_note_events
from .score_model import (
    LyricSyllabic,
    Measure,
    NoteScoreEvent,
    QuantizedEvent,
    RestScoreEvent,
    ScoreMetadata,
    ScoreModel,
    score_model_from_quantized_events,
)

__all__ = [
    "V1_NOTATION_POLICY",
    "CrossBarNotePolicy",
    "DottedVsTiedPolicy",
    "LyricSyllabic",
    "Measure",
    "MusicXMLExportError",
    "NotationPolicy",
    "NoteScoreEvent",
    "QuantizedEvent",
    "RestScoreEvent",
    "ScoreMetadata",
    "ScoreModel",
    "quantize_note_events",
    "score_model_from_quantized_events",
    "score_model_to_music21_score",
    "score_model_to_musicxml_bytes",
    "score_model_to_musicxml_string",
    "write_score_model_musicxml",
]
