from __future__ import annotations

import asyncio
import importlib
from contextlib import asynccontextmanager
from http.client import HTTPConnection
from pathlib import Path
import socket
import time

import pytest

from hub.cli.run import _run_runtime
from hub.media.http_audio import StaticAudioServer
from hub.runtime import load_runtime_config


TOKEN = "Au_xP8rQ2vK6tW0yL9eR3cF7dH1mZ5sG4bN_jTiEoCzB"


def request(port: int, path: str, token: str | None = None, method: str = "GET") -> tuple[int, bytes]:
    connection = HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request(method, path, headers={"Authorization": f"Bearer {token}"} if token else {})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


@asynccontextmanager
async def cli_listener(tmp_path: Path, monkeypatch, *, artifact_cleanup_interval_seconds=60):
    for key in ("AUDIO_PUBLIC_HOST", "AUDIO_PUBLIC_PORT", "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH"):
        monkeypatch.delenv(key, raising=False)
    for key, value in {
        "DEVICE_TRANSPORT": "realtime", "HUB_REALTIME_AUTH_TOKEN": "RT_8bQ6ZcP4fV9mR2tY7aS3dG5hJ0kL1nW_uEoXiCvBN",
        "DEEPGRAM_API_KEY": "invented-dg", "ELEVENLABS_API_KEY": "invented-el",
        "AUDIO_SERVER_BIND_HOST": "127.0.0.1", "AUDIO_SERVER_PORT": "0",
        "AUDIO_PUBLIC_BASE_URL": "https://audio.example.test", "AUDIO_RELAY_AUTH_TOKEN": TOKEN,
    }.items():
        monkeypatch.setenv(key, value)
    ready = asyncio.Future()

    async def endpoint_runtime(*, audio_server, **kwargs):
        ready.set_result(audio_server)
        await asyncio.Future()

    monkeypatch.setattr(importlib.import_module("hub.cli.run"), "_run_realtime_runtime", endpoint_runtime)
    task = asyncio.create_task(_run_runtime(tmp_path, artifact_cleanup_interval_seconds=artifact_cleanup_interval_seconds))
    try:
        done, _ = await asyncio.wait([ready, task], timeout=2, return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            await task
        assert ready.done(), "CLI did not start listener"
        yield ready.result()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_audio_listener_rejects_implicit_anonymous_and_direct_remote_configuration(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="developer|relay"):
        StaticAudioServer(host="127.0.0.1", port=0, root=tmp_path)
    for host in ("0.0.0.0", "::", "localhost", "192.0.2.1"):
        with pytest.raises(ValueError, match="loopback"):
            StaticAudioServer(host=host, port=0, root=tmp_path, developer_mode=True)
    for token in ("short", "a" * 64, "abcdefghijklmnop" * 4, "replace-me".ljust(64, "x"), "!" * 64):
        with pytest.raises(ValueError, match="AUDIO_RELAY_AUTH_TOKEN"):
            StaticAudioServer(host="127.0.0.1", port=0, root=tmp_path, relay_token=token,
                              public_base_url="https://audio.example.test")


@pytest.mark.anyio
async def test_cli_refuses_reused_audio_credential(tmp_path: Path, monkeypatch) -> None:
    async with cli_listener(tmp_path, monkeypatch):
        monkeypatch.setenv("HUB_REALTIME_AUTH_TOKEN", TOKEN)
        with pytest.raises(ValueError, match="must not reuse"):
            load_runtime_config(tmp_path)


@pytest.mark.anyio
async def test_cli_audio_listener_authenticates_before_file_access_and_never_lists(tmp_path: Path, monkeypatch) -> None:
    async with cli_listener(tmp_path, monkeypatch) as server:
        audio = server.root / "reply.mp3"
        audio.write_bytes(b"audio-sentinel")
        url = server.url_for(audio)
        path = url.removeprefix("https://audio.example.test")
        assert path.startswith("/files/")
        assert TOKEN not in url and "reply" not in url
        for target in ("/", "/reply.mp3", path, f"{path}?token={TOKEN}"):
            status, body = await asyncio.to_thread(request, server.port, target)
            assert status in {400, 401}
            assert b"audio-sentinel" not in body and TOKEN.encode() not in body
        assert (await asyncio.to_thread(request, server.port, path, "invalid"))[0] == 401
        assert await asyncio.to_thread(request, server.port, path, TOKEN) == (200, b"audio-sentinel")
        for target in ("/", "/reply.mp3", "/../reply.mp3", "/%2e%2e/reply.mp3", "/files/%2e%2e%2freply.mp3"):
            status, body = await asyncio.to_thread(request, server.port, target, TOKEN)
            assert status == 404
            assert b"reply.mp3" not in body


@pytest.mark.anyio
async def test_cli_listener_bounds_partial_headers_and_recovers_at_deadline(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUDIO_MAX_REQUESTS", "2")
    monkeypatch.setenv("AUDIO_HEADER_TIMEOUT_SECONDS", "0.25")
    monkeypatch.setenv("AUDIO_IO_TIMEOUT_SECONDS", "0.2")
    async with cli_listener(tmp_path, monkeypatch) as server:
        clients = [socket.create_connection(("127.0.0.1", server.port), timeout=1) for _ in range(2)]
        try:
            for client in clients:
                client.sendall(b"GET / HTTP/1.1\r\nHost: incomplete")
            await asyncio.sleep(0.05)
            assert (await asyncio.to_thread(request, server.port, "/", TOKEN))[0] == 503
            # Dripping bytes cannot reset the absolute header deadline.
            await asyncio.sleep(0.1)
            for client in clients:
                client.sendall(b"x")
            await asyncio.sleep(0.25)
            for client in clients:
                assert await asyncio.to_thread(client.recv, 1024) == b""
            assert (await asyncio.to_thread(request, server.port, "/", TOKEN))[0] == 404
        finally:
            for client in clients:
                client.close()


@pytest.mark.anyio
async def test_cli_listener_bounds_file_bytes_and_registration_lifetime(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUDIO_MAX_RESPONSE_BYTES", "8")
    monkeypatch.setenv("AUDIO_MAX_FILES", "1")
    monkeypatch.setenv("AUDIO_FILE_TTL_SECONDS", "0.2")
    async with cli_listener(tmp_path, monkeypatch) as server:
        root = server.root
        path = root / "reply.mp3"
        path.write_bytes(b"12345678")
        target = server.url_for(path).removeprefix("https://audio.example.test")
        assert await asyncio.to_thread(request, server.port, target, TOKEN) == (200, b"12345678")
        with pytest.raises(RuntimeError, match="capacity"):
            server.url_for(path)
        await asyncio.sleep(0.3)
        assert (await asyncio.to_thread(request, server.port, target, TOKEN))[0] == 404
        path.write_bytes(b"123456789")
        with pytest.raises(ValueError, match="limit"):
            server.url_for(path)
        path.write_bytes(b"healthy")
        assert server.url_for(path).startswith("https://audio.example.test/files/")


def test_file_registration_rejects_symlinks_and_traversal(tmp_path: Path) -> None:
    server = StaticAudioServer(host="127.0.0.1", port=0, root=tmp_path, developer_mode=True)
    outside = tmp_path.parent / "outside-audio.mp3"
    outside.write_bytes(b"private")
    link = tmp_path / "link.mp3"
    link.symlink_to(outside)
    for path in (link, outside, tmp_path / ".." / "outside-audio.mp3"):
        with pytest.raises(ValueError, match="contained"):
            server.url_for(path)


@pytest.mark.anyio
async def test_cli_header_byte_limit_is_exact_and_socket_remains_healthy(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AUDIO_MAX_HEADER_BYTES", "256")
    async with cli_listener(tmp_path, monkeypatch) as server:
        prefix = f"GET / HTTP/1.1\r\nHost: local\r\nAuthorization: Bearer {TOKEN}\r\nX-Pad: ".encode("ascii")
        for size, status in ((256, b"404"), (257, b"431")):
            payload = prefix + b"x" * (size - len(prefix) - 4) + b"\r\n\r\n"
            def exchange():
                with socket.create_connection(("127.0.0.1", server.port), timeout=1) as client:
                    client.sendall(payload)
                    return client.recv(1024)
            assert status in await asyncio.to_thread(exchange)
        assert (await asyncio.to_thread(request, server.port, "/", TOKEN))[0] == 404


@pytest.mark.anyio
async def test_registered_audio_rechecks_aliases_and_repairs_permissions_before_serving(tmp_path: Path, monkeypatch) -> None:
    import os
    import stat

    async with cli_listener(tmp_path, monkeypatch) as server:
        audio = server.root / "reply.mp3"
        audio.write_bytes(b"safe")
        target = server.url_for(audio).removeprefix("https://audio.example.test")
        audio.chmod(0o666)
        assert await asyncio.to_thread(request, server.port, target, TOKEN) == (200, b"safe")
        assert stat.S_IMODE(audio.stat().st_mode) == 0o600
        outside = tmp_path / "outside.mp3"
        outside.write_bytes(b"outside private audio")
        audio.unlink()
        audio.symlink_to(outside)
        assert (await asyncio.to_thread(request, server.port, target, TOKEN))[0] == 404
        audio.unlink()
        os.link(outside, audio)
        assert (await asyncio.to_thread(request, server.port, target, TOKEN))[0] == 404
        with pytest.raises(ValueError, match="contained"):
            server.url_for(audio)
