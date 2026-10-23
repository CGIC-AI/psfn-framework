from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import time
import uuid

import httpx
import websockets
from websockets.protocol import State

from hub.adapters.bounds import ProviderLimits, ProviderLimitError, bounded_request, decode_json
from hub.adapters.provider_socket import ProviderSocketConnect
from hub.devices.realtime_output import RealtimeOutputLimits


@dataclass(slots=True)
class _ContextState:
    queue: "asyncio.Queue[bytes | None]"
    queued_bytes: int = 0
    total_bytes: int = 0
    failure: str | None = None
    finished: bool = False
    created: float = field(default_factory=time.monotonic)
    last_read: float = field(default_factory=time.monotonic)
    connection: object | None = None
    sender: asyncio.Task | None = None

    def fail(self, message: str) -> None:
        self.failure = message
        self.finished = True
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queued_bytes = 0
        self.queue.put_nowait(None)


class ElevenLabsStreamingTTS:
    def __init__(
        self, *, api_key: str, voice_id: str | None,
        model_id: str = "eleven_flash_v2_5", limits: ProviderLimits | None = None,
        websocket_url: str | None = None, http_client: httpx.AsyncClient | None = None,
        output_limits: RealtimeOutputLimits | None = None,
    ) -> None:
        self._api_key, self._voice_id, self._model_id = api_key, voice_id, model_id
        self._limits = limits or ProviderLimits()
        self._connector = ProviderSocketConnect(output_limits or RealtimeOutputLimits())
        self._websocket_url = websocket_url
        self._http_client = http_client or httpx.AsyncClient(timeout=30.0)
        self._owns_client = http_client is None
        self._ws = None
        self._reader_task: asyncio.Task | None = None
        self._close_task: asyncio.Task | None = None
        self._context_cleanups: set[asyncio.Task] = set()
        self._context_close_lock = asyncio.Lock()
        self._contexts: dict[str, _ContextState] = {}
        self._send_lock = asyncio.Lock()
        self._connect_lock = asyncio.Lock()

    async def stream_text(self, *, text_chunks: "asyncio.Queue[str | None]", context_id: str | None = None):
        ctx_id = context_id or f"ctx-{uuid.uuid4().hex}"
        self._expire_contexts()
        if not isinstance(ctx_id, str) or len(ctx_id) > 128 or ctx_id in self._contexts:
            raise RuntimeError("Provider context unavailable")
        if len(self._contexts) >= self._limits.max_contexts:
            raise ProviderLimitError("Provider context capacity exceeded")
        state = _ContextState(queue=asyncio.Queue(maxsize=self._limits.max_queued_chunks + 1))
        self._contexts[ctx_id] = state
        sender_task = None

        async def sender() -> None:
            try:
                pending = ""
                has_started = False
                text_bytes = 0
                while True:
                    item = await asyncio.wait_for(text_chunks.get(), self._limits.idle_seconds)
                    if item is None:
                        break
                    if not isinstance(item, str):
                        raise ValueError("Invalid provider text")
                    text_bytes += len(item.encode("utf-8"))
                    if text_bytes > self._limits.max_text_bytes:
                        raise ProviderLimitError("Provider text limit exceeded")
                    if state.failure:
                        return
                    pending += item
                    while True:
                        flush_text, pending = _take_flush_chunk(pending, has_started=has_started)
                        if not flush_text:
                            break
                        await self._send_json({"context_id": ctx_id, "text": flush_text, "flush": True})
                        has_started = True
                if pending.strip():
                    await self._send_json({"context_id": ctx_id, "text": pending.strip(), "flush": True})
                await self._send_json({"context_id": ctx_id, "close_context": True})
            except Exception:
                state.fail("Provider text stream failed")
                if state.connection is not None:
                    state.connection.transport.abort()

        try:
            voice_id = await asyncio.wait_for(self._resolve_voice_id(), self._limits.idle_seconds)
            if state.failure:
                raise ProviderLimitError(state.failure)
            await asyncio.wait_for(self._ensure_connected(voice_id), self._limits.idle_seconds)
            if state.failure:
                raise ProviderLimitError(state.failure)
            state.connection = self._ws
            await self._send_json({
                "context_id": ctx_id, "text": " ",
                "voice_settings": {"stability": 0.35, "similarity_boost": 0.7, "speed": 1.0},
            })
            sender_task = asyncio.create_task(sender())
            state.sender = sender_task
            while True:
                remaining = self._limits.max_age_seconds - (time.monotonic() - state.created)
                if remaining <= 0:
                    state.fail("Provider context expired")
                try:
                    chunk = await asyncio.wait_for(state.queue.get(), max(0.001, min(self._limits.idle_seconds, remaining)))
                except TimeoutError:
                    state.fail("Provider context expired")
                    raise ProviderLimitError("Provider context expired") from None
                if state.failure:
                    raise ProviderLimitError(state.failure)
                if state.connection is not None and state.connection.output.failed:
                    state.fail("Provider stream failed")
                    raise ProviderLimitError("Provider stream failed")
                if chunk is None:
                    return
                state.queued_bytes -= len(chunk)
                state.last_read = time.monotonic()
                yield chunk
        finally:
            cleanup = asyncio.create_task(self._settle_context(ctx_id, state, sender_task))
            self._context_cleanups.add(cleanup)
            cleanup.add_done_callback(self._context_cleanups.discard)
            await asyncio.shield(cleanup)

    async def _settle_context(self, ctx_id, state, sender_task) -> None:
        if sender_task is not None:
            sender_task.cancel()
            await asyncio.gather(sender_task, return_exceptions=True)
        async with self._context_close_lock:
            await self._remove_context(ctx_id, state)

    async def _remove_context(self, ctx_id, state) -> None:
        state.fail("Provider context closed")
        ws = state.connection
        current = self._contexts.get(ctx_id)
        if current is not None and current is not state:
            return
        # A provider shutdown retains the registry until its reader settles.
        if self._close_task is not None:
            return
        siblings = any(other is not state and other.connection is ws for other in self._contexts.values())
        if ws is not None and self._ws is ws:
            if siblings and _is_open(ws):
                try:
                    await asyncio.wait_for(self._send_json({"context_id": ctx_id, "close_context": True}), 1)
                except Exception:
                    ws.transport.abort()
            else:
                await ws.close()
                reader = self._reader_task
                if reader is not None:
                    await asyncio.shield(reader)
        if self._contexts.get(ctx_id) is state:
            self._contexts.pop(ctx_id)

    def _expire_contexts(self) -> None:
        now = time.monotonic()
        for ctx_id, state in list(self._contexts.items()):
            if now - state.created >= self._limits.max_age_seconds or now - state.last_read >= self._limits.idle_seconds:
                state.fail("Provider context expired")
                if state.sender is not None and not state.sender.done():
                    state.sender.cancel()
                else:
                    self._contexts.pop(ctx_id, None)

    async def aclose(self) -> None:
        if self._close_task is None:
            self._close_task = asyncio.create_task(self._settle_close())
        task = self._close_task
        try:
            await asyncio.shield(task)
        finally:
            if task.done() and self._close_task is task:
                self._close_task = None

    async def _settle_close(self) -> None:
        await self._connector.cancel_pending()
        for state in self._contexts.values():
            state.fail("Provider connection closed")
        reader = self._reader_task
        if reader is not None:
            reader.cancel()
        ws = self._ws
        if ws is not None:
            await ws.close()
        if reader is not None:
            await asyncio.gather(reader, return_exceptions=True)
        senders = [state.sender for state in self._contexts.values() if state.sender is not None]
        for sender in senders:
            sender.cancel()
        if senders:
            await asyncio.gather(*senders, return_exceptions=True)
        if self._context_cleanups:
            await asyncio.gather(*self._context_cleanups, return_exceptions=True)
        self._contexts.clear()
        if self._ws is ws:
            self._ws = None
        self._reader_task = None
        if self._owns_client:
            await self._http_client.aclose()

    async def _resolve_voice_id(self) -> str:
        if self._voice_id:
            return self._voice_id
        body = await bounded_request(self._http_client, "GET", "https://api.elevenlabs.io/v1/voices",
                                     max_bytes=self._limits.max_json_bytes, headers={"xi-api-key": self._api_key})
        voices = decode_json(body).get("voices")
        if not isinstance(voices, list) or not voices or not all(isinstance(voice, dict) for voice in voices):
            raise RuntimeError("Provider returned invalid voice list")
        selected = next((voice for voice in voices if voice.get("category") == "premade"), voices[0])
        voice_id = selected.get("voice_id")
        if not isinstance(voice_id, str) or not voice_id or len(voice_id) > 128:
            raise RuntimeError("Provider returned invalid voice identity")
        self._voice_id = voice_id
        return voice_id

    async def _ensure_connected(self, voice_id: str) -> None:
        if self._close_task is not None:
            await asyncio.shield(self._close_task)
        generation = self._connector.generation
        async with self._connect_lock:
            if _is_open(self._ws):
                return
            if self._reader_task is not None:
                await asyncio.shield(self._reader_task)
            uri = (f"wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input"
                   f"?model_id={self._model_id}&output_format=mp3_44100_128"
                   "&inactivity_timeout=180&auto_mode=true")
            self._ws = await self._connector.connect(
                self._websocket_url or uri, generation=generation, additional_headers={"xi-api-key": self._api_key},
                ping_interval=20, ping_timeout=20, max_size=self._limits.max_ws_message_bytes,
                max_queue=self._limits.max_ws_queue, compression=None, close_timeout=2,
            )
            self._reader_task = asyncio.create_task(self._reader_loop(self._ws))

    async def _reader_loop(self, ws) -> None:
        iterator = ws.__aiter__()
        try:
            while True:
                self._expire_contexts()
                try:
                    raw = await asyncio.wait_for(anext(iterator), min(1, self._limits.idle_seconds))
                except TimeoutError:
                    continue
                if not isinstance(raw, str):
                    raise ValueError("Provider stream invalid")
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise ValueError("Provider stream invalid")
                context = payload.get("contextId")
                if not isinstance(context, str):
                    continue
                state = self._contexts.get(context)
                if state is None or state.finished:
                    continue
                audio_b64 = payload.get("audio")
                if audio_b64:
                    if not isinstance(audio_b64, str):
                        state.fail("Provider audio invalid")
                        continue
                    padding = len(audio_b64) - len(audio_b64.rstrip("="))
                    predicted = ((len(audio_b64) + 3) // 4) * 3 - padding
                    if predicted > self._limits.max_queued_bytes or state.total_bytes + predicted > self._limits.max_audio_bytes:
                        state.fail("Provider audio limit exceeded")
                        continue
                    audio = _decode_audio(audio_b64)
                    if (state.queue.qsize() >= self._limits.max_queued_chunks
                            or state.queued_bytes + len(audio) > self._limits.max_queued_bytes
                            or state.total_bytes + len(audio) > self._limits.max_audio_bytes):
                        state.fail("Provider audio limit exceeded")
                        continue
                    state.queued_bytes += len(audio)
                    state.total_bytes += len(audio)
                    state.queue.put_nowait(audio)
                if payload.get("isFinal") or payload.get("is_final"):
                    state.finished = True
                    state.queue.put_nowait(None)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass  # Every affected consumer receives a static failure below.
        finally:
            affected = [(ctx_id, state) for ctx_id, state in self._contexts.items() if state.connection is ws]
            for _, state in affected:
                if not state.finished or ws.output.failed:
                    state.fail("Provider stream failed")
                if state.sender is not None:
                    state.sender.cancel()
            await ws.close()
            senders = [state.sender for _, state in affected if state.sender is not None]
            if senders:
                await asyncio.gather(*senders, return_exceptions=True)
            for ctx_id, state in affected:
                if self._contexts.get(ctx_id) is state:
                    self._contexts.pop(ctx_id)
            if self._ws is ws:
                self._ws = None
            if self._reader_task is asyncio.current_task():
                self._reader_task = None

    async def _send_json(self, payload: dict[str, object]) -> None:
        async with self._send_lock:
            if self._ws is None:
                raise RuntimeError("Provider connection unavailable")
            try:
                await self._ws.send(json.dumps(payload))
            except websockets.ConnectionClosed:
                raise RuntimeError("Provider output unavailable") from None


def _decode_audio(value: str) -> bytes:
    import base64

    return base64.b64decode(value, validate=True)


def _is_open(connection: websockets.ClientConnection | None) -> bool:
    return connection is not None and getattr(connection, "state", None) == State.OPEN


def _take_flush_chunk(
    chunk: str,
    *,
    has_started: bool,
    first_words: int = 2,
    first_chars: int = 18,
    soft_limit: int = 64,
    hard_limit: int = 120,
) -> tuple[str | None, str]:
    if not chunk:
        return None, chunk

    boundary = _sentence_boundary(chunk)
    trailing_boundary = _trailing_whitespace_boundary(chunk)
    if boundary is None and trailing_boundary is not None and not has_started and _should_start_playback(
        chunk,
        first_words=first_words,
        first_chars=first_chars,
    ):
        boundary = trailing_boundary
    if boundary is None and trailing_boundary is not None and len(chunk.strip()) >= soft_limit:
        boundary = trailing_boundary
    if boundary is None and len(chunk.strip()) >= hard_limit:
        boundary = len(chunk)
    if boundary is None:
        return None, chunk

    flush_text = chunk[:boundary].strip()
    remainder = chunk[boundary:].lstrip()
    if not flush_text:
        return None, remainder
    return flush_text, remainder


def _should_flush(
    chunk: str,
    *,
    has_started: bool = False,
    first_words: int = 2,
    first_chars: int = 18,
    soft_limit: int = 64,
    hard_limit: int = 120,
) -> bool:
    flush_text, _ = _take_flush_chunk(
        chunk,
        has_started=has_started,
        first_words=first_words,
        first_chars=first_chars,
        soft_limit=soft_limit,
        hard_limit=hard_limit,
    )
    return flush_text is not None


def _sentence_boundary(chunk: str) -> int | None:
    for index, char in enumerate(chunk):
        if char not in ".?!\n":
            continue
        next_index = index + 1
        if next_index >= len(chunk) or chunk[next_index].isspace():
            return next_index
    return None


def _trailing_whitespace_boundary(chunk: str) -> int | None:
    if not chunk or not chunk[-1].isspace():
        return None
    return len(chunk)


def _should_start_playback(chunk: str, *, first_words: int, first_chars: int) -> bool:
    stripped = chunk.strip()
    if not stripped:
        return False
    if len(stripped) >= first_chars:
        return True
    return len(stripped.split()) >= first_words
