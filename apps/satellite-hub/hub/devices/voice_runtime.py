from __future__ import annotations

import asyncio
import array
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
import json
import logging
import math
from pathlib import Path
import uuid
import wave

from aioesphomeapi.model import VoiceAssistantAudioSettings, VoiceAssistantEventType

from hub.adapters.interfaces import AgentProvider, STTProvider, TTSProvider
from hub.devices.esphome_session import ESPHomeSession
from hub.media.http_audio import StaticAudioServer
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
    last_speech_at: datetime | None = None


class VoiceAssistantRuntime:
    def __init__(
        self,
        *,
        session: ESPHomeSession,
        stt: STTProvider,
        agent: AgentProvider,
        tts: TTSProvider,
        audio_server: StaticAudioServer,
        session_cache: SessionCache,
        artifacts_root: Path,
        continue_conversation: bool,
        announcement_timeout_seconds: float,
        endpointing_grace_seconds: float,
        silence_timeout_seconds: float,
        max_turn_seconds: float,
        speech_rms_threshold: float,
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
        self._endpointing_grace_seconds = endpointing_grace_seconds
        self._silence_timeout_seconds = silence_timeout_seconds
        self._max_turn_seconds = max_turn_seconds
        self._speech_rms_threshold = speech_rms_threshold
        self._active: ActiveTurn | None = None
        self._last_session_id: str | None = None
        self._watchdog_task: asyncio.Task[None] | None = None
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
        self._cancel_watchdog()

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
            if first_speech:
                self._append_event(
                    self._active,
                    "speech_start",
                    {
                        "rms": round(rms, 3),
                        "threshold": self._speech_rms_threshold,
                    },
                )

    async def handle_stop(self, abort: bool) -> None:
        if self._active is None:
            if self._discard_audio_until_stop:
                self._discard_audio_until_stop = False
                _LOGGER.info("Voice turn drain completed after local finalization")
                return
            _LOGGER.warning("Received stop without an active turn")
            return
        await self._finish_turn(abort=abort, stop_reason="device_stop")

    def _resolve_session_id(self, conversation_id: str) -> str:
        if conversation_id:
            self._last_session_id = conversation_id
            return conversation_id

        if self._last_session_id and self._session_cache.get(self._last_session_id):
            return self._last_session_id

        session_id = f"session-{uuid.uuid4().hex[:12]}"
        self._last_session_id = session_id
        return session_id

    async def _speak_text(self, text: str, *, start_conversation: bool) -> None:
        synthesized = await self._tts.synthesize(text)
        url = self._audio_server.url_for(synthesized.audio_path)
        self._append_runtime_event("announcement", {"text": text, "url": url})
        await self._session.client.send_voice_assistant_announcement_await_response(
            media_id=url,
            timeout=self._announcement_timeout_seconds,
            start_conversation=start_conversation,
        )

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

    def _append_runtime_event(self, event_type: str, payload: object) -> None:
        runtime_path = ensure_directory(self._artifacts_root) / "runtime-events.jsonl"
        line = {
            "timestamp": isoformat_z(utc_now()),
            "type": event_type,
            "payload": payload,
        }
        with runtime_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(to_jsonable(line), sort_keys=True) + "\n")

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

    async def _finish_turn(self, *, abort: bool, stop_reason: str) -> None:
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

        self._append_event(
            active,
            "stop",
            {
                "aborted": abort,
                "reason": stop_reason,
                "chunks": active.chunks,
                "bytes_received": active.bytes_received,
                "speech_detected": active.last_speech_at is not None,
            },
        )
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_STT_END,
            None,
        )

        if abort:
            write_json(
                active.reply_path,
                {
                    "session_id": active.session_id,
                    "status": "aborted",
                    "reason": stop_reason,
                },
            )
            return

        pcm_audio = active.pcm_path.read_bytes()
        wav_audio = self._wav_bytes(pcm_audio)
        active.wav_path.write_bytes(wav_audio)
        self._session.client.send_voice_assistant_event(
            VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_START,
            None,
        )

        try:
            transcript = await self._stt.transcribe(wav_audio)
            write_json(active.transcript_path, transcript)
            self._append_event(active, "transcript", transcript)

            if transcript.text:
                session = self._session_cache.get_or_create(active.session_id)
                agent_reply = await self._agent.reply(
                    text=transcript.text,
                    conversation_id=active.session_id,
                    history=session.history,
                )
                self._session_cache.set_history(active.session_id, agent_reply.history)
                response_text = agent_reply.text.strip() or "I don't have a response yet."
                write_json(
                    active.reply_path,
                    {
                        "session_id": active.session_id,
                        "transcript": transcript.text,
                        "response": response_text,
                        "reason": stop_reason,
                    },
                )
            else:
                response_text = "I didn't catch that."
                write_json(
                    active.reply_path,
                    {
                        "session_id": active.session_id,
                        "transcript": "",
                        "response": response_text,
                        "reason": stop_reason,
                    },
                )

            self._session.client.send_voice_assistant_event(
                VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_END,
                {"continue_conversation": "1" if self._continue_conversation else "0"},
            )
            await self._speak_text(response_text, start_conversation=self._continue_conversation)
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
            try:
                await self._speak_text("Sorry, something went wrong.", start_conversation=False)
            except Exception:
                _LOGGER.exception("Failed to speak fallback error message")

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
