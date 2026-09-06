"""Profile-owned adapter configuration; credentials remain in Hermes MCP config."""

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from uuid import UUID

HERMES_REVISION = "5bd439d3ed4ae5f099857813383389dcd0ab4369"
CONFIG_FILE = "psfn-memory.json"


@dataclass(frozen=True)
class Config:
    body_id: str
    companion_id: str
    mcp_server: str = "psfn"
    platforms: tuple[str, ...] = ("cli",)
    retry_batch_size: int = 20
    retry_interval_seconds: float = 30.0
    shutdown_timeout_seconds: float = 5.0

    @classmethod
    def parse(cls, values: dict) -> "Config":
        if not isinstance(values, dict) or set(values) - set(cls.__dataclass_fields__):
            raise ValueError("Invalid PSFN provider config fields")
        result = cls(**values)
        for key in ("body_id", "companion_id", "mcp_server"):
            value = getattr(result, key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"PSFN {key} must be a nonempty string")
        UUID(result.companion_id)
        if not result.mcp_server.replace("_", "").isalnum():
            raise ValueError("PSFN mcp_server must contain only letters, digits or underscores")
        if (
            not isinstance(result.platforms, (list, tuple))
            or not result.platforms
            or any(not isinstance(p, str) or not p.strip() for p in result.platforms)
            or any(p in {"subagent", "cron", "tool", "flush"} for p in result.platforms)
        ):
            raise ValueError("PSFN platforms must name interactive surfaces only")
        if type(result.retry_batch_size) is not int or result.retry_batch_size < 1:
            raise ValueError("PSFN retry_batch_size must be a positive integer")
        for key in ("retry_interval_seconds", "shutdown_timeout_seconds"):
            value = getattr(result, key)
            if type(value) not in (int, float) or not 0 < value < float("inf"):
                raise ValueError(f"PSFN {key} must be finite and positive")
        return result

    @classmethod
    def load(cls, hermes_home: str | Path) -> "Config":
        return cls.parse(json.loads((Path(hermes_home) / CONFIG_FILE).read_text()))

    def save(self, hermes_home: str | Path) -> None:
        path = Path(hermes_home) / CONFIG_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(asdict(self), indent=2) + "\n")
        temporary.replace(path)
