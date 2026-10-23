from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid
import weakref


_NAMESPACE_LOCKS: weakref.WeakValueDictionary = weakref.WeakValueDictionary()
_NAMESPACE_LOCKS_GUARD = threading.Lock()


def _namespace_lock(root: Path):
    with _NAMESPACE_LOCKS_GUARD:
        key = str(root)
        lock = _NAMESPACE_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _NAMESPACE_LOCKS[key] = lock
        return lock


def artifact_time() -> float:
    return time.time()


def _directory(path: Path, *, create: bool) -> int:
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.absolute().parts[1:]:
            if part in {".", ".."}:
                raise ValueError("Unsafe artifact directory")
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _regular(descriptor: int) -> os.stat_result:
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError("Unsafe artifact file")
    os.fchmod(descriptor, 0o600)
    return info


class ArtifactStore:
    """Descriptor-relative private files; paths never authorize escaping this root."""

    def __init__(self, root: Path, *, retention_hours: float | None = None, max_file_bytes: int = 16 * 1024 * 1024) -> None:
        try:
            hours = retention_hours if retention_hours is not None else float(os.getenv("HUB_ARTIFACT_RETENTION_HOURS", "24"))
        except ValueError:
            raise ValueError("Invalid artifact retention policy") from None
        if not math.isfinite(hours) or not 1 <= hours <= 168:
            raise ValueError("Artifact retention must be between 1 and 168 hours")
        if max_file_bytes < 1:
            raise ValueError("Artifact file capacity must be positive")
        anchor = root.absolute()
        if (len(anchor.parts) < 3 or anchor == Path.home() or anchor.parent == Path("/home") or anchor == Path.cwd()
                or (anchor / ".git").exists()
                or anchor in Path.cwd().parents or ".." in anchor.parts):
            raise ValueError("Unsafe artifact root")
        self.root = self.namespace_path(anchor)
        self._retention_seconds = hours * 3600
        self._max_file_bytes = max_file_bytes
        self._lock = _namespace_lock(self.root)
        self._last_cleanup = 0.0
        self._private_export = False
        try:
            descriptor = _directory(anchor, create=True)
            try:
                os.fchmod(descriptor, 0o700)
            finally:
                os.close(descriptor)
        except OSError:
            raise ValueError("Unsafe artifact root") from None
        self.directory(self.root)
        self.cleanup()

    @staticmethod
    def namespace_path(root: Path) -> Path:
        return root.absolute() if root.name == ".hub-artifacts-v1" else root.absolute() / ".hub-artifacts-v1"

    @classmethod
    def write_private_bytes(cls, path: Path, data: bytes) -> None:
        """Explicit operator export: secure one file, never sweep its siblings."""
        writer = cls.__new__(cls)
        writer.root = path.parent.absolute()
        writer._lock = _namespace_lock(writer.root)
        writer._retention_seconds = None
        writer._max_file_bytes = 16 * 1024 * 1024
        writer._last_cleanup = time.monotonic()
        writer._private_export = True
        writer.write_bytes(path, data)

    def _relative(self, path: Path) -> Path:
        try:
            relative = path.absolute().relative_to(self.root)
            if ".." in relative.parts:
                raise ValueError()
            return relative
        except ValueError:
            raise ValueError("Unsafe artifact path") from None

    @contextmanager
    def _parent(self, path: Path, *, create: bool = True):
        descriptor = None
        try:
            relative = self._relative(path)
            if not relative.parts:
                raise ValueError("Artifact file requires a name")
            descriptor = _directory(self.root, create=create)
            if not self._private_export:
                os.fchmod(descriptor, 0o700)
            for part in relative.parts[:-1]:
                if create:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.fchmod(child, 0o700)
                os.close(descriptor)
                descriptor = child
            yield descriptor, relative.name
        except OSError:
            raise ValueError("Unsafe or unavailable artifact path") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def directory(self, path: Path) -> Path:
        relative = self._relative(path)
        try:
            descriptor = _directory(self.root, create=True)
            try:
                os.fchmod(descriptor, 0o700)
                for part in relative.parts:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                    os.fchmod(child, 0o700)
                    os.close(descriptor)
                    descriptor = child
            finally:
                os.close(descriptor)
        except OSError:
            raise ValueError("Unsafe artifact directory") from None
        return self.root / relative

    def _maybe_cleanup(self) -> None:
        if self._retention_seconds is not None and time.monotonic() - self._last_cleanup >= 60:
            self.cleanup()

    def write_bytes(self, path: Path, data: bytes) -> None:
        if len(data) > self._max_file_bytes:
            raise ValueError("Artifact byte limit exceeded")
        self._maybe_cleanup()
        with self._lock, self._parent(path) as (parent, name):
            try:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError("Unsafe artifact destination")
            except FileNotFoundError:
                pass
            temporary = f".pending-{uuid.uuid4().hex}"
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                _regular(descriptor)
                with os.fdopen(descriptor, "wb", closefd=False) as output:
                    output.write(data)
                    output.flush()
                    os.fsync(descriptor)
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
                os.fsync(parent)
            finally:
                os.close(descriptor)
                try:
                    os.unlink(temporary, dir_fd=parent)
                except FileNotFoundError:
                    pass

    def append_bytes(self, path: Path, data: bytes) -> None:
        self._maybe_cleanup()
        with self._lock, self._parent(path) as (parent, name):
            descriptor = os.open(name, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            try:
                info = _regular(descriptor)
                if info.st_size + len(data) > self._max_file_bytes:
                    raise ValueError("Artifact byte limit exceeded")
                remaining = memoryview(data)
                while remaining:
                    written = os.write(descriptor, remaining)
                    remaining = remaining[written:]
            finally:
                os.close(descriptor)

    def read_bytes(self, path: Path) -> bytes:
        with self._lock, self._parent(path, create=False) as (parent, name):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = _regular(descriptor)
                if info.st_size > self._max_file_bytes:
                    raise ValueError("Artifact byte limit exceeded")
                with os.fdopen(descriptor, "rb", closefd=False) as source:
                    data = source.read(self._max_file_bytes + 1)
                if len(data) > self._max_file_bytes:
                    raise ValueError("Artifact byte limit exceeded")
                return data
            finally:
                os.close(descriptor)

    def open_read(self, path: Path) -> int:
        with self._parent(path, create=False) as (parent, name):
            descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                if _regular(descriptor).st_size > self._max_file_bytes:
                    raise ValueError("Artifact byte limit exceeded")
                return descriptor
            except BaseException:
                os.close(descriptor)
                raise

    def write_json(self, path: Path, data) -> None:
        from hub.util import to_jsonable
        self.write_bytes(path, (json.dumps(to_jsonable(data), indent=2, sort_keys=True) + "\n").encode("utf-8"))

    def remove(self, path: Path) -> None:
        with self._lock, self._parent(path, create=False) as (parent, name):
            os.unlink(name, dir_fd=parent)

    def cleanup(self) -> None:
        cutoff = artifact_time() - self._retention_seconds

        def visit(parent: int, depth: int = 0) -> None:
            if depth > 64:
                raise ValueError("Artifact directory depth exceeded")
            with os.scandir(parent) as entries:
                for entry in entries:
                    try:
                        info = entry.stat(follow_symlinks=False)
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                            try:
                                os.fchmod(child, 0o700)
                                visit(child, depth + 1)
                            finally:
                                os.close(child)
                            if info.st_mtime <= cutoff:
                                try:
                                    os.rmdir(entry.name, dir_fd=parent)
                                except OSError:
                                    pass  # Fresh children retain this directory.
                        elif (stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                              and re.fullmatch(r"(?:audio\.(?:pcm|wav)|reply\.(?:mp3|flac)|(?:reply|transcript|manifest|device_info)\.json|(?:runtime-)?events\.jsonl|[0-9a-f]{32}\.(?:mp3|flac|wav|ogg)|\.pending-[0-9a-f]{32})", entry.name)):
                            descriptor = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                            try:
                                current = _regular(descriptor)
                                if current.st_mtime <= cutoff:
                                    os.unlink(entry.name, dir_fd=parent)
                            finally:
                                os.close(descriptor)
                    except FileNotFoundError:
                        continue  # Another bounded cleanup may have won this entry.

        try:
            with self._lock:
                descriptor = _directory(self.root, create=False)
                try:
                    os.fchmod(descriptor, 0o700)
                    visit(descriptor)
                finally:
                    os.close(descriptor)
                self._last_cleanup = time.monotonic()
        except OSError:
            raise ValueError("Artifact cleanup failed") from None

    def close(self) -> None:
        self.cleanup()
