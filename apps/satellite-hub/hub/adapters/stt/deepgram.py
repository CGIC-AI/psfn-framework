from __future__ import annotations

from time import perf_counter

import httpx

from hub.adapters.interfaces import STTProvider, TranscriptResult
from hub.adapters.bounds import ProviderLimits, bounded_request, decode_json


class DeepgramSTTProvider(STTProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str = "nova-3",
        client: httpx.AsyncClient | None = None,
        limits: ProviderLimits | None = None,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._client = client or httpx.AsyncClient(timeout=60.0)
        self._owns_client = client is None
        self._limits = limits or ProviderLimits()

    async def transcribe(self, pcm_audio: bytes) -> TranscriptResult:
        if len(pcm_audio) > self._limits.max_audio_bytes:
            raise RuntimeError("Provider audio limit exceeded")
        started = perf_counter()
        body = await bounded_request(
            self._client, "POST",
            "https://api.deepgram.com/v1/listen",
            max_bytes=self._limits.max_json_bytes,
            timeout_seconds=self._limits.max_age_seconds,
            params={
                "model": self._model,
                "smart_format": "true",
            },
            headers={
                "Authorization": f"Token {self._api_key}",
                "Content-Type": "audio/wav",
            },
            content=pcm_audio,
        )
        payload = decode_json(body)
        transcript = (
            payload.get("results", {})
            .get("channels", [{}])[0]
            .get("alternatives", [{}])[0]
            .get("transcript", "")
            .strip()
        )
        if len(transcript.encode("utf-8")) > self._limits.max_text_bytes:
            raise RuntimeError("Provider transcript limit exceeded")
        return TranscriptResult(
            text=transcript,
            provider="deepgram",
            latency_ms=int((perf_counter() - started) * 1000),
            is_final=True,
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
