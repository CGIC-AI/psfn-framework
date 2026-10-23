from __future__ import annotations

from hub.storage.artifacts import ArtifactStore

from dataclasses import dataclass
from datetime import datetime
import json
import logging
from pathlib import Path
from io import BytesIO
import uuid
import wave

from aioesphomeapi.model import VoiceAssistantAnnounceFinished, VoiceAssistantAudioSettings

from hub.util import isoformat_z, to_jsonable, utc_now

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
        self._artifacts = ArtifactStore(output_root)
        self._output_root = self._artifacts.root
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
        safe_id = uuid.uuid4().hex
        directory = self._artifacts.directory(
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
        self._artifacts.write_bytes(active.pcm_path, b"")
        self._append_event(active, "start", {
            "conversation_id": conversation_id,
            "flags": flags,
            "wake_word_phrase": wake_word_phrase,
            "audio_settings": to_jsonable(audio_settings),
        })
        self._active = active
        _LOGGER.info("Voice transport started")
        return self._listen_port

    async def handle_audio(self, data: bytes) -> None:
        if self._active is None:
            _LOGGER.warning("Dropping audio chunk because no active conversation exists")
            return

        self._artifacts.append_bytes(self._active.pcm_path, data)
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
        _LOGGER.info("Voice transport stopped")

    async def handle_announcement_finished(self, finished: VoiceAssistantAnnounceFinished) -> None:
        if self._active is None:
            return
        self._append_event(self._active, "announcement_finished", {"success": finished.success})

    def _finalize(self, active: ActiveConversation, *, stop_reason: str, aborted: bool) -> None:
        finished_at = utc_now()
        self._append_event(active, "stop", {"stop_reason": stop_reason, "aborted": aborted})
        self._write_wav(active.pcm_path, active.wav_path)
        self._artifacts.write_json(
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
        line = {
            "timestamp": isoformat_z(utc_now()),
            "type": event_type,
            "payload": payload,
        }
        self._artifacts.append_bytes(active.events_path, (json.dumps(to_jsonable(line), sort_keys=True) + "\n").encode("utf-8"))

    def _write_wav(self, pcm_path: Path, wav_path: Path) -> None:
        raw = self._artifacts.read_bytes(pcm_path)
        output = BytesIO()
        with wave.open(output, "wb") as handle:
            handle.setnchannels(self._pcm_format.channels)
            handle.setsampwidth(self._pcm_format.sample_width_bytes)
            handle.setframerate(self._pcm_format.sample_rate)
            handle.writeframes(raw)
        self._artifacts.write_bytes(wav_path, output.getvalue())
