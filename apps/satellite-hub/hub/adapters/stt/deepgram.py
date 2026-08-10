from __future__ import annotations

from time import perf_counter

import httpx

from hub.adapters.interfaces import STTProvider, TranscriptResult


class DeepgramSTTProvider(STTProvider):
    def __init__(
        self,
        *,
        api_key: str,
        model: str = "nova-3",
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._client = httpx.AsyncClient(timeout=60.0)

    async def transcribe(self, pcm_audio: bytes) -> TranscriptResult:
        started = perf_counter()
        response = await self._client.post(
            "https://api.deepgram.com/v1/listen",
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
        response.raise_for_status()
        payload = response.json()
        transcript = (
            payload.get("results", {})
            .get("channels", [{}])[0]
            .get("alternatives", [{}])[0]
            .get("transcript", "")
            .strip()
        )
        return TranscriptResult(
            text=transcript,
            provider="deepgram",
            latency_ms=int((perf_counter() - started) * 1000),
            is_final=True,
        )

    async def aclose(self) -> None:
        await self._client.aclose()
