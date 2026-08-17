from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import pytest

from hub.security.device_assertion import HubDeviceAssertionConfig, HubDeviceAssertionIssuer


COMPANION_ID = "8e88cd65-38da-4f93-855a-d01276521eff"


def _write_authority(tmp_path: Path, *, enrollment_status: str = "active") -> HubDeviceAssertionConfig:
    private_key = Ed25519PrivateKey.generate()
    private_path = tmp_path / "hub-private.pem"
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
    fleet_auth_path = tmp_path / "fleet-auth.json"
    fleet_auth_path.write_text(
        json.dumps(
            {
                "hubDeviceAssertions": {
                    "issuer": "fixture-hub",
                    "audience": "https://fleet.example.test",
                    "maxTtlSeconds": 60,
                    "keys": [
                        {
                            "kid": "fixture-key",
                            "status": "active",
                            "publicKeyPem": public_pem,
                        }
                    ],
                }
            }
        ),
        encoding="utf-8",
    )
    registry_path = tmp_path / "satellites.json"
    registry_path.write_text(
        json.dumps(
            {
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
        ),
        encoding="utf-8",
    )
    return HubDeviceAssertionConfig(
        fleet_auth_path=fleet_auth_path,
        satellite_registry_path=registry_path,
        private_key_path=private_path,
        ttl_seconds=30,
        companion_id=COMPANION_ID,
        satellite_id="bedroom",
        endpoint_id="waveshare",
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
