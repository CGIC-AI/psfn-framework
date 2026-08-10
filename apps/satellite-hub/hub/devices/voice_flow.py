from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import json
import logging
from pathlib import Path
import wave

from aioesphomeapi.model import VoiceAssistantAnnounceFinished, VoiceAssistantAudioSettings

from hub.util import ensure_directory, isoformat_z, to_jsonable, utc_now, write_json

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class PCMFormatAssumption:
    sample_rate: int = 16000
    channels: int = 1
    sample_width_bytes: int = 2


@dataclass(slots=True)
class ActiveConversation:
    conversation_id: str
    started_at: datetime
    flags: int
    wake_word_phrase: str | None
    audio_settings: VoiceAssistantAudioSettings
    directory: Path
    pcm_path: Path
    wav_path: Path
    manifest_path: Path
    events_path: Path
    chunks: int = 0
    bytes_received: int = 0


class VoiceTransportSpike:
    def __init__(
        self,
        *,
        output_root: Path,
        pcm_format: PCMFormatAssumption,
        listen_port: int = 0,
    ) -> None:
        self._output_root = ensure_directory(output_root)
        self._pcm_format = pcm_format
        self._listen_port = listen_port
        self._active: ActiveConversation | None = None

    async def handle_start(
        self,
        conversation_id: str,
        flags: int,
        audio_settings: VoiceAssistantAudioSettings,
        wake_word_phrase: str | None,
    ) -> int | None:
        if self._active is not None:
            self._finalize(self._active, stop_reason="superseded", aborted=True)

        started_at = utc_now()
        safe_id = conversation_id.replace("/", "_") or "unknown"
        directory = ensure_directory(
            self._output_root / started_at.strftime("%Y%m%d") / f"{started_at.strftime('%H%M%S')}_{safe_id}"
        )
        active = ActiveConversation(
            conversation_id=conversation_id,
            started_at=started_at,
            flags=flags,
            wake_word_phrase=wake_word_phrase,
            audio_settings=audio_settings,
            directory=directory,
            pcm_path=directory / "audio.pcm",
            wav_path=directory / "audio.wav",
            manifest_path=directory / "manifest.json",
            events_path=directory / "events.jsonl",
        )
        active.pcm_path.touch()
        self._append_event(active, "start", {
            "conversation_id": conversation_id,
            "flags": flags,
            "wake_word_phrase": wake_word_phrase,
            "audio_settings": to_jsonable(audio_settings),
        })
        self._active = active
        _LOGGER.info("Voice transport started: %s", conversation_id)
        return self._listen_port

    async def handle_audio(self, data: bytes) -> None:
        if self._active is None:
            _LOGGER.warning("Dropping audio chunk because no active conversation exists")
            return

        with self._active.pcm_path.open("ab") as handle:
            handle.write(data)
        self._active.chunks += 1
        self._active.bytes_received += len(data)

    async def handle_stop(self, abort: bool) -> None:
        if self._active is None:
            _LOGGER.warning("Received stop without an active conversation")
            return

        active = self._active
        self._active = None
        self._finalize(
            active,
            stop_reason="abort" if abort else "audio_end",
            aborted=abort,
        )
        _LOGGER.info("Voice transport stopped: %s", active.conversation_id)

    async def handle_announcement_finished(self, finished: VoiceAssistantAnnounceFinished) -> None:
        if self._active is None:
            return
        self._append_event(self._active, "announcement_finished", {"success": finished.success})

    def _finalize(self, active: ActiveConversation, *, stop_reason: str, aborted: bool) -> None:
        finished_at = utc_now()
        self._append_event(active, "stop", {"stop_reason": stop_reason, "aborted": aborted})
        self._write_wav(active.pcm_path, active.wav_path)
        write_json(
            active.manifest_path,
            {
                "conversation_id": active.conversation_id,
                "started_at": isoformat_z(active.started_at),
                "finished_at": isoformat_z(finished_at),
                "stop_reason": stop_reason,
                "aborted": aborted,
                "flags": active.flags,
                "wake_word_phrase": active.wake_word_phrase,
                "audio_settings": active.audio_settings,
                "chunks": active.chunks,
                "bytes_received": active.bytes_received,
                "artifacts": {
                    "pcm": active.pcm_path,
                    "wav": active.wav_path,
                    "events": active.events_path,
                },
                "wav_assumptions": {
                    "sample_rate": self._pcm_format.sample_rate,
                    "channels": self._pcm_format.channels,
                    "sample_width_bytes": self._pcm_format.sample_width_bytes,
                },
            },
        )

    def _append_event(self, active: ActiveConversation, event_type: str, payload: dict[str, object]) -> None:
        ensure_directory(active.events_path.parent)
        line = {
            "timestamp": isoformat_z(utc_now()),
            "type": event_type,
            "payload": payload,
        }
        with active.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(to_jsonable(line), sort_keys=True) + "\n")

    def _write_wav(self, pcm_path: Path, wav_path: Path) -> None:
        raw = pcm_path.read_bytes()
        with wave.open(str(wav_path), "wb") as handle:
            handle.setnchannels(self._pcm_format.channels)
            handle.setsampwidth(self._pcm_format.sample_width_bytes)
            handle.setframerate(self._pcm_format.sample_rate)
            handle.writeframes(raw)
