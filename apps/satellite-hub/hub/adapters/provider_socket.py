"""Provider connection factory: no data or automatic control output bypasses ownership."""

from __future__ import annotations

import asyncio

from websockets.asyncio.client import ClientConnection

from hub.devices.realtime_output import RealtimeOutput, RealtimeOutputLimits


class ProviderClientConnection(ClientConnection):
    def __init__(self, *args, output_limits: RealtimeOutputLimits, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.output = RealtimeOutput(self, output_limits)
        self._tcp_closed = False

    def process_event(self, event) -> None:
        if not self.output.failed:
            super().process_event(event)

    async def recv(self, decode: bool | None = None) -> str | bytes:
        message = await super().recv(decode)
        if self.output.failed:
            await self.wait_closed()
            raise self.protocol.close_exc
        return message

    async def send(self, message, text: bool | None = None) -> None:
        try:
            await super().send(message, text=text)
        except asyncio.CancelledError:
            self.output.fail()
            raise

    def send_data(self) -> None:
        self.output.before_write()
        try:
            super().send_data()
        except (OSError, RuntimeError):
            self.output.fail()
            raise OSError("Provider output unavailable") from None
        self.output.flushed()

    def connection_lost(self, exc: Exception | None) -> None:
        if self._tcp_closed:
            return
        self._tcp_closed = True
        try:
            # Never retain transport exceptions containing upstream content.
            super().connection_lost(None if exc is None else OSError("Provider transport failed"))
        finally:
            self.output.closed()
