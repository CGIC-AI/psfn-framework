from __future__ import annotations

import array
import asyncio
from datetime import timedelta
import json
from pathlib import Path

import pytest
from aioesphomeapi.model import MediaPlayerCommand, VoiceAssistantAudioSettings, VoiceAssistantEventType

from hub.adapters.interfaces import TranscriptResult
from hub.devices.voice_runtime import VoiceAssistantRuntime
from hub.devices.voice_runtime_streaming import StreamingVoiceAssistantRuntime
from hub.storage.session_cache import SessionCache
from hub.util import utc_now


class _FakeClient:
    def __init__(self, *, announcement_delay: float = 0.0) -> None:
        self.announcement_delay = announcement_delay
        self.events: list[tuple[object, object]] = []
        self.announcements: list[tuple[str, bool]] = []
        self.media_commands: list[tuple[int, object]] = []

    def send_voice_assistant_event(self, event_type, data) -> None:
        self.events.append((event_type, data))

    async def send_voice_assistant_announcement_await_response(
        self,
        *,
        media_id: str,
        timeout: float,
        start_conversation: bool,
    ) -> None:
        self.announcements.append((media_id, start_conversation))
        await asyncio.sleep(self.announcement_delay)

    def media_player_command(self, key: int, *, command) -> None:
        self.media_commands.append((key, command))


class _FakeSession:
    def __init__(self, client: _FakeClient) -> None:
        self.client = client


class _FakeStream:
    def __init__(self, *, content_type: str) -> None:
        self.url = "http://example.test/stream"
        self.content_type = content_type
        self.writes: list[bytes] = []
        self.closed = False

    def write(self, data: bytes) -> None:
        self.writes.append(data)

    def close(self) -> None:
        self.closed = True


class _FakeAudioServer:
    def __init__(self) -> None:
        self.streams: list[_FakeStream] = []

    def open_stream(self, *, content_type: str = "audio/mpeg") -> _FakeStream:
        stream = _FakeStream(content_type=content_type)
        self.streams.append(stream)
        return stream


class _FakeSTT:
    def __init__(self, *, transcript_text: str = "") -> None:
        self.active = False
        self.started_sessions: list[str] = []
        self.aborted_turns = 0
        self.transcript_text = transcript_text

    async def start_turn(self, session_id: str) -> None:  # pragma: no cover - interface stub
        if self.active:
            raise RuntimeError("Deepgram turn already active")
        self.active = True
        self.started_sessions.append(session_id)

    async def send_audio(self, data: bytes) -> None:  # pragma: no cover - interface stub
        return

    async def finish_turn(self):  # pragma: no cover - interface stub
        self.active = False
        return TranscriptResult(text=self.transcript_text, provider="deepgram-live", latency_ms=0, is_final=True)

    async def abort_turn(self) -> None:  # pragma: no cover - interface stub
        self.active = False
        self.aborted_turns += 1


class _FakeAgent:
    def __init__(self, steps: list[tuple[float, str]]) -> None:
        self.steps = steps

    async def stream_reply(self, *, text: str, conversation_id: str):
        for delay, chunk in self.steps:
            await asyncio.sleep(delay)
            yield chunk


class _FakeTTS:
    async def stream_text(self, *, text_chunks: "asyncio.Queue[str | None]", context_id: str | None = None):
        while True:
            item = await text_chunks.get()
            if item is None:
                break
            yield item.encode("utf-8")


class _PassthroughTranscoder:
    async def transcode(self, chunks):
        async for chunk in chunks:
            yield chunk


def _make_streaming_runtime(
    tmp_path: Path,
    *,
    agent_steps: list[tuple[float, str]],
    announcement_delay: float,
    reply_timeout: float,
    transcript_text: str = "",
    initial_silence_timeout: float = 4.0,
    endpointing_grace: float = 0.0,
    silence_timeout: float = 0.0,
    min_speech_chunks_for_endpointing: int = 4,
    default_conversation_id: str | None = None,
) -> tuple[StreamingVoiceAssistantRuntime, _FakeClient, _FakeAudioServer]:
    client = _FakeClient(announcement_delay=announcement_delay)
    audio_server = _FakeAudioServer()
    stt = _FakeSTT(transcript_text=transcript_text)
    runtime = StreamingVoiceAssistantRuntime(
        session=_FakeSession(client),
        stt=stt,
        agent=_FakeAgent(agent_steps),
        tts=_FakeTTS(),
        audio_server=audio_server,
        session_cache=SessionCache(ttl=timedelta(seconds=300)),
        artifacts_root=tmp_path,
        continue_conversation=False,
        announcement_timeout_seconds=1.0,
        reply_timeout_seconds=reply_timeout,
        initial_silence_timeout_seconds=initial_silence_timeout,
        endpointing_grace_seconds=endpointing_grace,
        silence_timeout_seconds=silence_timeout,
        max_turn_seconds=10.0,
        speech_rms_threshold=1.0,
        min_speech_chunks_for_endpointing=min_speech_chunks_for_endpointing,
        media_player_key=42,
        audio_transcoder=_PassthroughTranscoder(),
        default_conversation_id=default_conversation_id,
    )
    return runtime, client, audio_server


@pytest.mark.anyio
async def test_empty_device_conversation_uses_stable_configured_channel(tmp_path: Path) -> None:
    runtime, _, _ = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "unused")],
        announcement_delay=0.0,
        reply_timeout=0.05,
        default_conversation_id="bedroom",
    )

    await runtime.handle_start(
        conversation_id="",
        flags=0,
        audio_settings=VoiceAssistantAudioSettings(),
        wake_word_phrase="Purrsephone",
    )

    assert runtime._active is not None
    assert runtime._active.session_id == "bedroom"
    assert runtime._stt.started_sessions == ["bedroom"]


@pytest.mark.parametrize("runtime_cls", [VoiceAssistantRuntime, StreamingVoiceAssistantRuntime])
def test_chunk_rms_returns_zero_for_empty_audio(runtime_cls: type) -> None:
    assert runtime_cls._chunk_rms(b"") == 0.0
    assert runtime_cls._chunk_rms(b"\x01") == 0.0


@pytest.mark.parametrize("runtime_cls", [VoiceAssistantRuntime, StreamingVoiceAssistantRuntime])
def test_chunk_rms_detects_signal_level(runtime_cls: type) -> None:
    samples = array.array("h", [0, 0, 120, -120, 300, -300])
    rms = runtime_cls._chunk_rms(samples.tobytes())

    assert 180.0 < rms < 190.0


@pytest.mark.anyio
async def test_stream_agent_reply_allows_playback_to_finish_after_reply_timeout_window(tmp_path: Path) -> None:
    runtime, client, audio_server = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "Fast response.")],
        announcement_delay=0.05,
        reply_timeout=0.01,
    )

    response = await runtime._stream_agent_reply("session-1", "hello")

    assert response == "Fast response."
    assert client.events[0][0] == VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_START
    assert client.events[-1][0] == VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_END
    assert audio_server.streams[0].closed is True
    assert audio_server.streams[0].content_type == "audio/flac"
    assert b"Fast response." in b"".join(audio_server.streams[0].writes)


@pytest.mark.anyio
async def test_stream_agent_reply_still_times_out_before_first_delta(tmp_path: Path) -> None:
    runtime, _, _ = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.05, "Late response.")],
        announcement_delay=0.0,
        reply_timeout=0.01,
    )

    with pytest.raises(TimeoutError):
        await runtime._stream_agent_reply("session-2", "hello")


@pytest.mark.anyio
async def test_handle_start_interrupts_active_response_pipeline(tmp_path: Path) -> None:
    runtime, client, _ = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "unused")],
        announcement_delay=0.0,
        reply_timeout=0.05,
    )
    runtime._response_task = asyncio.create_task(asyncio.sleep(10))

    await runtime.handle_start(
        conversation_id="",
        flags=0,
        audio_settings=VoiceAssistantAudioSettings(),
        wake_word_phrase="Okay Nabu",
    )

    assert runtime._response_task is None or runtime._response_task.done()
    assert client.media_commands == [(42, MediaPlayerCommand.STOP)]


@pytest.mark.anyio
async def test_handle_start_aborts_superseded_stt_turn_before_restarting(tmp_path: Path) -> None:
    runtime, _, _ = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "unused")],
        announcement_delay=0.0,
        reply_timeout=0.05,
    )

    await runtime.handle_start(
        conversation_id="",
        flags=0,
        audio_settings=VoiceAssistantAudioSettings(),
        wake_word_phrase="Okay Nabu",
    )
    first_session_id = runtime._active.session_id

    await runtime.handle_start(
        conversation_id="",
        flags=0,
        audio_settings=VoiceAssistantAudioSettings(),
        wake_word_phrase=None,
    )

    assert runtime._stt.aborted_turns == 1
    assert runtime._stt.started_sessions == [first_session_id, first_session_id]
    assert runtime._active is not None


@pytest.mark.anyio
async def test_stream_agent_reply_does_not_request_followup_from_announcement(tmp_path: Path) -> None:
    runtime, client, _ = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "Sure.")],
        announcement_delay=0.0,
        reply_timeout=0.05,
    )
    runtime._continue_conversation = True

    await runtime._stream_agent_reply("session-3", "hello")

    assert client.announcements == [("http://example.test/stream", False)]


@pytest.mark.anyio
async def test_finish_turn_with_empty_transcript_is_silent(tmp_path: Path) -> None:
    runtime, client, audio_server = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "unused")],
        announcement_delay=0.0,
        reply_timeout=0.05,
        transcript_text="",
    )

    await runtime.handle_start(
        conversation_id="",
        flags=0,
        audio_settings=VoiceAssistantAudioSettings(),
        wake_word_phrase="Okay Nabu",
    )
    await runtime._finish_turn(abort=False, stop_reason="silence_timeout")

    assert audio_server.streams == []
    assert client.announcements == []
    assert client.events[-2] == (
        VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_END,
        {"continue_conversation": "0"},
    )


@pytest.mark.anyio
async def test_watchdog_waits_for_minimum_speech_before_endpointing(tmp_path: Path) -> None:
    runtime, _, _ = _make_streaming_runtime(
        tmp_path,
        agent_steps=[(0.0, "unused")],
        announcement_delay=0.0,
        reply_timeout=0.05,
        transcript_text="",
        initial_silence_timeout=0.3,
        endpointing_grace=0.0,
        silence_timeout=0.05,
        min_speech_chunks_for_endpointing=4,
    )

    await runtime.handle_start(
        conversation_id="",
        flags=0,
        audio_settings=VoiceAssistantAudioSettings(),
        wake_word_phrase=None,
    )
    active = runtime._active
    assert active is not None
    active.started_at = active.started_at - timedelta(seconds=0.15)
    active.last_speech_at = utc_now()
    active.speech_chunks = 1

    await asyncio.sleep(0.12)
    assert runtime._active is not None

    await asyncio.sleep(0.25)
    assert runtime._active is None
    reply = json.loads(active.reply_path.read_text())
    assert reply["reason"] == "insufficient_speech_timeout"
