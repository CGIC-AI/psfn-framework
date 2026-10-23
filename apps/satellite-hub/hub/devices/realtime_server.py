from __future__ import annotations

from hub.storage.artifacts import ArtifactStore

import asyncio
import base64
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
import json
import logging
from pathlib import Path
import time
import uuid
import wave

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider
from hub.adapters.stt.deepgram_live import DeepgramLiveSTTProvider
from hub.adapters.tts.elevenlabs_streaming import ElevenLabsStreamingTTS
from hub.devices.realtime_admission import RealtimeAdmission
from hub.devices.realtime_output import RealtimeOutputLimits
from hub.media.http_audio import StaticAudioServer
from hub.satellite_claims import ClientCertificateConfig, SatelliteClaimConfig
from hub.security.realtime_access import RealtimeAccess
from hub.storage.session_cache import SessionCache
from hub.util import isoformat_z, to_jsonable, utc_now

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class _RealtimeTurn:
    session_id: str
    turn_id: str
    started_at: datetime
    wake_word_phrase: str | None
    directory: Path
    pcm_path: Path
    wav_path: Path
    transcript_path: Path
    reply_path: Path
    events_path: Path
    bytes_received: int = 0
    chunks: int = 0


class _RealtimeConnection:
    def __init__(
        self,
        *,
        websocket,
        audio_server: StaticAudioServer,
        session_cache: SessionCache,
        artifacts_root: Path,
        deepgram_api_key: str,
        elevenlabs_api_key: str,
        elevenlabs_voice_id: str | None,
        elevenlabs_model_id: str,
        psfn_api_base_url: str,
        psfn_api_key: str | None,
        psfn_provider: str | None,
        psfn_model: str,
        psfn_author_id: str | None,
        psfn_author_name: str | None,
        psfn_satellite_claim: SatelliteClaimConfig,
        psfn_client_certificate: ClientCertificateConfig | None,
        max_audio_bytes: int = 4 * 1024 * 1024,
        max_audio_duration_seconds: float = 120,
        idle_timeout_seconds: float = 30,
    ) -> None:
        self._websocket = websocket
        self._audio_server = audio_server
        self._session_cache = session_cache
        self._artifacts_root = artifacts_root
        self._artifact_store: ArtifactStore | None = None
        self._stt = DeepgramLiveSTTProvider(api_key=deepgram_api_key)
        self._tts = ElevenLabsStreamingTTS(
            api_key=elevenlabs_api_key,
            voice_id=elevenlabs_voice_id,
            model_id=elevenlabs_model_id,
        )
        self._agent = PsfnStreamingProvider(
            api_base_url=psfn_api_base_url,
            api_key=psfn_api_key,
            provider_name=psfn_provider,
            model_name=psfn_model,
            author_id=psfn_author_id,
            author_name=psfn_author_name,
            claim_config=psfn_satellite_claim,
            client_certificate=psfn_client_certificate,
        )
        self._device_id = f"client-{uuid.uuid4().hex[:8]}"
        self._device_name = "Realtime Voice Client"
        self._session_id = f"realtime:{self._device_id}"
        self._active_turn: _RealtimeTurn | None = None
        self._reply_task: asyncio.Task[None] | None = None
        self._send_lock = asyncio.Lock()
        self._max_audio_bytes = max_audio_bytes
        self._max_audio_duration = max_audio_duration_seconds
        self._idle_timeout = idle_timeout_seconds
        self._pending_audio: bytearray | None = None
        self._pending_started = 0.0
        self._pending_wake_word: str | None = None
        self._pending_turn_id: str | None = None

    @property
    def _artifacts(self) -> ArtifactStore:
        if self._artifact_store is None:
            self._artifact_store = ArtifactStore(self._artifacts_root)
            self._artifacts_root = self._artifact_store.root
        return self._artifact_store

    async def run(self) -> None:
        await self._send_json(
            {
                "type": "session.ready",
                "device_id": self._device_id,
                "device_name": self._device_name,
                "session_id": self._session_id,
                "audio_format": "pcm_s16le_16000_mono_in/mp3_44100_out",
            }
        )
        iterator = self._websocket.__aiter__()
        while True:
            timeout = self._idle_timeout
            if self._pending_audio is not None:
                timeout = min(timeout, self._max_audio_duration - (time.monotonic() - self._pending_started))
            try:
                raw_message = await asyncio.wait_for(anext(iterator), max(0, timeout))
            except StopAsyncIteration:
                return
            # Output can fail while wait_for hands the received frame back.
            if self._websocket.output.failed:
                return
            if not isinstance(raw_message, str):
                raise ValueError("Realtime requires JSON text frames")
            payload = json.loads(raw_message)
            if not isinstance(payload, dict) or not isinstance(payload.get("type"), str):
                raise ValueError("Invalid realtime frame")
            await self._handle_message(payload)

    async def aclose(self) -> None:
        self._pending_audio = None
        await self._cancel_reply(reason="connection_closed")
        if self._active_turn is not None:
            with suppress(Exception):
                await self._stt.abort_turn()
            self._active_turn = None
        await self._stt.aclose()
        await self._tts.aclose()
        await self._agent.aclose()
        if self._artifact_store is not None:
            self._artifact_store.close()

    async def _handle_message(self, payload: dict[str, object]) -> None:
        message_type = str(payload.get("type") or "")
        if message_type == "hello":
            self._device_name = str(payload.get("device_name") or self._device_name)
            self._session_cache.touch(self._session_id)
            await self._send_json(
                {
                    "type": "hello.ack",
                    "device_id": self._device_id,
                    "device_name": self._device_name,
                    "session_id": self._session_id,
                }
            )
            return

        if message_type == "interrupt":
            self._pending_audio = None
            await self._cancel_reply(reason="client_interrupt")
            await self._send_json({"type": "assistant.interrupted", "session_id": self._session_id})
            return

        if message_type == "turn.start":
            if self._pending_audio is not None:
                raise ValueError("Overlapping audio turn")
            self._pending_audio = bytearray()
            self._pending_started = time.monotonic()
            self._pending_wake_word = _clean_optional(payload.get("wake_word_phrase"))
            self._pending_turn_id = f"turn-{uuid.uuid4().hex[:8]}"
            await self._send_json({"type": "turn.started", "session_id": self._session_id,
                                   "turn_id": self._pending_turn_id, "wake_word_phrase": self._pending_wake_word})
            return

        if message_type == "audio":
            value = payload.get("audio")
            if not isinstance(value, str) or self._pending_audio is None:
                raise ValueError("Audio requires an active turn")
            data = base64.b64decode(value, validate=True)
            if len(data) % 2 or len(self._pending_audio) + len(data) > min(self._max_audio_bytes, int(self._max_audio_duration * 32000)) or time.monotonic() - self._pending_started > self._max_audio_duration:
                self._pending_audio = None
                raise ValueError("Audio turn exceeds PCM limit")
            self._pending_audio.extend(data)
            return

        if message_type == "turn.end":
            pcm = bytes(self._pending_audio or b"")
            self._pending_audio = None
            if not pcm:
                return
            if time.monotonic() - self._pending_started > self._max_audio_duration:
                raise ValueError("Audio turn exceeds duration")
            await self._start_turn(wake_word_phrase=self._pending_wake_word)
            await self._handle_audio(pcm)
            await self._finish_turn(reason=str(payload.get("reason") or "client_end"))
            return

        if message_type == "session.reset":
            self._pending_audio = None
            await self._cancel_reply(reason="session_reset")
            if self._active_turn is not None:
                with suppress(Exception):
                    await self._stt.abort_turn()
                self._active_turn = None
            self._session_id = f"realtime:{self._device_id}:{uuid.uuid4().hex[:8]}"
            self._session_cache.touch(self._session_id)
            await self._send_json({"type": "session.reset.ack", "session_id": self._session_id})
            return

        raise ValueError("Unsupported realtime frame")

    async def _start_turn(self, *, wake_word_phrase: str | None) -> None:
        await self._cancel_reply(reason="new_turn")
        if self._active_turn is not None:
            with suppress(Exception):
                await self._stt.abort_turn()
        started_at = utc_now()
        turn_id = self._pending_turn_id or f"turn-{uuid.uuid4().hex[:8]}"
        safe_session = uuid.uuid4().hex
        directory = self._artifacts.directory(
            self._artifacts_root / started_at.strftime("%Y%m%d") / f"{started_at.strftime('%H%M%S')}_{safe_session}_{turn_id}"
        )
        turn = _RealtimeTurn(
            session_id=self._session_id,
            turn_id=turn_id,
            started_at=started_at,
            wake_word_phrase=wake_word_phrase,
            directory=directory,
            pcm_path=directory / "audio.pcm",
            wav_path=directory / "audio.wav",
            transcript_path=directory / "transcript.json",
            reply_path=directory / "reply.json",
            events_path=directory / "events.jsonl",
        )
        self._artifacts.write_bytes(turn.pcm_path, b"")
        try:
            await self._stt.start_turn(self._session_id)
        except Exception as exc:
            _LOGGER.error("Failed to start realtime STT turn")
            self._artifacts.remove(turn.pcm_path)
            await self._send_json(
                {
                    "type": "error",
                    "message": f"Failed to start speech recognition: {exc}",
                }
            )
            return
        self._active_turn = turn
        self._session_cache.touch(self._session_id)
        self._append_event(
            turn,
            "start",
            {
                "session_id": self._session_id,
                "turn_id": turn_id,
                "wake_word_phrase": wake_word_phrase,
            },
        )

    async def _handle_audio(self, data: bytes) -> None:
        if not data or self._active_turn is None:
            return
        self._artifacts.append_bytes(self._active_turn.pcm_path, data)
        self._active_turn.bytes_received += len(data)
        self._active_turn.chunks += 1
        await self._stt.send_audio(data)

    async def _finish_turn(self, *, reason: str) -> None:
        turn = self._active_turn
        if turn is None:
            return
        self._active_turn = None
        transcript = await self._stt.finish_turn()
        self._artifacts.write_bytes(turn.wav_path, _wav_bytes(self._artifacts.read_bytes(turn.pcm_path)))
        self._artifacts.write_json(turn.transcript_path, transcript)
        self._append_event(
            turn,
            "stop",
            {
                "reason": reason,
                "chunks": turn.chunks,
                "bytes_received": turn.bytes_received,
            },
        )
        self._append_event(turn, "transcript", to_jsonable(transcript))
        await self._send_json(
            {
                "type": "transcript.final",
                "session_id": self._session_id,
                "turn_id": turn.turn_id,
                "text": transcript.text,
                "provider": transcript.provider,
                "latency_ms": transcript.latency_ms,
            }
        )
        if not transcript.text.strip():
            self._artifacts.write_json(
                turn.reply_path,
                {
                    "session_id": self._session_id,
                    "turn_id": turn.turn_id,
                    "status": "no_input",
                    "reason": reason,
                    "transcript": "",
                },
            )
            await self._send_json(
                {
                    "type": "turn.no_input",
                    "session_id": self._session_id,
                    "turn_id": turn.turn_id,
                    "reason": reason,
                }
            )
            return
        self._reply_task = asyncio.create_task(self._run_reply(turn=turn, transcript=transcript.text, reason=reason))

    async def _run_reply(self, *, turn: _RealtimeTurn, transcript: str, reason: str) -> None:
        response_text = ""
        text_chunks: asyncio.Queue[str | None] = asyncio.Queue(maxsize=32)
        tts_task = asyncio.create_task(self._stream_audio_chunks(turn=turn, text_chunks=text_chunks))
        await self._send_json(
            {
                "type": "assistant.start",
                "session_id": turn.session_id,
                "turn_id": turn.turn_id,
            }
        )
        try:
            async for delta in self._agent.stream_reply(text=transcript, conversation_id=turn.session_id):
                if not delta:
                    continue
                response_text += delta
                await self._send_json(
                    {
                        "type": "assistant.text",
                        "session_id": turn.session_id,
                        "turn_id": turn.turn_id,
                        "delta": delta,
                    }
                )
                await text_chunks.put(delta)
            await text_chunks.put(None)
            await tts_task
            self._artifacts.write_json(
                turn.reply_path,
                {
                    "session_id": turn.session_id,
                    "turn_id": turn.turn_id,
                    "reason": reason,
                    "transcript": transcript,
                    "response": response_text,
                },
            )
            await self._send_json(
                {
                    "type": "assistant.end",
                    "session_id": turn.session_id,
                    "turn_id": turn.turn_id,
                    "text": response_text,
                }
            )
        except asyncio.CancelledError:
            with suppress(asyncio.QueueFull):
                text_chunks.put_nowait(None)
            tts_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await tts_task
            self._artifacts.write_json(
                turn.reply_path,
                {
                    "session_id": turn.session_id,
                    "turn_id": turn.turn_id,
                    "status": "interrupted",
                    "transcript": transcript,
                },
            )
            raise
        except Exception as exc:
            self._artifacts.write_json(
                turn.reply_path,
                {
                    "session_id": turn.session_id,
                    "turn_id": turn.turn_id,
                    "status": "error",
                    "transcript": transcript,
                    "error": str(exc),
                },
            )
            await self._send_json(
                {
                    "type": "error",
                    "session_id": turn.session_id,
                    "turn_id": turn.turn_id,
                    "message": str(exc),
                }
            )
        finally:
            if not tts_task.done():
                tts_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await tts_task
            if self._reply_task is asyncio.current_task():
                self._reply_task = None

    async def _stream_audio_chunks(self, *, turn: _RealtimeTurn, text_chunks: "asyncio.Queue[str | None]") -> None:
        await self._send_json(
            {
                "type": "assistant.audio.start",
                "session_id": turn.session_id,
                "turn_id": turn.turn_id,
                "mime_type": "audio/mpeg",
            }
        )
        async for chunk in self._tts.stream_text(
            text_chunks=text_chunks,
            context_id=f"{turn.session_id}:{turn.turn_id}",
        ):
            await self._send_json(
                {
                    "type": "assistant.audio.chunk",
                    "session_id": turn.session_id,
                    "turn_id": turn.turn_id,
                    "audio": _encode_audio(chunk),
                }
            )
        await self._send_json(
            {
                "type": "assistant.audio.end",
                "session_id": turn.session_id,
                "turn_id": turn.turn_id,
            }
        )

    async def _cancel_reply(self, *, reason: str) -> None:
        if self._reply_task is None or self._reply_task.done():
            self._reply_task = None
            return
        self._reply_task.cancel()
        with suppress(asyncio.CancelledError):
            await self._reply_task
        self._reply_task = None
        await self._send_json({"type": "assistant.cancelled", "session_id": self._session_id, "reason": reason})

    async def _send_json(self, payload: dict[str, object]) -> None:
        async with self._send_lock:
            await self._websocket.send(json.dumps(payload))

    def _append_event(self, turn: _RealtimeTurn, event_type: str, payload: dict[str, object]) -> None:
        entry = {
            "timestamp": isoformat_z(utc_now()),
            "type": event_type,
            "payload": payload,
        }
        self._artifacts.append_bytes(turn.events_path, (json.dumps(entry, sort_keys=True) + "\n").encode("utf-8"))


class RealtimeVoiceServer:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        artifacts_root: Path,
        audio_server: StaticAudioServer,
        session_cache: SessionCache,
        deepgram_api_key: str,
        elevenlabs_api_key: str,
        elevenlabs_voice_id: str | None,
        elevenlabs_model_id: str,
        psfn_api_base_url: str,
        psfn_api_key: str | None,
        psfn_provider: str | None,
        psfn_model: str,
        psfn_author_id: str | None,
        psfn_author_name: str | None,
        psfn_satellite_claim: SatelliteClaimConfig,
        psfn_client_certificate: ClientCertificateConfig | None,
        auth_token: str | None = None,
        developer_mode: bool = False,
        allowed_origins: tuple[str, ...] = (),
        max_frame_bytes: int = 256 * 1024,
        max_connections: int = 64,
        output_limits: RealtimeOutputLimits | None = None,
        max_audio_bytes: int = 4 * 1024 * 1024,
        max_audio_duration_seconds: float = 120,
        idle_timeout_seconds: float = 30,
    ) -> None:
        self._access = RealtimeAccess(host, auth_token, developer_mode, allowed_origins)
        if auth_token and auth_token in {psfn_api_key, deepgram_api_key, elevenlabs_api_key}:
            raise ValueError("HUB_REALTIME_AUTH_TOKEN must not reuse another credential")
        for value in (max_frame_bytes, max_connections, max_audio_bytes, max_audio_duration_seconds, idle_timeout_seconds):
            if not isinstance(value, (int, float)) or not 0 < value <= 2_147_483_647:
                raise ValueError("Realtime resource limits must be positive bounded numbers")
        self._max_frame_bytes = max_frame_bytes
        self._admission = RealtimeAdmission(max_connections, output_limits)
        self._max_audio_bytes = max_audio_bytes
        self._max_audio_duration = max_audio_duration_seconds
        self._idle_timeout = idle_timeout_seconds
        self._connections = self._admission.connections
        self._host = host
        self._port = port
        self._artifacts_root = artifacts_root
        self._audio_server = audio_server
        self._session_cache = session_cache
        self._deepgram_api_key = deepgram_api_key
        self._elevenlabs_api_key = elevenlabs_api_key
        self._elevenlabs_voice_id = elevenlabs_voice_id
        self._elevenlabs_model_id = elevenlabs_model_id
        self._psfn_api_base_url = psfn_api_base_url
        self._psfn_api_key = psfn_api_key
        self._psfn_provider = psfn_provider
        self._psfn_model = psfn_model
        self._psfn_author_id = psfn_author_id
        self._psfn_author_name = psfn_author_name
        self._psfn_satellite_claim = psfn_satellite_claim
        self._psfn_client_certificate = psfn_client_certificate
        self._server = None

    async def __aenter__(self) -> "RealtimeVoiceServer":
        self._admission.accepting = True
        self._server = await serve(
            self._handle_connection,
            self._host,
            self._port,
            process_request=self._process_request,
            create_connection=self._admission.create_connection,
            max_size=self._max_frame_bytes,
            max_queue=32,
            write_limit=1024 * 1024,
            open_timeout=5,
            close_timeout=5,
            compression=None,
            ping_interval=20,
            ping_timeout=20,
        )
        return self

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("Realtime server is not listening")
        return self._server.sockets[0].getsockname()[1]

    def _process_request(self, websocket, request):
        from http import HTTPStatus

        if websocket not in self._connections:
            return websocket.respond(HTTPStatus.SERVICE_UNAVAILABLE, "Realtime access denied\n")
        try:
            status = self._access.reject_status(request, websocket.remote_address[0])
        except (ValueError, TypeError):
            status = HTTPStatus.BAD_REQUEST
        if status is not None:
            return websocket.respond(status, "Realtime access denied\n")
        return None

    async def __aexit__(self, exc_type, exc, tb) -> None:
        server = self._server
        if server is None:
            return
        self._admission.stop()
        server.close()
        try:
            await server.wait_closed()
        except asyncio.CancelledError:
            for connection in tuple(self._connections):
                connection.transport.abort()
            await server.wait_closed()
            raise
        finally:
            # Repeated cancellation can interrupt the cleanup wait. Keep the
            # closing server reachable so another exit can finish awaiting it.
            if server.close_task.done() and self._server is server:
                self._server = None

    async def _handle_connection(self, websocket) -> None:
        connection = _RealtimeConnection(
            websocket=websocket,
            audio_server=self._audio_server,
            session_cache=self._session_cache,
            artifacts_root=self._artifacts_root,
            deepgram_api_key=self._deepgram_api_key,
            elevenlabs_api_key=self._elevenlabs_api_key,
            elevenlabs_voice_id=self._elevenlabs_voice_id,
            elevenlabs_model_id=self._elevenlabs_model_id,
            psfn_api_base_url=self._psfn_api_base_url,
            psfn_api_key=self._psfn_api_key,
            psfn_provider=self._psfn_provider,
            psfn_model=self._psfn_model,
            psfn_author_id=self._psfn_author_id,
            psfn_author_name=self._psfn_author_name,
            psfn_satellite_claim=self._psfn_satellite_claim,
            psfn_client_certificate=self._psfn_client_certificate,
            max_audio_bytes=self._max_audio_bytes,
            max_audio_duration_seconds=self._max_audio_duration,
            idle_timeout_seconds=self._idle_timeout,
        )
        try:
            await connection.run()
        except ConnectionClosed:
            return
        except (ValueError, TypeError, TimeoutError):
            await websocket.close(1008, "Invalid or expired realtime input")
        finally:
            await connection.aclose()


def _clean_optional(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _encode_audio(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _decode_audio(value: str) -> bytes:
    if not value:
        return b""
    return base64.b64decode(value)


def _wav_bytes(pcm_audio: bytes) -> bytes:
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(16000)
        wav_file.writeframes(pcm_audio)
    return buffer.getvalue()
