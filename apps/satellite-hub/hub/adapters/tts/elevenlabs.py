from __future__ import annotations

from hub.storage.artifacts import ArtifactStore

from pathlib import Path
import uuid

import httpx

from hub.adapters.interfaces import SynthesizedAudio, TTSProvider
from hub.adapters.bounds import ProviderLimits, bounded_request, decode_json


class ElevenLabsTTSProvider(TTSProvider):
    def __init__(
        self,
        *,
        api_key: str,
        output_root: Path,
        voice_id: str | None = None,
        model_id: str = "eleven_multilingual_v2",
        client: httpx.AsyncClient | None = None,
        limits: ProviderLimits | None = None,
    ) -> None:
        self._api_key = api_key
        self._artifacts = ArtifactStore(output_root)
        self._output_root = self._artifacts.root
        self._voice_id = voice_id
        self._model_id = model_id
        self._client = client or httpx.AsyncClient(timeout=60.0)
        self._owns_client = client is None
        self._limits = limits or ProviderLimits()

    async def synthesize(self, text: str) -> SynthesizedAudio:
        if len(text.encode("utf-8")) > self._limits.max_text_bytes:
            raise RuntimeError("Provider text limit exceeded")
        voice_id = await self._resolve_voice_id()
        body = await bounded_request(
            self._client, "POST",
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            max_bytes=self._limits.max_http_bytes,
            timeout_seconds=self._limits.max_age_seconds,
            params={"output_format": "mp3_44100_128"},
            headers={
                "xi-api-key": self._api_key,
                "Accept": "audio/mpeg",
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": self._model_id,
            },
        )
        filename = f"{uuid.uuid4().hex}.mp3"
        output_path = self._output_root / filename
        self._artifacts.write_bytes(output_path, body)
        return SynthesizedAudio(
            provider="elevenlabs",
            audio_path=output_path,
            content_type="audio/mpeg",
        )

    async def _resolve_voice_id(self) -> str:
        if self._voice_id:
            return self._voice_id

        body = await bounded_request(
            self._client, "GET",
            "https://api.elevenlabs.io/v1/voices",
            max_bytes=self._limits.max_json_bytes,
            timeout_seconds=self._limits.max_age_seconds,
            headers={"xi-api-key": self._api_key},
        )
        payload = decode_json(body)
        voices = payload.get("voices", [])
        if not voices:
            raise RuntimeError("ElevenLabs returned no voices for this account")

        premade = next((voice for voice in voices if voice.get("category") == "premade"), voices[0])
        voice_id = premade.get("voice_id")
        if not voice_id:
            raise RuntimeError("ElevenLabs voice list did not include a voice_id")
        self._voice_id = voice_id
        return voice_id

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
        self._artifacts.close()
