from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
from typing import Literal, TypedDict


CapabilityProfile = Literal[
    "voice-only",
    "text-only",
    "voxta-avatar",
    "vision-capable",
    "telemetry-only",
    "mobile-location",
]
EndpointClass = Literal["voice", "text", "avatar", "vision", "telemetry", "mobile"]
LocationMode = Literal["static", "mobile", "unavailable"]
TelemetryMode = Literal["disabled", "static", "periodic", "event"]
TelemetryCategory = Literal[
    "location",
    "timezone",
    "room",
    "presence",
    "battery",
    "health",
    "device_status",
    "avatar_state",
]
FrameworkCapability = Literal[
    "text",
    "audio_input",
    "speech_to_text",
    "audio_output",
    "text_to_speech",
    "vision",
    "image_upload",
    "avatar",
    "avatar_expression",
    "avatar_action",
    "location",
    "timezone",
    "presence",
    "health",
    "battery",
    "telemetry",
    "outbound_delivery",
    "robotics",
]
FrameworkTelemetryScope = Literal[
    "location",
    "timezone",
    "presence",
    "health",
    "battery",
    "network",
    "orientation",
    "ambient",
    "device",
    "status",
]


class SatelliteCapabilities(TypedDict):
    input: list[str]
    output: list[str]
    control: list[str]
    safety: list[str]


@dataclass(frozen=True, slots=True)
class TelemetryConfig:
    mode: TelemetryMode
    categories: tuple[TelemetryCategory, ...]


@dataclass(frozen=True, slots=True)
class ClientCertificateConfig:
    cert_path: Path | None = None
    key_path: Path | None = None
    ca_path: Path | None = None

    @property
    def configured(self) -> bool:
        return self.cert_path is not None and self.key_path is not None


@dataclass(frozen=True, slots=True)
class SatelliteClaimConfig:
    namespace: str
    type: str
    channel_type: str
    satellite_id: str
    endpoint_id: str
    display_name: str
    endpoint_class: EndpointClass
    location_mode: LocationMode
    capability_profile: CapabilityProfile
    telemetry: TelemetryConfig
    tls: ClientCertificateConfig | None = None


@dataclass(frozen=True, slots=True)
class ProfileDefaults:
    endpoint_class: EndpointClass
    location_mode: LocationMode
    capabilities: SatelliteCapabilities
    telemetry: TelemetryConfig


SATELLITE_CLAIM_NAMESPACE = "satellite.endpoint"
DEFAULT_CHANNEL_TYPE = SATELLITE_CLAIM_NAMESPACE
DEFAULT_SATELLITE_ID = "hub"
DEFAULT_ENDPOINT_ID = "hub"
DEFAULT_ENDPOINT_DISPLAY_NAME = "PSFN Satellite Hub"
DEFAULT_CAPABILITY_PROFILE: CapabilityProfile = "voice-only"

CAPABILITY_PROFILE_DEFAULTS: dict[CapabilityProfile, ProfileDefaults] = {
    "voice-only": ProfileDefaults(
        endpoint_class="voice",
        location_mode="static",
        capabilities={
            "input": ["microphone_pcm", "final_transcript", "text", "wake_event"],
            "output": ["text", "subtitle", "streamed_audio"],
            "control": ["interrupt", "presence", "session_attach"],
            "safety": [],
        },
        telemetry=TelemetryConfig(mode="disabled", categories=()),
    ),
    "text-only": ProfileDefaults(
        endpoint_class="text",
        location_mode="static",
        capabilities={
            "input": ["text"],
            "output": ["text", "subtitle"],
            "control": ["interrupt", "session_attach"],
            "safety": [],
        },
        telemetry=TelemetryConfig(mode="disabled", categories=()),
    ),
    "voxta-avatar": ProfileDefaults(
        endpoint_class="avatar",
        location_mode="static",
        capabilities={
            "input": ["text", "vision_upload"],
            "output": ["text", "subtitle", "local_file_audio", "animation", "action", "expression"],
            "control": ["interrupt", "presence", "session_attach"],
            "safety": ["action_allowlist", "local_only"],
        },
        telemetry=TelemetryConfig(mode="event", categories=("presence", "avatar_state")),
    ),
    "vision-capable": ProfileDefaults(
        endpoint_class="vision",
        location_mode="static",
        capabilities={
            "input": ["text", "vision_upload"],
            "output": ["text", "subtitle"],
            "control": ["interrupt", "presence", "session_attach"],
            "safety": ["confirmation_required"],
        },
        telemetry=TelemetryConfig(mode="event", categories=("presence", "health")),
    ),
    "telemetry-only": ProfileDefaults(
        endpoint_class="telemetry",
        location_mode="static",
        capabilities={
            "input": [],
            "output": [],
            "control": ["presence"],
            "safety": ["local_only"],
        },
        telemetry=TelemetryConfig(mode="periodic", categories=("presence", "health", "device_status")),
    ),
    "mobile-location": ProfileDefaults(
        endpoint_class="mobile",
        location_mode="mobile",
        capabilities={
            "input": ["microphone_pcm", "final_transcript", "text", "vision_upload", "wake_event"],
            "output": ["text", "subtitle", "streamed_audio"],
            "control": ["interrupt", "presence", "session_attach"],
            "safety": ["confirmation_required"],
        },
        telemetry=TelemetryConfig(mode="event", categories=("location", "timezone", "presence", "battery", "health")),
    ),
}


def normalize_claim_config(
    *,
    namespace: str | None = None,
    claim_type: str | None = None,
    channel_type: str | None = None,
    satellite_id: str | None = None,
    endpoint_id: str | None = None,
    display_name: str | None = None,
    endpoint_class: EndpointClass | None = None,
    location_mode: LocationMode | None = None,
    capability_profile: CapabilityProfile = DEFAULT_CAPABILITY_PROFILE,
    telemetry: TelemetryConfig | None = None,
    tls: ClientCertificateConfig | None = None,
) -> SatelliteClaimConfig:
    defaults = CAPABILITY_PROFILE_DEFAULTS[capability_profile]
    claim_namespace = _normalized_or(namespace, SATELLITE_CLAIM_NAMESPACE)
    return SatelliteClaimConfig(
        namespace=claim_namespace,
        type=_normalized_or(claim_type, capability_profile),
        channel_type=_normalized_or(channel_type, claim_namespace),
        satellite_id=_normalized_or(satellite_id, DEFAULT_SATELLITE_ID),
        endpoint_id=_normalized_or(endpoint_id, satellite_id or DEFAULT_ENDPOINT_ID),
        display_name=_normalized_or(display_name, DEFAULT_ENDPOINT_DISPLAY_NAME),
        endpoint_class=endpoint_class or defaults.endpoint_class,
        location_mode=location_mode or defaults.location_mode,
        capability_profile=capability_profile,
        telemetry=telemetry or defaults.telemetry,
        tls=tls,
    )


def default_capabilities_for_profile(profile: CapabilityProfile) -> SatelliteCapabilities:
    capabilities = CAPABILITY_PROFILE_DEFAULTS[profile].capabilities
    return _clone_capabilities(capabilities)


def build_satellite_claim_envelope(
    *,
    config: SatelliteClaimConfig,
    conversation_id: str,
    session_id: str | None = None,
    channel_id: str | None = None,
    current_capabilities: SatelliteCapabilities | None = None,
    active_satellites: list[dict[str, object]] | None = None,
    api_key: str | None = None,
) -> dict[str, object]:
    resolved_session_id = (session_id or conversation_id).strip()
    resolved_channel_id = channel_id or derive_channel_id(config.channel_type, resolved_session_id)
    capabilities = current_capabilities or default_capabilities_for_profile(config.capability_profile)
    fingerprint = _certificate_fingerprint(config.tls.cert_path if config.tls else None)
    client_certificate_configured = bool(config.tls and config.tls.configured)
    auth: dict[str, object] = {
        "mode": "mtls" if client_certificate_configured else "bearer" if api_key else "none",
        "clientCertificateConfigured": client_certificate_configured,
    }
    if fingerprint:
        auth["clientCertificateFingerprintSha256"] = fingerprint

    return {
        "protocolVersion": "satellite-claim.v1",
        "claim": {
            "namespace": config.namespace,
            "type": config.type,
            "satelliteId": config.satellite_id,
            "endpointId": config.endpoint_id,
            "sessionId": resolved_session_id,
            "threadId": conversation_id,
            "channelId": resolved_channel_id,
            "deviceClass": config.endpoint_class,
            "displayName": config.display_name,
            "locationMode": config.location_mode,
        },
        "capabilities": {
            "profile": config.capability_profile,
            "current": _clone_capabilities(capabilities),
            "activeSatellites": active_satellites
            or [
                {
                    "id": config.satellite_id,
                    "name": config.display_name,
                    "transport": "websocket",
                    "capabilities": _clone_capabilities(capabilities),
                }
            ],
        },
        "telemetry": {
            "mode": config.telemetry.mode,
            "categories": list(config.telemetry.categories),
        },
        "auth": auth,
    }


def build_satellite_registry_headers(
    *,
    config: SatelliteClaimConfig,
    satellite_claim: dict[str, object],
) -> dict[str, str]:
    claim = satellite_claim.get("claim")
    capabilities = satellite_claim.get("capabilities")
    if not isinstance(claim, dict):
        raise ValueError("satellite claim envelope is missing claim metadata")
    if not isinstance(capabilities, dict):
        raise ValueError("satellite claim envelope is missing capability metadata")
    current_capabilities = capabilities.get("current")
    if not isinstance(current_capabilities, dict):
        raise ValueError("satellite claim envelope is missing current capabilities")

    mapped_capabilities = framework_capabilities_for_satellite_capabilities(current_capabilities)
    telemetry_scopes = framework_telemetry_scopes_for_config(config.telemetry)
    headers = {
        "X-PSFN-Satellite-Claim-Type": config.type,
        "X-PSFN-Satellite-ID": config.satellite_id,
        "X-PSFN-Satellite-Endpoint-ID": config.endpoint_id,
        "X-PSFN-Satellite-Session-ID": str(claim.get("sessionId") or ""),
        "X-PSFN-Satellite-Thread-ID": str(claim.get("threadId") or ""),
    }
    if mapped_capabilities:
        headers["X-PSFN-Satellite-Capabilities"] = ",".join(mapped_capabilities)
    if telemetry_scopes:
        headers["X-PSFN-Satellite-Telemetry-Scopes"] = ",".join(telemetry_scopes)

    auth = satellite_claim.get("auth")
    if isinstance(auth, dict):
        fingerprint = auth.get("clientCertificateFingerprintSha256")
        if isinstance(fingerprint, str) and fingerprint:
            headers["X-PSFN-Client-Cert-Fingerprint-SHA256"] = fingerprint

    return headers


def framework_capabilities_for_satellite_capabilities(
    capabilities: SatelliteCapabilities | dict[str, object],
) -> tuple[FrameworkCapability, ...]:
    inputs = set(_string_values(capabilities.get("input", [])))
    outputs = set(_string_values(capabilities.get("output", [])))
    mapped: list[FrameworkCapability] = []

    def add(value: FrameworkCapability) -> None:
        if value not in mapped:
            mapped.append(value)

    if {"text"} & inputs or {"text", "subtitle"} & outputs:
        add("text")
    if {"microphone_pcm", "wake_event"} & inputs:
        add("audio_input")
    if "final_transcript" in inputs:
        add("speech_to_text")
    if {"streamed_audio", "local_file_audio"} & outputs:
        add("audio_output")
        add("text_to_speech")
    if "vision_upload" in inputs:
        add("vision")
        add("image_upload")
    if {"animation", "expression", "action", "gaze"} & outputs:
        add("avatar")
    if "expression" in outputs:
        add("avatar_expression")
    if "action" in outputs:
        add("avatar_action")
    return tuple(mapped)


def framework_telemetry_scopes_for_config(telemetry: TelemetryConfig) -> tuple[FrameworkTelemetryScope, ...]:
    if telemetry.mode == "disabled":
        return ()
    mapped: list[FrameworkTelemetryScope] = []

    def add(value: FrameworkTelemetryScope) -> None:
        if value not in mapped:
            mapped.append(value)

    for category in telemetry.categories:
        if category in {"location", "timezone", "presence", "battery", "health"}:
            add(category)
        elif category == "device_status":
            add("device")
            add("status")
        elif category == "avatar_state":
            add("status")
    return tuple(mapped)


def derive_channel_id(channel_type: str, conversation_id: str) -> str:
    normalized = conversation_id.strip()
    if not normalized:
        raise ValueError("PSFN conversation ID is required for channel derivation")
    if normalized.startswith(f"{channel_type}:"):
        return normalized
    return f"{channel_type}:{normalized}"


def _clone_capabilities(capabilities: SatelliteCapabilities) -> SatelliteCapabilities:
    return {
        "input": list(capabilities.get("input", [])),
        "output": list(capabilities.get("output", [])),
        "control": list(capabilities.get("control", [])),
        "safety": list(capabilities.get("safety", [])),
    }


def _string_values(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item)


def _certificate_fingerprint(path: Path | None) -> str | None:
    if path is None:
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _normalized_or(value: str | None, fallback: str) -> str:
    normalized = (value or "").strip()
    return normalized or fallback
