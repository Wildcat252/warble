"""
/playback/start must explain a bad device instead of returning a bare 500.

A PortAudio device index is not a stable identifier: connecting or removing a
device renumbers everything after it. A client that saved index 1 while an
iPhone was attached later finds index 1 pointing at an output-only device, and
opening that for capture raises "Invalid number of channels [PaErrorCode
-9998]". That reached the singer as an unexplained HTTP 500 at the start of an
exercise, with nothing to act on.

No audio hardware is touched: PlaybackPipeline.start is replaced with a stub
that raises, which is the whole code path under test. See the CI notes in
CLAUDE.md about MicCapture.
"""

from __future__ import annotations

import sounddevice as sd
from fastapi.testclient import TestClient


def _client_with_failing_start(monkeypatch, exc: Exception) -> TestClient:
    from backend import main

    def _raise(device_id: int | None = None, loop: object | None = None) -> None:
        raise exc

    # Signature matches PlaybackPipeline.start(device_id=None, loop=None).
    monkeypatch.setattr(main._pipeline, "start", _raise)
    return TestClient(main.app)


def test_invalid_device_returns_400_not_500(monkeypatch) -> None:
    client = _client_with_failing_start(
        monkeypatch,
        sd.PortAudioError("Error opening InputStream: Invalid number of channels [PaErrorCode -9998]"),
    )

    res = client.post("/playback/start?device_id=1")

    assert res.status_code == 400
    detail = res.json()["detail"]
    assert detail["error"] == "invalid_device"
    assert detail["requested_device_id"] == 1
    # The caller needs the real reason, not just a status code.
    assert "-9998" in detail["message"]


def test_error_lists_devices_the_caller_can_pick_instead(monkeypatch) -> None:
    client = _client_with_failing_start(monkeypatch, sd.PortAudioError("Error querying device 99"))

    detail = client.post("/playback/start?device_id=99").json()["detail"]

    # Recovery data: without this the client can only guess what to retry with.
    assert "valid_devices" in detail
    assert "default_device_id" in detail
    for device in detail["valid_devices"]:
        assert set(device) == {"id", "name"}


def test_failed_start_leaves_the_pipeline_stopped(monkeypatch) -> None:
    from backend import main

    client = _client_with_failing_start(monkeypatch, sd.PortAudioError("boom"))
    client.post("/playback/start?device_id=1")

    # A half-started pipeline would make the next attempt return early as if
    # it were already playing, ignoring the device the caller asked for.
    assert main._pipeline.state.name == "STOPPED"


def test_a_working_device_still_starts_normally(monkeypatch) -> None:
    from backend import main

    started: dict[str, object] = {}

    def _ok(device_id: int | None = None, loop: object | None = None) -> None:
        started["device_id"] = device_id

    monkeypatch.setattr(main._pipeline, "start", _ok)
    res = TestClient(main.app).post("/playback/start?device_id=0")

    assert res.status_code == 200
    assert started["device_id"] == 0
