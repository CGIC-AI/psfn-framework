from __future__ import annotations

from hub.storage.artifacts import ArtifactStore

from pathlib import Path
import uuid

import httpx

from hub.adapters.interfaces import SynthesizedAudio, TTSProvider
from hub.adapters.bounds import ProviderLimits, bounded_request


class DeepgramTTSProvider(TTSProvider):
    def __init__(
        self,
        *,
        api_key: str,
        output_root: Path,
        model: str = "aura-2-thalia-en",
        client: httpx.AsyncClient | None = None,
        limits: ProviderLimits | None = None,
    ) -> None:
        self._api_key = api_key
        self._artifacts = ArtifactStore(output_root)
        self._output_root = self._artifacts.root
        self._model = model
        self._client = client or httpx.AsyncClient(timeout=60.0)
        self._owns_client = client is None
        self._limits = limits or ProviderLimits()

    async def synthesize(self, text: str) -> SynthesizedAudio:
        if len(text.encode("utf-8")) > self._limits.max_text_bytes:
            raise RuntimeError("Provider text limit exceeded")
        body = await bounded_request(
            self._client, "POST",
            "https://api.deepgram.com/v1/speak",
            max_bytes=self._limits.max_http_bytes,
            timeout_seconds=self._limits.max_age_seconds,
            params={
                "model": self._model,
                "encoding": "mp3",
            },
            headers={
                "Authorization": f"Token {self._api_key}",
                "Content-Type": "application/json",
            },
            json={"text": text},
        )
        output_path = self._output_root / f"{uuid.uuid4().hex}.mp3"
        self._artifacts.write_bytes(output_path, body)
        return SynthesizedAudio(
            provider="deepgram",
            audio_path=output_path,
            content_type="audio/mpeg",
        )

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
        self._artifacts.close()
