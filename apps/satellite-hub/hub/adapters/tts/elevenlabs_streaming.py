from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import uuid

import httpx
import websockets
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State


@dataclass(slots=True)
class _ContextState:
    queue: "asyncio.Queue[bytes | None]"


class ElevenLabsStreamingTTS:
    def __init__(
        self,
        *,
        api_key: str,
        voice_id: str | None,
        model_id: str = "eleven_flash_v2_5",
    ) -> None:
        self._api_key = api_key
        self._voice_id = voice_id
        self._model_id = model_id
        self._http_client = httpx.AsyncClient(timeout=30.0)
        self._ws: websockets.ClientConnection | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._contexts: dict[str, _ContextState] = {}
        self._send_lock = asyncio.Lock()

    async def stream_text(
        self,
        *,
        text_chunks: "asyncio.Queue[str | None]",
        context_id: str | None = None,
    ):
        voice_id = await self._resolve_voice_id()
        await self._ensure_connected(voice_id)

        ctx_id = context_id or f"ctx-{uuid.uuid4().hex}"
        state = _ContextState(queue=asyncio.Queue())
        self._contexts[ctx_id] = state

        await self._send_json(
            {
                "context_id": ctx_id,
                "text": " ",
                "voice_settings": {
                    "stability": 0.35,
                    "similarity_boost": 0.7,
                    "speed": 1.0,
                },
            }
        )

        async def _sender() -> None:
            try:
                pending = ""
                has_started = False
                while True:
                    item = await text_chunks.get()
                    if item is None:
                        break
                    if not item:
                        continue
                    pending += item
                    while True:
                        flush_text, pending = _take_flush_chunk(pending, has_started=has_started)
                        if not flush_text:
                            break
                        await self._send_json(
                            {
                                "context_id": ctx_id,
                                "text": flush_text,
                                "flush": True,
                            }
                        )
                        has_started = True

                final_text = pending.strip()
                if final_text:
                    await self._send_json(
                        {
                            "context_id": ctx_id,
                            "text": final_text,
                            "flush": True,
                        }
                    )
                await self._send_json({"context_id": ctx_id, "close_context": True})
            except Exception:
                await state.queue.put(None)
                raise

        sender_task = asyncio.create_task(_sender())

        try:
            while True:
                chunk = await state.queue.get()
                if chunk is None:
                    break
                yield chunk
        finally:
            sender_task.cancel()
            self._contexts.pop(ctx_id, None)

    async def aclose(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        if self._ws is not None:
            try:
                await self._send_json({"close_socket": True})
            except Exception:
                pass
            await self._ws.close()
            self._ws = None
        await self._http_client.aclose()
        for state in self._contexts.values():
            await state.queue.put(None)
        self._contexts.clear()

    async def _resolve_voice_id(self) -> str:
        if self._voice_id:
            return self._voice_id
        response = await self._http_client.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": self._api_key},
        )
        response.raise_for_status()
        payload = response.json()
        voices = payload.get("voices", [])
        if not voices:
            raise RuntimeError("ElevenLabs returned no voices for this account")
        premade = next((voice for voice in voices if voice.get("category") == "premade"), voices[0])
        voice_id = premade.get("voice_id")
        if not voice_id:
            raise RuntimeError("ElevenLabs voice list did not include a voice_id")
        self._voice_id = voice_id
        return voice_id

    async def _ensure_connected(self, voice_id: str) -> None:
        if _is_open(self._ws):
            return
        uri = (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input"
            f"?model_id={self._model_id}"
            "&output_format=mp3_44100_128"
            "&inactivity_timeout=180"
            "&auto_mode=true"
        )
        self._ws = await websockets.connect(
            uri,
            additional_headers={"xi-api-key": self._api_key},
            ping_interval=20,
            ping_timeout=20,
            max_size=None,
        )
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def _reader_loop(self) -> None:
        try:
            assert self._ws is not None
            async for raw_message in self._ws:
                if isinstance(raw_message, bytes):
                    continue
                payload = json.loads(raw_message)
                context_id = payload.get("contextId")
                if not context_id:
                    continue
                state = self._contexts.get(context_id)
                if state is None:
                    continue
                audio_b64 = payload.get("audio")
                if audio_b64:
                    await state.queue.put(_decode_audio(audio_b64))
                if payload.get("isFinal") or payload.get("is_final"):
                    await state.queue.put(None)
        except asyncio.CancelledError:
            return
        except ConnectionClosed:
            return
        finally:
            self._ws = None
            for state in self._contexts.values():
                await state.queue.put(None)

    async def _send_json(self, payload: dict[str, object]) -> None:
        async with self._send_lock:
            assert self._ws is not None
            await self._ws.send(json.dumps(payload))


def _decode_audio(value: str) -> bytes:
    import base64

    return base64.b64decode(value)


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
