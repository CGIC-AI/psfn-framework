from __future__ import annotations

import json
from datetime import datetime, timezone

from aioesphomeapi.model import BinarySensorInfo, BinarySensorState
import pytest

from hub.devices.interaction_runtime import (
    ESPHomeInteractionRecorder,
    SatelliteInteraction,
    deliver_interaction,
    find_headpat_signal_key,
)


def test_headpat_signal_is_discovered_from_native_api_metadata() -> None:
    entities = [
        BinarySensorInfo(object_id="other", key=10),
        BinarySensorInfo(object_id="headpat", key=42),
    ]

    assert find_headpat_signal_key(entities) == 42


def test_headpat_event_is_recorded_as_a_typed_interaction(tmp_path) -> None:
    recorder = ESPHomeInteractionRecorder(
        headpat_signal_key=42,
        endpoint_id="waveshare-bedroom",
        artifacts_root=tmp_path,
        now=lambda: datetime(2026, 7, 14, 2, 30, tzinfo=timezone.utc),
    )

    recorded = recorder.handle_state(BinarySensorState(key=42, state=True))

    assert recorded is not None
    assert recorded.interaction_type == "headpat"
    assert recorded.endpoint_id == "waveshare-bedroom"
    assert recorded.occurred_at == "2026-07-14T02:30:00+00:00"
    lines = (tmp_path / "interactions" / "events.jsonl").read_text(encoding="utf-8").splitlines()
    assert [json.loads(line) for line in lines] == [
        {
            "endpointId": "waveshare-bedroom",
            "interactionType": "headpat",
            "occurredAt": "2026-07-14T02:30:00+00:00",
            "protocolVersion": "satellite-interaction.v1",
            "source": "esphome-native-api",
        },
    ]


def test_interaction_recorder_ignores_other_entities_and_event_types(tmp_path) -> None:
    recorder = ESPHomeInteractionRecorder(
        headpat_signal_key=42,
        endpoint_id="waveshare-bedroom",
        artifacts_root=tmp_path,
    )

    assert recorder.handle_state(BinarySensorState(key=99, state=True)) is None
    assert recorder.handle_state(BinarySensorState(key=42, state=False)) is None
    assert not (tmp_path / "interactions" / "events.jsonl").exists()


@pytest.mark.anyio
async def test_headpat_interaction_delivers_one_fixed_touch_stimulus() -> None:
    captured: list[dict[str, object]] = []

    class Submitter:
        async def submit_touch_stimulus(self, **kwargs):
            captured.append(kwargs)
            return {"status": "accepted", "messageId": "stimulus-1"}

    result = await deliver_interaction(
        SatelliteInteraction(
            interaction_type="headpat",
            endpoint_id="waveshare-bedroom",
            occurred_at="2026-07-14T02:30:00+00:00",
        ),
        submitter=Submitter(),
        conversation_id="bedroom",
    )

    assert result == {"status": "accepted", "messageId": "stimulus-1"}
    assert captured == [{
        "conversation_id": "bedroom",
        "kind": "headpat",
        "region": "head",
        "count": 1,
        "duration_ms": 0,
        "response_mode": "respond",
    }]
