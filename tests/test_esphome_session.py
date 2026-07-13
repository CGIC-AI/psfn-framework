from __future__ import annotations

import asyncio

import pytest

from hub.config import ESPHomeTarget
from hub.devices.esphome_session import ESPHomeSession


class _FakeClient:
    def __init__(self, *args, **kwargs) -> None:
        self.on_stop = None
        self.disconnected = False

    async def connect(self, *, on_stop, login: bool) -> None:
        assert login is True
        self.on_stop = on_stop

    async def disconnect(self, *, force: bool) -> None:
        assert force is True
        self.disconnected = True


@pytest.mark.anyio
async def test_session_reports_native_api_disconnect(monkeypatch) -> None:
    monkeypatch.setattr("hub.devices.esphome_session.APIClient", _FakeClient)
    session = ESPHomeSession(ESPHomeTarget(host="device.local"))

    async with session:
        client = session.client
        waiter = asyncio.create_task(session.wait_disconnected())
        assert client.on_stop is not None
        await client.on_stop(False)
        await asyncio.wait_for(waiter, timeout=0.1)

    assert client.disconnected is True
