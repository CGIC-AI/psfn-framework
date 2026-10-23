from __future__ import annotations

from http.client import HTTPConnection
from pathlib import Path
import time
import socket
from urllib.parse import urlsplit

import pytest

from hub.media.audio_limits import AudioLimits
from hub.media.http_audio import StaticAudioServer


def make_server(tmp_path: Path, **limits) -> StaticAudioServer:
    return StaticAudioServer(
        host="127.0.0.1", port=0, root=tmp_path, developer_mode=True,
        limits=AudioLimits(**limits),
    )


def fetch(server, stream) -> bytes:
    connection = HTTPConnection("127.0.0.1", server.port, timeout=2)
    try:
        connection.request("GET", urlsplit(stream.url).path)
        response = connection.getresponse()
        assert response.status == 200
        return response.read()
    finally:
        connection.close()


def test_hundred_never_fetched_streams_are_bounded_expire_and_recover(tmp_path: Path) -> None:
    server = make_server(tmp_path, max_streams=2, stream_idle_seconds=0.05)
    accepted = []
    for _ in range(100):
        try:
            accepted.append(server.open_stream())
        except RuntimeError as error:
            assert str(error) == "Audio stream registry capacity exceeded"
    assert len(accepted) == 2
    time.sleep(0.06)
    server.purge_expired()
    for stream in accepted:
        with pytest.raises(RuntimeError, match="unavailable"):
            stream.write(b"late")
    healthy = server.open_stream()
    healthy.write(b"healthy")
    healthy.close()


def test_stream_exact_chunk_and_byte_limits_then_backpressure_is_stable(tmp_path: Path) -> None:
    server = make_server(tmp_path, max_stream_chunks=2, max_stream_bytes=8)
    server.start()
    try:
        exact = server.open_stream()
        exact.write(b"1234")
        exact.write(b"5678")
        exact.close()
        assert fetch(server, exact) == b"12345678"
        full = server.open_stream()
        full.write(b"1234")
        full.write(b"5678")
        for _ in range(3):
            with pytest.raises(RuntimeError, match="capacity|unavailable"):
                full.write(b"x")
        full.close()
        oversized = server.open_stream()
        with pytest.raises(RuntimeError, match="capacity"):
            oversized.write(b"123456789")
        healthy = server.open_stream()
        healthy.write(b"ok")
        healthy.close()
        assert fetch(server, healthy) == b"ok"
    finally:
        server.stop()


def test_stream_age_expires_even_with_producer_activity_and_shutdown_unblocks_reader(tmp_path: Path) -> None:
    server = make_server(tmp_path, stream_max_age_seconds=0.05, stream_idle_seconds=1)
    server.start()
    stream = server.open_stream()
    stream.write(b"first")
    time.sleep(0.06)
    with pytest.raises(RuntimeError, match="unavailable"):
        stream.write(b"late")
    live = server.open_stream()
    connection = HTTPConnection("127.0.0.1", server.port, timeout=1)
    connection.request("GET", urlsplit(live.url).path)
    assert connection.getresponse().status == 200
    started = time.monotonic()
    server.stop()
    assert time.monotonic() - started < 0.5
    connection.close()
    with pytest.raises(RuntimeError, match="unavailable"):
        live.write(b"late")
    server.start()
    healthy = server.open_stream()
    healthy.write(b"recovered")
    healthy.close()
    assert fetch(server, healthy) == b"recovered"
    server.stop()


def test_slow_real_socket_consumer_cannot_accumulate_unbounded_audio_and_recovers(tmp_path: Path) -> None:
    server = make_server(
        tmp_path, max_streams=1, max_stream_chunks=2, max_stream_bytes=2 * 1024 * 1024,
        max_response_bytes=8 * 1024 * 1024, io_timeout_seconds=0.1, stream_idle_seconds=0.2,
    )
    server.start()
    client = socket.socket()
    client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    client.settimeout(1)
    client.connect(("127.0.0.1", server.port))
    try:
        stream = server.open_stream()
        client.sendall(f"GET {urlsplit(stream.url).path} HTTP/1.1\r\nHost: local\r\n\r\n".encode("ascii"))
        assert b"200" in client.recv(1024)
        admitted = 0
        for _ in range(100):
            try:
                stream.write(b"a" * (1024 * 1024))
                admitted += 1
            except RuntimeError:
                break
        assert 0 < admitted <= 8
        for _ in range(3):
            with pytest.raises(RuntimeError, match="unavailable"):
                stream.write(b"late")
        time.sleep(0.3)
        healthy = server.open_stream()
        healthy.write(b"healthy")
        healthy.close()
        assert fetch(server, healthy) == b"healthy"
    finally:
        client.close()
        server.stop()
