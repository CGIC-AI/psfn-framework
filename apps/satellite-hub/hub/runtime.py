from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import socket
from typing import TypeVar

from dotenv import load_dotenv

from hub.config import ESPHomeTarget, RealtimeTarget
from hub.security.device_assertion import HubDeviceAssertionConfig
from hub.satellite_claims import (
    CAPABILITY_PROFILE_DEFAULTS,
    DEFAULT_CAPABILITY_PROFILE,
    DEFAULT_ENDPOINT_DISPLAY_NAME,
    DEFAULT_ENDPOINT_ID,
    DEFAULT_SATELLITE_ID,
    SATELLITE_CLAIM_NAMESPACE,
    ClientCertificateConfig,
    CapabilityProfile,
    EndpointClass,
    LocationMode,
    SatelliteClaimConfig,
    TelemetryConfig,
    TelemetryCategory,
    TelemetryMode,
    normalize_claim_config,
)


TEnum = TypeVar("TEnum", bound=str)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_path(project_root: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return project_root / path


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"Missing required setting: {name}")
    return value


def _load_optional_env(path: Path, *, override: bool) -> None:
    if path.exists():
        load_dotenv(path, override=override, encoding="utf-8")


def detect_outbound_host(remote_host: str, remote_port: int) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((remote_host, remote_port))
        return sock.getsockname()[0]


@dataclass(slots=True)
class HubRuntimeConfig:
    project_root: Path
    device_transport: str
    esphome_target: ESPHomeTarget | None
    realtime_target: RealtimeTarget
    deepgram_api_key: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str | None
    elevenlabs_model_id: str
    psfn_api_base_url: str
    psfn_api_key: str | None
    psfn_provider: str | None
    psfn_model: str
    psfn_author_id: str | None
    psfn_author_name: str | None
    psfn_satellite_claim: SatelliteClaimConfig
    voice_conversation_id: str
    psfn_client_certificate: ClientCertificateConfig | None
    hub_device_assertion: HubDeviceAssertionConfig | None
    audio_bind_host: str
    audio_public_host: str
    audio_port: int
    audio_public_port: int
    artifacts_root: Path
    continue_conversation: bool
    session_ttl_seconds: int
    announcement_timeout_seconds: float
    reply_timeout_seconds: float
    voice_initial_silence_timeout_seconds: float
    voice_endpointing_grace_seconds: float
    voice_silence_timeout_seconds: float
    voice_max_turn_seconds: float
    voice_speech_rms_threshold: float
    voice_min_speech_chunks_for_endpointing: int

    @property
    def audio_root(self) -> Path:
        return self.artifacts_root / "audio"


def load_runtime_config(project_root: Path) -> HubRuntimeConfig:
    project_env = project_root / ".env"
    _load_optional_env(project_env, override=True)

    device_transport = os.getenv("DEVICE_TRANSPORT", "esphome").strip().lower()
    if device_transport not in {"esphome", "realtime", "hybrid"}:
        raise ValueError(f"Unsupported DEVICE_TRANSPORT: {device_transport}")

    esphome_target: ESPHomeTarget | None = None
    detect_host: str | None = None
    detect_port: int | None = None
    if device_transport in {"esphome", "hybrid"}:
        host = _required("ESPHOME_HOST")
        port = int(os.getenv("ESPHOME_PORT", "6053"))
        noise_psk = os.getenv("ESPHOME_NOISE_PSK") or None
        password = os.getenv("ESPHOME_PASSWORD") or None
        expected_name = os.getenv("ESPHOME_EXPECTED_NAME") or None
        esphome_target = ESPHomeTarget(
            host=host,
            port=port,
            password=password,
            noise_psk=noise_psk,
            expected_name=expected_name,
        )
        detect_host = host
        detect_port = port

    audio_bind_host = os.getenv("AUDIO_SERVER_BIND_HOST", "0.0.0.0")
    configured_audio_public_host = os.getenv("AUDIO_PUBLIC_HOST") or None
    audio_port = int(os.getenv("AUDIO_SERVER_PORT", "8099"))
    audio_public_port = int(os.getenv("AUDIO_PUBLIC_PORT") or str(audio_port))
    realtime_bind_host = os.getenv("REALTIME_VOICE_BIND_HOST", "0.0.0.0")
    realtime_port = int(os.getenv("REALTIME_VOICE_PORT", "8787"))
    configured_realtime_public_host = os.getenv("REALTIME_VOICE_PUBLIC_HOST") or None
    if configured_audio_public_host:
        audio_public_host = configured_audio_public_host
    elif device_transport == "realtime":
        if not configured_realtime_public_host:
            raise ValueError(
                "AUDIO_PUBLIC_HOST or REALTIME_VOICE_PUBLIC_HOST is required when DEVICE_TRANSPORT=realtime",
            )
        audio_public_host = configured_realtime_public_host
    else:
        assert detect_host is not None and detect_port is not None
        audio_public_host = detect_outbound_host(detect_host, detect_port)
    realtime_public_host = configured_realtime_public_host or audio_public_host

    psfn_api_base_url = os.getenv("PSFN_API_BASE_URL", "http://127.0.0.1:3100/v1").strip()
    psfn_api_key = os.getenv("PSFN_API_KEY") or None
    psfn_provider = (os.getenv("PSFN_PROVIDER") or "").strip().lower() or None
    psfn_model = os.getenv("PSFN_MODEL", "psfn").strip()
    if psfn_provider and (not psfn_model or psfn_model == "psfn"):
        raise ValueError("PSFN_MODEL must name a concrete provider model when PSFN_PROVIDER is set")
    psfn_author_id = os.getenv("PSFN_AUTHOR_ID") or None
    psfn_author_name = os.getenv("PSFN_AUTHOR_NAME") or None
    if bool(psfn_author_id) != bool(psfn_author_name):
        raise ValueError("PSFN_AUTHOR_ID and PSFN_AUTHOR_NAME must both be set when either is configured")
    psfn_client_certificate = _load_psfn_client_certificate(project_root)
    psfn_satellite_claim = _load_psfn_satellite_claim(psfn_client_certificate)
    hub_device_assertion = _load_hub_device_assertion_config(
        project_root,
        satellite_id=psfn_satellite_claim.satellite_id,
        endpoint_id=psfn_satellite_claim.endpoint_id,
    )
    voice_conversation_id = (
        os.getenv("VOICE_CONVERSATION_ID")
        or psfn_satellite_claim.satellite_id
    ).strip()
    if not voice_conversation_id:
        raise ValueError("VOICE_CONVERSATION_ID must be non-empty")
    artifacts_root = _resolve_path(project_root, os.getenv("ARTIFACT_ROOT", ".artifacts/runtime"))

    return HubRuntimeConfig(
        project_root=project_root,
        device_transport=device_transport,
        esphome_target=esphome_target,
        realtime_target=RealtimeTarget(
            bind_host=realtime_bind_host,
            port=realtime_port,
            public_host=realtime_public_host,
        ),
        deepgram_api_key=_required("DEEPGRAM_API_KEY"),
        elevenlabs_api_key=_required("ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=os.getenv("ELEVENLABS_VOICE_ID") or None,
        elevenlabs_model_id=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
        psfn_api_base_url=psfn_api_base_url,
        psfn_api_key=psfn_api_key,
        psfn_provider=psfn_provider,
        psfn_model=psfn_model,
        psfn_author_id=psfn_author_id,
        psfn_author_name=psfn_author_name,
        psfn_satellite_claim=psfn_satellite_claim,
        voice_conversation_id=voice_conversation_id,
        psfn_client_certificate=psfn_client_certificate,
        hub_device_assertion=hub_device_assertion,
        audio_bind_host=audio_bind_host,
        audio_public_host=audio_public_host,
        audio_port=audio_port,
        audio_public_port=audio_public_port,
        artifacts_root=artifacts_root,
        continue_conversation=_env_bool("CONTINUE_CONVERSATION", True),
        session_ttl_seconds=int(os.getenv("SESSION_TTL_SECONDS", "300")),
        announcement_timeout_seconds=float(os.getenv("ANNOUNCEMENT_TIMEOUT_SECONDS", "120")),
        reply_timeout_seconds=float(os.getenv("VOICE_REPLY_TIMEOUT_SECONDS", "30")),
        voice_initial_silence_timeout_seconds=float(os.getenv("VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS", "4.0")),
        voice_endpointing_grace_seconds=float(os.getenv("VOICE_ENDPOINTING_GRACE_SECONDS", "2.0")),
        voice_silence_timeout_seconds=float(os.getenv("VOICE_SILENCE_TIMEOUT_SECONDS", "1.2")),
        voice_max_turn_seconds=float(os.getenv("VOICE_MAX_TURN_SECONDS", "20")),
        voice_speech_rms_threshold=float(os.getenv("VOICE_SPEECH_RMS_THRESHOLD", "25")),
        voice_min_speech_chunks_for_endpointing=int(os.getenv("VOICE_MIN_SPEECH_CHUNKS_FOR_ENDPOINTING", "4")),
    )


def _load_hub_device_assertion_config(
    project_root: Path,
    *,
    satellite_id: str,
    endpoint_id: str,
) -> HubDeviceAssertionConfig | None:
    names = (
        "HUB_DEVICE_ASSERTION_FLEET_AUTH_PATH",
        "HUB_DEVICE_ASSERTION_SATELLITE_REGISTRY_PATH",
        "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH",
        "HUB_DEVICE_ASSERTION_TTL_SECONDS",
        "PSFN_COMPANION_ID",
    )
    values = {name: (os.getenv(name) or "").strip() for name in names}
    if not any(values.values()):
        return None
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise ValueError(
            "Hub device assertion configuration is incomplete: " + ", ".join(missing)
        )
    try:
        ttl_seconds = int(values["HUB_DEVICE_ASSERTION_TTL_SECONDS"])
    except ValueError as exc:
        raise ValueError("HUB_DEVICE_ASSERTION_TTL_SECONDS must be an integer") from exc
    return HubDeviceAssertionConfig(
        fleet_auth_path=_resolve_path(project_root, values["HUB_DEVICE_ASSERTION_FLEET_AUTH_PATH"]),
        satellite_registry_path=_resolve_path(
            project_root,
            values["HUB_DEVICE_ASSERTION_SATELLITE_REGISTRY_PATH"],
        ),
        private_key_path=_resolve_path(project_root, values["HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH"]),
        ttl_seconds=ttl_seconds,
        companion_id=values["PSFN_COMPANION_ID"],
        satellite_id=satellite_id,
        endpoint_id=endpoint_id,
    )


def _load_psfn_satellite_claim(tls: ClientCertificateConfig | None) -> SatelliteClaimConfig:
    capability_profile = _parse_capability_profile(os.getenv("PSFN_CAPABILITY_PROFILE")) or DEFAULT_CAPABILITY_PROFILE
    defaults = CAPABILITY_PROFILE_DEFAULTS[capability_profile]
    telemetry_mode = _parse_telemetry_mode(os.getenv("PSFN_TELEMETRY_MODE")) or defaults.telemetry.mode
    telemetry_categories = (
        tuple(_parse_telemetry_category(value) for value in _split_csv(os.getenv("PSFN_TELEMETRY_CATEGORIES")))
        if os.getenv("PSFN_TELEMETRY_CATEGORIES")
        else defaults.telemetry.categories
    )
    return normalize_claim_config(
        namespace=os.getenv("PSFN_CLAIM_NAMESPACE") or SATELLITE_CLAIM_NAMESPACE,
        claim_type=os.getenv("PSFN_CLAIM_TYPE") or capability_profile,
        channel_type=os.getenv("PSFN_CHANNEL_TYPE") or os.getenv("PSFN_CLAIM_NAMESPACE") or SATELLITE_CLAIM_NAMESPACE,
        satellite_id=os.getenv("PSFN_SATELLITE_ID") or DEFAULT_SATELLITE_ID,
        endpoint_id=os.getenv("PSFN_ENDPOINT_ID") or os.getenv("PSFN_SATELLITE_ID") or DEFAULT_ENDPOINT_ID,
        display_name=os.getenv("PSFN_ENDPOINT_NAME") or DEFAULT_ENDPOINT_DISPLAY_NAME,
        endpoint_class=_parse_endpoint_class(os.getenv("PSFN_ENDPOINT_CLASS")) or defaults.endpoint_class,
        location_mode=_parse_location_mode(os.getenv("PSFN_LOCATION_MODE")) or defaults.location_mode,
        capability_profile=capability_profile,
        telemetry=TelemetryConfig(mode=telemetry_mode, categories=telemetry_categories),
        addressed_companion_id=os.getenv("PSFN_COMPANION_ID") or None,
        tls=tls,
    )


def _load_psfn_client_certificate(project_root: Path) -> ClientCertificateConfig | None:
    cert_path = os.getenv("PSFN_CLIENT_CERT_PATH") or None
    key_path = os.getenv("PSFN_CLIENT_KEY_PATH") or None
    ca_path = os.getenv("PSFN_CA_CERT_PATH") or None
    if not cert_path and not key_path and not ca_path:
        return None
    if bool(cert_path) != bool(key_path):
        raise ValueError("PSFN_CLIENT_CERT_PATH and PSFN_CLIENT_KEY_PATH must both be set when either is configured")
    return ClientCertificateConfig(
        cert_path=_resolve_existing_file(project_root, cert_path, "PSFN_CLIENT_CERT_PATH") if cert_path else None,
        key_path=_resolve_existing_file(project_root, key_path, "PSFN_CLIENT_KEY_PATH") if key_path else None,
        ca_path=_resolve_existing_file(project_root, ca_path, "PSFN_CA_CERT_PATH") if ca_path else None,
    )


def _resolve_existing_file(project_root: Path, value: str, name: str) -> Path:
    path = _resolve_path(project_root, value)
    if not path.is_file():
        raise ValueError(f"{name} must point to a readable file")
    try:
        with path.open("rb"):
            pass
    except OSError as exc:
        raise ValueError(f"{name} must point to a readable file") from exc
    return path


def _split_csv(value: str | None) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _parse_capability_profile(value: str | None) -> CapabilityProfile | None:
    return _parse_enum(
        value,
        ["voice-only", "text-only", "voxta-avatar", "vision-capable", "telemetry-only", "mobile-location"],
        "PSFN_CAPABILITY_PROFILE",
    )


def _parse_endpoint_class(value: str | None) -> EndpointClass | None:
    return _parse_enum(value, ["voice", "text", "avatar", "vision", "telemetry", "mobile"], "PSFN_ENDPOINT_CLASS")


def _parse_location_mode(value: str | None) -> LocationMode | None:
    return _parse_enum(value, ["static", "mobile", "unavailable"], "PSFN_LOCATION_MODE")


def _parse_telemetry_mode(value: str | None) -> TelemetryMode | None:
    return _parse_enum(value, ["disabled", "static", "periodic", "event"], "PSFN_TELEMETRY_MODE")


def _parse_telemetry_category(value: str) -> TelemetryCategory:
    parsed = _parse_enum(
        value,
        ["location", "timezone", "room", "presence", "battery", "health", "device_status", "avatar_state"],
        "PSFN_TELEMETRY_CATEGORIES",
    )
    assert parsed is not None
    return parsed


def _parse_enum(value: str | None, allowed: list[TEnum], name: str) -> TEnum | None:
    normalized = (value or "").strip()
    if not normalized:
        return None
    if normalized in allowed:
        return normalized  # type: ignore[return-value]
    raise ValueError(f"{name} must be one of: {', '.join(allowed)}")
