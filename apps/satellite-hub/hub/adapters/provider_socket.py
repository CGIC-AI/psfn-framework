"""Provider connection factory: no data or automatic control output bypasses ownership."""

from __future__ import annotations

import asyncio

import websockets
from websockets.asyncio.client import ClientConnection

from hub.devices.realtime_output import RealtimeOutput, RealtimeOutputLimits


class ProviderSocketConnect:
    """Own a pending handshake and its TCP connection until cancellation settles."""

    def __init__(self, output_limits: RealtimeOutputLimits) -> None:
        self.output_limits = output_limits
        self.generation = 0
        self.task: asyncio.Task | None = None
        self.connection: ProviderClientConnection | None = None

    def create_connection(self, *args, **kwargs):
        self.connection = ProviderClientConnection(*args, output_limits=self.output_limits, **kwargs)
        return self.connection

    async def connect(self, uri, *, generation: int, **kwargs):
        if generation != self.generation:
            raise RuntimeError("Provider connection closed")

        async def opening():
            return await websockets.connect(uri, create_connection=self.create_connection, **kwargs)

        task = asyncio.create_task(opening())
        self.task = task
        try:
            return await task
        except Exception:
            raise RuntimeError("Provider connection failed") from None
        finally:
            if self.task is task:
                self.task = None
                self.connection = None

    async def cancel_pending(self) -> None:
        self.generation += 1
        task, connection = self.task, self.connection
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            # connect() aborts on cancellation; await the terminal notification.
            if connection is not None and getattr(connection, "transport", None) is not None:
                connection.transport.abort()
                await connection.wait_closed()


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
