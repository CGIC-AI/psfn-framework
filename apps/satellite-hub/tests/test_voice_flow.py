from __future__ import annotations

import asyncio
import json
from pathlib import Path

from aioesphomeapi.model import VoiceAssistantAudioSettings

from hub.devices.voice_flow import PCMFormatAssumption, VoiceTransportSpike


def test_voice_transport_spike_writes_artifacts(tmp_path: Path) -> None:
    async def scenario() -> None:
        spike = VoiceTransportSpike(
            output_root=tmp_path,
            pcm_format=PCMFormatAssumption(
                sample_rate=16000,
                channels=1,
                sample_width_bytes=2,
            ),
            listen_port=0,
        )
        port = await spike.handle_start(
            "conversation-1",
            3,
            VoiceAssistantAudioSettings(
                noise_suppression_level=2,
                auto_gain=3,
                volume_multiplier=4.0,
            ),
            "hey device",
        )
        assert port == 0
        await spike.handle_audio(b"\x01\x02\x03\x04")
        await spike.handle_audio(b"\x05\x06")
        await spike.handle_stop(False)

    asyncio.run(scenario())

    manifests = list(tmp_path.rglob("manifest.json"))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    assert manifest["conversation_id"] == "conversation-1"
    assert manifest["chunks"] == 2
    assert manifest["bytes_received"] == 6
    assert manifest["stop_reason"] == "audio_end"

    pcm_path = manifests[0].parent / "audio.pcm"
    wav_path = manifests[0].parent / "audio.wav"
    assert pcm_path.read_bytes() == b"\x01\x02\x03\x04\x05\x06"
    assert wav_path.exists()
