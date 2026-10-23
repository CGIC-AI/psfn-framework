from __future__ import annotations

import asyncio
import importlib
import json
from http.client import HTTPConnection
from inspect import unwrap
from pathlib import Path
import socket
import threading

import pytest
from aioesphomeapi.model import VoiceAssistantAudioSettings
from websockets.asyncio.client import connect

from hub.cli.run import _run_realtime_runtime, _run_runtime
from hub.devices.realtime_server import RealtimeVoiceServer
from hub.storage.artifacts import ArtifactStore
from test_http_audio_security import configure_cli_listener_environment
from test_voice_runtime import _FakeClient, _FakeSTT


@pytest.fixture
def local_runtime(tmp_path: Path, monkeypatch):
    configure_cli_listener_environment(monkeypatch)
    ready = asyncio.Queue()
    use_realtime_listener = False

    async def endpoint_runtime(*, audio_server, **kwargs):
        await ready.put(audio_server)
        if use_realtime_listener:
            await _run_realtime_runtime(audio_server=audio_server, **kwargs)
        else:
            await asyncio.Future()

    monkeypatch.setattr(importlib.import_module("hub.cli.run"), "_run_realtime_runtime", endpoint_runtime)

    async def start(port=0, *, realtime_listener=False):
        nonlocal use_realtime_listener
        use_realtime_listener = realtime_listener
        monkeypatch.setenv("AUDIO_SERVER_PORT", str(port))
        task = asyncio.create_task(_run_runtime(tmp_path, artifact_cleanup_interval_seconds=0.01))
        started = asyncio.create_task(ready.get())
        done, _ = await asyncio.wait((task, started), timeout=2, return_when=asyncio.FIRST_COMPLETED)
        if task in done:
            started.cancel()
            await asyncio.gather(started, return_exceptions=True)
            await task
        assert started in done, "CLI listener did not start"
        return task, started.result()

    return start


async def wait_for_event(event: threading.Event) -> None:
    async with asyncio.timeout(2):
        while not event.is_set():
            await asyncio.sleep(0.001)


def listener_status(port: int) -> int:
    connection = HTTPConnection("127.0.0.1", port, timeout=1)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        response.read()
        return response.status
    finally:
        connection.close()


@pytest.fixture
def realtime_servers(monkeypatch):
    monkeypatch.setenv("REALTIME_VOICE_BIND_HOST", "127.0.0.1")
    monkeypatch.setenv("REALTIME_VOICE_PORT", "0")
    ready = asyncio.Queue()
    enter = RealtimeVoiceServer.__aenter__

    async def observed_enter(server):
        await enter(server)
        await ready.put(server)
        return server

    monkeypatch.setattr(RealtimeVoiceServer, "__aenter__", observed_enter)
    return ready


@pytest.fixture
def local_esphome_session(monkeypatch):
    monkeypatch.setenv("DEVICE_TRANSPORT", "hybrid")
    monkeypatch.setenv("ESPHOME_HOST", "esphome.example.test")
    subscribed = asyncio.Queue()
    callback_tasks = []
    controls = {"unsubscribe_error": None}

    class LocalSession:
        def __init__(self, target):
            self.client = _FakeClient()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def device_info(self):
            return None

        async def list_entities_services(self):
            return [], []

        def subscribe_voice_assistant(self, **callbacks):
            subscribed.put_nowait(callbacks)

            def unsubscribe():
                for task in callback_tasks:
                    task.cancel()
                if controls["unsubscribe_error"] is not None:
                    raise controls["unsubscribe_error"]

            return unsubscribe

        async def wait_disconnected(self):
            await asyncio.Future()

    monkeypatch.setattr(importlib.import_module("hub.cli.run"), "ESPHomeSession", LocalSession)
    return subscribed, callback_tasks, controls


@pytest.mark.anyio
@pytest.mark.parametrize("cancellations", [1, 2, 3])
@pytest.mark.parametrize("cleanup_fails", [False, True])
async def test_cli_cancellation_retains_cleanup_and_listener_until_safe_restart(
    local_runtime, monkeypatch, caplog, cancellations, cleanup_fails,
):
    task, audio = await local_runtime()
    port, listener, httpd = audio.port, audio._thread, audio._httpd
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    cleanup = ArtifactStore.cleanup

    def gated_cleanup(store):
        if threading.current_thread() is not threading.main_thread() and not entered.is_set():
            entered.set()
            try:
                assert release.wait(5), "cleanup gate was not released"
                if cleanup_fails:
                    raise RuntimeError("invented-private-cleanup-detail")
                return cleanup(store)
            finally:
                finished.set()
        return cleanup(store)

    monkeypatch.setattr(ArtifactStore, "cleanup", gated_cleanup)
    try:
        await wait_for_event(entered)
        for _ in range(cancellations):
            task.cancel()
            await asyncio.sleep(0.02)
        assert not task.done(), "CLI abandoned cleanup while its thread still owns artifacts"
        assert not finished.is_set()
        assert listener.is_alive()
        assert await asyncio.to_thread(listener_status, port) == 401
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert finished.is_set()
        assert not listener.is_alive()
        assert httpd.socket.fileno() == -1
        assert not any(t.get_name().startswith("hub-") for t in asyncio.all_tasks() if not t.done())
        if cleanup_fails:
            assert "Artifact cleanup failed" in caplog.text
            assert "invented-private-cleanup-detail" not in caplog.text
        audio.stop()
        audio.stop()
        assert not task.cancel()
        with socket.socket() as client:
            assert client.connect_ex(("127.0.0.1", port)) != 0
        restarted, replacement = await local_runtime(port)
        try:
            assert await asyncio.to_thread(listener_status, port) == 401
        finally:
            restarted.cancel()
            await asyncio.gather(restarted, return_exceptions=True)
            replacement.stop()
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        audio.stop()


@pytest.mark.anyio
async def test_cli_repeated_cancellation_closes_real_realtime_and_audio_listeners(
    local_runtime, realtime_servers, monkeypatch,
):
    task, audio = await local_runtime(realtime_listener=True)
    try:
        realtime = await asyncio.wait_for(realtime_servers.get(), 2)
        realtime_port, audio_port = realtime.port, audio.port
        realtime_socket = realtime._server.sockets[0]
        listener, httpd = audio._thread, audio._httpd
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert realtime_socket.fileno() == -1
        assert httpd.socket.fileno() == -1
        assert not listener.is_alive()
        assert not any(t.get_name().startswith("hub-") for t in asyncio.all_tasks() if not t.done())
        monkeypatch.setenv("REALTIME_VOICE_PORT", str(realtime_port))
        restarted, replacement = await local_runtime(audio_port, realtime_listener=True)
        try:
            fresh_realtime = await asyncio.wait_for(realtime_servers.get(), 2)
            assert fresh_realtime.port == realtime_port
            assert await asyncio.to_thread(listener_status, audio_port) == 401
        finally:
            restarted.cancel()
            await asyncio.gather(restarted, return_exceptions=True)
            replacement.stop()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        audio.stop()


@pytest.mark.anyio
async def test_cli_listener_stop_failure_still_releases_socket_and_closes_artifacts(local_runtime, monkeypatch):
    task, audio = await local_runtime()
    port, listener, httpd = audio.port, audio._thread, audio._httpd
    close_active = httpd.close_active
    closed_stores = []
    close_store = ArtifactStore.close

    def failing_close_active():
        close_active()
        raise RuntimeError("synthetic listener stop failure")

    def observed_close(store):
        closed_stores.append(store.root)
        close_store(store)

    monkeypatch.setattr(httpd, "close_active", failing_close_active)
    monkeypatch.setattr(ArtifactStore, "close", observed_close)
    try:
        task.cancel()
        with pytest.raises(RuntimeError, match="synthetic listener stop failure"):
            await task
        assert not listener.is_alive()
        assert httpd.socket.fileno() == -1
        assert audio.root in closed_stores
        assert len(set(closed_stores)) == 2
        restarted, replacement = await local_runtime(port)
        try:
            assert await asyncio.to_thread(listener_status, port) == 401
        finally:
            restarted.cancel()
            await asyncio.gather(restarted, return_exceptions=True)
            replacement.stop()
    finally:
        monkeypatch.setattr(httpd, "close_active", close_active)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        audio.stop()


@pytest.mark.anyio
@pytest.mark.parametrize("agent_close_fails", [False, True])
async def test_cli_waits_for_provider_teardown_and_attempts_every_provider_close(
    local_runtime, monkeypatch, agent_close_fails,
):
    module = importlib.import_module("hub.cli.run")
    monkeypatch.setenv("DEVICE_TRANSPORT", "hybrid")
    monkeypatch.setenv("ESPHOME_HOST", "esphome.example.test")
    session_entered, close_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    closed = []

    class LocalESPHomeSession:
        def __init__(self, target):
            pass

        async def __aenter__(self):
            session_entered.set()
            await asyncio.Future()

        async def __aexit__(self, *args):
            pass

    def provider(name):
        class LocalProvider:
            def __init__(self, **kwargs):
                pass

            async def aclose(self):
                if name == "agent":
                    close_entered.set()
                    await release.wait()
                closed.append(name)
                if name == "agent" and agent_close_fails:
                    raise RuntimeError("synthetic provider close failure")

        return LocalProvider

    monkeypatch.setattr(module, "ESPHomeSession", LocalESPHomeSession)
    monkeypatch.setattr(module, "PsfnStreamingProvider", provider("agent"))
    monkeypatch.setattr(module, "DeepgramLiveSTTProvider", provider("stt"))
    monkeypatch.setattr(module, "ElevenLabsStreamingTTS", provider("tts"))
    task, audio = await local_runtime()
    listener, httpd = audio._thread, audio._httpd
    try:
        await asyncio.wait_for(session_entered.wait(), 2)
        task.cancel()
        await asyncio.wait_for(close_entered.wait(), 2)
        for _ in range(2):
            task.cancel()
            await asyncio.sleep(0.01)
        assert not task.done(), "CLI abandoned an in-progress provider close"
        release.set()
        if agent_close_fails:
            with pytest.raises(ExceptionGroup, match="TaskGroup"):
                await task
        else:
            with pytest.raises(asyncio.CancelledError):
                await task
        assert closed == ["agent", "stt", "tts"]
        assert not listener.is_alive()
        assert httpd.socket.fileno() == -1
        assert not any(t.get_name().startswith("hub-") for t in asyncio.all_tasks() if not t.done())
    finally:
        release.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        audio.stop()


@pytest.mark.anyio
@pytest.mark.parametrize("responding", [False, True])
@pytest.mark.parametrize("cleanup_failure", [None, "abort", "artifacts", "unsubscribe"])
async def test_cli_joins_active_esphome_turn_tasks_before_closing_providers(
    local_runtime, local_esphome_session, monkeypatch, responding, cleanup_failure,
):
    cleanup_error_enabled = True
    module = importlib.import_module("hub.cli.run")
    subscribed, _, session_controls = local_esphome_session
    if cleanup_failure == "unsubscribe":
        session_controls["unsubscribe_error"] = RuntimeError("Synthetic unsubscribe failure")
    response_entered = asyncio.Event()
    providers = []

    class LocalProvider(_FakeSTT):
        def __init__(self, **kwargs):
            super().__init__()
            self.closed = False
            providers.append(self)

        async def finish_turn(self):
            response_entered.set()
            await asyncio.Future()

        async def aclose(self):
            self.closed = True

        async def abort_turn(self):
            await super().abort_turn()
            if cleanup_error_enabled and cleanup_failure == "abort":
                raise RuntimeError("Synthetic active turn abort failure")

    for name in ("PsfnStreamingProvider", "DeepgramLiveSTTProvider", "ElevenLabsStreamingTTS"):
        monkeypatch.setattr(module, name, LocalProvider)
    task, audio = await local_runtime()
    turn_tasks = []
    try:
        callbacks = await asyncio.wait_for(subscribed.get(), 2)
        await callbacks["handle_start"]("invented-turn", 0, VoiceAssistantAudioSettings(), None)
        voice = unwrap(callbacks["handle_start"]).__self__
        close_artifacts = voice._artifacts.close

        def observed_close():
            close_artifacts()
            if cleanup_error_enabled and cleanup_failure == "artifacts":
                raise RuntimeError("Synthetic active turn artifact close failure")

        monkeypatch.setattr(voice._artifacts, "close", observed_close)
        turn_tasks.append(voice._watchdog_task)
        if responding:
            response = asyncio.create_task(callbacks["handle_stop"](False))
            turn_tasks.append(response)
            await asyncio.wait_for(response_entered.wait(), 2)
        task.cancel()
        await asyncio.sleep(0.02)
        assert task.done(), "CLI reconnected after a shutdown failure"
        if cleanup_failure is not None:
            with pytest.raises(ExceptionGroup, match="TaskGroup"):
                await task
        else:
            with pytest.raises(asyncio.CancelledError):
                await task
        assert all(turn.done() for turn in turn_tasks), "CLI abandoned an active voice turn task"
        assert voice._active is None
        assert all(provider.closed and not provider.active for provider in providers)
    finally:
        cleanup_error_enabled = False
        session_controls["unsubscribe_error"] = None
        task.cancel()
        if not task.done():
            for owned in asyncio.all_tasks():
                if owned.get_coro().__qualname__ == "_run_esphome_runtime":
                    owned.cancel()
        for turn in turn_tasks:
            turn.cancel()
        await asyncio.gather(task, *turn_tasks, return_exceptions=True)
        audio.stop()


@pytest.mark.anyio
async def test_cli_joins_inflight_esphome_callback_cancellation_cleanup(
    local_runtime, local_esphome_session, monkeypatch,
):
    subscribed, callback_tasks, _ = local_esphome_session
    start_entered, cancel_entered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    closed = []

    class LocalProvider(_FakeSTT):
        def __init__(self, **kwargs):
            super().__init__()

        async def start_turn(self, session_id):
            start_entered.set()
            try:
                await asyncio.Future()
            finally:
                cancel_entered.set()
                await release.wait()

        async def aclose(self):
            closed.append(self)

    module = importlib.import_module("hub.cli.run")
    for name in ("PsfnStreamingProvider", "DeepgramLiveSTTProvider", "ElevenLabsStreamingTTS"):
        monkeypatch.setattr(module, name, LocalProvider)
    task, audio = await local_runtime()
    try:
        callbacks = await asyncio.wait_for(subscribed.get(), 2)
        start = asyncio.create_task(callbacks["handle_start"]("invented-start", 0, VoiceAssistantAudioSettings(), None))
        callback_tasks.append(start)
        await asyncio.wait_for(start_entered.wait(), 2)
        task.cancel()
        await asyncio.wait_for(cancel_entered.wait(), 2)
        task.cancel()
        await asyncio.sleep(0.02)
        assert not task.done(), "CLI abandoned a device callback's cancellation cleanup"
        assert not start.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert start.done()
        assert len(closed) == 3
    finally:
        release.set()
        task.cancel()
        for callback in callback_tasks:
            callback.cancel()
        await asyncio.gather(task, *callback_tasks, return_exceptions=True)
        audio.stop()


@pytest.mark.anyio
@pytest.mark.parametrize("failing_provider", ["stt", "tts", "agent"])
async def test_cli_connected_realtime_provider_failure_still_closes_every_resource(
    local_runtime, realtime_servers, monkeypatch, failing_provider,
):
    closed = []
    closed_stores = set()
    close_store = ArtifactStore.close

    def provider(name):
        class LocalProvider(_FakeSTT):
            def __init__(self, **kwargs):
                super().__init__()

            async def aclose(self):
                closed.append(name)
                if name == failing_provider:
                    raise RuntimeError("Synthetic close failure")

        return LocalProvider

    def observed_close(store):
        closed_stores.add(store)
        close_store(store)

    module = importlib.import_module("hub.devices.realtime_server")
    monkeypatch.setattr(module, "DeepgramLiveSTTProvider", provider("stt"))
    monkeypatch.setattr(module, "ElevenLabsStreamingTTS", provider("tts"))
    monkeypatch.setattr(module, "PsfnStreamingProvider", provider("agent"))
    monkeypatch.setattr(ArtifactStore, "close", observed_close)
    task, audio = await local_runtime(realtime_listener=True)
    listener, httpd = audio._thread, audio._httpd
    try:
        realtime = await asyncio.wait_for(realtime_servers.get(), 2)
        async with connect(
            f"ws://127.0.0.1:{realtime.port}",
            additional_headers={"Authorization": "Bearer RT_8bQ6ZcP4fV9mR2tY7aS3dG5hJ0kL1nW_uEoXiCvBN"},
        ) as client:
            assert json.loads(await client.recv())["type"] == "session.ready"
            await client.send(json.dumps({"type": "turn.start"}))
            await client.send(json.dumps({"type": "audio", "audio": "AQACAAMA"}))
            await client.send(json.dumps({"type": "turn.end"}))
            async with asyncio.timeout(2):
                while json.loads(await client.recv())["type"] != "turn.no_input":
                    pass
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert closed == ["stt", "tts", "agent"]
        assert len(closed_stores) == 3
        assert not listener.is_alive()
        assert httpd.socket.fileno() == -1
        assert realtime._server is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        audio.stop()
