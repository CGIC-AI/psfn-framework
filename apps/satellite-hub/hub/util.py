from __future__ import annotations

from dataclasses import fields, is_dataclass
from datetime import datetime, timezone
from enum import Enum
import json
from pathlib import Path
from typing import Any


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def ensure_directory(path: Path) -> Path:
    from hub.storage.artifacts import _directory
    import os
    descriptor = _directory(path, create=True)
    try:
        os.fchmod(descriptor, 0o700)
    finally:
        os.close(descriptor)
    return path


def to_jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return {field.name: to_jsonable(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return isoformat_z(value)
    if isinstance(value, Enum):
        return value.name
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    return value


def write_json(path: Path, data: Any) -> None:
    from hub.storage.artifacts import ArtifactStore
    ArtifactStore.write_private_bytes(path, (json.dumps(to_jsonable(data), indent=2, sort_keys=True) + "\n").encode("utf-8"))
