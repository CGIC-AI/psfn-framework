from __future__ import annotations

from pathlib import Path
import uuid

import httpx

from hub.adapters.interfaces import SynthesizedAudio, TTSProvider
from hub.util import ensure_directory


class ElevenLabsTTSProvider(TTSProvider):
    def __init__(
        self,
        *,
        api_key: str,
        output_root: Path,
        voice_id: str | None = None,
        model_id: str = "eleven_multilingual_v2",
    ) -> None:
        self._api_key = api_key
        self._output_root = ensure_directory(output_root)
        self._voice_id = voice_id
        self._model_id = model_id
        self._client = httpx.AsyncClient(timeout=60.0)

    async def synthesize(self, text: str) -> SynthesizedAudio:
        voice_id = await self._resolve_voice_id()
        response = await self._client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
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
        response.raise_for_status()
        filename = f"{uuid.uuid4().hex}.mp3"
        output_path = self._output_root / filename
        output_path.write_bytes(response.content)
        return SynthesizedAudio(
            provider="elevenlabs",
            audio_path=output_path,
            content_type="audio/mpeg",
        )

    async def _resolve_voice_id(self) -> str:
        if self._voice_id:
            return self._voice_id

        response = await self._client.get(
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

    async def aclose(self) -> None:
        await self._client.aclose()
