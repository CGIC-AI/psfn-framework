"""Shared finite output ownership at the pinned websockets Sans-I/O boundary."""

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
                and self._native_bytes() == 0)

    def _tls_transport(self):
        transport = self.connection.transport
        if transport.get_extra_info("ssl_object") is None:
            return None
        # CPython's SSL transport reports BIO/plaintext retention only; encrypted
        # TCP output is independently retained below it. Unknown TLS seams deny.
        protocol = getattr(transport, "_ssl_protocol", None)
        native = getattr(protocol, "_transport", None)
        if (native is None or not callable(getattr(native, "get_write_buffer_size", None))
                or native.get_extra_info("ssl_object") is not None):
            self.fail()
            raise OSError("WebSocket output transport unsupported")
        return native

    def _native_bytes(self) -> int:
        native = self.connection.transport.get_write_buffer_size()
        tls = self._tls_transport()
        return native if tls is None else native + tls.get_write_buffer_size()

    def _wire_charge(self, size: int) -> int:
        if not size or self._tls_transport() is None:
            return size
        # RFC 5246: at most 2^14 plaintext bytes and 2048 expansion bytes per
        # record, plus its five-byte header. This exceeds TLS 1.3's expansion.
        return size + ((size + 16383) // 16384) * 2053

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
        if self.timer is not None:
            self.timer.cancel()
            self.timer = None
        # Retain the charge until connection_lost confirms terminal cleanup.
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
        charge = self._wire_charge(len(frame.data) + 14)
        native = self._native_bytes()
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
        try:
            self._serialize_frame(frame)
        except (OSError, RuntimeError):
            self.fail()
            raise OSError("WebSocket output unavailable") from None
        self._watch()

    def before_write(self) -> None:
        # Includes HTTP upgrade/rejection output, which isn't a WebSocket frame.
        wire_bytes = sum(self._wire_charge(len(data)) for data in self.connection.protocol.writes)
        native = self._native_bytes()
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
