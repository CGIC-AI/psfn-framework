from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class ESPHomeTarget:
    host: str
    port: int = 6053
    password: str | None = None
    noise_psk: str | None = None
    expected_name: str | None = None
    client_info: str = "psfn-satellite-hub"
    timezone: str = "America/New_York"


@dataclass(slots=True)
class RealtimeTarget:
    bind_host: str = "0.0.0.0"
    port: int = 8787
    public_host: str | None = None
