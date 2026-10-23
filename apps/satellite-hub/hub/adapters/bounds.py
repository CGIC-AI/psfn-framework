from __future__ import annotations

from dataclasses import dataclass, fields
import asyncio
import json
import math


class ProviderLimitError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ProviderLimits:
    max_http_bytes: int = 16 * 1024 * 1024
    max_json_bytes: int = 256 * 1024
    max_ws_message_bytes: int = 1024 * 1024
    max_ws_queue: int = 4
    max_contexts: int = 16
    max_queued_chunks: int = 64
    max_queued_bytes: int = 1024 * 1024
    max_audio_bytes: int = 16 * 1024 * 1024
    max_text_bytes: int = 65536
    max_segments: int = 128
    idle_seconds: float = 15
    max_age_seconds: float = 120

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if not math.isfinite(value) or value <= 0 or (not field.name.endswith("seconds") and not isinstance(value, int)):
                raise ValueError("Provider limits must be positive finite capacities")


async def response_chunks(response, *, max_bytes: int):
    if response.headers.get("Content-Encoding", "identity").lower() not in {"", "identity"}:
        raise ProviderLimitError("Provider response encoding rejected")
    content_length = response.headers.get("Content-Length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError:
            raise ProviderLimitError("Provider response limit exceeded") from None
        if declared < 0 or declared > max_bytes:
            raise ProviderLimitError("Provider response limit exceeded")
    total = 0
    iterator = response.aiter_bytes() if response.is_stream_consumed else response.aiter_raw()
    async for chunk in iterator:
        total += len(chunk)
        if total > max_bytes:
            raise ProviderLimitError("Provider response limit exceeded")
        yield chunk


async def bounded_request(client, method: str, url: str, *, max_bytes: int, timeout_seconds: float = 120, **kwargs) -> bytes:
    headers = dict(kwargs.pop("headers", {}) or {})
    headers["Accept-Encoding"] = "identity"
    async with asyncio.timeout(timeout_seconds), client.stream(method, url, headers=headers, **kwargs) as response:
        if response.status_code >= 400:
            raise RuntimeError(f"Provider request failed ({response.status_code})")
        body = bytearray()
        async for chunk in response_chunks(response, max_bytes=max_bytes):
            body.extend(chunk)
        return bytes(body)


def decode_json(body: bytes) -> dict:
    try:
        result = json.loads(body)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, UnicodeError):
        raise RuntimeError("Provider returned invalid JSON") from None


async def bounded_lines(response, *, max_bytes: int, max_line_bytes: int):
    pending = bytearray()
    async for chunk in response_chunks(response, max_bytes=max_bytes):
        offset = 0
        while offset < len(chunk):
            end = chunk.find(b"\n", offset)
            piece_end = len(chunk) if end < 0 else end
            if len(pending) + piece_end - offset > max_line_bytes:
                raise ProviderLimitError("Provider response limit exceeded")
            pending.extend(chunk[offset:piece_end])
            if end < 0:
                break
            try:
                yield pending.decode("utf-8").removesuffix("\r")
            except UnicodeError:
                raise RuntimeError("Provider returned invalid stream data") from None
            pending.clear()
            offset = end + 1
    if pending:
        try:
            yield pending.decode("utf-8").removesuffix("\r")
        except UnicodeError:
            raise RuntimeError("Provider returned invalid stream data") from None
