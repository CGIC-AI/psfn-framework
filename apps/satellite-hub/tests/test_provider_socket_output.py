from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
import json
import socket
import ssl
import datetime

import httpx
import pytest
import websockets
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed
from websockets.frames import Frame, OP_CLOSE, OP_PING, OP_TEXT
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from hub.adapters.bounds import ProviderLimits
from hub.adapters.stt.deepgram_live import DeepgramLiveSTTProvider
from hub.adapters.tts.elevenlabs_streaming import ElevenLabsStreamingTTS
from hub.devices.realtime_output import RealtimeOutputLimits


async def eventually(predicate, timeout=3):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


@pytest.fixture(autouse=True)
def loopback_only(monkeypatch):
    connect = websockets.connect

    def local_connect(uri, **kwargs):
        assert uri.startswith(("ws://127.0.0.1:", "wss://127.0.0.1:"))
        return connect(uri, proxy=None, **kwargs)

    async def reject_http(*args, **kwargs):
        raise AssertionError("HTTP is forbidden in provider socket fixtures")

    monkeypatch.setattr(websockets, "connect", local_connect)
    monkeypatch.setattr(httpx.AsyncClient, "send", reject_http)


@asynccontextmanager
async def provider_peer(kind, **options):
    accepted = asyncio.Queue()
    stopped = asyncio.Event()
    connections = 0

    async def handler(ws):
        nonlocal connections
        connections += 1
        await accepted.put(ws)
        if connections == 1:
            await stopped.wait()
            return
        try:
            async for raw in ws:
                if kind == "deepgram":
                    if isinstance(raw, bytes):
                        await ws.send(json.dumps({"type": "Results", "is_final": True,
                            "channel": {"alternatives": [{"transcript": "recovered"}]}}))
                    elif json.loads(raw).get("type") == "Finalize":
                        await ws.send('{"type":"UtteranceEnd"}')
                elif json.loads(raw).get("text") == " ":
                    await ws.send(json.dumps({"contextId": "fresh", "audio": "b2s=", "isFinal": True}))
        except ConnectionClosed:
            return

    async with serve(handler, "127.0.0.1", 0, compression=None, ping_interval=None, close_timeout=0.1) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        cls = DeepgramLiveSTTProvider if kind == "deepgram" else ElevenLabsStreamingTTS
        if kind == "elevenlabs":
            options["voice_id"] = "fixture"
        provider = cls(api_key="invented-credential", websocket_url=url,
                       limits=ProviderLimits(max_ws_message_bytes=1024, max_ws_queue=1), **options)
        stream = task = None
        try:
            if kind == "deepgram":
                await provider.start_turn("fixture")
            else:
                stream = provider.stream_text(text_chunks=asyncio.Queue(), context_id="fixture")
                task = asyncio.create_task(anext(stream))
            peer = await asyncio.wait_for(accepted.get(), 1)
            await eventually(lambda: provider._ws is not None)
            connection = provider._ws
            peer.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            connection.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            await asyncio.sleep(0.02)
            if kind == "elevenlabs":
                await asyncio.wait_for(peer.recv(), 1)
            peer.transport.pause_reading()
            yield provider, connection, peer, task
        finally:
            if provider._ws is not None:
                provider._ws.transport.abort()
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if stream is not None:
                await stream.aclose()
            await provider.aclose()
            stopped.set()


@pytest.mark.anyio
async def test_simultaneous_tts_context_cancellation_closes_last_socket_under_send_contention():
    accepted = asyncio.Queue()

    async def handler(ws):
        await accepted.put(ws)
        await ws.wait_closed()

    async with serve(handler, "127.0.0.1", 0, close_timeout=0.1) as server:
        provider = ElevenLabsStreamingTTS(api_key="invented", voice_id="fixture",
            websocket_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}")
        streams = [provider.stream_text(text_chunks=asyncio.Queue(), context_id=str(index)) for index in range(2)]
        tasks = [asyncio.create_task(anext(stream)) for stream in streams]
        try:
            await accepted.get()
            await eventually(lambda: len(provider._contexts) == 2 and all(state.sender is not None for state in provider._contexts.values()))
            connection = provider._ws
            async with provider._send_lock:
                for task in tasks:
                    task.cancel()
                await eventually(lambda: len(provider._context_cleanups) == 2)
                await asyncio.sleep(0.02)  # Let both finalizers reach the held send lock.
            await asyncio.gather(*tasks, return_exceptions=True)
            await eventually(lambda: provider._reader_task is None, timeout=0.3)
            assert connection.connection_lost_waiter.done()
            assert not provider._contexts
            assert not provider._context_cleanups
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            for stream in streams:
                await stream.aclose()
            await provider.aclose()


@pytest.fixture
def tls_contexts(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
        .not_valid_after(now + datetime.timedelta(days=1)).sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "certificate.pem", tmp_path / "key.pem"
    cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()))
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server.load_cert_chain(cert_path, key_path)
    client = ssl.create_default_context(cafile=str(cert_path))
    client.check_hostname = False
    return server, client


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
@pytest.mark.parametrize("action", ("second_write", "deadline", "ping_flood", "exact", "one_over"))
async def test_tls_output_accounts_tcp_buffers_record_expansion_and_deadline(kind, action, tls_contexts, monkeypatch, record_property):
    server_context, client_context = tls_contexts
    connect = websockets.connect

    def tls_connect(uri, **kwargs):
        return connect(uri, ssl=client_context, **kwargs)

    monkeypatch.setattr(websockets, "connect", tls_connect)
    accepted = asyncio.Queue()
    stopped = asyncio.Event()

    async def handler(ws):
        await accepted.put(ws)
        await stopped.wait()

    async with serve(handler, "127.0.0.1", 0, ssl=server_context, compression=None,
                     ping_interval=None, close_timeout=0.1) as server:
        url = f"wss://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        limits = RealtimeOutputLimits(max_bytes=900_611 if action == "exact" else 900_610 if action == "one_over" else 1_048_576,
                                      completion_timeout=0.15)
        options = {"api_key": "invented", "websocket_url": url, "output_limits": limits}
        provider = (DeepgramLiveSTTProvider(**options) if kind == "deepgram"
                    else ElevenLabsStreamingTTS(voice_id="fixture", **options))
        stream = task = None
        try:
            if kind == "deepgram":
                await provider.start_turn("fixture")
            else:
                stream = provider.stream_text(text_chunks=asyncio.Queue(), context_id="fixture")
                task = asyncio.create_task(anext(stream))
            peer = await accepted.get()
            await eventually(lambda: provider._ws is not None)
            connection = provider._ws
            raw = connection.transport._ssl_protocol._transport
            peer.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            connection.transport.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            if kind == "elevenlabs":
                await asyncio.wait_for(peer.recv(), 1)
            peer.transport.pause_reading()
            peak = 0
            send_frame = connection.protocol.send_frame

            def observe(frame):
                nonlocal peak
                send_frame(frame)
                retained = (connection.transport.get_write_buffer_size() + raw.get_write_buffer_size()
                            + sum(map(len, connection.protocol.writes)))
                peak = max(peak, retained)

            monkeypatch.setattr(connection.protocol, "send_frame", observe)
            if action == "one_over":
                with pytest.raises(ConnectionClosed):
                    await connection.send(b"d" * 800_000)
            elif action == "ping_flood":
                peer.transport.write(Frame(OP_PING, b"p" * 125).serialize(mask=False) * 18_000)
            else:
                await connection.send(b"d" * 800_000)
                assert raw.get_write_buffer_size() > 0
                assert connection.output.bytes > 0
                assert connection.output.deadline is not None
                if action == "second_write":
                    with pytest.raises(ConnectionClosed):
                        await connection.send(b"d" * 800_000)
            await eventually(lambda: connection.connection_lost_waiter.done())
            record_property("tls_native_plus_pending_peak_bytes", peak)
            assert peak <= limits.max_bytes
            assert connection.transport.get_write_buffer_size() + raw.get_write_buffer_size() == 0
            assert connection.output.bytes == 0
            assert connection.output.timer is None
            await eventually(lambda: provider._reader_task is None)
        finally:
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            if stream is not None:
                await stream.aclose()
            await provider.aclose()
            stopped.set()


async def recover(provider, kind):
    if kind == "deepgram":
        await provider.start_turn("fresh")
        await provider.send_audio(b"12")
        assert (await provider.finish_turn()).text == "recovered"
        assert provider._keepalive_task is None
    else:
        text = asyncio.Queue()
        text.put_nowait("hi")
        text.put_nowait(None)
        assert [chunk async for chunk in provider.stream_text(text_chunks=text, context_id="fresh")] == [b"ok"]
        assert not provider._contexts
        assert not provider._context_cleanups
    assert provider._reader_task is None


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
async def test_real_provider_legal_ping_flood_bounds_native_output_and_settles(kind, monkeypatch, record_property, tmp_path, caplog):
    async with provider_peer(kind) as (provider, connection, peer, task):
        peak = 0
        combined_peak = 0
        write = connection.transport.write
        send_frame = connection.protocol.send_frame

        def observe_frame(frame):
            nonlocal combined_peak
            send_frame(frame)
            retained = sum(map(len, connection.protocol.writes)) + connection.transport.get_write_buffer_size()
            combined_peak = max(combined_peak, retained)

        def observe(data):
            nonlocal peak
            write(data)
            peak = max(peak, connection.transport.get_write_buffer_size())

        monkeypatch.setattr(connection.transport, "write", observe)
        monkeypatch.setattr(connection.protocol, "send_frame", observe_frame)
        peer.transport.write(Frame(OP_PING, b"p" * 125).serialize(mask=False) * 18_000)
        await eventually(lambda: peak > 1_048_576 or connection.connection_lost_waiter.done())
        record_property("native_peak_bytes", peak)
        record_property("native_plus_pending_peak_bytes", combined_peak)
        assert peak <= 1_048_576, f"native output retained {peak} bytes"
        assert combined_peak <= 1_048_576
        await eventually(lambda: connection.connection_lost_waiter.done())
        await eventually(lambda: provider._reader_task is None)
        if kind == "deepgram":
            await eventually(lambda: provider._keepalive_task is None)
            with pytest.raises(RuntimeError, match="Provider"):
                await provider.finish_turn()
        else:
            with pytest.raises(RuntimeError, match="Provider"):
                await task
            assert not provider._contexts
        assert not connection.protocol.writes
        assert connection.transport.get_write_buffer_size() == 0
        assert list(tmp_path.iterdir()) == []
        assert "invented-credential" not in caplog.text
        await recover(provider, kind)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
@pytest.mark.parametrize(("size", "accepted"), ((1010, True), (1011, False)))
async def test_application_exact_capacity_and_one_over(kind, size, accepted):
    async with provider_peer(kind, output_limits=RealtimeOutputLimits(max_bytes=1024)) as (_, connection, peer, _):
        if accepted:
            await connection.send(b"d" * size)
            peer.transport.resume_reading()
            assert await asyncio.wait_for(peer.recv(), 1) == b"d" * size
        else:
            with pytest.raises(ConnectionClosed):
                await connection.send(b"d" * size)
            assert connection.connection_lost_waiter.done()


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
@pytest.mark.parametrize(("max_bytes", "max_frames", "accepted"), (
    (882, 4, True), (881, 4, False), (1024, 3, False),
))
async def test_pending_fragments_and_controls_compete_for_exact_capacity(kind, max_bytes, max_frames, accepted):
    limits = RealtimeOutputLimits(max_bytes=max_bytes, max_frames=max_frames)
    async with provider_peer(kind, output_limits=limits) as (_, connection, peer, _):
        async def batch():
            # One synchronous Sans-I/O transaction, before any bytes drain.
            async with connection.send_context():
                connection.protocol.send_binary(b"d" * 700, fin=False)
                connection.protocol.send_ping(b"p" * 125)
                connection.protocol.send_pong(b"p")
                connection.protocol.send_continuation(b"", fin=True)

        if accepted:
            await batch()
            peer.transport.resume_reading()
            assert await asyncio.wait_for(peer.recv(), 1) == b"d" * 700
        else:
            with pytest.raises(ConnectionClosed):
                await batch()
            assert connection.connection_lost_waiter.done()


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
async def test_native_output_has_absolute_completion_deadline(kind):
    limits = RealtimeOutputLimits(completion_timeout=0.15)
    async with provider_peer(kind, output_limits=limits) as (_, connection, _, _):
        connection.transport.set_write_buffer_limits(high=1_048_576)
        started = connection.loop.time()
        await connection.send(b"d" * 262_144)
        assert connection.transport.get_write_buffer_size() > 0
        deadline = connection.output.deadline
        await asyncio.sleep(0.06)
        await connection.pong(b"p")
        assert connection.output.deadline == deadline
        await eventually(lambda: connection.connection_lost_waiter.done())
        assert 0.1 <= connection.loop.time() - started < 1
        assert connection.output.timer is None
        assert connection.output.bytes == connection.output.frames == 0


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
@pytest.mark.parametrize("action", ("ping", "pong", "close", "peer_close", "fragment", "cancel", "shutdown", "write_error"))
async def test_native_application_control_failure_cancellation_and_shutdown_settle(kind, action, monkeypatch):
    limits = RealtimeOutputLimits(max_bytes=262_158, completion_timeout=0.15)
    async with provider_peer(kind, output_limits=limits) as (provider, connection, peer, task):
        connection.transport.set_write_buffer_limits(high=1_048_576)
        if action == "write_error":
            def reject(data):
                raise OSError("invented-upstream-content")
            monkeypatch.setattr(connection.transport, "write", reject)
            with pytest.raises(ConnectionClosed):
                await connection.send(b"data")
        elif action == "cancel":
            waiting = asyncio.Event()

            async def chunks():
                yield b"d" * 262_144
                waiting.set()
                await asyncio.Event().wait()
                yield b"a"

            sending = asyncio.create_task(connection.send(chunks()))
            await asyncio.wait_for(waiting.wait(), 1)
            sending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await sending
            assert connection.fragmented_send_waiter is None
        else:
            await connection.send(b"d" * 262_144)
            assert connection.transport.get_write_buffer_size() > 0
            if action in {"ping", "pong", "fragment"}:
                with pytest.raises(ConnectionClosed):
                    if action == "ping":
                        await connection.ping(b"p")
                    elif action == "pong":
                        await connection.pong(b"p")
                    else:
                        await connection.send([b"a", b"b"])
            elif action == "peer_close":
                peer.transport.write(Frame(OP_CLOSE, b"\x03\xe8").serialize(mask=False))
            elif action == "close":
                await connection.close()
                await connection.close()
            else:
                await provider.aclose()
                await provider.aclose()
        await eventually(lambda: connection.connection_lost_waiter.done())
        await eventually(lambda: provider._reader_task is None)
        connection.connection_lost(None)
        assert connection.output.timer is None
        assert connection.output.frames == connection.output.bytes == connection.output.pending_bytes == 0
        assert not connection.protocol.writes
        assert connection.transport.get_write_buffer_size() == 0
        assert not connection.drain_waiters
        if kind == "deepgram":
            assert provider._keepalive_task is None
            if action != "shutdown":
                with pytest.raises(RuntimeError, match="Provider"):
                    await provider.finish_turn()
        elif action != "shutdown":
            with pytest.raises(RuntimeError, match="Provider"):
                await task
            assert not provider._contexts
        await recover(provider, kind)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
async def test_repeated_shutdown_cancellation_retains_lifecycle_until_settlement(kind, monkeypatch):
    async with provider_peer(kind) as (provider, connection, _, _):
        started = asyncio.Event()
        release = asyncio.Event()
        close = connection.close

        async def gated_close(*args, **kwargs):
            started.set()
            await release.wait()
            await close(*args, **kwargs)

        monkeypatch.setattr(connection, "close", gated_close)
        closing = asyncio.create_task(provider.aclose())
        repeated = None
        try:
            await asyncio.wait_for(started.wait(), 1)
            closing.cancel()
            with pytest.raises(asyncio.CancelledError):
                await closing
            assert provider._ws is connection
            repeated = asyncio.create_task(provider.aclose())
            await asyncio.sleep(0)
            repeated.cancel()
            with pytest.raises(asyncio.CancelledError):
                await repeated
            assert provider._ws is connection
        finally:
            release.set()
            connection.transport.abort()
            await provider.aclose()
        assert provider._ws is None
        assert provider._reader_task is None
        assert connection.connection_lost_waiter.done()
        await recover(provider, kind)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
async def test_provider_task_cancellation_closes_socket_and_releases_children(kind):
    async with provider_peer(kind) as (provider, connection, _, task):
        if kind == "deepgram":
            connection.transport.set_write_buffer_limits(high=1)
            sending = asyncio.create_task(provider.send_audio(b"d" * 262_144))
            await eventually(lambda: connection.transport.get_write_buffer_size() > 0)
            sending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await sending
        else:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        await eventually(lambda: connection.connection_lost_waiter.done())
        await eventually(lambda: provider._reader_task is None)
        if kind == "deepgram":
            assert provider._keepalive_task is None
        else:
            assert not provider._contexts
        await recover(provider, kind)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
async def test_control_overflow_discards_provider_result_in_same_read_batch(kind, tmp_path, caplog):
    async with provider_peer(kind, output_limits=RealtimeOutputLimits(max_frames=3)) as (provider, connection, peer, task):
        if kind == "deepgram":
            task = asyncio.create_task(provider.finish_turn())
            await asyncio.sleep(0)
            payload = {"type": "Results", "from_finalize": True, "is_final": True,
                "channel": {"alternatives": [{"transcript": "invented-result-content"}]}}
        else:
            payload = {"contextId": "fixture", "audio": "aW52ZW50ZWQtYXVkaW8=", "isFinal": True}
        peer.transport.write(Frame(OP_PING, b"p" * 125).serialize(mask=False) * 4
                             + Frame(OP_TEXT, json.dumps(payload).encode()).serialize(mask=False))
        with pytest.raises(RuntimeError, match="Provider") as failure:
            await asyncio.wait_for(task, 1)
        assert "invented-result-content" not in str(failure.value)
        assert "invented-credential" not in str(failure.value)
        await eventually(lambda: provider._reader_task is None)
        assert connection.connection_lost_waiter.done()
        if kind == "elevenlabs":
            assert not provider._contexts
        assert not list(tmp_path.iterdir())
        assert "invented-result-content" not in caplog.text
        await recover(provider, kind)


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ("deepgram", "elevenlabs"))
async def test_shutdown_settles_inflight_provider_handshake(kind):
    arrived = asyncio.Event()
    release = asyncio.Event()
    peers = []

    async def gate(connection, request):
        peers.append(connection)
        arrived.set()
        await release.wait()

    async def handler(ws):
        await ws.wait_closed()

    async with serve(handler, "127.0.0.1", 0, process_request=gate, close_timeout=0.1) as server:
        url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        provider = (DeepgramLiveSTTProvider(api_key="invented", websocket_url=url) if kind == "deepgram"
                    else ElevenLabsStreamingTTS(api_key="invented", voice_id="fixture", websocket_url=url))
        stream = None
        if kind == "deepgram":
            opening = asyncio.create_task(provider.start_turn("fixture"))
        else:
            stream = provider.stream_text(text_chunks=asyncio.Queue(), context_id="fixture")
            opening = asyncio.create_task(anext(stream))
        try:
            await asyncio.wait_for(arrived.wait(), 1)
            await asyncio.wait_for(provider.aclose(), 1)
            release.set()
            with suppress(RuntimeError, asyncio.CancelledError):
                await asyncio.wait_for(opening, 1)
            assert provider._ws is None
            assert provider._reader_task is None
            if kind == "deepgram":
                assert provider._keepalive_task is None
            else:
                assert not provider._contexts
            await eventually(lambda: all(peer.connection_lost_waiter.done() for peer in peers))
        finally:
            release.set()
            opening.cancel()
            await asyncio.gather(opening, return_exceptions=True)
            if stream is not None:
                await stream.aclose()
            await provider.aclose()
