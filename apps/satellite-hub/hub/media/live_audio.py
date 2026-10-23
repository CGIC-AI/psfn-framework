from __future__ import annotations

from collections import deque
import threading
import time

from hub.media.audio_limits import AudioLimits


class AudioStreamUnavailable(RuntimeError):
    pass


class StreamBuffer:
    """One producer and one consumer; activity means consumer progress."""

    def __init__(self, content_type: str, limits: AudioLimits) -> None:
        self.content_type = content_type
        self._limits = limits
        self._chunks: deque[bytes] = deque()
        self._queued_bytes = 0
        self._total_bytes = 0
        self._created = self._last_read = time.monotonic()
        self._closed = self._failed = self._claimed = False
        self._condition = threading.Condition()

    def _expired(self) -> bool:
        now = time.monotonic()
        return (now - self._created >= self._limits.stream_max_age_seconds
                or now - self._last_read >= self._limits.stream_idle_seconds)

    def _abort(self) -> None:
        self._failed = True
        self._chunks.clear()
        self._queued_bytes = 0
        self._condition.notify_all()

    def expire(self) -> bool:
        with self._condition:
            if self._failed or self._expired():
                self._abort()
                return True
            return False

    def abort(self) -> None:
        with self._condition:
            self._abort()

    def claim(self) -> bool:
        with self._condition:
            if self._claimed or self._failed or self._expired():
                return False
            self._claimed = True
            return True

    def write(self, data: bytes) -> None:
        with self._condition:
            if self._failed or self._closed or self._expired():
                self._abort()
                raise AudioStreamUnavailable("Audio stream unavailable")
            if not data:
                return
            if (len(self._chunks) >= self._limits.max_stream_chunks
                    or self._queued_bytes + len(data) > self._limits.max_stream_bytes
                    or self._total_bytes + len(data) > self._limits.max_response_bytes):
                self._abort()
                raise AudioStreamUnavailable("Audio stream capacity exceeded")
            self._chunks.append(bytes(data))
            self._queued_bytes += len(data)
            self._total_bytes += len(data)
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def next_chunk(self) -> bytes | None:
        with self._condition:
            while True:
                if self._failed or self._expired():
                    self._abort()
                    raise AudioStreamUnavailable("Audio stream unavailable")
                if self._chunks:
                    chunk = self._chunks.popleft()
                    self._queued_bytes -= len(chunk)
                    self._last_read = time.monotonic()
                    return chunk
                if self._closed:
                    return None
                self._condition.wait(timeout=min(0.1, self._limits.stream_idle_seconds))


class LiveAudioStream:
    def __init__(self, *, stream_id: str, url: str, buffer: StreamBuffer) -> None:
        self.stream_id, self.url, self.content_type = stream_id, url, buffer.content_type
        self._buffer = buffer

    def write(self, data: bytes) -> None:
        self._buffer.write(data)

    def close(self) -> None:
        self._buffer.close()
