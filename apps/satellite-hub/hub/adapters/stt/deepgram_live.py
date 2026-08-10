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

_LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class _TurnState:
    conversation_id: str
    started_at: float = field(default_factory=perf_counter)
    final_segments: list[str] = field(default_factory=list)
    interim_text: str = ""
    finalize_requested: bool = False
    finalize_event: asyncio.Event = field(default_factory=asyncio.Event)


class DeepgramLiveSTTProvider:
    def __init__(
        self,
        *,
        api_key: str,
        model: str = "nova-3",
        sample_rate: int = 16000,
        endpointing_ms: int = 300,
        utterance_end_ms: int = 1000,
    ) -> None:
        self._api_key = api_key
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
            _LOGGER.warning("Resetting lingering Deepgram turn before starting %s", conversation_id)
            await self.abort_turn()
        await self._ensure_connected()
        self._active_turn = _TurnState(conversation_id=conversation_id)

    async def send_audio(self, data: bytes) -> None:
        if not data or self._active_turn is None:
            return
        await self._send_binary(data)

    async def finish_turn(self) -> TranscriptResult:
        turn = self._active_turn
        if turn is None:
            return TranscriptResult(text="", provider="deepgram-live", latency_ms=0, is_final=True)

        turn.finalize_requested = True
        try:
            await self._send_text({"type": "Finalize"})
            await asyncio.wait_for(turn.finalize_event.wait(), timeout=2.5)
        except (TimeoutError, ConnectionClosed):
            pass
        finally:
            self._active_turn = None

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
                url,
                additional_headers={"Authorization": f"Token {self._api_key}"},
                ping_interval=20,
                ping_timeout=20,
                max_size=None,
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
        except ConnectionClosed:
            return
        finally:
            if self._ws is ws:
                self._ws = None
            if self._reader_task is asyncio.current_task():
                self._reader_task = None

    def _handle_message(self, payload: dict[str, Any]) -> None:
        turn = self._active_turn
        if turn is None:
            return

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

        transcript = str(alternatives[0].get("transcript", "") or "").strip()
        if transcript:
            if payload.get("is_final"):
                if not turn.final_segments or turn.final_segments[-1] != transcript:
                    turn.final_segments.append(transcript)
            else:
                turn.interim_text = transcript

        if turn.finalize_requested and (
            payload.get("speech_final") or payload.get("from_finalize")
        ):
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
        if self._keepalive_task is not None:
            self._keepalive_task.cancel()
            self._keepalive_task = None
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        if self._ws is not None:
            try:
                await self._ws.close()
            finally:
                self._ws = None


def _is_open(connection: websockets.ClientConnection | None) -> bool:
    return connection is not None and getattr(connection, "state", None) == State.OPEN
