from __future__ import annotations

import asyncio
from contextlib import suppress
import json
from pathlib import Path
import socket

import httpx
import pytest
import websockets
from websockets.exceptions import ConnectionClosed
from websockets.frames import Frame, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG, OP_TEXT

from hub.devices.realtime_output import RealtimeOutputLimits

from test_realtime_access import server
from test_realtime_admission import _PARTIAL, _UPGRADE, _clean, _close, _eventually, _recover


@pytest.fixture(autouse=True)
def no_provider_network(monkeypatch):
    calls = []

    async def reject(*args, **kwargs):
        calls.append(True)
        raise AssertionError("Provider network is forbidden in socket output tests")

    monkeypatch.setattr(httpx.AsyncClient, "send", reject)
    monkeypatch.setattr(websockets, "connect", reject)
    yield
    assert not calls


async def _read_frame(reader):
    header = await reader.readexactly(2)
    length = header[1] & 127
    if length == 126:
        length = int.from_bytes(await reader.readexactly(2), "big")
    elif length == 127:
        length = int.from_bytes(await reader.readexactly(8), "big")
    return header[0] & 15, await reader.readexactly(length)


async def _unread_peer(hub):
    reader, writer = await asyncio.open_connection("127.0.0.1", hub.port)
    writer.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    writer.write(_PARTIAL + _UPGRADE.replace(
        b"\r\n\r\n", b"\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n"))
    await writer.drain()
    response = await reader.readuntil(b"\r\n\r\n")
    assert response.startswith(b"HTTP/1.1 101 ")
    assert b"Sec-WebSocket-Extensions:" not in response
    _, ready = await _read_frame(reader)
    assert json.loads(ready)["type"] == "session.ready"
    writer.transport.pause_reading()
    peer, = hub._connections
    peer.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
    return reader, writer, peer


@pytest.mark.anyio
async def test_legal_ping_flood_cannot_bypass_native_output_cap(monkeypatch, tmp_path: Path, record_property) -> None:
    async with server(tmp_path, max_connections=1) as hub:
        websocket_server = hub._server
        _, writer, peer = await _unread_peer(hub)
        tasks = tuple(websocket_server.handlers.values())
        peak = 0
        write = peer.transport.write

        def observe(data):
            nonlocal peak
            write(data)
            peak = max(peak, peer.transport.get_write_buffer_size())

        monkeypatch.setattr(peer.transport, "write", observe)
        try:
            writer.write(Frame(OP_PING, b"p" * 125).serialize(mask=True) * 18_000)
            with suppress(ConnectionError):
                await writer.drain()
            await _eventually(lambda: peak > 1_048_576 or peer.connection_lost_waiter.done(), timeout=5)
            record_property("native_peak_bytes", peak)
            assert peak <= 1_048_576, f"native output retained {peak} bytes"
            await _eventually(lambda: peer.connection_lost_waiter.done())
            await _clean(hub, websocket_server, tasks)
            assert not (tmp_path / "artifacts").exists()
            await _recover(hub, websocket_server)
        finally:
            writer.transport.abort()
            await _close(writer)


@pytest.mark.anyio
@pytest.mark.parametrize(("count", "max_frames", "max_bytes", "accepted"), (
    (3, 3, 417, True),  # Three 125-byte payloads plus three 14-byte projections.
    (3, 3, 416, False),
    (4, 3, 1024, False),
))
async def test_control_batch_exact_capacity_and_one_over(
    tmp_path: Path, count: int, max_frames: int, max_bytes: int, accepted: bool,
) -> None:
    limits = RealtimeOutputLimits(max_frames=max_frames, max_bytes=max_bytes)
    async with server(tmp_path, output_limits=limits, max_connections=1) as hub:
        websocket_server = hub._server
        reader, writer, peer = await _unread_peer(hub)
        tasks = tuple(websocket_server.handlers.values())
        try:
            writer.write(Frame(OP_PING, b"p" * 125).serialize(mask=True) * count)
            await writer.drain()
            if accepted:
                writer.transport.resume_reading()
                for _ in range(count):
                    assert await asyncio.wait_for(_read_frame(reader), 1) == (OP_PONG, b"p" * 125)
                assert not peer.connection_lost_waiter.done()
            else:
                await _eventually(lambda: peer.connection_lost_waiter.done())
        finally:
            writer.transport.abort()
            await _close(writer)
        await _clean(hub, websocket_server, tasks)
        assert peer.output.timer is None
        assert peer.output.frames == peer.output.bytes == peer.output.pending_bytes == 0
        assert not peer.protocol.writes
        assert peer.transport.get_write_buffer_size() == 0
        await _recover(hub, websocket_server)


@pytest.mark.anyio
@pytest.mark.parametrize(("size", "accepted"), ((1010, True), (1011, False)))
async def test_application_exact_capacity_and_one_over(tmp_path: Path, size: int, accepted: bool) -> None:
    async with server(tmp_path, output_limits=RealtimeOutputLimits(max_bytes=1024)) as hub:
        reader, writer, peer = await _unread_peer(hub)
        try:
            if accepted:
                await peer.send(b"d" * size)
                writer.transport.resume_reading()
                assert await asyncio.wait_for(_read_frame(reader), 1) == (OP_BINARY, b"d" * size)
            else:
                with pytest.raises(ConnectionClosed):
                    await peer.send(b"d" * size)
                assert peer.connection_lost_waiter.done()
        finally:
            writer.transport.abort()
            await _close(writer)
        await _clean(hub, hub._server)
        await _recover(hub, hub._server)


@pytest.mark.anyio
async def test_native_pressure_has_absolute_deadline_and_holds_admission(tmp_path: Path) -> None:
    limits = RealtimeOutputLimits(completion_timeout=0.15)
    async with server(tmp_path, max_connections=1, output_limits=limits) as hub:
        websocket_server = hub._server
        _, writer, peer = await _unread_peer(hub)
        tasks = tuple(websocket_server.handlers.values())
        started = asyncio.get_running_loop().time()
        try:
            await peer.send(b"d" * 262_144)
            assert peer.transport.get_write_buffer_size() > 0
            assert hub._connections == {peer}
            _, denied = await asyncio.open_connection("127.0.0.1", hub.port)
            await _close(denied)
            assert hub._connections == {peer}
            await _eventually(lambda: peer.connection_lost_waiter.done())
            assert 0.1 <= asyncio.get_running_loop().time() - started < 1
            await _clean(hub, websocket_server, tasks)
            assert peer.output.timer is None
            assert peer.output.bytes == peer.output.frames == 0
            assert not peer.protocol.writes
            assert not peer.drain_waiters
            assert peer.transport.get_write_buffer_size() == 0
            await _recover(hub, websocket_server)
        finally:
            writer.transport.abort()
            await _close(writer)


@pytest.mark.anyio
@pytest.mark.parametrize("action", ("ping", "pong", "close", "peer_close", "fragment", "cancel", "shutdown"))
async def test_control_fragment_cancel_and_shutdown_share_output_ownership(tmp_path: Path, action: str) -> None:
    hub = server(tmp_path, max_connections=1, output_limits=RealtimeOutputLimits(max_bytes=262_158, completion_timeout=0.15))
    async with hub:
        websocket_server = hub._server
        _, writer, peer = await _unread_peer(hub)
        tasks = tuple(websocket_server.handlers.values())
        try:
            if action == "cancel":
                waiting = asyncio.Event()

                async def chunks():
                    yield b"d" * 262_144
                    waiting.set()
                    await asyncio.Event().wait()
                    yield b"a"

                pending = asyncio.create_task(peer.send(chunks()))
                await waiting.wait()
            else:
                await peer.send(b"d" * 262_144)  # Exact cap; native bytes are still retained.
            assert peer.transport.get_write_buffer_size() > 0
            if action == "ping":
                with pytest.raises(ConnectionClosed):
                    await peer.ping(b"p" * 125)
            elif action == "pong":
                with pytest.raises(ConnectionClosed):
                    await peer.pong(b"p" * 125)
            elif action == "close":
                await peer.close()
                await peer.close()
            elif action == "peer_close":
                writer.write(Frame(OP_CLOSE, b"\x03\xe8").serialize(mask=True))
                await writer.drain()
            elif action == "fragment":
                with pytest.raises(ConnectionClosed):
                    await peer.send([b"a", b"b"])
                assert peer.fragmented_send_waiter is None
            elif action == "cancel":
                pending.cancel()
                with suppress(asyncio.CancelledError, ConnectionClosed):
                    await pending
                assert pending.done()
                assert peer.fragmented_send_waiter is None
            else:
                websocket_server.close()
                websocket_server.close()
                await websocket_server.wait_closed()
            await _eventually(lambda: peer.connection_lost_waiter.done())
            peer.connection_lost(None)  # Repeated terminal notification is safe.
            await _clean(hub, websocket_server, tasks)
            assert peer.output.timer is None
            assert not peer.protocol.writes
            assert peer.output.frames == peer.output.bytes == peer.output.pending_bytes == 0
            assert peer.transport.get_write_buffer_size() == 0
            assert not peer.drain_waiters
            assert not (tmp_path / "artifacts").exists()
            if action != "shutdown":
                await _recover(hub, websocket_server)
        finally:
            writer.transport.abort()
            await _close(writer)
    # Repeated shutdown does not retain the old budget on restart.
    await hub.__aexit__(None, None, None)
    async with hub:
        await _recover(hub, hub._server)


@pytest.mark.parametrize("kwargs", (
    {"max_frames": True}, {"max_frames": 1.5}, {"max_bytes": 0},
    {"max_bytes": float("inf")}, {"completion_timeout": float("nan")},
    {"completion_timeout": True}, {"completion_timeout": 0},
))
def test_invalid_output_limits_fail_startup(kwargs) -> None:
    with pytest.raises(ValueError, match="Realtime output"):
        RealtimeOutputLimits(**kwargs)


@pytest.mark.anyio
async def test_native_write_error_aborts_and_releases_only_on_tcp_close(monkeypatch, tmp_path: Path) -> None:
    async with server(tmp_path, max_connections=1) as hub:
        websocket_server = hub._server
        _, writer, peer = await _unread_peer(hub)
        tasks = tuple(websocket_server.handlers.values())
        abort = peer.transport.abort
        charged = []

        def observe_abort():
            charged.append(peer in hub._connections)
            abort()

        def write_error(data):
            raise OSError("Synthetic write failure")

        monkeypatch.setattr(peer.transport, "abort", observe_abort)
        monkeypatch.setattr(peer.transport, "write", write_error)
        try:
            with pytest.raises(ConnectionClosed):
                await peer.send(b"d")
            assert charged and charged[0]
            await _clean(hub, websocket_server, tasks)
            assert peer.output.timer is None
            assert not peer.protocol.writes
            assert peer.transport.get_write_buffer_size() == 0
            await _recover(hub, websocket_server)
        finally:
            writer.transport.abort()
            await _close(writer)


@pytest.mark.anyio
async def test_cancelled_shutdown_awaits_terminal_cleanup_and_can_repeat(tmp_path: Path) -> None:
    hub = server(tmp_path, max_connections=1)
    await hub.__aenter__()
    websocket_server = hub._server
    _, writer, peer = await _unread_peer(hub)
    tasks = tuple(websocket_server.handlers.values())
    try:
        await peer.send(b"d" * 262_144)
        closing = asyncio.create_task(hub.__aexit__(None, None, None))
        await asyncio.sleep(0)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert closing.done()
        await _clean(hub, websocket_server, tasks)
        assert websocket_server.close_task.done()
        assert peer.output.timer is None
        assert not peer.protocol.writes
        assert peer.output.bytes == peer.output.frames == 0
        assert peer.transport.get_write_buffer_size() == 0
        assert peer.keepalive_task is None or peer.keepalive_task.done()
        await hub.__aexit__(None, None, None)
        async with hub:
            await _recover(hub, hub._server)
    finally:
        writer.transport.abort()
        await _close(writer)
        await hub.__aexit__(None, None, None)


@pytest.mark.anyio
@pytest.mark.parametrize("buffered_audio", (False, True))
async def test_output_overflow_does_not_admit_trailing_application_work(tmp_path: Path, buffered_audio: bool) -> None:
    limits = RealtimeOutputLimits(max_frames=3, max_bytes=1024)
    async with server(tmp_path, output_limits=limits) as hub:
        reader, writer, peer = await _unread_peer(hub)
        try:
            if buffered_audio:
                writer.transport.resume_reading()
                for payload in ({"type": "turn.start"}, {"type": "audio", "audio": "AQACAAMA"}, {"type": "hello"}):
                    writer.write(Frame(OP_TEXT, json.dumps(payload).encode()).serialize(mask=True))
                await writer.drain()
                assert json.loads((await _read_frame(reader))[1])["type"] == "turn.started"
                assert json.loads((await _read_frame(reader))[1])["type"] == "hello.ack"
                writer.transport.pause_reading()
            frames = [Frame(OP_PING, b"p" * 125) for _ in range(4)]
            payloads = ({"type": "turn.end"},) if buffered_audio else (
                {"type": "turn.start"}, {"type": "audio", "audio": "AQACAAMA"}, {"type": "turn.end"})
            for payload in payloads:
                frames.append(Frame(OP_TEXT, json.dumps(payload).encode()))
            writer.write(b"".join(frame.serialize(mask=True) for frame in frames))
            await writer.drain()
            await _eventually(lambda: peer.connection_lost_waiter.done())
            await _clean(hub, hub._server)
            assert not (tmp_path / "artifacts").exists()
            await _recover(hub, hub._server)
        finally:
            writer.transport.abort()
            await _close(writer)


@pytest.mark.anyio
async def test_repeated_shutdown_cancellation_retains_cleanup_ownership(monkeypatch, tmp_path: Path) -> None:
    from hub.devices.realtime_server import _RealtimeConnection

    cleanup_started = asyncio.Event()
    finish_cleanup = asyncio.Event()
    aclose = _RealtimeConnection.aclose

    async def gated_cleanup(connection):
        cleanup_started.set()
        await finish_cleanup.wait()
        await aclose(connection)

    monkeypatch.setattr(_RealtimeConnection, "aclose", gated_cleanup)
    hub = server(tmp_path, max_connections=1)
    await hub.__aenter__()
    websocket_server = hub._server
    _, writer, peer = await _unread_peer(hub)
    tasks = tuple(websocket_server.handlers.values())
    repeated = None
    try:
        closing = asyncio.create_task(hub.__aexit__(None, None, None))
        await asyncio.sleep(0)
        closing.cancel()
        await asyncio.wait_for(cleanup_started.wait(), 1)
        closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await closing
        assert peer.connection_lost_waiter.done()
        assert hub._server is websocket_server
        assert not websocket_server.close_task.done()
        repeated = asyncio.create_task(hub.__aexit__(None, None, None))
        await asyncio.sleep(0)
        assert not repeated.done()
        assert hub._server is websocket_server
        finish_cleanup.set()
        await asyncio.wait_for(repeated, 1)
        await _clean(hub, websocket_server, tasks)
        assert websocket_server.close_task.done()
        assert hub._server is None
        assert peer.output.timer is None
        assert not peer.protocol.writes
        await hub.__aexit__(None, None, None)
        async with hub:
            await _recover(hub, hub._server)
    finally:
        finish_cleanup.set()
        writer.transport.abort()
        await _close(writer)
        await websocket_server.wait_closed()
        if repeated is not None:
            await repeated
        await hub.__aexit__(None, None, None)
