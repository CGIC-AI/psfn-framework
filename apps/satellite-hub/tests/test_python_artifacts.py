from __future__ import annotations

import os
from pathlib import Path
import stat
import time
import threading

from aioesphomeapi.model import VoiceAssistantAudioSettings
import pytest

from hub.storage.artifacts import ArtifactStore
from hub.util import write_json
from test_voice_runtime import _make_streaming_runtime


def test_artifact_store_repairs_modes_and_atomically_writes_reads_appends_with_open_umask(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    root.mkdir(mode=0o777)
    root.chmod(0o777)
    previous = os.umask(0)
    try:
        store = ArtifactStore(root)
        root = store.root
        path = root / "turn" / "transcript.json"
        store.write_json(path, {"text": "invented private content"})
        assert stat.S_IMODE(root.stat().st_mode) == 0o700
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        path.chmod(0o666)
        store.append_bytes(path, b"\n")
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert b"invented private content" in store.read_bytes(path)
        store.write_bytes(path, b"replaced")
        assert store.read_bytes(path) == b"replaced"
        explicit = tmp_path / "operator-export.json"
        write_json(explicit, {"device": "invented"})
        assert stat.S_IMODE(explicit.stat().st_mode) == 0o600
    finally:
        os.umask(previous)


def test_artifact_store_rejects_escape_symlinks_and_hardlink_aliases_without_touching_outside(tmp_path: Path) -> None:
    root, outside = tmp_path / "artifacts", tmp_path / "outside"
    outside.mkdir()
    secret = outside / "secret.json"
    secret.write_bytes(b"unchanged")
    store = ArtifactStore(root)
    root = store.root
    (root / "middle").symlink_to(outside, target_is_directory=True)
    (root / "destination.json").symlink_to(secret)
    os.link(secret, root / "hardlink.json")
    targets = [
        root / "../outside/secret.json", tmp_path / "artifacts-sibling/secret.json",
        root / "middle/secret.json", root / "destination.json", root / "hardlink.json",
    ]
    for path in targets:
        for operation in (lambda: store.write_bytes(path, b"no"), lambda: store.append_bytes(path, b"no"), lambda: store.read_bytes(path)):
            with pytest.raises(ValueError, match="artifact"):
                operation()
    root_link = tmp_path / "root-link"
    root_link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="artifact"):
        ArtifactStore(root_link)
    (tmp_path / "ancestor-link").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="artifact"):
        ArtifactStore(tmp_path / "ancestor-link/child")
    assert secret.read_bytes() == b"unchanged"


def test_retention_covers_every_format_on_startup_and_close_and_never_follows_links(tmp_path: Path) -> None:
    root = tmp_path / "artifacts"
    root.mkdir()
    unrelated = root / "unrelated.json"
    unrelated.write_bytes(b"unrelated")
    root = root / ".hub-artifacts-v1"
    root.mkdir()
    formats = ("audio.pcm", "audio.wav", "reply.mp3", "reply.flac", "transcript.json", "reply.json", "events.jsonl", "device_info.json")
    old = time.time() - 25 * 3600
    for filename in formats:
        path = root / filename
        path.write_bytes(b"expired")
        os.utime(path, (old, old))
    fresh = root / "fresh.json"
    fresh.write_bytes(b"fresh")
    outside = tmp_path / "outside.json"
    outside.write_bytes(b"outside")
    os.utime(outside, (old, old))
    (root / "link.json").symlink_to(outside)
    store = ArtifactStore(root)
    assert not any((root / filename).exists() for filename in formats)
    assert fresh.read_bytes() == b"fresh" and outside.read_bytes() == b"outside"
    store.write_bytes(root / "reply.json", b"late")
    os.utime(root / "reply.json", (old, old))
    store.close()
    assert not (root / "reply.json").exists()
    assert fresh.exists() and (root / "link.json").is_symlink()
    assert unrelated.read_bytes() == b"unrelated"


def test_broad_roots_are_rejected_and_operator_exports_never_sweep_siblings(tmp_path: Path) -> None:
    for root in (Path("/"), Path.home(), Path.cwd(), Path.cwd().parent):
        with pytest.raises(ValueError, match="root"):
            ArtifactStore(root)
    unrelated = tmp_path / "audio.pcm"
    unrelated.write_bytes(b"unrelated expired file")
    old = time.time() - 200 * 3600
    os.utime(unrelated, (old, old))
    write_json(tmp_path / "operator-export.json", {"export": "invented"})
    assert unrelated.read_bytes() == b"unrelated expired file"


def test_shared_namespace_cleanup_cannot_unlink_a_fresh_concurrent_append(tmp_path: Path, monkeypatch) -> None:
    first, second = ArtifactStore(tmp_path), ArtifactStore(tmp_path)
    path = first.root / "events.jsonl"
    first.write_bytes(path, b"old")
    old = time.time() - 25 * 3600
    os.utime(path, (old, old))
    inode = path.stat().st_ino
    snapshot, proceed, attempted = threading.Event(), threading.Event(), threading.Event()
    original = os.fstat
    failures = []

    def pause_snapshot(descriptor):
        info = original(descriptor)
        if info.st_ino == inode and threading.current_thread().name == "artifact-cleanup-test":
            snapshot.set()
            assert proceed.wait(2)
        return info

    def clean():
        try:
            first.cleanup()
        except Exception as error:
            failures.append(error)

    def append():
        attempted.set()
        try:
            second.append_bytes(path, b"fresh")
        except Exception as error:
            failures.append(error)

    monkeypatch.setattr(os, "fstat", pause_snapshot)
    cleaner = threading.Thread(target=clean, name="artifact-cleanup-test")
    writer = threading.Thread(target=append)
    cleaner.start()
    assert snapshot.wait(2)
    writer.start()
    assert attempted.wait(2)
    proceed.set()
    cleaner.join(2)
    writer.join(2)
    assert not cleaner.is_alive() and not writer.is_alive() and failures == []
    assert second.read_bytes(path) == b"fresh"


@pytest.mark.anyio
async def test_idle_runtime_and_audio_artifacts_expire_periodically_and_cleanup_task_is_disposed(tmp_path, monkeypatch) -> None:
    import asyncio
    import hub.storage.artifacts as artifact_module
    from test_http_audio_security import cli_listener

    current = time.time()
    monkeypatch.setattr(artifact_module, "artifact_time", lambda: current)
    async with cli_listener(tmp_path, monkeypatch, artifact_cleanup_interval_seconds=0.02) as server:
        main = ArtifactStore.namespace_path(tmp_path / ".artifacts/runtime")
        paths = (main / "transcript.json", server.root / "reply.mp3")
        for path in paths:
            path.write_bytes(b"expired invented data")
        current += 25 * 3600
        fresh = main / "reply.json"
        fresh.write_bytes(b"fresh")
        os.utime(fresh, (current, current))
        for _ in range(50):
            if all(not path.exists() for path in paths):
                break
            await asyncio.sleep(0.02)
        assert all(not path.exists() for path in paths)
        assert fresh.read_bytes() == b"fresh"
    assert not any(task.get_name() == "hub-artifact-cleanup" and not task.done() for task in asyncio.all_tasks())


@pytest.mark.parametrize("hours", [0, -1, 169, float("nan"), float("inf")])
def test_retention_policy_rejects_unbounded_or_invalid_hours(tmp_path: Path, hours) -> None:
    with pytest.raises(ValueError, match="retention"):
        ArtifactStore(tmp_path, retention_hours=hours)


@pytest.mark.anyio
async def test_real_streaming_runtime_uses_private_opaque_artifact_paths(tmp_path: Path) -> None:
    sentinel = "invented-private-id-9qR"
    runtime, _, _ = _make_streaming_runtime(
        tmp_path, agent_steps=[(0, "invented reply")], transcript_text="invented transcript",
        announcement_delay=0, reply_timeout=1,
    )
    await runtime.handle_start(sentinel + "/../outside", 0, VoiceAssistantAudioSettings(), "invented wake phrase")
    await runtime.handle_stop(False)
    paths = list(tmp_path.rglob("*"))
    assert any(path.name == "transcript.json" for path in paths)
    assert all(sentinel not in str(path.relative_to(tmp_path)) for path in paths)
    assert all(stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600) for path in paths)
