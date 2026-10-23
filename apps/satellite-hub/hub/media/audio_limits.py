from __future__ import annotations

from dataclasses import dataclass, fields
import math
import os


@dataclass(frozen=True, slots=True)
class AudioLimits:
    max_requests: int = 16
    max_header_bytes: int = 8192
    header_timeout_seconds: float = 5.0
    io_timeout_seconds: float = 5.0
    response_timeout_seconds: float = 120.0
    max_response_bytes: int = 16 * 1024 * 1024
    max_files: int = 128
    file_ttl_seconds: float = 300.0
    max_streams: int = 16
    max_stream_chunks: int = 64
    max_stream_bytes: int = 1024 * 1024
    stream_max_age_seconds: float = 120.0
    stream_idle_seconds: float = 15.0

    def __post_init__(self) -> None:
        for field in fields(self):
            value = getattr(self, field.name)
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Audio limits must be positive and finite")
            if not field.name.endswith("seconds") and (not isinstance(value, int) or isinstance(value, bool)):
                raise ValueError("Audio capacities must be integers")

    @classmethod
    def from_env(cls) -> AudioLimits:
        values = {}
        for field in fields(cls):
            raw = os.getenv(f"AUDIO_{field.name.upper()}")
            if raw is not None:
                try:
                    values[field.name] = float(raw) if field.name.endswith("seconds") else int(raw)
                except ValueError:
                    raise ValueError(f"Invalid AUDIO_{field.name.upper()}") from None
        return cls(**values)
