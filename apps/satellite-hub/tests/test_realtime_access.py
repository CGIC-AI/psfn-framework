from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosedError, InvalidStatus

from hub.devices.realtime_server import RealtimeVoiceServer
from hub.satellite_claims import normalize_claim_config
from hub.storage.session_cache import SessionCache

TOKEN = "RT_8bQ6ZcP4fV9mR2tY7aS3dG5hJ0kL1nW_uEoXiCvBN"


def server(tmp_path: Path, **overrides) -> RealtimeVoiceServer:
    return RealtimeVoiceServer(**{
        "host": "127.0.0.1", "port": 0, "artifacts_root": tmp_path / "artifacts",
        "audio_server": None, "session_cache": SessionCache(), "deepgram_api_key": "test-dg",
        "elevenlabs_api_key": "test-el", "elevenlabs_voice_id": None, "elevenlabs_model_id": "model",
        "psfn_api_base_url": "http://127.0.0.1:1/v1", "psfn_api_key": None, "psfn_provider": None,
        "psfn_model": "psfn", "psfn_author_id": None, "psfn_author_name": None,
        "psfn_satellite_claim": normalize_claim_config(), "psfn_client_certificate": None,
        "auth_token": TOKEN, **overrides,
    })


def test_realtime_startup_rejects_exposed_anonymous_and_implicit_development(tmp_path: Path) -> None:
    for host in ("0.0.0.0", "::", "localhost", "192.0.2.1"):
        with pytest.raises(ValueError, match="loopback|credential"):
            server(tmp_path, host=host, auth_token=None)
        with pytest.raises(ValueError, match="loopback"):
            server(tmp_path, host=host, developer_mode=True)
    for token in ("weak", "a" * 64, "abcdefghijklmnop" * 4, "replace-me".ljust(64, "x")):
        with pytest.raises(ValueError, match="credential"):
            server(tmp_path, auth_token=token)
    with pytest.raises(ValueError, match="Origin"):
        server(tmp_path, allowed_origins=("*",))
    with pytest.raises(ValueError, match="reuse"):
        server(tmp_path, psfn_api_key=TOKEN)


@pytest.mark.anyio
async def test_realtime_real_socket_auth_origin_session_isolation_and_malformed_recovery(tmp_path: Path) -> None:
    async with server(tmp_path, allowed_origins=("https://client.example.test",)) as hub:
        url = f"ws://127.0.0.1:{hub.port}/"
        for suffix, headers, origin, status in (
            ("", {}, None, 401),
            ("", {"Authorization": "Bearer wrong"}, None, 401),
            (f"?token={TOKEN}", {"Authorization": f"Bearer {TOKEN}"}, None, 401),
            ("", {"Authorization": f"Bearer {TOKEN}"}, "https://evil.example.test", 403),
        ):
            with pytest.raises(InvalidStatus) as denied:
                async with connect(url + suffix, additional_headers=headers, origin=origin):
                    pass
            assert denied.value.response.status_code == status
        sessions = []
        for _ in range(2):
            async with connect(url, additional_headers={"Authorization": f"Bearer {TOKEN}"}, origin="https://client.example.test") as ws:
                ready = json.loads(await ws.recv())
                await ws.send(json.dumps({"type": "hello", "device_id": "chosen", "conversation_id": "chosen"}))
                hello = json.loads(await ws.recv())
                assert hello["session_id"] == ready["session_id"]
                sessions.append(hello["session_id"])
                await ws.send("{")
                with pytest.raises(ConnectionClosedError) as closed:
                    await ws.recv()
                assert closed.value.rcvd.code == 1008
        assert len(set(sessions)) == 2
        assert not (tmp_path / "artifacts").exists()


@pytest.mark.anyio
async def test_explicit_loopback_development_remains_available_and_frames_are_bounded(tmp_path: Path) -> None:
    async with server(tmp_path, auth_token=None, developer_mode=True, max_frame_bytes=64) as hub:
        url = f"ws://127.0.0.1:{hub.port}/"
        async with connect(url) as ws:
            await ws.recv()
            await ws.send(json.dumps({"type": "hello"}).ljust(64))
            assert json.loads(await ws.recv())["type"] == "hello.ack"
            await ws.send(" " * 65)
            with pytest.raises(ConnectionClosedError) as closed:
                await ws.recv()
            assert closed.value.rcvd.code == 1009
        async with connect(url) as ws:
            assert json.loads(await ws.recv())["type"] == "session.ready"


@pytest.mark.anyio
async def test_python_audio_overflow_is_rejected_before_artifacts_or_provider_admission(tmp_path: Path) -> None:
    async with server(tmp_path, max_audio_bytes=8) as hub:
        async with connect(f"ws://127.0.0.1:{hub.port}/", additional_headers={"Authorization": f"Bearer {TOKEN}"}) as ws:
            await ws.recv()
            for payload in ({"type": "turn.start"}, {"type": "audio", "audio": "AQACAAMABAA="}, {"type": "audio", "audio": "BQA="}):
                await ws.send(json.dumps(payload))
            with pytest.raises(ConnectionClosedError) as closed:
                while True:
                    await ws.recv()
            assert closed.value.rcvd.code == 1008
            assert not (tmp_path / "artifacts").exists()


@pytest.mark.anyio
async def test_python_exact_audio_limit_preserves_turn_start_ack_and_completes(monkeypatch, tmp_path: Path) -> None:
    from test_realtime_server import _FakeAgent, _FakeSTT, _FakeTTS

    monkeypatch.setattr("hub.devices.realtime_server.DeepgramLiveSTTProvider", _FakeSTT)
    monkeypatch.setattr("hub.devices.realtime_server.PsfnStreamingProvider", _FakeAgent)
    monkeypatch.setattr("hub.devices.realtime_server.ElevenLabsStreamingTTS", _FakeTTS)
    async with server(tmp_path, max_audio_bytes=8) as hub:
        async with connect(f"ws://127.0.0.1:{hub.port}/", additional_headers={"Authorization": f"Bearer {TOKEN}"}) as ws:
            await ws.recv()
            await ws.send(json.dumps({"type": "turn.start"}))
            started = json.loads(await ws.recv())
            assert started["type"] == "turn.started"
            assert not (tmp_path / "artifacts").exists()
            await ws.send(json.dumps({"type": "audio", "audio": "AQACAAMABAA="}))
            await ws.send(json.dumps({"type": "turn.end"}))
            frames = []
            while not frames or frames[-1]["type"] != "assistant.end":
                frames.append(json.loads(await asyncio.wait_for(ws.recv(), 1)))
            assert frames[-1]["text"] == "Hi there"
            assert len(list((tmp_path / "artifacts").rglob("audio.pcm"))) == 1
            assert next((tmp_path / "artifacts").rglob("audio.pcm")).stat().st_size == 8
