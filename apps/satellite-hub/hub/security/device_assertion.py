from __future__ import annotations

import base64
from dataclasses import dataclass
import json
from pathlib import Path
import re
import stat
import time
from typing import Any
from urllib.parse import urlsplit
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$")
_STABLE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


@dataclass(frozen=True, slots=True)
class HubDeviceAssertionConfig:
    fleet_auth_path: Path
    satellite_registry_path: Path
    private_key_path: Path
    ttl_seconds: int
    companion_id: str
    satellite_id: str
    endpoint_id: str


@dataclass(frozen=True, slots=True)
class _AssertionAuthority:
    issuer: str
    kid: str
    audience: str
    private_key: Ed25519PrivateKey
    device_id: str
    enrollment_version: int
    place_id: str | None


class HubDeviceAssertionIssuer:
    """Mint short-lived assertions from current server-owned enrollment authority."""

    def __init__(self, config: HubDeviceAssertionConfig) -> None:
        self._config = config
        _require_uuid(config.companion_id, "Hub device assertion companion id")
        _require_token(config.satellite_id, "Hub device assertion satellite id")
        _require_token(config.endpoint_id, "Hub device assertion endpoint id")
        if config.ttl_seconds < 5 or config.ttl_seconds > 60:
            raise ValueError("Hub device assertion TTL must be between 5 and 60 seconds")
        self._read_authority()

    def issue(self, session_id: str) -> str:
        authority = self._read_authority()
        now = int(time.time())
        header = {
            "alg": "EdDSA",
            "typ": "PSFN-HUB-DEVICE",
            "v": 1,
            "kid": authority.kid,
        }
        claims: dict[str, object] = {
            "iss": authority.issuer,
            "device_id": authority.device_id,
            "enrollment_version": authority.enrollment_version,
            "enrollment_assurance": "device_credential",
        }
        if authority.place_id is not None:
            claims["place_id"] = authority.place_id
        claims.update(
            {
                "aud": authority.audience,
                "companion_id": self._config.companion_id,
                "session_id": _require_token(session_id, "Hub device assertion session id"),
                "iat": now,
                "exp": now + self._config.ttl_seconds,
                "jti": str(uuid.uuid4()),
            }
        )
        encoded_header = _encode_json(header)
        encoded_claims = _encode_json(claims)
        signing_input = f"{encoded_header}.{encoded_claims}".encode("ascii")
        signature = authority.private_key.sign(signing_input)
        return f"{signing_input.decode('ascii')}.{_base64url(signature)}"

    def _read_authority(self) -> _AssertionAuthority:
        private_key = _read_private_key(self._config.private_key_path)
        fleet_auth = _read_object(self._config.fleet_auth_path, "Fleet auth owner")
        assertions = _require_object(fleet_auth.get("hubDeviceAssertions"), "Hub device assertion owner")
        issuer = _require_stable_id(assertions.get("issuer"), "Hub device assertion issuer")
        audience = _require_exact_https_origin(assertions.get("audience"))
        maximum_ttl = _require_positive_integer(
            assertions.get("maxTtlSeconds"),
            "Hub device assertion maximum TTL",
        )
        if self._config.ttl_seconds > maximum_ttl:
            raise ValueError("Hub device assertion TTL exceeds the active verifier maximum")
        keys = assertions.get("keys")
        if not isinstance(keys, list):
            raise ValueError("Hub device assertion verifier keys must be an array")
        active = [item for item in keys if isinstance(item, dict) and item.get("status") == "active"]
        if len(active) != 1:
            raise ValueError("Hub device assertion owner must have exactly one active verifier")
        kid = _require_stable_id(active[0].get("kid"), "Hub device assertion key id")
        _require_matching_public_key(private_key, active[0].get("publicKeyPem"))

        registry = _read_object(self._config.satellite_registry_path, "Satellite registry")
        if registry.get("enabled") is not True:
            raise ValueError("Hub device assertions require an enabled satellite registry")
        satellites = registry.get("satellites")
        if not isinstance(satellites, list):
            raise ValueError("Satellite registry satellites must be an array")
        matched_satellites = [
            item
            for item in satellites
            if isinstance(item, dict) and item.get("satelliteId") == self._config.satellite_id
        ]
        if len(matched_satellites) != 1:
            raise ValueError("Hub device assertion requires one exact satellite enrollment")
        endpoints = matched_satellites[0].get("endpoints")
        if not isinstance(endpoints, list):
            raise ValueError("Satellite registry endpoints must be an array")
        matched_endpoints = [
            item
            for item in endpoints
            if isinstance(item, dict) and item.get("endpointId") == self._config.endpoint_id
        ]
        if len(matched_endpoints) != 1:
            raise ValueError("Hub device assertion requires one exact endpoint enrollment")
        enrollment = _require_object(
            matched_endpoints[0].get("hubDeviceEnrollment"),
            "Hub device enrollment",
        )
        if enrollment.get("enrollmentStatus") != "active":
            raise ValueError("Hub device assertion requires an active endpoint enrollment")
        device_id = _require_token(enrollment.get("deviceId"), "Hub device assertion device id")
        enrollment_version = _require_positive_integer(
            enrollment.get("enrollmentVersion"),
            "Hub device assertion enrollment version",
        )
        place_value = matched_satellites[0].get("placeId")
        place_id = None if place_value is None else _require_token(place_value, "Hub device assertion place id")
        return _AssertionAuthority(
            issuer=issuer,
            kid=kid,
            audience=audience,
            private_key=private_key,
            device_id=device_id,
            enrollment_version=enrollment_version,
            place_id=place_id,
        )


def _read_object(path: Path, field: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{field} is unreadable or invalid") from exc
    return _require_object(value, field)


def _read_private_key(path: Path) -> Ed25519PrivateKey:
    try:
        metadata = path.stat()
    except OSError as exc:
        raise ValueError("Hub device assertion private key is unreadable") from exc
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise ValueError("Hub device assertion private key must be a private mode-0600 file")
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except (TypeError, ValueError) as exc:
        raise ValueError("Hub device assertion private key must be an Ed25519 private key") from exc
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError("Hub device assertion private key must be an Ed25519 private key")
    return key


def _require_matching_public_key(private_key: Ed25519PrivateKey, value: object) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Hub device assertion active verifier must contain a public key")
    try:
        public_key = serialization.load_pem_public_key(value.encode("utf-8"))
        actual = private_key.public_key().public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        expected = public_key.public_bytes(
            serialization.Encoding.DER,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError("Hub device assertion active verifier public key is invalid") from exc
    if actual != expected:
        raise ValueError("Hub device assertion private key does not match the active verifier")


def _require_object(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return value


def _require_positive_integer(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _require_token(value: object, field: str) -> str:
    if not isinstance(value, str) or not _TOKEN_PATTERN.fullmatch(value.strip()):
        raise ValueError(f"{field} has an invalid format")
    return value.strip()


def _require_stable_id(value: object, field: str) -> str:
    if not isinstance(value, str) or value != value.strip() or not _STABLE_ID_PATTERN.fullmatch(value):
        raise ValueError(f"{field} must use stable identifier characters")
    return value


def _require_uuid(value: object, field: str) -> str:
    if not isinstance(value, str) or not _UUID_PATTERN.fullmatch(value.strip()):
        raise ValueError(f"{field} must be a lowercase RFC-4122 UUID")
    return value.strip()


def _require_exact_https_origin(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Hub device assertion audience must be an exact normalized HTTPS origin")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or value.endswith("/")
        or value != f"https://{parsed.netloc}"
    ):
        raise ValueError("Hub device assertion audience must be an exact normalized HTTPS origin")
    return value


def _encode_json(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _base64url(encoded)


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")
