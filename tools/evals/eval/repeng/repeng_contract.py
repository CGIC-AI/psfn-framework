#!/usr/bin/env python3
"""Shared contracts for PSFN RepE/repeng-style contrast tooling."""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1

CORE_EMOTION_LABELS = (
    "anger",
    "anticipation",
    "confusion",
    "disgust",
    "fear",
    "joy",
    "love",
    "neutral",
    "optimism",
    "pessimism",
    "sadness",
    "surprise",
    "trust",
)

REQUIRED_ACAC_AXIS_IDS = (
    "acac.arousal.high_vs_low",
    "acac.control.high_vs_low",
    "acac.approach.approach_vs_avoid",
    "acac.certainty.high_vs_low",
)

DATASET_KINDS = ("core_emotion", "acac_axis", "smoke")
AXIS_KINDS = ("core_emotion", "acac_axis")
SAFE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

JsonObject = dict[str, Any]


class ContractError(ValueError):
    """Raised when a dataset or artifact violates the repo-owned contract."""


def read_json_object(path: Path) -> JsonObject:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ContractError(f"{path}: invalid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ContractError(f"{path}: top-level value must be an object")
    return parsed


def write_json(path: Path, value: JsonObject) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_contrast_dataset(path: Path) -> JsonObject:
    dataset = read_json_object(path)
    validate_contrast_dataset(dataset, str(path))
    return dataset


def validate_contrast_dataset(dataset: JsonObject, field: str = "dataset") -> JsonObject:
    allowed = {
        "schemaVersion",
        "datasetId",
        "kind",
        "ontology",
        "description",
        "controlAxes",
        "pairs",
    }
    reject_unknown_keys(dataset, allowed, field)

    require_value(dataset.get("schemaVersion") == SCHEMA_VERSION, f"{field}.schemaVersion must be {SCHEMA_VERSION}")
    dataset_id = parse_safe_id(dataset.get("datasetId"), f"{field}.datasetId")
    kind = parse_enum(dataset.get("kind"), DATASET_KINDS, f"{field}.kind")
    parse_non_empty_string(dataset.get("ontology"), f"{field}.ontology")
    parse_non_empty_string(dataset.get("description"), f"{field}.description")

    axes_value = dataset.get("controlAxes")
    if not isinstance(axes_value, list) or not axes_value:
        raise ContractError(f"{field}.controlAxes must be a non-empty array")

    pairs_value = dataset.get("pairs")
    if not isinstance(pairs_value, list) or not pairs_value:
        raise ContractError(f"{field}.pairs must be a non-empty array")

    axis_ids: set[str] = set()
    axis_kinds: dict[str, str] = {}
    for index, axis in enumerate(axes_value):
        if not isinstance(axis, dict):
            raise ContractError(f"{field}.controlAxes[{index}] must be an object")
        validate_axis(axis, f"{field}.controlAxes[{index}]")
        axis_id = axis["id"]
        if axis_id in axis_ids:
            raise ContractError(f"{field}.controlAxes[{index}].id duplicates {axis_id}")
        axis_ids.add(axis_id)
        axis_kinds[axis_id] = axis["kind"]

    pair_ids: set[str] = set()
    pairs_by_axis = {axis_id: 0 for axis_id in axis_ids}
    for index, pair in enumerate(pairs_value):
        if not isinstance(pair, dict):
            raise ContractError(f"{field}.pairs[{index}] must be an object")
        validate_pair(pair, axis_ids, f"{field}.pairs[{index}]")
        pair_id = pair["id"]
        if pair_id in pair_ids:
            raise ContractError(f"{field}.pairs[{index}].id duplicates {pair_id}")
        pair_ids.add(pair_id)
        pairs_by_axis[pair["axisId"]] += 1

    uncovered_axes = sorted(axis_id for axis_id, count in pairs_by_axis.items() if count == 0)
    if uncovered_axes:
        raise ContractError(f"{field}.pairs has no pairs for axes: {', '.join(uncovered_axes)}")

    if kind == "core_emotion" and any(axis_kind != "core_emotion" for axis_kind in axis_kinds.values()):
        raise ContractError(f"{field}.kind core_emotion may only include core_emotion axes")
    if kind == "acac_axis" and any(axis_kind != "acac_axis" for axis_kind in axis_kinds.values()):
        raise ContractError(f"{field}.kind acac_axis may only include acac_axis axes")

    return {
        "datasetId": dataset_id,
        "kind": kind,
        "axisCount": len(axis_ids),
        "pairCount": len(pair_ids),
        "axes": sorted(axis_ids),
    }


def validate_axis(axis: JsonObject, field: str) -> None:
    allowed = {
        "id",
        "kind",
        "positivePole",
        "negativePole",
        "description",
    }
    reject_unknown_keys(axis, allowed, field)
    axis_id = parse_safe_id(axis.get("id"), f"{field}.id")
    kind = parse_enum(axis.get("kind"), AXIS_KINDS, f"{field}.kind")
    positive = parse_non_empty_string(axis.get("positivePole"), f"{field}.positivePole")
    negative = parse_non_empty_string(axis.get("negativePole"), f"{field}.negativePole")
    parse_non_empty_string(axis.get("description"), f"{field}.description")
    if positive == negative:
        raise ContractError(f"{field}.positivePole must differ from negativePole")
    if kind == "core_emotion" and not axis_id.startswith("emotion."):
        raise ContractError(f"{field}.id for core emotion axes must start with emotion.")
    if kind == "acac_axis" and not axis_id.startswith("acac."):
        raise ContractError(f"{field}.id for ACAC axes must start with acac.")


def validate_pair(pair: JsonObject, axis_ids: set[str], field: str) -> None:
    allowed = {
        "id",
        "axisId",
        "positive",
        "negative",
        "metadata",
    }
    reject_unknown_keys(pair, allowed, field)
    parse_safe_id(pair.get("id"), f"{field}.id")
    axis_id = parse_safe_id(pair.get("axisId"), f"{field}.axisId")
    if axis_id not in axis_ids:
        raise ContractError(f"{field}.axisId references unknown axis {axis_id}")
    positive = parse_non_empty_string(pair.get("positive"), f"{field}.positive")
    negative = parse_non_empty_string(pair.get("negative"), f"{field}.negative")
    if positive == negative:
        raise ContractError(f"{field}.positive must differ from negative")
    metadata = pair.get("metadata", {})
    if not isinstance(metadata, dict):
        raise ContractError(f"{field}.metadata must be an object when present")


def validate_required_coverage(
    summaries: list[JsonObject],
    *,
    require_core_emotion_coverage: bool,
    require_acac_coverage: bool,
) -> None:
    axes = {axis for summary in summaries for axis in summary["axes"]}
    if require_core_emotion_coverage:
        required = {f"emotion.{label}" for label in CORE_EMOTION_LABELS}
        missing = sorted(required - axes)
        if missing:
            raise ContractError(f"missing core emotion axes: {', '.join(missing)}")
    if require_acac_coverage:
        missing = sorted(set(REQUIRED_ACAC_AXIS_IDS) - axes)
        if missing:
            raise ContractError(f"missing ACAC axes: {', '.join(missing)}")


def pairs_by_axis(dataset: JsonObject) -> dict[str, list[JsonObject]]:
    grouped: dict[str, list[JsonObject]] = {
        axis["id"]: [] for axis in dataset["controlAxes"]
    }
    for pair in dataset["pairs"]:
        grouped[pair["axisId"]].append(pair)
    return grouped


def select_pairs_for_axis(
    grouped_pairs: dict[str, list[JsonObject]],
    axis_id: str,
    limit: int | None,
) -> list[JsonObject]:
    pairs = grouped_pairs[axis_id]
    if limit is None:
        return pairs
    return pairs[:limit]


def parse_layers(value: str) -> list[int]:
    layers: list[int] = []
    for raw_part in value.split(","):
        part = raw_part.strip()
        if not part:
            continue
        try:
            layer = int(part)
        except ValueError as exc:
            raise ContractError(f"invalid layer index {part!r}") from exc
        if layer < 0:
            raise ContractError("layer indexes must be non-negative")
        layers.append(layer)
    if not layers:
        raise ContractError("at least one layer index is required")
    if len(layers) != len(set(layers)):
        raise ContractError("layer indexes must be unique")
    return layers


def deterministic_text_vector(
    *,
    text: str,
    axis_id: str,
    layer: int,
    vector_dim: int,
    seed: int,
    model_id: str,
) -> list[float]:
    if vector_dim <= 0:
        raise ContractError("vector_dim must be positive")
    values: list[float] = []
    counter = 0
    while len(values) < vector_dim:
        payload = f"{seed}|{model_id}|{axis_id}|{layer}|{counter}|{text}".encode("utf-8")
        digest = hashlib.sha256(payload).digest()
        for byte in digest:
            values.append((byte / 127.5) - 1.0)
            if len(values) == vector_dim:
                break
        counter += 1
    return values


def mean_vector(vectors: list[list[float]]) -> list[float]:
    if not vectors:
        raise ContractError("cannot average an empty vector set")
    dim = len(vectors[0])
    require_value(dim > 0, "vectors must be non-empty")
    sums = [0.0] * dim
    for vector in vectors:
        if len(vector) != dim:
            raise ContractError("cannot average vectors with different dimensions")
        for index, value in enumerate(vector):
            if not math.isfinite(value):
                raise ContractError("vectors must contain only finite numbers")
            sums[index] += value
    return [value / len(vectors) for value in sums]


def subtract_vectors(left: list[float], right: list[float]) -> list[float]:
    if len(left) != len(right):
        raise ContractError("cannot subtract vectors with different dimensions")
    return [left[index] - right[index] for index in range(len(left))]


def dot_product(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        raise ContractError("cannot dot vectors with different dimensions")
    return sum(left[index] * right[index] for index in range(len(left)))


def vector_norm(vector: list[float]) -> float:
    return math.sqrt(sum(value * value for value in vector))


def normalized_vector(vector: list[float]) -> list[float]:
    norm = vector_norm(vector)
    if not math.isfinite(norm) or norm <= 0:
        raise ContractError("cannot normalize a zero or non-finite vector")
    return [value / norm for value in vector]


def reject_unknown_keys(value: JsonObject, allowed: set[str], field: str) -> None:
    unknown = sorted(set(value.keys()) - allowed)
    if unknown:
        raise ContractError(f"{field} contains unknown keys: {', '.join(unknown)}")


def parse_safe_id(value: Any, field: str) -> str:
    parsed = parse_non_empty_string(value, field)
    if not SAFE_ID_PATTERN.fullmatch(parsed):
        raise ContractError(f"{field} must match {SAFE_ID_PATTERN.pattern}")
    return parsed


def parse_non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{field} must be a string")
    normalized = value.strip()
    if not normalized:
        raise ContractError(f"{field} must be non-empty")
    return normalized


def parse_enum(value: Any, allowed: tuple[str, ...], field: str) -> str:
    parsed = parse_non_empty_string(value, field)
    if parsed not in allowed:
        expected = ", ".join(allowed)
        raise ContractError(f"{field} must be one of: {expected}")
    return parsed


def require_value(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)
