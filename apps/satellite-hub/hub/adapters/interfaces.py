from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(slots=True)
class TranscriptResult:
    text: str
    provider: str
    latency_ms: int
    is_final: bool = True


@dataclass(slots=True)
class AgentReply:
    text: str
    history: list[dict[str, str]]


@dataclass(slots=True)
class SynthesizedAudio:
    provider: str
    audio_path: Path
    content_type: str


class STTProvider(Protocol):
    async def transcribe(self, pcm_audio: bytes) -> TranscriptResult: ...


class AgentProvider(Protocol):
    async def reply(
        self,
        *,
        text: str,
        conversation_id: str,
        history: list[dict[str, str]],
    ) -> AgentReply: ...


class TTSProvider(Protocol):
    async def synthesize(self, text: str) -> SynthesizedAudio: ...
