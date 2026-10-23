"""Admission at the websockets accepted-TCP connection factory boundary."""

from __future__ import annotations

import asyncio

from websockets.asyncio.server import ServerConnection
from websockets.protocol import CONNECTING


class RealtimeAdmission:
    """One fixed budget shared by pending and authenticated TCP connections.

    Factory admission is synchronous on the server's event loop. A slot is held
    from construction until connection_lost, with no authentication transfer or
    background wait_closed task. Rejected sockets create no WebSocket handler.
    """

    def __init__(self, limit: int) -> None:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 0 < limit <= 2_147_483_647:
            raise ValueError("Realtime connection limit must be a positive bounded integer")
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

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        super().connection_made(transport)
        # A previously constructed connection may reach this callback only after
        # shutdown starts. It still owns its slot and releases it on TCP close.
        if not self._admission.accepting:
            transport.abort()

    def connection_lost(self, exc: Exception | None) -> None:
        try:
            super().connection_lost(exc)
        finally:
            self._admission.connections.discard(self)
