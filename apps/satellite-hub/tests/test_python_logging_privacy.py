from __future__ import annotations

import importlib
import logging
import sys

from aioesphomeapi.model import VoiceAssistantAudioSettings
import httpx
import pytest

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider
from hub.cli.run import _run_esphome_runtime
from hub.runtime import load_runtime_config
from test_http_audio_security import cli_listener
from test_voice_runtime import _make_streaming_runtime


SENTINEL = "InventedPrivateTranscriptReplyTokenPath_9qR\x1b[31m\nFORGED-EVENT"


@pytest.mark.anyio
@pytest.mark.parametrize("level", [logging.INFO, logging.DEBUG, logging.ERROR])
async def test_runtime_stdout_stderr_exclude_private_content_even_on_provider_exception(tmp_path, capfd, level) -> None:
    root = logging.getLogger()
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    previous = root.level
    root.addHandler(handler)
    root.setLevel(level)
    try:
        runtime, _, _ = _make_streaming_runtime(
            tmp_path, agent_steps=[(0, SENTINEL)], transcript_text=SENTINEL,
            announcement_delay=0, reply_timeout=0.1,
        )
        await runtime.handle_start(SENTINEL, 0, VoiceAssistantAudioSettings(), SENTINEL)
        await runtime.handle_stop(False)

        # An actual HTTP provider failure contains upstream text and a private URL.
        async with httpx.AsyncClient(
            base_url="http://provider.test/InventedPrivateTranscriptReplyTokenPath_9qR/v1",
            transport=httpx.MockTransport(lambda request: httpx.Response(403, text=SENTINEL)),
        ) as client:
            provider = PsfnStreamingProvider(api_base_url="http://provider.test/v1", model_name="psfn", client=client)
            runtime._agent = provider
            await runtime.handle_start(SENTINEL, 0, VoiceAssistantAudioSettings(), SENTINEL)
            await runtime.handle_stop(False)
        # Non-JSON upstream SSE is another debug diagnostic boundary.
        async with httpx.AsyncClient(
            base_url="http://provider.test/v1",
            transport=httpx.MockTransport(lambda request: httpx.Response(200, text="data: " + SENTINEL + "\n\ndata: [DONE]\n\n")),
        ) as client:
            provider = PsfnStreamingProvider(api_base_url="http://provider.test/v1", model_name="psfn", client=client)
            with pytest.raises(RuntimeError):
                _ = [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="test")]
        output = capfd.readouterr()
        combined = output.out + output.err
        assert "InventedPrivateTranscriptReplyTokenPath" not in combined
        assert "FORGED-EVENT" not in combined and "\x1b" not in combined
        if level <= logging.INFO:
            assert "Voice turn" in combined
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)


@pytest.mark.anyio
async def test_cli_startup_and_reconnect_never_echo_names_paths_tokens_or_exceptions(tmp_path, monkeypatch, capfd) -> None:
    import asyncio

    class FailedSession:
        def __init__(self, target):
            pass

        async def __aenter__(self):
            raise RuntimeError(SENTINEL)

        async def __aexit__(self, *args):
            pass

    cli = importlib.import_module("hub.cli.run")
    monkeypatch.setattr(cli, "ESPHomeSession", FailedSession)
    async with cli_listener(tmp_path, monkeypatch) as server:
        monkeypatch.setenv("DEVICE_TRANSPORT", "esphome")
        monkeypatch.setenv("ESPHOME_HOST", "InventedPrivateTranscriptReplyTokenPath_9qR.example.test")
        monkeypatch.setenv("PSFN_API_BASE_URL", "http://provider.test/InventedPrivateTranscriptReplyTokenPath_9qR/v1")
        config = load_runtime_config(tmp_path)
        task = asyncio.create_task(_run_esphome_runtime(config=config, audio_server=server, session_cache=None))
        await asyncio.sleep(0.05)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    output = capfd.readouterr()
    assert "InventedPrivateTranscriptReplyTokenPath" not in output.out + output.err
    assert "FORGED-EVENT" not in output.out + output.err


@pytest.mark.anyio
async def test_empty_provider_completion_is_an_explicit_failure_without_invented_speech(tmp_path) -> None:
    import json
    runtime, _, server = _make_streaming_runtime(
        tmp_path, agent_steps=[], transcript_text="invented input",
        announcement_delay=0, reply_timeout=0.1,
    )
    await runtime.handle_start("invented-session", 0, VoiceAssistantAudioSettings(), None)
    await runtime.handle_stop(False)
    reply = json.loads(next(tmp_path.rglob("reply.json")).read_text())
    assert reply["status"] == "error"
    assert "response" not in reply
    assert all(not stream.writes for stream in server.streams)
