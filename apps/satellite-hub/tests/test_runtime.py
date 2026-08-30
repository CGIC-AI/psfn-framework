from __future__ import annotations

from pathlib import Path

import pytest

from hub.adapters.tts.elevenlabs_streaming import _should_flush, _take_flush_chunk
from hub.media.http_audio import StaticAudioServer
from hub.runtime import load_runtime_config


def test_load_runtime_config_reads_psfn_and_project_env(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "ESPHOME_HOST",
        "ESPHOME_PORT",
        "ESPHOME_EXPECTED_NAME",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "AUDIO_SERVER_PORT",
        "AUDIO_PUBLIC_PORT",
        "AUDIO_PUBLIC_HOST",
        "PSFN_API_BASE_URL",
        "PSFN_API_KEY",
        "PSFN_PROVIDER",
        "PSFN_MODEL",
        "PSFN_CLAIM_NAMESPACE",
        "PSFN_CLAIM_TYPE",
        "PSFN_CHANNEL_TYPE",
        "PSFN_SATELLITE_ID",
        "PSFN_ENDPOINT_ID",
        "PSFN_ENDPOINT_NAME",
        "PSFN_ENDPOINT_CLASS",
        "PSFN_CAPABILITY_PROFILE",
        "PSFN_LOCATION_MODE",
        "PSFN_TELEMETRY_MODE",
        "PSFN_TELEMETRY_CATEGORIES",
        "PSFN_CLIENT_CERT_PATH",
        "PSFN_CLIENT_KEY_PATH",
        "PSFN_CA_CERT_PATH",
        "VOICE_CONVERSATION_ID",
        "HUB_DEVICE_ASSERTION_FLEET_AUTH_PATH",
        "HUB_DEVICE_ASSERTION_SATELLITE_REGISTRY_PATH",
        "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH",
        "HUB_DEVICE_ASSERTION_TTL_SECONDS",
        "PSFN_COMPANION_ID",
    ):
        monkeypatch.delenv(name, raising=False)

    (tmp_path / ".env").write_text(
        "ESPHOME_HOST=esphome.example\n"
        "ESPHOME_PORT=6053\n"
        "ESPHOME_EXPECTED_NAME=Opanhome-Voice-Pi\n"
        "AUDIO_PUBLIC_HOST=voice.example\n"
        "AUDIO_SERVER_PORT=8100\n"
        "AUDIO_PUBLIC_PORT=8099\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n"
        "PSFN_API_BASE_URL=http://psfn.example:3100/v1\n"
        "PSFN_PROVIDER=openrouter\n"
        "PSFN_MODEL=z-ai-glm-5.2-nitro\n",
        encoding="utf-8",
    )

    config = load_runtime_config(tmp_path)

    assert config.device_transport == "esphome"
    assert config.esphome_target.host == "esphome.example"
    assert config.esphome_target.expected_name == "Opanhome-Voice-Pi"
    assert config.deepgram_api_key == "project-deepgram"
    assert config.elevenlabs_api_key == "project-eleven"
    assert config.audio_public_host == "voice.example"
    assert config.audio_port == 8100
    assert config.audio_public_port == 8099
    assert config.psfn_api_base_url == "http://psfn.example:3100/v1"
    assert config.psfn_api_key is None
    assert config.psfn_provider == "openrouter"
    assert config.psfn_model == "z-ai-glm-5.2-nitro"
    assert config.psfn_satellite_claim.namespace == "satellite.endpoint"
    assert config.psfn_satellite_claim.channel_type == "satellite.endpoint"
    assert config.psfn_satellite_claim.capability_profile == "voice-only"
    assert config.psfn_satellite_claim.telemetry.mode == "disabled"
    assert config.voice_conversation_id == "hub"
    assert config.hub_device_assertion is None
    assert config.elevenlabs_model_id == "eleven_flash_v2_5"
    assert config.reply_timeout_seconds == 30.0
    assert config.voice_initial_silence_timeout_seconds == 4.0
    assert config.voice_endpointing_grace_seconds == 2.0


def test_load_runtime_config_supports_realtime_mode_without_esphome_target(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "DEVICE_TRANSPORT",
        "ESPHOME_HOST",
        "ESPHOME_PORT",
        "ESPHOME_EXPECTED_NAME",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "AUDIO_PUBLIC_HOST",
        "REALTIME_VOICE_PUBLIC_HOST",
        "PSFN_API_BASE_URL",
        "PSFN_API_KEY",
        "PSFN_PROVIDER",
        "PSFN_MODEL",
        "PSFN_CLAIM_NAMESPACE",
        "PSFN_CLAIM_TYPE",
        "PSFN_CHANNEL_TYPE",
        "PSFN_SATELLITE_ID",
        "PSFN_ENDPOINT_ID",
        "PSFN_ENDPOINT_NAME",
        "PSFN_ENDPOINT_CLASS",
        "PSFN_CAPABILITY_PROFILE",
        "PSFN_LOCATION_MODE",
        "PSFN_TELEMETRY_MODE",
        "PSFN_TELEMETRY_CATEGORIES",
        "PSFN_CLIENT_CERT_PATH",
        "PSFN_CLIENT_KEY_PATH",
        "PSFN_CA_CERT_PATH",
        "VOICE_CONVERSATION_ID",
    ):
        monkeypatch.delenv(name, raising=False)

    (tmp_path / ".env").write_text(
        "DEVICE_TRANSPORT=realtime\n"
        "AUDIO_PUBLIC_HOST=voice.example\n"
        "REALTIME_VOICE_PORT=9001\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n"
        "PSFN_API_BASE_URL=http://127.0.0.1:3100/v1\n"
        "PSFN_MODEL=psfn\n",
        encoding="utf-8",
    )

    config = load_runtime_config(tmp_path)

    assert config.device_transport == "realtime"
    assert config.esphome_target is None
    assert config.realtime_target.port == 9001
    assert config.realtime_target.public_host == "voice.example"
    assert config.psfn_api_base_url == "http://127.0.0.1:3100/v1"
    assert config.psfn_model == "psfn"


def test_load_runtime_config_reads_satellite_claim_and_cert_settings(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "DEVICE_TRANSPORT",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "AUDIO_PUBLIC_HOST",
        "PSFN_API_BASE_URL",
        "PSFN_PROVIDER",
        "PSFN_MODEL",
        "PSFN_CLAIM_NAMESPACE",
        "PSFN_CLAIM_TYPE",
        "PSFN_CHANNEL_TYPE",
        "PSFN_SATELLITE_ID",
        "PSFN_ENDPOINT_ID",
        "PSFN_ENDPOINT_NAME",
        "PSFN_ENDPOINT_CLASS",
        "PSFN_CAPABILITY_PROFILE",
        "PSFN_LOCATION_MODE",
        "PSFN_TELEMETRY_MODE",
        "PSFN_TELEMETRY_CATEGORIES",
        "PSFN_CLIENT_CERT_PATH",
        "PSFN_CLIENT_KEY_PATH",
        "PSFN_CA_CERT_PATH",
        "VOICE_CONVERSATION_ID",
    ):
        monkeypatch.delenv(name, raising=False)

    (tmp_path / "client.pem").write_text("client-cert", encoding="utf-8")
    (tmp_path / "client.key").write_text("client-key", encoding="utf-8")
    (tmp_path / "ca.pem").write_text("ca-cert", encoding="utf-8")
    (tmp_path / ".env").write_text(
        "DEVICE_TRANSPORT=realtime\n"
        "AUDIO_PUBLIC_HOST=voice.example\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n"
        "PSFN_API_BASE_URL=http://127.0.0.1:3100/v1\n"
        "PSFN_MODEL=psfn\n"
        "PSFN_CAPABILITY_PROFILE=mobile-location\n"
        "PSFN_SATELLITE_ID=phone-sat\n"
        "PSFN_ENDPOINT_ID=phone-browser\n"
        "PSFN_ENDPOINT_NAME=Phone Browser\n"
        "VOICE_CONVERSATION_ID=phone-primary\n"
        "PSFN_TELEMETRY_MODE=event\n"
        "PSFN_TELEMETRY_CATEGORIES=location,timezone,battery\n"
        "PSFN_CLIENT_CERT_PATH=client.pem\n"
        "PSFN_CLIENT_KEY_PATH=client.key\n"
        "PSFN_CA_CERT_PATH=ca.pem\n",
        encoding="utf-8",
    )

    config = load_runtime_config(tmp_path)

    assert config.psfn_satellite_claim.namespace == "satellite.endpoint"
    assert config.psfn_satellite_claim.type == "mobile-location"
    assert config.psfn_satellite_claim.satellite_id == "phone-sat"
    assert config.psfn_satellite_claim.endpoint_id == "phone-browser"
    assert config.psfn_satellite_claim.endpoint_class == "mobile"
    assert config.psfn_satellite_claim.location_mode == "mobile"
    assert config.voice_conversation_id == "phone-primary"
    assert config.psfn_satellite_claim.telemetry.categories == ("location", "timezone", "battery")
    assert config.psfn_client_certificate is not None
    assert config.psfn_client_certificate.cert_path == tmp_path / "client.pem"
    assert config.psfn_client_certificate.key_path == tmp_path / "client.key"
    assert config.psfn_client_certificate.ca_path == tmp_path / "ca.pem"


def test_load_runtime_config_accepts_world_avatar_profile(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PSFN_CAPABILITY_PROFILE", "world-avatar")
    (tmp_path / ".env").write_text(
        "DEVICE_TRANSPORT=realtime\n"
        "AUDIO_PUBLIC_HOST=voice.example\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n"
        "PSFN_API_BASE_URL=http://127.0.0.1:3100/v1\n"
        "PSFN_PROVIDER=\n"
        "PSFN_MODEL=psfn\n"
        "PSFN_CLAIM_TYPE=\n"
        "PSFN_ENDPOINT_CLASS=\n"
        "PSFN_LOCATION_MODE=\n"
        "PSFN_TELEMETRY_MODE=\n"
        "PSFN_TELEMETRY_CATEGORIES=\n"
        "PSFN_CLIENT_CERT_PATH=\n"
        "PSFN_CLIENT_KEY_PATH=\n"
        "PSFN_CA_CERT_PATH=\n"
        "PSFN_SATELLITE_ID=eidoverse-world\n"
        "PSFN_ENDPOINT_ID=eidoverse-avatar\n",
        encoding="utf-8",
    )

    config = load_runtime_config(tmp_path)

    assert config.psfn_satellite_claim.capability_profile == "world-avatar"
    assert config.psfn_satellite_claim.type == "world-avatar"
    assert config.psfn_satellite_claim.endpoint_class == "avatar"


def test_load_runtime_config_rejects_unknown_capability_profile(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PSFN_CAPABILITY_PROFILE", "unknown-avatar")
    (tmp_path / ".env").write_text(
        "DEVICE_TRANSPORT=realtime\n"
        "AUDIO_PUBLIC_HOST=voice.example\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n"
        "PSFN_PROVIDER=\n"
        "PSFN_CLIENT_CERT_PATH=\n"
        "PSFN_CLIENT_KEY_PATH=\n"
        "PSFN_CA_CERT_PATH=\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match=r"PSFN_CAPABILITY_PROFILE must be one of:.*world-avatar"):
        load_runtime_config(tmp_path)


def test_load_runtime_config_requires_public_host_in_realtime_mode(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "DEVICE_TRANSPORT",
        "AUDIO_PUBLIC_HOST",
        "REALTIME_VOICE_PUBLIC_HOST",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)

    (tmp_path / ".env").write_text(
        "DEVICE_TRANSPORT=realtime\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n",
        encoding="utf-8",
    )

    with pytest.raises(
        ValueError,
        match="AUDIO_PUBLIC_HOST or REALTIME_VOICE_PUBLIC_HOST is required when DEVICE_TRANSPORT=realtime",
    ):
        load_runtime_config(tmp_path)


def test_load_runtime_config_requires_complete_hub_device_assertion_authority(
    tmp_path: Path,
    monkeypatch,
) -> None:
    for name in (
        "HUB_DEVICE_ASSERTION_FLEET_AUTH_PATH",
        "HUB_DEVICE_ASSERTION_SATELLITE_REGISTRY_PATH",
        "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH",
        "HUB_DEVICE_ASSERTION_TTL_SECONDS",
        "PSFN_COMPANION_ID",
        "PSFN_CLIENT_CERT_PATH",
        "PSFN_CLIENT_KEY_PATH",
        "PSFN_CA_CERT_PATH",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH", "/run/secrets/hub-private.pem")
    (tmp_path / ".env").write_text(
        "ESPHOME_HOST=esphome.example\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="configuration is incomplete"):
        load_runtime_config(tmp_path)


def test_load_runtime_config_requires_concrete_model_with_provider(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "ESPHOME_HOST",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "PSFN_PROVIDER",
        "PSFN_MODEL",
    ):
        monkeypatch.delenv(name, raising=False)

    (tmp_path / ".env").write_text(
        "ESPHOME_HOST=esphome.example\n"
        "DEEPGRAM_API_KEY=project-deepgram\n"
        "ELEVENLABS_API_KEY=project-eleven\n"
        "PSFN_PROVIDER=openrouter\n"
        "PSFN_MODEL=psfn\n",
        encoding="utf-8",
    )

    with pytest.raises(
        ValueError,
        match="PSFN_MODEL must name a concrete provider model when PSFN_PROVIDER is set",
    ):
        load_runtime_config(tmp_path)


def test_static_audio_server_uses_public_host_for_urls(tmp_path: Path) -> None:
    root = tmp_path / "audio"
    root.mkdir()
    audio_path = root / "reply.mp3"
    audio_path.write_bytes(b"test")

    server = StaticAudioServer(
        host="0.0.0.0",
        port=8099,
        root=root,
        public_host="192.0.2.50",
        public_port=18099,
    )

    assert server.url_for(audio_path) == "http://192.0.2.50:18099/reply.mp3"
    stream = server.open_stream()
    assert stream.url.startswith("http://192.0.2.50:18099/streams/")
    stream.close()


def test_static_audio_server_open_stream_uses_stream_endpoint(tmp_path: Path) -> None:
    root = tmp_path / "audio"
    root.mkdir()

    server = StaticAudioServer(
        host="0.0.0.0",
        port=8099,
        root=root,
        public_host="192.0.2.50",
    )

    stream = server.open_stream(content_type="audio/mpeg")

    assert stream.url.startswith("http://192.0.2.50:8099/streams/")
    stream.write(b"test")
    stream.close()


def test_should_flush_prefers_sentence_boundaries_but_allows_long_chunks() -> None:
    assert _should_flush("Hello there.", has_started=True) is True
    assert _should_flush("Short chunk", has_started=True) is False
    assert _should_flush(f"{'x' * 80} ", has_started=True) is True


def test_take_flush_chunk_starts_playback_after_a_short_phrase() -> None:
    flush_text, remainder = _take_flush_chunk("Let me check ", has_started=False)

    assert flush_text == "Let me check"
    assert remainder == ""


def test_take_flush_chunk_prefers_sentence_boundaries() -> None:
    flush_text, remainder = _take_flush_chunk("First sentence. Second one", has_started=True)

    assert flush_text == "First sentence."
    assert remainder == "Second one"
