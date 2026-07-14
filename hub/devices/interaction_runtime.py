from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Literal, Protocol

from aioesphomeapi.model import BinarySensorInfo, BinarySensorState, EntityInfo, EntityState


InteractionType = Literal["headpat"]


class TouchStimulusSubmitter(Protocol):
    async def submit_touch_stimulus(
        self,
        *,
        conversation_id: str,
        kind: Literal["headpat"],
        region: Literal["head"],
        count: int,
        duration_ms: int,
        response_mode: Literal["respond"],
    ) -> dict[str, str]: ...


@dataclass(frozen=True, slots=True)
class SatelliteInteraction:
    interaction_type: InteractionType
    endpoint_id: str
    occurred_at: str
    protocol_version: str = "satellite-interaction.v1"
    source: str = "esphome-native-api"

    def to_wire(self) -> dict[str, str]:
        return {
            "protocolVersion": self.protocol_version,
            "interactionType": self.interaction_type,
            "endpointId": self.endpoint_id,
            "source": self.source,
            "occurredAt": self.occurred_at,
        }


def find_headpat_signal_key(entities: Iterable[EntityInfo]) -> int | None:
    for entity in entities:
        if isinstance(entity, BinarySensorInfo) and entity.object_id == "headpat":
            return entity.key
    return None


async def deliver_interaction(
    interaction: SatelliteInteraction,
    *,
    submitter: TouchStimulusSubmitter,
    conversation_id: str,
) -> dict[str, str]:
    return await submitter.submit_touch_stimulus(
        conversation_id=conversation_id,
        kind="headpat",
        region="head",
        count=1,
        duration_ms=0,
        response_mode="respond",
    )


class ESPHomeInteractionRecorder:
    def __init__(
        self,
        *,
        headpat_signal_key: int,
        endpoint_id: str,
        artifacts_root: Path,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._headpat_signal_key = headpat_signal_key
        self._endpoint_id = endpoint_id
        self._events_path = artifacts_root / "interactions" / "events.jsonl"
        self._now = now or (lambda: datetime.now(timezone.utc))

    def handle_state(self, state: EntityState) -> SatelliteInteraction | None:
        if (
            not isinstance(state, BinarySensorState)
            or state.key != self._headpat_signal_key
            or not state.state
        ):
            return None

        occurred_at = self._now()
        if occurred_at.tzinfo is None:
            occurred_at = occurred_at.replace(tzinfo=timezone.utc)
        interaction = SatelliteInteraction(
            interaction_type="headpat",
            endpoint_id=self._endpoint_id,
            occurred_at=occurred_at.astimezone(timezone.utc).isoformat(),
        )
        self._events_path.parent.mkdir(parents=True, exist_ok=True)
        with self._events_path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(interaction.to_wire(), separators=(",", ":"), sort_keys=True))
            stream.write("\n")
        return interaction
