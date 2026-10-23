from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, suppress
import json
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.protocol import OPEN

from test_realtime_access import TOKEN, server


_PARTIAL = b"GET / HTTP/1.1\r\nHost: localhost\r\n"
_UPGRADE = (
    b"Upgrade: websocket\r\nConnection: Upgrade\r\n"
    b"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    b"Sec-WebSocket-Version: 13\r\n"
    + f"Authorization: Bearer {TOKEN}\r\n\r\n".encode()
)


async def _eventually(predicate, timeout: float = 1) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


async def _close(writer: asyncio.StreamWriter) -> None:
    writer.close()
    with suppress(ConnectionError):
        await writer.wait_closed()


async def _eof(reader: asyncio.StreamReader, timeout: float = 1) -> None:
    with suppress(ConnectionError):
        assert await asyncio.wait_for(reader.read(), timeout) == b""


async def _partial(hub):
    reader, writer = await asyncio.open_connection("127.0.0.1", hub.port)
    writer.write(_PARTIAL)
    await writer.drain()
    return reader, writer


async def _clean(hub, websocket_server, tasks=()) -> None:
    await _eventually(lambda: not hub._connections and not websocket_server.handlers)
    assert all(task.done() for task in tasks)


async def _recover(hub, websocket_server) -> None:
    async with connect(
        f"ws://127.0.0.1:{hub.port}/",
        additional_headers={"Authorization": f"Bearer {TOKEN}"},
    ) as websocket:
        assert json.loads(await websocket.recv())["type"] == "session.ready"
    await _clean(hub, websocket_server)


@pytest.mark.anyio
@pytest.mark.parametrize("limit", (1, 3))
async def test_pending_tcp_limit_is_exact_and_excess_clients_allocate_no_handlers(tmp_path: Path, limit: int) -> None:
    async with server(tmp_path, max_connections=limit) as hub:
        websocket_server = hub._server
        clients = [await _partial(hub) for _ in range(limit)]
        try:
            await _eventually(lambda: len(websocket_server.handlers) == limit)
            assert len(hub._connections) == limit
            assert not websocket_server.connections
            tasks = tuple(websocket_server.handlers.values())
            admitted = set(hub._connections)
            # Includes the original eight-client reproduction at limit=1.
            for _ in range(8):
                reader, writer = await asyncio.open_connection("127.0.0.1", hub.port)
                try:
                    writer.write(_PARTIAL + b"X-Slow:")
                    with suppress(ConnectionError):
                        await writer.drain()
                    await _eof(reader)
                    assert hub._connections == admitted
                    assert tuple(websocket_server.handlers.values()) == tasks
                finally:
                    await _close(writer)
            # Slow header progress must neither allocate a new slot nor free one.
            for _, writer in clients:
                writer.write(b"X-Slow: a")
                await writer.drain()
            assert hub._connections == admitted
        finally:
            for _, writer in clients:
                await _close(writer)
        await _clean(hub, websocket_server, tasks)
        await _recover(hub, websocket_server)


@pytest.mark.anyio
async def test_pending_charge_is_retained_through_authenticated_handoff(tmp_path: Path) -> None:
    async with server(tmp_path, max_connections=1) as hub:
        websocket_server = hub._server
        reader, writer = await _partial(hub)
        try:
            await _eventually(lambda: len(websocket_server.handlers) == 1)
            connection, = hub._connections
            tasks = tuple(websocket_server.handlers.values())
            writer.write(_UPGRADE)
            await writer.drain()
            response = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 1)
            assert response.startswith(b"HTTP/1.1 101 ")
            await _eventually(lambda: connection.protocol.state is OPEN)
            assert hub._connections == {connection}
            assert websocket_server.connections == {connection}
            assert tuple(websocket_server.handlers.values()) == tasks
            excess_reader, excess_writer = await asyncio.open_connection("127.0.0.1", hub.port)
            try:
                await _eof(excess_reader)
                assert hub._connections == {connection}
                assert tuple(websocket_server.handlers.values()) == tasks
            finally:
                await _close(excess_writer)
        finally:
            await _close(writer)
        await _clean(hub, websocket_server, tasks)
        await _recover(hub, websocket_server)


@pytest.mark.anyio
async def test_authenticated_exact_limit_and_normal_close_recover_capacity(tmp_path: Path) -> None:
    async with server(tmp_path, max_connections=2) as hub:
        websocket_server = hub._server
        async with AsyncExitStack() as stack:
            for _ in range(2):
                websocket = await stack.enter_async_context(connect(
                    f"ws://127.0.0.1:{hub.port}/",
                    additional_headers={"Authorization": f"Bearer {TOKEN}"},
                ))
                assert json.loads(await websocket.recv())["type"] == "session.ready"
            assert len(hub._connections) == len(websocket_server.connections) == 2
            tasks = tuple(websocket_server.handlers.values())
            reader, writer = await asyncio.open_connection("127.0.0.1", hub.port)
            try:
                await _eof(reader)
                assert len(websocket_server.handlers) == 2
            finally:
                await _close(writer)
        await _clean(hub, websocket_server, tasks)
        await _recover(hub, websocket_server)


@pytest.mark.anyio
@pytest.mark.parametrize("suffix", (
    b"\r\n",  # Access denial.
    b"bad header\r\n\r\n",  # Malformed HTTP header.
    b"Sec-WebSocket-Key: invalid\r\n" + _UPGRADE,  # Authorized invalid upgrade.
))
async def test_denied_and_malformed_handshakes_release_once_and_recover(tmp_path: Path, suffix: bytes) -> None:
    async with server(tmp_path, max_connections=1) as hub:
        websocket_server = hub._server
        reader, writer = await _partial(hub)
        await _eventually(lambda: len(websocket_server.handlers) == 1)
        tasks = tuple(websocket_server.handlers.values())
        try:
            writer.write(suffix)
            await writer.drain()
            with suppress(ConnectionError):
                await asyncio.wait_for(reader.read(), 1)
        finally:
            await _close(writer)
        await _clean(hub, websocket_server, tasks)
        # Two rounds expose accidental double-release or lost accounting.
        await _recover(hub, websocket_server)
        await _recover(hub, websocket_server)


@pytest.mark.anyio
async def test_slow_headers_keep_absolute_five_second_timeout_and_recover(tmp_path: Path) -> None:
    async with server(tmp_path, max_connections=1) as hub:
        websocket_server = hub._server
        assert websocket_server.open_timeout == 5
        reader, writer = await _partial(hub)
        await _eventually(lambda: len(websocket_server.handlers) == 1)
        tasks = tuple(websocket_server.handlers.values())
        started = asyncio.get_running_loop().time()

        async def drip() -> None:
            while True:
                writer.write(b"x")
                await writer.drain()
                await asyncio.sleep(0.2)

        drip_task = asyncio.create_task(drip())
        try:
            await _eof(reader, timeout=6)
            elapsed = asyncio.get_running_loop().time() - started
            assert 4 <= elapsed < 6
        finally:
            drip_task.cancel()
            with suppress(asyncio.CancelledError, ConnectionError):
                await drip_task
            await _close(writer)
        await _clean(hub, websocket_server, tasks)
        await _recover(hub, websocket_server)


@pytest.mark.anyio
async def test_abrupt_partial_close_releases_slot_and_handler(tmp_path: Path) -> None:
    async with server(tmp_path, max_connections=1) as hub:
        websocket_server = hub._server
        _, writer = await _partial(hub)
        await _eventually(lambda: len(websocket_server.handlers) == 1)
        tasks = tuple(websocket_server.handlers.values())
        writer.transport.abort()
        await _close(writer)
        await _clean(hub, websocket_server, tasks)
        await _recover(hub, websocket_server)


@pytest.mark.anyio
async def test_shutdown_aborts_pending_handshakes_awaits_tasks_and_can_restart(tmp_path: Path) -> None:
    hub = server(tmp_path, max_connections=2)
    async with hub:
        websocket_server = hub._server
        pending_reader, pending_writer = await _partial(hub)
        websocket = await connect(
            f"ws://127.0.0.1:{hub.port}/",
            additional_headers={"Authorization": f"Bearer {TOKEN}"},
        )
        assert json.loads(await websocket.recv())["type"] == "session.ready"
        assert len(hub._connections) == 2
        tasks = tuple(websocket_server.handlers.values())
        started = asyncio.get_running_loop().time()
    assert asyncio.get_running_loop().time() - started < 1
    await _eof(pending_reader)
    await _close(pending_writer)
    await asyncio.wait_for(websocket.wait_closed(), 1)
    assert websocket.close_code == 1001
    await _clean(hub, websocket_server, tasks)
    assert websocket_server.close_task.done()
    assert not hub._admission.accepting
    async with hub:
        await _recover(hub, hub._server)


@pytest.mark.parametrize("limit", (True, 1.5))
def test_connection_budget_requires_integer_capacity(tmp_path: Path, limit) -> None:
    with pytest.raises(ValueError, match="connection limit"):
        server(tmp_path, max_connections=limit)


@pytest.mark.anyio
async def test_shutdown_handles_synchronous_release_and_later_tcp_cleanup(monkeypatch, tmp_path: Path) -> None:
    hub = server(tmp_path, max_connections=3)
    failures = []
    monkeypatch.setattr(asyncio.get_running_loop(), "call_exception_handler", failures.append)
    async with hub:
        websocket_server = hub._server
        clients = [await _partial(hub) for _ in range(3)]
        await _eventually(lambda: len(websocket_server.handlers) == 3)
        tasks = tuple(websocket_server.handlers.values())
        aborted = []

        def synchronous_abort(connection, abort):
            def wrapped() -> None:
                # Exercise synchronous registry mutation on the real accepted
                # connection, followed by its actual asyncio TCP close callback.
                hub._connections.discard(connection)
                aborted.append(connection)
                abort()
            return wrapped

        for connection in tuple(hub._connections):
            transport = connection.transport
            monkeypatch.setattr(transport, "abort", synchronous_abort(connection, transport.abort))
        hub._admission.stop()
        hub._admission.stop()
        assert len(aborted) == 3
        assert not hub._connections
        for reader, writer in clients:
            await _eof(reader)
            await _close(writer)
        await _clean(hub, websocket_server, tasks)
        assert not failures
    async with hub:
        await _recover(hub, hub._server)
    assert not failures
