"""Finite output ownership for the pinned websockets Sans-I/O write boundary."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import math

from websockets.frames import Frame


@dataclass(frozen=True, slots=True)
class RealtimeOutputLimits:
    max_frames: int = 8192
    max_bytes: int = 1024 * 1024
    completion_timeout: float = 5

    def __post_init__(self) -> None:
        for value in (self.max_frames, self.max_bytes):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= 2_147_483_647:
                raise ValueError("Realtime output capacity must be a positive bounded integer")
        if (isinstance(self.completion_timeout, bool)
                or not isinstance(self.completion_timeout, (int, float))
                or not math.isfinite(self.completion_timeout)
                or not 0 < self.completion_timeout <= 2_147_483_647):
            raise ValueError("Realtime output deadline must be a positive finite bounded number")


class RealtimeOutput:
    """One owner for queued frames and native asyncio transport retention.

    websockets 15.0.1 routes all data and control output through send_frame,
    including automatic pongs and close echoes inside its synchronous parser.
    Reserve before serialization, with the RFC 6455 maximum 14-byte header.
    Compression is disabled at the listener and rejected here as an invariant.
    Charges release only when both Sans-I/O writes and the native buffer empty;
    partial drain never renews the absolute completion deadline.
    """

    def __init__(self, connection, limits: RealtimeOutputLimits) -> None:
        self.connection = connection
        self.limits = limits
        self.frames = 0
        self.bytes = 0
        self.pending_bytes = 0
        self.failed = False
        self.timer: asyncio.TimerHandle | None = None
        self.deadline: float | None = None
        self._serialize_frame = connection.protocol.send_frame
        connection.protocol.send_frame = self.send_frame

    def _empty(self) -> bool:
        return (not self.connection.protocol.writes
                and self.connection.transport.get_write_buffer_size() == 0)

    def _release(self) -> None:
        self.frames = self.bytes = self.pending_bytes = 0
        self.deadline = None
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None

    def fail(self) -> None:
        if self.failed:
            return
        self.failed = True
        self.connection.protocol.writes.clear()
        self._release()
        self.connection.transport.abort()

    def closed(self) -> None:
        self.failed = True
        self.connection.protocol.writes.clear()
        self._release()

    def _check(self) -> None:
        self.timer = None
        if self.failed:
            return
        if self._empty():
            self._release()
        elif self.deadline is not None and self.connection.loop.time() >= self.deadline:
            self.fail()
        else:
            self._watch()

    def _watch(self) -> None:
        if self.timer is None and not self.failed:
            self.timer = self.connection.loop.call_later(0.01, self._check)

    def send_frame(self, frame: Frame) -> None:
        if self.failed:
            return
        if self._empty():
            self._release()
        charge = len(frame.data) + 14
        native = self.connection.transport.get_write_buffer_size()
        if (self.connection.protocol.extensions
                or self.frames + 1 > self.limits.max_frames
                or max(self.bytes, native + self.pending_bytes) + charge > self.limits.max_bytes
                or (self.deadline is not None and self.connection.loop.time() >= self.deadline)):
            self.fail()
            return
        self.frames += 1
        self.bytes += charge
        self.pending_bytes += charge
        if self.deadline is None:
            self.deadline = self.connection.loop.time() + self.limits.completion_timeout
        self._serialize_frame(frame)
        self._watch()

    def before_write(self) -> None:
        # Includes HTTP upgrade/rejection output, which isn't a WebSocket frame.
        wire_bytes = sum(map(len, self.connection.protocol.writes))
        native = self.connection.transport.get_write_buffer_size()
        if (self.failed or native + wire_bytes > self.limits.max_bytes
                or (self.deadline is not None and self.connection.loop.time() >= self.deadline)):
            self.fail()
            raise OSError("Realtime output unavailable")
        if wire_bytes and self.deadline is None:
            self.deadline = self.connection.loop.time() + self.limits.completion_timeout

    def flushed(self) -> None:
        self.pending_bytes = 0
        if self._empty():
            self._release()
        elif self.deadline is not None:
            self._watch()
