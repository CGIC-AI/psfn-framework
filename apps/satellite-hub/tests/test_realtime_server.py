from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from hub.adapters.interfaces import TranscriptResult
from hub.devices.realtime_server import RealtimeVoiceServer, _RealtimeConnection
from hub.satellite_claims import normalize_claim_config
from hub.storage.session_cache import SessionCache


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []

    async def send(self, payload: str) -> None:
        self.sent.append(json.loads(payload))


class _FakeSTT:
    def __init__(self, *args, **kwargs) -> None:
        self.audio: list[bytes] = []

    async def start_turn(self, conversation_id: str) -> None:
        return

    async def send_audio(self, data: bytes) -> None:
        self.audio.append(data)

    async def finish_turn(self) -> TranscriptResult:
        return TranscriptResult(text="hello there", provider="fake-stt", latency_ms=12, is_final=True)

    async def abort_turn(self) -> None:
        return

    async def aclose(self) -> None:
        return


class _FakeAgent:
    def __init__(self, *args, **kwargs) -> None:
        return

    async def stream_reply(self, *, text: str, conversation_id: str):
        yield "Hi"
        yield " there"

    async def aclose(self) -> None:
        return


class _FakeTTS:
    def __init__(self, *args, **kwargs) -> None:
        return

    async def stream_text(self, *, text_chunks: "asyncio.Queue[str | None]", context_id: str | None = None):
        while True:
            item = await text_chunks.get()
            if item is None:
                break
            yield item.encode("utf-8")

    async def aclose(self) -> None:
        return


def test_unauthenticated_realtime_server_refuses_device_assertion_authority(
    tmp_path: Path,
) -> None:
    with pytest.raises(TypeError, match="hub_device_assertion"):
        RealtimeVoiceServer(
            host="127.0.0.1",
            port=8787,
            artifacts_root=tmp_path,
            audio_server=None,  # type: ignore[arg-type]
            session_cache=SessionCache(),
            deepgram_api_key="dg",
            elevenlabs_api_key="el",
            elevenlabs_voice_id=None,
            elevenlabs_model_id="model",
            psfn_api_base_url="http://127.0.0.1:3100/v1",
            psfn_api_key=None,
            psfn_provider=None,
            psfn_model="psfn",
            psfn_author_id=None,
            psfn_author_name=None,
            psfn_satellite_claim=normalize_claim_config(),
            psfn_client_certificate=None,
            **{"hub_device_assertion": object()},
        )


@pytest.mark.anyio
async def test_realtime_connection_streams_text_and_audio(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr("hub.devices.realtime_server.DeepgramLiveSTTProvider", _FakeSTT)
    monkeypatch.setattr("hub.devices.realtime_server.PsfnStreamingProvider", _FakeAgent)
    monkeypatch.setattr("hub.devices.realtime_server.ElevenLabsStreamingTTS", _FakeTTS)

    websocket = _FakeWebSocket()
    connection = _RealtimeConnection(
        websocket=websocket,
        audio_server=None,  # type: ignore[arg-type]
        session_cache=SessionCache(),
        artifacts_root=tmp_path,
        deepgram_api_key="dg",
        elevenlabs_api_key="el",
        elevenlabs_voice_id=None,
        elevenlabs_model_id="model",
        psfn_api_base_url="http://127.0.0.1:3100/v1",
        psfn_api_key=None,
        psfn_provider=None,
        psfn_model="model",
        psfn_author_id=None,
        psfn_author_name=None,
        psfn_satellite_claim=normalize_claim_config(),
        psfn_client_certificate=None,
    )

    await connection._handle_message({"type": "hello", "device_id": "pi-test", "device_name": "Pi Test"})
    await connection._handle_message({"type": "turn.start", "wake_word_phrase": "Hey Companion"})
    await connection._handle_message({"type": "audio", "audio": "AQACAAMA"})
    await connection._handle_message({"type": "turn.end"})
    assert connection._reply_task is not None
    await asyncio.wait_for(connection._reply_task, timeout=1)

    sent_types = [payload["type"] for payload in websocket.sent]
    assert "hello.ack" in sent_types
    assert "turn.started" in sent_types
    assert "transcript.final" in sent_types
    assert "assistant.start" in sent_types
    assert "assistant.text" in sent_types
    assert "assistant.audio.start" in sent_types
    assert "assistant.audio.chunk" in sent_types
    assert "assistant.audio.end" in sent_types
    assert "assistant.end" in sent_types

    await connection.aclose()
