from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import logging
from time import perf_counter
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

from hub.adapters.interfaces import TranscriptResult
from hub.adapters.bounds import ProviderLimits, ProviderLimitError

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class _TurnState:
    conversation_id: str
    started_at: float = field(default_factory=perf_counter)
    final_segments: list[str] = field(default_factory=list)
    interim_text: str = ""
    finalize_requested: bool = False
    finalize_event: asyncio.Event = field(default_factory=asyncio.Event)
    final_bytes: int = 0
    audio_bytes: int = 0
    failure: str | None = None


class DeepgramLiveSTTProvider:
    def __init__(
        self,
        *,
        api_key: str,
        model: str = "nova-3",
        sample_rate: int = 16000,
        endpointing_ms: int = 300,
        utterance_end_ms: int = 1000,
        limits: ProviderLimits | None = None,
        websocket_url: str | None = None,
    ) -> None:
        self._api_key = api_key
        self._limits = limits or ProviderLimits()
        self._websocket_url = websocket_url
        self._model = model
        self._sample_rate = sample_rate
        self._endpointing_ms = endpointing_ms
        self._utterance_end_ms = utterance_end_ms
        self._ws: websockets.ClientConnection | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._keepalive_task: asyncio.Task[None] | None = None
        self._active_turn: _TurnState | None = None
        self._send_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()
        self._last_send_at = perf_counter()

    async def start_turn(self, conversation_id: str) -> None:
        if self._active_turn is not None:
            _LOGGER.warning("Resetting lingering Deepgram turn")
            await self.abort_turn()
        await self._ensure_connected()
        self._active_turn = _TurnState(conversation_id=conversation_id)

    async def send_audio(self, data: bytes) -> None:
        if not data or self._active_turn is None:
            return
        turn = self._active_turn
        if turn.failure:
            raise ProviderLimitError(turn.failure)
        if turn.audio_bytes + len(data) > self._limits.max_audio_bytes or perf_counter() - turn.started_at >= self._limits.max_age_seconds:
            self._fail_turn("Provider audio limit exceeded")
            await self._disconnect()
            raise ProviderLimitError("Provider audio limit exceeded")
        turn.audio_bytes += len(data)
        await self._send_binary(data)

    async def finish_turn(self) -> TranscriptResult:
        turn = self._active_turn
        if turn is None:
            return TranscriptResult(text="", provider="deepgram-live", latency_ms=0, is_final=True)

        turn.finalize_requested = True
        try:
            if turn.failure:
                raise ProviderLimitError(turn.failure)
            await self._send_text({"type": "Finalize"})
            await asyncio.wait_for(turn.finalize_event.wait(), timeout=2.5)
            if turn.failure:
                raise ProviderLimitError(turn.failure)
        except (TimeoutError, ConnectionClosed):
            raise RuntimeError("Provider transcription did not complete") from None
        finally:
            self._active_turn = None
            await self._disconnect()

        transcript = " ".join(segment for segment in turn.final_segments if segment).strip()
        if not transcript:
            transcript = turn.interim_text.strip()
        return TranscriptResult(
            text=transcript,
            provider="deepgram-live",
            latency_ms=int((perf_counter() - turn.started_at) * 1000),
            is_final=True,
        )

    async def abort_turn(self) -> None:
        if self._active_turn is None and not _is_open(self._ws):
            return
        self._active_turn = None
        await self._disconnect()

    async def aclose(self) -> None:
        await self._disconnect()
        self._active_turn = None

    async def _ensure_connected(self) -> None:
        if _is_open(self._ws):
            return
        async with self._connect_lock:
            if _is_open(self._ws):
                return
            url = (
                "wss://api.deepgram.com/v1/listen"
                f"?model={self._model}"
                "&encoding=linear16"
                f"&sample_rate={self._sample_rate}"
                "&channels=1"
                "&interim_results=true"
                f"&endpointing={self._endpointing_ms}"
                f"&utterance_end_ms={self._utterance_end_ms}"
                "&vad_events=true"
                "&smart_format=true"
            )
            self._ws = await websockets.connect(
                self._websocket_url or url,
                additional_headers={"Authorization": f"Token {self._api_key}"},
                ping_interval=20,
                ping_timeout=20,
                max_size=self._limits.max_ws_message_bytes,
                max_queue=self._limits.max_ws_queue,
                compression=None,
                close_timeout=2,
            )
            self._reader_task = asyncio.create_task(self._reader_loop())
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def _reader_loop(self) -> None:
        ws = self._ws
        try:
            if ws is None:
                return
            async for raw_message in ws:
                if isinstance(raw_message, bytes):
                    continue
                self._handle_message(json.loads(raw_message))
        except asyncio.CancelledError:
            return
        except Exception:
            self._fail_turn("Provider stream failed")
        finally:
            turn = self._active_turn
            if turn is not None and not turn.finalize_event.is_set():
                self._fail_turn("Provider stream closed")
            if ws is not None:
                await ws.close()
            if self._ws is ws:
                self._ws = None
            if self._reader_task is asyncio.current_task():
                self._reader_task = None

    def _handle_message(self, payload: dict[str, Any]) -> None:
        turn = self._active_turn
        if turn is None:
            return
        if not isinstance(payload, dict):
            raise ValueError("Provider stream invalid")

        message_type = payload.get("type", "")
        if message_type == "UtteranceEnd":
            if turn.finalize_requested:
                turn.finalize_event.set()
            return

        if message_type != "Results":
            return

        channel = payload.get("channel", {})
        alternatives = channel.get("alternatives", [])
        if not alternatives:
            return

        transcript = alternatives[0].get("transcript", "") or ""
        if not isinstance(transcript, str):
            raise ValueError("Provider stream invalid")
        transcript = transcript.strip()
        size = len(transcript.encode("utf-8"))
        if size > self._limits.max_text_bytes:
            raise ProviderLimitError("Provider transcript limit exceeded")
        if transcript:
            if payload.get("is_final"):
                if not turn.final_segments or turn.final_segments[-1] != transcript:
                    added = size + (1 if turn.final_segments else 0)
                    if len(turn.final_segments) >= self._limits.max_segments or turn.final_bytes + added > self._limits.max_text_bytes:
                        raise ProviderLimitError("Provider transcript limit exceeded")
                    turn.final_segments.append(transcript)
                    turn.final_bytes += added
                    turn.interim_text = ""
            else:
                if turn.final_bytes + size > self._limits.max_text_bytes:
                    raise ProviderLimitError("Provider transcript limit exceeded")
                turn.interim_text = transcript

        if turn.finalize_requested and (
            payload.get("speech_final") or payload.get("from_finalize")
        ):
            turn.finalize_event.set()

    def _fail_turn(self, failure: str) -> None:
        turn = self._active_turn
        if turn is not None:
            turn.failure = failure
            turn.final_segments.clear()
            turn.interim_text = ""
            turn.final_bytes = 0
            turn.finalize_event.set()

    async def _send_binary(self, data: bytes) -> None:
        async with self._send_lock:
            await self._ensure_connected()
            assert self._ws is not None
            await self._ws.send(data)
            self._last_send_at = perf_counter()

    async def _send_text(self, payload: dict[str, Any]) -> None:
        async with self._send_lock:
            await self._ensure_connected()
            assert self._ws is not None
            await self._ws.send(json.dumps(payload))
            self._last_send_at = perf_counter()

    async def _keepalive_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(8)
                if not _is_open(self._ws):
                    return
                if perf_counter() - self._last_send_at < 8:
                    continue
                try:
                    await self._send_text({"type": "KeepAlive"})
                except ConnectionClosed:
                    return
        except asyncio.CancelledError:
            return
        finally:
            if self._keepalive_task is asyncio.current_task():
                self._keepalive_task = None

    async def _disconnect(self) -> None:
        tasks = [task for task in (self._keepalive_task, self._reader_task) if task is not None and task is not asyncio.current_task()]
        self._keepalive_task = self._reader_task = None
        for task in tasks:
            task.cancel()
        ws, self._ws = self._ws, None
        if ws is not None:
            await ws.close()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def _is_open(connection: websockets.ClientConnection | None) -> bool:
    return connection is not None and getattr(connection, "state", None) == State.OPEN
