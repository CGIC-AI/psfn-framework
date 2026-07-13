from __future__ import annotations

import asyncio
import array
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
import json
import logging
import math
from pathlib import Path
import uuid
import wave

from aioesphomeapi.model import MediaPlayerCommand, VoiceAssistantAudioSettings, VoiceAssistantEventType

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider
from hub.adapters.stt.deepgram_live import DeepgramLiveSTTProvider
from hub.adapters.tts.elevenlabs_streaming import ElevenLabsStreamingTTS
from hub.devices.esphome_session import ESPHomeSession
from hub.media.audio_transcoder import FfmpegMp3ToFlacTranscoder, StreamingAudioTranscoder
from hub.media.http_audio import LiveAudioStream, StaticAudioServer
from hub.storage.session_cache import SessionCache
from hub.util import ensure_directory, isoformat_z, to_jsonable, utc_now, write_json

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class ActiveTurn:
    conversation_id: str
    session_id: str
    started_at: datetime
    flags: int
    wake_word_phrase: str | None
    audio_settings: VoiceAssistantAudioSettings
    directory: Path
    pcm_path: Path
    wav_path: Path
    transcript_path: Path
    reply_path: Path
    events_path: Path
    chunks: int = 0
    bytes_received: int = 0
    speech_chunks: int = 0
    last_speech_at: datetime | None = None


class StreamingVoiceAssistantRuntime:
    def __init__(
        self,
        *,
        session: ESPHomeSession,
        stt: DeepgramLiveSTTProvider,
        agent: PsfnStreamingProvider,
        tts: ElevenLabsStreamingTTS,
        audio_server: StaticAudioServer,
        session_cache: SessionCache,
        artifacts_root: Path,
        continue_conversation: bool,
        announcement_timeout_seconds: float,
        reply_timeout_seconds: float,
        initial_silence_timeout_seconds: float,
        endpointing_grace_seconds: float,
        silence_timeout_seconds: float,
        max_turn_seconds: float,
        speech_rms_threshold: float,
        min_speech_chunks_for_endpointing: int,
        media_player_key: int | None = None,
        audio_transcoder: StreamingAudioTranscoder | None = None,
        pinned_conversation_id: str | None = None,
    ) -> None:
        self._session = session
        self._stt = stt
        self._agent = agent
        self._tts = tts
        self._audio_server = audio_server
        self._session_cache = session_cache
        self._artifacts_root = ensure_directory(artifacts_root)
        self._continue_conversation = continue_conversation
        self._announcement_timeout_seconds = announcement_timeout_seconds
        self._reply_timeout_seconds = reply_timeout_seconds
        self._initial_silence_timeout_seconds = initial_silence_timeout_seconds
        self._endpointing_grace_seconds = endpointing_grace_seconds
        self._silence_timeout_seconds = silence_timeout_seconds
        self._max_turn_seconds = max_turn_seconds
        self._speech_rms_threshold = speech_rms_threshold
        self._min_speech_chunks_for_endpointing = min_speech_chunks_for_endpointing
        self._media_player_key = media_player_key
        self._audio_transcoder = audio_transcoder or FfmpegMp3ToFlacTranscoder()
        self._pinned_conversation_id = (pinned_conversation_id or "").strip() or None
        self._active: ActiveTurn | None = None
        self._last_session_id: str | None = None
        self._watchdog_task: asyncio.Task[None] | None = None
        self._response_task: asyncio.Task[None] | None = None
        self._discard_audio_until_stop = False
        self._finalize_lock = asyncio.Lock()

    async def handle_start(
        self,
        conversation_id: str,
        flags: int,
        audio_settings: VoiceAssistantAudioSettings,
        wake_word_phrase: str | None,
    ) -> int | None:
        if self._active is not None:
            _LOGGER.warning("Replacing active turn %s", self._active.session_id)
            await self._finish_turn(abort=True, stop_reason="superseded")
        self._cancel_watchdog()
        was_responding = self._response_task is not None and not self._response_task.done()
        await self._cancel_response_task(reason="new_start")
        if was_responding and self._media_player_key is not None:
            self._session.client.media_player_command(
                self._media_player_key,
                command=MediaPlayerCommand.STOP,
            )

        session_id = self._resolve_session_id(conversation_id)
        started_at = utc_now()
        safe_id = session_id.replace("/", "_")
        directory = ensure_directory(
            self._artifacts_root / started_at.strftime("%Y%m%d") / f"{started_at.strftime('%H%M%S')}_{safe_id}"
        )
        active = ActiveTurn(
            conversation_id=conversation_id,
            session_id=session_id,
            started_at=started_at,
            flags=flags,
            wake_word_phrase=wake_word_phrase,
            audio_settings=audio_settings,
            directory=directory,
            pcm_path=directory / "audio.pcm",
            wav_path=directory / "audio.wav",
            transcript_path=directory / "transcript.json",
            reply_path=directory / "reply.json",
            events_path=directory / "events.jsonl",
        )
        active.pcm_path.touch()
        self._active = active
        self._discard_audio_until_stop = False
        self._session_cache.touch(session_id)
        await self._stt.start_turn(session_id)
        self._append_event(
            active,
            "start",
            {
                "conversation_id": conversation_id,
                "session_id": session_id,
                "flags": flags,
                "wake_word_phrase": wake_word_phrase,
                "audio_settings": to_jsonable(audio_settings),
            },
        )
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_RUN_START,
            None,
        )
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_STT_START,
            None,
        )
        _LOGGER.info("Voice turn started: session=%s raw_id=%s", session_id, conversation_id)
        self._watchdog_task = asyncio.create_task(self._watch_active_turn(active))
        return 0

    async def handle_audio(self, data: bytes) -> None:
        if self._active is None:
            if self._discard_audio_until_stop:
                return
            _LOGGER.warning("Dropping audio chunk because no active turn exists")
            return

        with self._active.pcm_path.open("ab") as handle:
            handle.write(data)
        self._active.chunks += 1
        self._active.bytes_received += len(data)
        rms = self._chunk_rms(data)
        if rms >= self._speech_rms_threshold:
            first_speech = self._active.last_speech_at is None
            self._active.last_speech_at = utc_now()
            self._active.speech_chunks += 1
            if first_speech:
                self._append_event(
                    self._active,
                    "speech_start",
                    {
                        "rms": round(rms, 3),
                        "threshold": self._speech_rms_threshold,
                    },
                )
        await self._stt.send_audio(data)

    async def handle_stop(self, abort: bool) -> None:
        if self._active is None:
            if self._discard_audio_until_stop:
                self._discard_audio_until_stop = False
                _LOGGER.info("Voice turn drain completed after local finalization")
                return
            _LOGGER.warning("Received stop without an active turn")
            return
        await self._finish_turn(abort=abort, stop_reason="device_stop")

    async def _watch_active_turn(self, active: ActiveTurn) -> None:
        try:
            while self._active is active:
                await asyncio.sleep(0.2)
                now = utc_now()
                elapsed_seconds = (now - active.started_at).total_seconds()
                if elapsed_seconds >= self._max_turn_seconds:
                    await self._finish_turn(abort=False, stop_reason="max_turn_timeout")
                    return
                if active.last_speech_at is None:
                    if elapsed_seconds >= self._initial_silence_timeout_seconds:
                        await self._finish_turn(abort=False, stop_reason="initial_silence_timeout")
                        return
                    continue
                if active.speech_chunks < self._min_speech_chunks_for_endpointing:
                    if elapsed_seconds >= self._initial_silence_timeout_seconds:
                        await self._finish_turn(abort=False, stop_reason="insufficient_speech_timeout")
                        return
                    continue
                if elapsed_seconds < self._endpointing_grace_seconds:
                    continue
                if (now - active.last_speech_at).total_seconds() >= self._silence_timeout_seconds:
                    await self._finish_turn(abort=False, stop_reason="silence_timeout")
                    return
        except asyncio.CancelledError:
            return

    def _cancel_watchdog(self) -> None:
        if self._watchdog_task is not None:
            self._watchdog_task.cancel()
            self._watchdog_task = None

    async def _cancel_response_task(self, *, reason: str) -> None:
        task = self._response_task
        if task is None:
            return
        if task.done():
            self._response_task = None
            return
        if task is asyncio.current_task():
            return
        _LOGGER.info("Interrupting active response pipeline: %s", reason)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            return
        except Exception:
            _LOGGER.exception("Response pipeline failed while interrupting active output")
        finally:
            with suppress(Exception):
                await self._stt.abort_turn()
            if self._response_task is task:
                self._response_task = None

    async def _finish_turn(self, *, abort: bool, stop_reason: str) -> None:
        response_task = asyncio.current_task() if not abort else None
        async with self._finalize_lock:
            active = self._active
            if active is None:
                return
            self._active = None
            current_task = asyncio.current_task()
            if self._watchdog_task is not None and self._watchdog_task is not current_task:
                self._watchdog_task.cancel()
            self._watchdog_task = None
            self._discard_audio_until_stop = stop_reason != "device_stop"
            if response_task is not None:
                self._response_task = response_task

        self._append_event(
            active,
            "stop",
            {
                "aborted": abort,
                "reason": stop_reason,
                "chunks": active.chunks,
                "bytes_received": active.bytes_received,
                "speech_chunks": active.speech_chunks,
                "speech_detected": active.last_speech_at is not None,
            },
        )
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_STT_END,
            None,
        )

        if abort:
            with suppress(Exception):
                await self._stt.abort_turn()
            write_json(
                active.reply_path,
                {
                    "session_id": active.session_id,
                    "status": "aborted",
                    "reason": stop_reason,
                },
            )
            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END,
                None,
            )
            return

        try:
            transcript = await self._stt.finish_turn()
            pcm_audio = active.pcm_path.read_bytes()
            wav_audio = self._wav_bytes(pcm_audio)
            active.wav_path.write_bytes(wav_audio)
            write_json(active.transcript_path, transcript)
            self._append_event(active, "transcript", transcript)

            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_START,
                None,
            )

            if transcript.text.strip():
                self._session.client.send_voice_assistant_event(
                    VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_END,
                    {"continue_conversation": "1" if self._continue_conversation else "0"},
                )
                response_text = await self._stream_agent_reply(active.session_id, transcript.text)
            else:
                self._session.client.send_voice_assistant_event(
                    VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_END,
                    {"continue_conversation": "0"},
                )
                write_json(
                    active.reply_path,
                    {
                        "session_id": active.session_id,
                        "transcript": "",
                        "status": "no_input",
                        "reason": stop_reason,
                    },
                )
                return
            write_json(
                active.reply_path,
                {
                    "session_id": active.session_id,
                    "transcript": transcript.text,
                    "response": response_text,
                    "reason": stop_reason,
                },
            )
        except asyncio.CancelledError:
            _LOGGER.info("Voice turn interrupted: %s", active.session_id)
            with suppress(Exception):
                await self._stt.abort_turn()
            write_json(
                active.reply_path,
                {
                    "session_id": active.session_id,
                    "status": "interrupted",
                    "reason": stop_reason,
                },
            )
            raise
        except TimeoutError as exc:
            _LOGGER.warning("Voice turn reply timed out: %s", active.session_id)
            write_json(
                active.reply_path,
                {
                    "session_id": active.session_id,
                    "status": "timeout",
                    "error": str(exc),
                    "reason": stop_reason,
                    "timeout_seconds": self._reply_timeout_seconds,
                },
            )
            self._append_event(
                active,
                "error",
                {
                    "code": "bridge_timeout",
                    "message": f"Reply timed out after {self._reply_timeout_seconds:.1f}s",
                },
            )
            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_ERROR,
                {
                    "code": "bridge_timeout",
                    "message": f"Reply timed out after {self._reply_timeout_seconds:.1f}s",
                },
            )
        except Exception as exc:
            _LOGGER.exception("Voice turn failed: %s", active.session_id)
            write_json(
                active.reply_path,
                {
                    "session_id": active.session_id,
                    "status": "error",
                    "error": str(exc),
                    "reason": stop_reason,
                },
            )
            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_ERROR,
                {"code": "bridge_error", "message": str(exc)},
            )
        finally:
            if self._response_task is response_task:
                self._response_task = None
            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END,
                None,
            )

    async def _stream_agent_reply(self, session_id: str, transcript: str) -> str:
        response_text = ""
        text_chunks: asyncio.Queue[str | None] = asyncio.Queue()
        stream = self._audio_server.open_stream(content_type="audio/flac")
        reply_stream = self._agent.stream_reply(text=transcript, conversation_id=session_id)
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_START,
            None,
        )
        announcement_task = asyncio.create_task(
            self._session.client.send_voice_assistant_announcement_await_response(
                media_id=stream.url,
                timeout=self._announcement_timeout_seconds,
                start_conversation=False,
            )
        )
        tts_task = asyncio.create_task(self._pipe_tts(text_chunks, stream))
        try:
            while True:
                try:
                    delta = await asyncio.wait_for(anext(reply_stream), timeout=self._reply_timeout_seconds)
                except StopAsyncIteration:
                    break
                except TimeoutError:
                    if response_text.strip():
                        _LOGGER.warning(
                            "Agent stream stalled after partial reply; finishing partial response: %s",
                            session_id,
                        )
                        break
                    raise
                response_text += delta
                await text_chunks.put(delta)
            await text_chunks.put(None)
            await tts_task
            stream.close()
            await announcement_task
        finally:
            with suppress(Exception):
                await reply_stream.aclose()
            stream.close()
            if not announcement_task.done():
                announcement_task.cancel()
            if not tts_task.done():
                tts_task.cancel()
            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_END,
                None,
            )
        return response_text.strip() or "I don't have a response yet."

    async def _stream_speech(self, text: str) -> None:
        text_chunks: asyncio.Queue[str | None] = asyncio.Queue()
        stream = self._audio_server.open_stream(content_type="audio/flac")
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_START,
            None,
        )
        announcement_task = asyncio.create_task(
            self._session.client.send_voice_assistant_announcement_await_response(
                media_id=stream.url,
                timeout=self._announcement_timeout_seconds,
                start_conversation=False,
            )
        )
        tts_task = asyncio.create_task(self._pipe_tts(text_chunks, stream))
        try:
            await text_chunks.put(text)
            await text_chunks.put(None)
            await tts_task
            stream.close()
            await announcement_task
        finally:
            stream.close()
            if not announcement_task.done():
                announcement_task.cancel()
            if not tts_task.done():
                tts_task.cancel()
            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_TTS_STREAM_END,
                None,
            )

    async def _pipe_tts(self, text_chunks: "asyncio.Queue[str | None]", stream: LiveAudioStream) -> None:
        mp3_chunks = self._tts.stream_text(text_chunks=text_chunks)
        async for audio_chunk in self._audio_transcoder.transcode(mp3_chunks):
            stream.write(audio_chunk)

    def _resolve_session_id(self, conversation_id: str) -> str:
        if self._pinned_conversation_id:
            self._last_session_id = self._pinned_conversation_id
            return self._pinned_conversation_id
        if conversation_id:
            self._last_session_id = conversation_id
            return conversation_id
        if self._last_session_id and self._session_cache.get(self._last_session_id):
            return self._last_session_id
        session_id = f"session-{uuid.uuid4().hex[:12]}"
        self._last_session_id = session_id
        return session_id

    def _wav_bytes(self, pcm_audio: bytes) -> bytes:
        buffer = BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            handle.writeframes(pcm_audio)
        return buffer.getvalue()

    def _append_event(self, active: ActiveTurn, event_type: str, payload: object) -> None:
        ensure_directory(active.events_path.parent)
        line = {
            "timestamp": isoformat_z(utc_now()),
            "type": event_type,
            "payload": payload,
        }
        with active.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(to_jsonable(line), sort_keys=True) + "\n")

    @staticmethod
    def _chunk_rms(data: bytes) -> float:
        if len(data) < 2:
            return 0.0
        if len(data) % 2:
            data = data[:-1]
        samples = array.array("h")
        samples.frombytes(data)
        if not samples:
            return 0.0
        power = sum(sample * sample for sample in samples) / len(samples)
        return math.sqrt(power)
