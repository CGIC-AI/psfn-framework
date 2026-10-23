from __future__ import annotations

from http.server import ThreadingHTTPServer
import logging
import socket
import threading


_LOGGER = logging.getLogger(__name__)


def shutdown_socket(connection) -> None:
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass  # Closing an already disconnected peer is idempotent.


class BoundedAudioHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, handler, *, owner) -> None:
        self.owner = owner
        self._admission = threading.BoundedSemaphore(owner._limits.max_requests)
        self._connections: set[socket.socket] = set()
        self._connections_lock = threading.Lock()
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(address, handler)

    def process_request(self, request, client_address) -> None:
        if not self._admission.acquire(blocking=False):
            try:
                request.settimeout(0.05)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass  # A rejected peer may have already disconnected.
            finally:
                self.shutdown_request(request)
            return
        with self._connections_lock:
            self._connections.add(request)
        request.settimeout(self.owner._limits.io_timeout_seconds)
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._release(request)
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._release(request)

    def _release(self, request) -> None:
        with self._connections_lock:
            self._connections.discard(request)
        self._admission.release()

    def close_active(self) -> None:
        with self._connections_lock:
            for connection in self._connections:
                shutdown_socket(connection)

    def handle_error(self, request, client_address) -> None:
        _LOGGER.warning("Audio request failed")

    def service_actions(self) -> None:
        self.owner.purge_expired()
