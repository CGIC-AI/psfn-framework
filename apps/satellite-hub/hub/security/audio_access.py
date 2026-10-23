from __future__ import annotations

from dataclasses import dataclass, field
from urllib.parse import urlsplit

from hub.security.realtime_access import RealtimeAccess, is_loopback, validate_credential


@dataclass(frozen=True, slots=True)
class AudioAccess:
    host: str
    public_base_url: str
    relay_token: str | None = field(default=None, repr=False)
    developer_mode: bool = False
    _guard: RealtimeAccess = field(init=False, repr=False)

    def __post_init__(self) -> None:
        if not is_loopback(self.host):
            raise ValueError("Audio HTTP requires a literal loopback bind behind a same-host HTTPS/auth relay")
        if not self.relay_token and not self.developer_mode:
            raise ValueError("Audio requires an authenticated HTTPS relay or explicit loopback developer mode")
        parsed = urlsplit(self.public_base_url)
        if (not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"}
                or parsed.query or parsed.fragment):
            raise ValueError("Audio public URL must be a credential-free origin")
        if self.developer_mode:
            if self.relay_token or parsed.scheme != "http" or not is_loopback(parsed.hostname):
                raise ValueError("Audio developer mode requires an HTTP loopback origin and no relay credential")
        elif parsed.scheme != "https":
            raise ValueError("Audio relay requires an HTTPS public origin")
        if self.relay_token:
            validate_credential(self.relay_token, "AUDIO_RELAY_AUTH_TOKEN")
        object.__setattr__(self, "_guard", RealtimeAccess(host=self.host, token=self.relay_token, developer_mode=self.developer_mode))

    def reject_status(self, request, remote_host: str):
        if not is_loopback(remote_host):
            return 403
        parsed = urlsplit(request.path)
        if parsed.query or parsed.fragment or parsed.scheme or parsed.netloc:
            return 400
        return self._guard.reject_status(request, remote_host)
