from __future__ import annotations

from functools import partial
from http.server import BaseHTTPRequestHandler
import os
from pathlib import Path
import re
import threading
import time
import uuid

from hub.security.audio_access import AudioAccess
from hub.media.audio_limits import AudioLimits
from hub.media.audio_http_server import BoundedAudioHTTPServer, shutdown_socket
from hub.media.live_audio import AudioStreamUnavailable, LiveAudioStream, StreamBuffer
from hub.storage.artifacts import ArtifactStore


class _HeaderLimitReached(Exception):
    pass


class _HeaderReader:
    def __init__(self, source, limit: int) -> None:
        self._source, self._remaining = source, limit

    def readline(self, size: int = -1) -> bytes:
        line = self._source.readline(min(size, self._remaining + 1) if size >= 0 else self._remaining + 1)
        self._remaining -= len(line)
        if self._remaining < 0:
            raise _HeaderLimitReached()
        return line

    def close(self) -> None:
        self._source.close()


class _AudioRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, owner: StaticAudioServer, **kwargs) -> None:
        self._owner = owner
        self._deadline: threading.Timer | None = None
        super().__init__(*args, **kwargs)

    def setup(self) -> None:
        super().setup()
        self.rfile = _HeaderReader(self.rfile, self._owner._limits.max_header_bytes)
        self._set_deadline(self._owner._limits.header_timeout_seconds)

    def _set_deadline(self, seconds: float) -> None:
        if self._deadline is not None:
            self._deadline.cancel()
        self._deadline = threading.Timer(seconds, shutdown_socket, args=(self.connection,))
        self._deadline.daemon = True
        self._deadline.start()

    def parse_request(self) -> bool:
        parsed = super().parse_request()
        self._set_deadline(self._owner._limits.response_timeout_seconds)
        self.close_connection = True
        return parsed

    def handle_one_request(self) -> None:
        self.requestline, self.request_version, self.command = "", "HTTP/1.0", None
        try:
            super().handle_one_request()
        except _HeaderLimitReached:
            self.send_error(431)

    def finish(self) -> None:
        if self._deadline is not None:
            self._deadline.cancel()
        super().finish()

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        self.close_connection = True
        try:
            rejected = self._owner._access.reject_status(self, self.client_address[0])
            if rejected:
                self._empty_response(rejected)
                return
            match = re.fullmatch(r"/(files|streams)/([0-9a-f]{32})", self.path)
            if match is None:
                self._empty_response(404)
            elif match[1] == "streams":
                self._serve_stream(match[2])
            else:
                self._serve_file(match[2])
        except (OSError, TimeoutError, ValueError, AudioStreamUnavailable):
            self.close_connection = True

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def send_error(self, code, message=None, explain=None) -> None:
        # Never reflect request text, parser errors, paths, or exception details.
        self._empty_response(code)

    def _empty_response(self, status: int) -> None:
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.send_header("Connection", "close")
        self.end_headers()

    def _serve_file(self, file_id: str) -> None:
        self._owner.purge_expired()
        entry = self._owner._files.get(file_id)
        relative = entry[0] if entry is not None else None
        if relative is None:
            self._empty_response(404)
            return
        try:
            descriptor = self._owner._open_file(relative)
        except (OSError, ValueError):
            self._empty_response(404)
            return
        with os.fdopen(descriptor, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            if size > self._owner._limits.max_response_bytes:
                self._empty_response(413)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command == "HEAD":
                return
            remaining = size
            while remaining:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _serve_stream(self, stream_id: str) -> None:
        if self.command == "HEAD":
            self._empty_response(404)
            return
        stream = self._owner._resolve_stream(stream_id)
        if stream is None:
            self._empty_response(404)
            return
        try:
            self.send_response(200)
            self.send_header("Content-Type", stream.content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            while True:
                chunk = stream.next_chunk()
                if chunk is None:
                    self.wfile.write(b"0\r\n\r\n")
                    break
                self.wfile.write(f"{len(chunk):X}\r\n".encode("ascii"))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
        finally:
            self._owner._remove_stream(stream_id)


class StaticAudioServer:
    def __init__(
        self, *, host: str, port: int, root: Path,
        public_host: str | None = None, public_port: int | None = None,
        public_base_url: str | None = None, relay_token: str | None = None,
        developer_mode: bool = False,
        limits: AudioLimits | None = None,
    ) -> None:
        advertised_host = public_host or host
        advertised_port = public_port if public_port is not None else port
        if ":" in advertised_host:
            advertised_host = f"[{advertised_host}]"
        self._access = AudioAccess(
            host=host, relay_token=relay_token, developer_mode=developer_mode,
            public_base_url=public_base_url or f"http://{advertised_host}:{advertised_port}",
        )
        self._host, self._port, self._root = host, port, root
        self._limits = limits or AudioLimits()
        self._artifacts = ArtifactStore(root, max_file_bytes=self._limits.max_response_bytes)
        self._root = self._artifacts.root
        self._httpd: BoundedAudioHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._streams: dict[str, StreamBuffer] = {}
        self._streams_lock = threading.Lock()
        self._files: dict[str, tuple[Path, float]] = {}
        self._files_lock = threading.Lock()

    @property
    def port(self) -> int:
        return self._httpd.server_port if self._httpd is not None else self._port

    @property
    def root(self) -> Path:
        return self._root

    @property
    def artifact_store(self) -> ArtifactStore:
        return self._artifacts

    def start(self) -> None:
        if self._httpd is not None:
            return
        self._artifacts.cleanup()
        handler = partial(_AudioRequestHandler, owner=self)
        self._httpd = BoundedAudioHTTPServer((self._host, self._port), handler, owner=self)
        self._thread = threading.Thread(target=partial(self._httpd.serve_forever, poll_interval=0.05), daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self._streams_lock:
            for stream in self._streams.values():
                stream.abort()
            self._streams.clear()
        with self._files_lock:
            self._files.clear()
        if self._httpd is None:
            self._artifacts.close()
            return
        self._httpd.shutdown()
        self._httpd.close_active()
        self._httpd.server_close()
        self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        self._artifacts.close()

    def _open_file(self, relative: Path) -> int:
        return self._artifacts.open_read(self._root / relative)

    def url_for(self, path: Path) -> str:
        try:
            relative = path.absolute().relative_to(self._root.absolute())
            if ".." in relative.parts:
                raise ValueError()
            descriptor = self._open_file(relative)
            try:
                if os.fstat(descriptor).st_size > self._limits.max_response_bytes:
                    raise ValueError("Audio file exceeds byte limit")
            finally:
                os.close(descriptor)
        except (OSError, ValueError):
            raise ValueError("Audio file must be a contained regular file without symlinks and within byte limit") from None
        self.purge_expired()
        file_id = uuid.uuid4().hex
        with self._files_lock:
            if len(self._files) >= self._limits.max_files:
                raise RuntimeError("Audio file registry capacity exceeded")
            self._files[file_id] = (relative, time.monotonic())
        return f"{self._access.public_base_url.rstrip('/')}/files/{file_id}"

    def purge_expired(self) -> None:
        now = time.monotonic()
        with self._files_lock:
            for file_id, (_, created) in list(self._files.items()):
                if now - created >= self._limits.file_ttl_seconds:
                    self._files.pop(file_id)
        with self._streams_lock:
            for stream_id, stream in list(self._streams.items()):
                if stream.expire():
                    self._streams.pop(stream_id)

    def open_stream(self, *, content_type: str = "audio/mpeg") -> LiveAudioStream:
        if content_type not in {"audio/mpeg", "audio/wav", "audio/ogg", "audio/pcm", "audio/flac"}:
            raise ValueError("Unsupported audio content type")
        self.purge_expired()
        stream_id = uuid.uuid4().hex
        buffer = StreamBuffer(content_type, self._limits)
        with self._streams_lock:
            if len(self._streams) >= self._limits.max_streams:
                raise RuntimeError("Audio stream registry capacity exceeded")
            self._streams[stream_id] = buffer
        return LiveAudioStream(
            stream_id=stream_id, url=f"{self._access.public_base_url.rstrip('/')}/streams/{stream_id}",
            buffer=buffer,
        )

    def _resolve_stream(self, stream_id: str) -> StreamBuffer | None:
        self.purge_expired()
        with self._streams_lock:
            stream = self._streams.get(stream_id)
            return stream if stream is not None and stream.claim() else None

    def _remove_stream(self, stream_id: str) -> None:
        with self._streams_lock:
            stream = self._streams.pop(stream_id, None)
            if stream is not None:
                stream.abort()
