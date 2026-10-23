from __future__ import annotations

from dataclasses import dataclass
import hmac
from http import HTTPStatus
import re
from urllib.parse import parse_qs, urlsplit


def is_loopback(host: str) -> bool:
    return host in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


@dataclass(frozen=True, slots=True)
class RealtimeAccess:
    host: str
    token: str | None = None
    developer_mode: bool = False
    allowed_origins: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.developer_mode and not is_loopback(self.host):
            raise ValueError("HUB_DEVELOPER_MODE requires a literal loopback bind address")
        if not is_loopback(self.host) and not self.token:
            raise ValueError("Non-loopback Python realtime requires a dedicated credential")
        if self.token is not None:
            token = self.token
            placeholder = re.search(r"change[_ -]?me|replace[_ -]?me|placeholder|your[_ -].*(key|token|password|secret)|not[_ -]?for[_ -]?production", token, re.I)
            repeated = any(len(token) % size == 0 and token[:size] * (len(token) // size) == token for size in range(1, len(token) // 2 + 1))
            if not re.fullmatch(r"[A-Za-z0-9_-]{43,512}", token) or len(set(token)) < 12 or placeholder or repeated:
                raise ValueError("HUB_REALTIME_AUTH_TOKEN credential must be strong dedicated base64url data")
        for origin in self.allowed_origins:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or "*" in origin:
                raise ValueError("HUB_ALLOWED_ORIGINS requires exact http(s) Origin values")

    def reject_status(self, request, remote_host: str) -> HTTPStatus | None:
        origins = request.headers.get_all("Origin")
        if len(origins) > 1 or (origins and origins[0] not in self.allowed_origins):
            return HTTPStatus.FORBIDDEN
        query = parse_qs(urlsplit(request.path).query, keep_blank_values=True)
        if any(name in query for name in ("token", "access_token", "credential", "authorization")):
            return HTTPStatus.UNAUTHORIZED
        headers = request.headers.get_all("Authorization")
        if not headers and self.developer_mode and is_loopback(self.host) and is_loopback(remote_host):
            return None
        if len(headers) == 1 and self.token and hmac.compare_digest(headers[0], f"Bearer {self.token}"):
            return None
        return HTTPStatus.UNAUTHORIZED
