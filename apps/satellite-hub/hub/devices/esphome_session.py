from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from aioesphomeapi import APIClient
from aioesphomeapi.model import EntityInfo, EntityState, UserService

from hub.config import ESPHomeTarget


@dataclass(slots=True)
class ProbeSnapshot:
    device_info: Any
    entities: list[EntityInfo]
    services: list[UserService]
    state_updates: list[dict[str, Any]]


class ESPHomeSession:
    def __init__(self, target: ESPHomeTarget) -> None:
        self._target = target
        self._client: APIClient | None = None
        self._disconnected = asyncio.Event()

    async def __aenter__(self) -> "ESPHomeSession":
        self._client = APIClient(
            self._target.host,
            self._target.port,
            self._target.password,
            client_info=self._target.client_info,
            noise_psk=self._target.noise_psk,
            expected_name=self._target.expected_name,
            timezone=self._target.timezone,
        )
        self._disconnected.clear()
        await self._client.connect(on_stop=self._handle_stop, login=True)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._client is not None:
            await self._client.disconnect(force=True)
            self._client = None

    @property
    def client(self) -> APIClient:
        if self._client is None:
            raise RuntimeError("ESPHome session is not connected")
        return self._client

    async def device_info(self) -> Any:
        return await self.client.device_info()

    async def list_entities_services(self) -> tuple[list[EntityInfo], list[UserService]]:
        return await self.client.list_entities_services()

    def subscribe_states(self, on_state: Callable[[EntityState], None]) -> None:
        self.client.subscribe_states(on_state)

    def subscribe_voice_assistant(self, **kwargs: Any):
        return self.client.subscribe_voice_assistant(**kwargs)

    async def wait_disconnected(self) -> None:
        """Wait until the native API connection is lost."""
        await self._disconnected.wait()

    async def _handle_stop(self, expected_disconnect: bool) -> None:
        del expected_disconnect
        self._disconnected.set()
