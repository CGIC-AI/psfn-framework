from __future__ import annotations

from hub.adapters.interfaces import STTProvider, TranscriptResult


class ElevenLabsSTTProvider(STTProvider):
    async def transcribe(self, pcm_audio: bytes) -> TranscriptResult:
        raise NotImplementedError("ElevenLabs realtime STT is planned for Phase 3")
