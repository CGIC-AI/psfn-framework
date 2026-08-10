from __future__ import annotations

from typing import Iterable

from hub.adapters.interfaces import SynthesizedAudio, TTSProvider


class FallbackTTSProvider(TTSProvider):
    def __init__(self, providers: Iterable[TTSProvider]) -> None:
        self._providers = list(providers)

    async def synthesize(self, text: str) -> SynthesizedAudio:
        last_error: Exception | None = None
        for provider in self._providers:
            try:
                return await provider.synthesize(text)
            except Exception as exc:  # pragma: no cover - network/provider dependent
                last_error = exc
        if last_error is None:
            raise RuntimeError("No TTS providers configured")
        raise last_error

    async def aclose(self) -> None:
        for provider in self._providers:
            close = getattr(provider, "aclose", None)
            if close is not None:
                await close()
