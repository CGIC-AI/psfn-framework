from __future__ import annotations

from pathlib import Path
import uuid

import httpx

from hub.adapters.interfaces import SynthesizedAudio, TTSProvider
from hub.util import ensure_directory


class DeepgramTTSProvider(TTSProvider):
    def __init__(
        self,
        *,
        api_key: str,
        output_root: Path,
        model: str = "aura-2-thalia-en",
    ) -> None:
        self._api_key = api_key
        self._output_root = ensure_directory(output_root)
        self._model = model
        self._client = httpx.AsyncClient(timeout=60.0)

    async def synthesize(self, text: str) -> SynthesizedAudio:
        response = await self._client.post(
            "https://api.deepgram.com/v1/speak",
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
        response.raise_for_status()
        output_path = self._output_root / f"{uuid.uuid4().hex}.mp3"
        output_path.write_bytes(response.content)
        return SynthesizedAudio(
            provider="deepgram",
            audio_path=output_path,
            content_type="audio/mpeg",
        )

    async def aclose(self) -> None:
        await self._client.aclose()
