from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import queue
import threading
from typing import Callable
from urllib.parse import urlsplit
import uuid


_STREAM_END = object()


@dataclass(slots=True)
class _RegisteredStream:
    content_type: str
    chunks: "queue.Queue[bytes | object]"


class LiveAudioStream:
    def __init__(
        self,
        *,
        stream_id: str,
        url: str,
        content_type: str,
        queue_obj: "queue.Queue[bytes | object]",
    ) -> None:
        self.stream_id = stream_id
        self.url = url
        self.content_type = content_type
        self._queue = queue_obj
        self._closed = False

    def write(self, data: bytes) -> None:
        if self._closed or not data:
            return
        self._queue.put(data)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.put(_STREAM_END)


class _AudioRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(
        self,
        *args,
        directory: str,
        resolve_stream: Callable[[str], _RegisteredStream | None],
        remove_stream: Callable[[str], None],
        **kwargs,
    ) -> None:
        self._resolve_stream = resolve_stream
        self._remove_stream = remove_stream
        super().__init__(*args, directory=directory, **kwargs)

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/streams/"):
            self._serve_stream(path.rsplit("/", 1)[-1])
            return
        super().do_GET()

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def _serve_stream(self, stream_id: str) -> None:
        stream = self._resolve_stream(stream_id)
        if stream is None:
            self.send_error(404, "Unknown stream")
            return

        completed = False
        try:
            self.send_response(200)
            self.send_header("Content-Type", stream.content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            while True:
                chunk = stream.chunks.get()
                if chunk is _STREAM_END:
                    completed = True
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    break
                payload = bytes(chunk)
                if not payload:
                    continue
                self.wfile.write(f"{len(payload):X}\r\n".encode("ascii"))
                self.wfile.write(payload)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            if not completed:
                try:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except Exception:
                    pass
            self._remove_stream(stream_id)


class StaticAudioServer:
    def __init__(self, *, host: str, port: int, root: Path, public_host: str | None = None) -> None:
        self._host = host
        self._port = port
        self._root = root
        self._public_host = public_host or host
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._streams: dict[str, _RegisteredStream] = {}
        self._streams_lock = threading.Lock()

    def start(self) -> None:
        if self._httpd is not None:
            return
        handler = partial(
            _AudioRequestHandler,
            directory=str(self._root),
            resolve_stream=self._resolve_stream,
            remove_stream=self._remove_stream,
        )
        self._httpd = ThreadingHTTPServer((self._host, self._port), handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._httpd is None:
            return
        self._httpd.shutdown()
        self._httpd.server_close()
        self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=2)
            self._thread = None
        with self._streams_lock:
            for stream in self._streams.values():
                stream.chunks.put(_STREAM_END)
            self._streams.clear()

    def url_for(self, path: Path) -> str:
        relative = path.relative_to(self._root).as_posix()
        return f"http://{self._public_host}:{self._port}/{relative}"

    def open_stream(self, *, content_type: str = "audio/mpeg") -> LiveAudioStream:
        stream_id = uuid.uuid4().hex
        chunks: "queue.Queue[bytes | object]" = queue.Queue()
        registered = _RegisteredStream(content_type=content_type, chunks=chunks)
        with self._streams_lock:
            self._streams[stream_id] = registered
        return LiveAudioStream(
            stream_id=stream_id,
            url=f"http://{self._public_host}:{self._port}/streams/{stream_id}",
            content_type=content_type,
            queue_obj=chunks,
        )

    def _resolve_stream(self, stream_id: str) -> _RegisteredStream | None:
        with self._streams_lock:
            return self._streams.get(stream_id)

    def _remove_stream(self, stream_id: str) -> None:
        with self._streams_lock:
            self._streams.pop(stream_id, None)
