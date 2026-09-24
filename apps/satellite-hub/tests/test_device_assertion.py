from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import pytest

from hub.security.device_assertion import HubDeviceAssertionConfig, HubDeviceAssertionIssuer


COMPANION_ID = "8e88cd65-38da-4f93-855a-d01276521eff"


def _private_key_file(tmp_path: Path, name: str = "hub-private.pem") -> tuple[Path, str]:
    private_key = Ed25519PrivateKey.generate()
    private_path = tmp_path / name
    private_path.write_bytes(
        private_key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    private_path.chmod(0o600)
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    return private_path, public_pem


def _ring(keys: list[dict[str, object]]) -> dict[str, object]:
    return {
        "issuer": "fixture-hub",
        "audience": "https://fleet.example.test",
        "maxTtlSeconds": 60,
        "keys": keys,
    }


def _write_authority(
    tmp_path: Path,
    *,
    enrollment_status: str = "active",
    ring_location: str = "fleet_auth",
    keys: list[dict[str, object]] | None = None,
) -> HubDeviceAssertionConfig:
    private_path, public_pem = _private_key_file(tmp_path)
    ring = _ring(keys if keys is not None else [
        {"kid": "fixture-key", "status": "active", "publicKeyPem": public_pem},
    ])
    registry: dict[str, object] = {
        "enabled": True,
        "satellites": [
            {
                "satelliteId": "bedroom",
                "placeId": "bedroom-place",
                "endpoints": [
                    {
                        "endpointId": "waveshare",
                        "hubDeviceEnrollment": {
                            "deviceId": "waveshare-device",
                            "enrollmentVersion": 7,
                            "enrollmentStatus": enrollment_status,
                        },
                    }
                ],
            }
        ],
    }
    fleet_auth_path: Path | None = None
    ring_path: Path | None = None
    if ring_location == "fleet_auth":
        fleet_auth_path = tmp_path / "fleet-auth.json"
        fleet_auth_path.write_text(json.dumps({"hubDeviceAssertions": ring}), encoding="utf-8")
    elif ring_location == "ring_bare":
        ring_path = tmp_path / "hub-ring.json"
        ring_path.write_text(json.dumps(ring), encoding="utf-8")
    elif ring_location == "ring_wrapped":
        ring_path = tmp_path / "hub-ring.json"
        ring_path.write_text(json.dumps({"hubDeviceAssertions": ring}), encoding="utf-8")
    elif ring_location == "registry":
        registry["hubDeviceAssertions"] = ring
    else:
        raise AssertionError(f"unknown ring location {ring_location}")
    registry_path = tmp_path / "satellites.json"
    registry_path.write_text(json.dumps(registry), encoding="utf-8")
    return HubDeviceAssertionConfig(
        satellite_registry_path=registry_path,
        private_key_path=private_path,
        ttl_seconds=30,
        companion_id=COMPANION_ID,
        satellite_id="bedroom",
        endpoint_id="waveshare",
        fleet_auth_path=fleet_auth_path,
        ring_path=ring_path,
    )


def _decode_segment(value: str) -> dict[str, object]:
    padded = value + "=" * (-len(value) % 4)
    return json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))


def test_issuer_mints_signed_assertion_from_current_exact_enrollment(tmp_path: Path) -> None:
    config = _write_authority(tmp_path)
    issuer = HubDeviceAssertionIssuer(config)

    token = issuer.issue("bedroom-session")
    encoded_header, encoded_claims, encoded_signature = token.split(".")
    header = _decode_segment(encoded_header)
    claims = _decode_segment(encoded_claims)
    signature = base64.urlsafe_b64decode(encoded_signature + "=" * (-len(encoded_signature) % 4))
    private_key = serialization.load_pem_private_key(config.private_key_path.read_bytes(), password=None)
    private_key.public_key().verify(signature, f"{encoded_header}.{encoded_claims}".encode("ascii"))

    assert header == {
        "alg": "EdDSA",
        "typ": "PSFN-HUB-DEVICE",
        "v": 1,
        "kid": "fixture-key",
    }
    assert claims["device_id"] == "waveshare-device"
    assert claims["enrollment_version"] == 7
    assert claims["enrollment_assurance"] == "device_credential"
    assert claims["companion_id"] == COMPANION_ID
    assert claims["session_id"] == "bedroom-session"
    assert claims["place_id"] == "bedroom-place"
    assert claims["exp"] == claims["iat"] + 30


def test_issuer_rechecks_revocation_before_each_assertion(tmp_path: Path) -> None:
    config = _write_authority(tmp_path)
    issuer = HubDeviceAssertionIssuer(config)
    registry = json.loads(config.satellite_registry_path.read_text(encoding="utf-8"))
    registry["satellites"][0]["endpoints"][0]["hubDeviceEnrollment"]["enrollmentStatus"] = "revoked"
    config.satellite_registry_path.write_text(json.dumps(registry), encoding="utf-8")

    with pytest.raises(ValueError, match="active endpoint enrollment"):
        issuer.issue("bedroom-session")


def test_issuer_rejects_group_readable_private_key(tmp_path: Path) -> None:
    config = _write_authority(tmp_path)
    config.private_key_path.chmod(0o640)

    with pytest.raises(ValueError, match="mode-0600"):
        HubDeviceAssertionIssuer(config)


@pytest.mark.parametrize("ring_location", ["registry", "ring_bare", "ring_wrapped", "fleet_auth"])
def test_issuer_reads_the_ring_without_requiring_fleet_auth(tmp_path: Path, ring_location: str) -> None:
    config = _write_authority(tmp_path, ring_location=ring_location)

    token = HubDeviceAssertionIssuer(config).issue("bedroom-session")

    assert _decode_segment(token.split(".")[0])["kid"] == "fixture-key"


def test_issuer_selects_the_verifier_entry_matching_the_private_key(tmp_path: Path) -> None:
    _, other_public_pem = _private_key_file(tmp_path, "other.pem")
    config = _write_authority(tmp_path, ring_location="registry", keys=[])
    public_pem = serialization.load_pem_private_key(
        config.private_key_path.read_bytes(), password=None
    ).public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    registry = json.loads(config.satellite_registry_path.read_text(encoding="utf-8"))
    registry["hubDeviceAssertions"]["keys"] = [
        {"kid": "new-active", "status": "active", "publicKeyPem": other_public_pem},
        {"kid": "old-retiring", "status": "retiring", "publicKeyPem": public_pem},
    ]
    config.satellite_registry_path.write_text(json.dumps(registry), encoding="utf-8")

    token = HubDeviceAssertionIssuer(config).issue("bedroom-session")

    assert _decode_segment(token.split(".")[0])["kid"] == "old-retiring"


def test_issuer_rejects_a_key_matching_no_live_verifier(tmp_path: Path) -> None:
    _, other_public_pem = _private_key_file(tmp_path, "other.pem")
    config = _write_authority(tmp_path, ring_location="registry", keys=[
        {"kid": "someone-else", "status": "active", "publicKeyPem": other_public_pem},
    ])

    with pytest.raises(ValueError, match="does not match any active or retiring verifier key"):
        HubDeviceAssertionIssuer(config)


def test_issuer_rejects_a_ring_without_exactly_one_active_key(tmp_path: Path) -> None:
    config = _write_authority(tmp_path, ring_location="registry", keys=[])

    with pytest.raises(ValueError, match="exactly one active verifier"):
        HubDeviceAssertionIssuer(config)


def test_issuer_rejects_two_ring_sources(tmp_path: Path) -> None:
    config = _write_authority(tmp_path, ring_location="fleet_auth")
    ring_path = tmp_path / "hub-ring.json"
    ring_path.write_text("{}", encoding="utf-8")

    with pytest.raises(ValueError, match="not both"):
        HubDeviceAssertionIssuer(
            HubDeviceAssertionConfig(
                satellite_registry_path=config.satellite_registry_path,
                private_key_path=config.private_key_path,
                ttl_seconds=30,
                companion_id=COMPANION_ID,
                satellite_id="bedroom",
                endpoint_id="waveshare",
                fleet_auth_path=config.fleet_auth_path,
                ring_path=ring_path,
            )
        )


def test_issuer_names_the_ring_env_when_the_registry_has_no_ring(tmp_path: Path) -> None:
    config = _write_authority(tmp_path, ring_location="fleet_auth")

    with pytest.raises(ValueError, match="HUB_DEVICE_ASSERTION_RING_PATH"):
        HubDeviceAssertionIssuer(
            HubDeviceAssertionConfig(
                satellite_registry_path=config.satellite_registry_path,
                private_key_path=config.private_key_path,
                ttl_seconds=30,
                companion_id=COMPANION_ID,
                satellite_id="bedroom",
                endpoint_id="waveshare",
            )
        )
