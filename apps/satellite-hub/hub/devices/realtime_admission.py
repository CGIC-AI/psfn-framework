"""Admission at the websockets accepted-TCP connection factory boundary."""

from __future__ import annotations

import asyncio

from websockets.asyncio.server import ServerConnection
from websockets.protocol import CONNECTING

from hub.devices.realtime_output import RealtimeOutput, RealtimeOutputLimits


class RealtimeAdmission:
    """One fixed budget shared by pending and authenticated TCP connections.

    Factory admission is synchronous on the server's event loop. A slot is held
    from construction until connection_lost, with no authentication transfer or
    background wait_closed task. Rejected sockets create no WebSocket handler.
    """

    def __init__(self, limit: int, output_limits: RealtimeOutputLimits | None = None) -> None:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 0 < limit <= 2_147_483_647:
            raise ValueError("Realtime connection limit must be a positive bounded integer")
        self.output_limits = output_limits or RealtimeOutputLimits()
        self.limit = limit
        self.connections: set[ServerConnection] = set()
        self.accepting = False

    def create_connection(self, protocol, server, **kwargs):
        if not self.accepting or len(self.connections) >= self.limit:
            return _RejectedConnection()
        connection = _AdmittedConnection(protocol, server, admission=self, **kwargs)
        self.connections.add(connection)
        return connection

    def stop(self) -> None:
        self.accepting = False
        for connection in tuple(self.connections):
            if connection.protocol.state is CONNECTING:
                transport = getattr(connection, "transport", None)
                if transport is not None:
                    transport.abort()


class _RejectedConnection(asyncio.Protocol):
    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        transport.abort()


class _AdmittedConnection(ServerConnection):
    def __init__(self, *args, admission: RealtimeAdmission, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._admission = admission
        self.output = RealtimeOutput(self, admission.output_limits)
        self._tcp_closed = False

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        super().connection_made(transport)
        # A previously constructed connection may reach this callback only after
        # shutdown starts. It still owns its slot and releases it on TCP close.
        if not self._admission.accepting:
            transport.abort()

    def process_event(self, event) -> None:
        if not self.output.failed:
            super().process_event(event)

    async def recv(self, decode: bool | None = None) -> str | bytes:
        message = await super().recv(decode)
        # recv() may already have queued a message when synchronous automatic
        # control output fails. Never hand it to the application after failure.
        if self.output.failed:
            await self.wait_closed()
            raise self.protocol.close_exc
        return message

    def send_data(self) -> None:
        self.output.before_write()
        try:
            super().send_data()
        except (OSError, RuntimeError):
            self.output.fail()
            raise
        self.output.flushed()

    def connection_lost(self, exc: Exception | None) -> None:
        if self._tcp_closed:
            return
        self._tcp_closed = True
        try:
            super().connection_lost(exc)
        finally:
            self.output.closed()
            self._admission.connections.discard(self)
