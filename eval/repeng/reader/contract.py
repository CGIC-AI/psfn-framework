"""Contracts for PSFN RepE reader artifacts and scenario inputs."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from repeng_contract import (
    ContractError,
    file_sha256,
    parse_non_empty_string,
    parse_safe_id,
    read_json_object,
    reject_unknown_keys,
    vector_norm,
)


READER_RESULT_ARTIFACT_TYPE = "psfn.repeng_reader_result"
CONTROL_VECTOR_MANIFEST_TYPE = "psfn.control_vector_manifest"
CONTROL_VECTOR_TYPE = "psfn.control_vector"
SUPPORTED_BACKENDS = ("fixture", "transformers")
SUPPORTED_PROJECTION_POOLS = ("mean", "last")


JsonObject = dict[str, Any]


@dataclass(frozen=True)
class ControlVector:
    axis_id: str
    layer: int
    path: str
    dim: int
    norm: float
    vector: list[float]
    source_pair_ids: list[str]


@dataclass(frozen=True)
class ControlVectorArtifact:
    manifest_path: Path
    artifact_dir: Path
    manifest_sha256: str
    manifest: JsonObject
    vectors: list[ControlVector]

    @property
    def layers(self) -> list[int]:
        return sorted({vector.layer for vector in self.vectors})

    @property
    def axis_ids(self) -> list[str]:
        return sorted({vector.axis_id for vector in self.vectors})

    @property
    def training_backend(self) -> str:
        return str(self.manifest["training"]["backend"])

    @property
    def model_id(self) -> str:
        return str(self.manifest["training"]["modelId"])


@dataclass(frozen=True)
class ReaderScenario:
    id: str
    prompt: str
    expected_scores: dict[str, float]
    source: str
    metadata: JsonObject


def load_control_vector_artifact(manifest_path: Path) -> ControlVectorArtifact:
    resolved_manifest_path = manifest_path.resolve()
    artifact_dir = resolved_manifest_path.parent
    manifest = read_json_object(resolved_manifest_path)
    validate_manifest(manifest, resolved_manifest_path)
    vectors = [
        load_control_vector(
            artifact_dir=artifact_dir,
            manifest_entry=entry,
            manifest_path=resolved_manifest_path,
            training=manifest["training"],
        )
        for entry in manifest["vectors"]
    ]
    ensure_unique_vectors(vectors, resolved_manifest_path)
    return ControlVectorArtifact(
        manifest_path=resolved_manifest_path,
        artifact_dir=artifact_dir,
        manifest_sha256=file_sha256(resolved_manifest_path),
        manifest=manifest,
        vectors=vectors,
    )


def validate_manifest(manifest: JsonObject, manifest_path: Path) -> None:
    allowed = {
        "schemaVersion",
        "artifactType",
        "artifactId",
        "createdAt",
        "dataset",
        "artifactLayout",
        "training",
        "vectors",
    }
    reject_unknown_keys(manifest, allowed, str(manifest_path))
    if manifest.get("schemaVersion") != 1:
        raise ContractError(f"{manifest_path}: schemaVersion must be 1")
    if manifest.get("artifactType") != CONTROL_VECTOR_MANIFEST_TYPE:
        raise ContractError(f"{manifest_path}: artifactType must be {CONTROL_VECTOR_MANIFEST_TYPE}")
    parse_non_empty_string(manifest.get("artifactId"), f"{manifest_path}.artifactId")
    validate_manifest_dataset(manifest.get("dataset"), f"{manifest_path}.dataset")
    validate_manifest_training(manifest.get("training"), f"{manifest_path}.training")
    vectors = manifest.get("vectors")
    if not isinstance(vectors, list) or not vectors:
        raise ContractError(f"{manifest_path}: vectors must be a non-empty array")
    for index, entry in enumerate(vectors):
        validate_manifest_vector_entry(entry, f"{manifest_path}.vectors[{index}]")


def validate_manifest_dataset(value: Any, field: str) -> None:
    if not isinstance(value, dict):
        raise ContractError(f"{field} must be an object")
    reject_unknown_keys(value, {"datasetId", "path", "sha256"}, field)
    parse_safe_id(value.get("datasetId"), f"{field}.datasetId")
    parse_non_empty_string(value.get("path"), f"{field}.path")
    digest = parse_non_empty_string(value.get("sha256"), f"{field}.sha256")
    if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
        raise ContractError(f"{field}.sha256 must be a lowercase SHA-256 digest")


def validate_manifest_training(value: Any, field: str) -> None:
    if not isinstance(value, dict):
        raise ContractError(f"{field} must be an object")
    reject_unknown_keys(value, {"backend", "modelId", "layers", "seed", "vectorDim", "limitPairsPerAxis"}, field)
    backend = parse_non_empty_string(value.get("backend"), f"{field}.backend")
    if backend not in SUPPORTED_BACKENDS:
        raise ContractError(f"{field}.backend must be one of: {', '.join(SUPPORTED_BACKENDS)}")
    parse_non_empty_string(value.get("modelId"), f"{field}.modelId")
    layers = value.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ContractError(f"{field}.layers must be a non-empty array")
    seen_layers: set[int] = set()
    for index, layer in enumerate(layers):
        parsed = parse_non_negative_int(layer, f"{field}.layers[{index}]")
        if parsed in seen_layers:
            raise ContractError(f"{field}.layers must be unique")
        seen_layers.add(parsed)
    if backend == "fixture":
        parse_int(value.get("seed"), f"{field}.seed")
        vector_dim = parse_positive_int(value.get("vectorDim"), f"{field}.vectorDim")
        if vector_dim <= 0:
            raise ContractError(f"{field}.vectorDim must be positive")


def validate_manifest_vector_entry(value: Any, field: str) -> None:
    if not isinstance(value, dict):
        raise ContractError(f"{field} must be an object")
    reject_unknown_keys(value, {"axisId", "layer", "path", "dim", "norm", "sourcePairIds"}, field)
    parse_safe_id(value.get("axisId"), f"{field}.axisId")
    parse_non_negative_int(value.get("layer"), f"{field}.layer")
    parse_non_empty_string(value.get("path"), f"{field}.path")
    parse_positive_int(value.get("dim"), f"{field}.dim")
    parse_finite_number(value.get("norm"), f"{field}.norm")
    source_pair_ids = value.get("sourcePairIds")
    if not isinstance(source_pair_ids, list) or not source_pair_ids:
        raise ContractError(f"{field}.sourcePairIds must be a non-empty array")
    for index, pair_id in enumerate(source_pair_ids):
        parse_safe_id(pair_id, f"{field}.sourcePairIds[{index}]")


def load_control_vector(
    *,
    artifact_dir: Path,
    manifest_entry: JsonObject,
    manifest_path: Path,
    training: JsonObject,
) -> ControlVector:
    vector_path = resolve_artifact_child_path(artifact_dir, str(manifest_entry["path"]), manifest_path)
    payload = read_json_object(vector_path)
    validate_vector_payload(payload, manifest_entry, vector_path, training)
    vector = [float(value) for value in payload["vector"]]
    return ControlVector(
        axis_id=str(manifest_entry["axisId"]),
        layer=int(manifest_entry["layer"]),
        path=str(manifest_entry["path"]),
        dim=int(manifest_entry["dim"]),
        norm=float(manifest_entry["norm"]),
        vector=vector,
        source_pair_ids=[str(pair_id) for pair_id in manifest_entry["sourcePairIds"]],
    )


def resolve_artifact_child_path(artifact_dir: Path, relative_path: str, manifest_path: Path) -> Path:
    raw_path = Path(relative_path)
    if raw_path.is_absolute():
        raise ContractError(f"{manifest_path}: vector path must be relative: {relative_path}")
    resolved_artifact_dir = artifact_dir.resolve()
    resolved_path = (artifact_dir / raw_path).resolve()
    try:
        resolved_path.relative_to(resolved_artifact_dir)
    except ValueError as exc:
        raise ContractError(f"{manifest_path}: vector path escapes artifact directory: {relative_path}") from exc
    return resolved_path


def validate_vector_payload(
    payload: JsonObject,
    manifest_entry: JsonObject,
    vector_path: Path,
    training: JsonObject,
) -> None:
    allowed = {
        "schemaVersion",
        "artifactType",
        "axisId",
        "layer",
        "backend",
        "modelId",
        "vector",
        "sourcePairIds",
    }
    reject_unknown_keys(payload, allowed, str(vector_path))
    if payload.get("schemaVersion") != 1:
        raise ContractError(f"{vector_path}: schemaVersion must be 1")
    if payload.get("artifactType") != CONTROL_VECTOR_TYPE:
        raise ContractError(f"{vector_path}: artifactType must be {CONTROL_VECTOR_TYPE}")
    if payload.get("axisId") != manifest_entry["axisId"] or payload.get("layer") != manifest_entry["layer"]:
        raise ContractError(f"{vector_path}: vector identity does not match manifest")
    if payload.get("backend") != training["backend"]:
        raise ContractError(f"{vector_path}: backend does not match manifest training backend")
    if payload.get("modelId") != training["modelId"]:
        raise ContractError(f"{vector_path}: modelId does not match manifest training modelId")
    source_pair_ids = payload.get("sourcePairIds")
    if source_pair_ids != manifest_entry["sourcePairIds"]:
        raise ContractError(f"{vector_path}: sourcePairIds do not match manifest")
    vector = payload.get("vector")
    if not isinstance(vector, list) or len(vector) != manifest_entry["dim"]:
        raise ContractError(f"{vector_path}: vector length does not match manifest dim")
    parsed = []
    for index, value in enumerate(vector):
        parsed.append(parse_finite_number(value, f"{vector_path}.vector[{index}]"))
    observed_norm = vector_norm(parsed)
    expected_norm = float(manifest_entry["norm"])
    if observed_norm <= 0:
        raise ContractError(f"{vector_path}: vector norm must be positive")
    if not math.isclose(observed_norm, expected_norm, rel_tol=1e-6, abs_tol=1e-6):
        raise ContractError(f"{vector_path}: vector norm does not match manifest")
    if training["backend"] == "fixture" and len(parsed) != training["vectorDim"]:
        raise ContractError(f"{vector_path}: fixture vector length does not match training.vectorDim")


def ensure_unique_vectors(vectors: list[ControlVector], manifest_path: Path) -> None:
    seen: set[tuple[str, int]] = set()
    for vector in vectors:
        key = (vector.axis_id, vector.layer)
        if key in seen:
            raise ContractError(f"{manifest_path}: duplicate vector for {vector.axis_id} layer {vector.layer}")
        seen.add(key)


def load_reader_scenarios(scenario_path: Path, *, limit: int | None = None) -> list[ReaderScenario]:
    if limit is not None and limit <= 0:
        raise ContractError("--limit-scenarios must be positive")
    value = read_json_value(scenario_path)
    if isinstance(value, dict) and "scenarios" in value:
        scenarios = parse_reader_scenario_set(value, str(scenario_path))
    elif isinstance(value, list):
        scenarios = parse_calibration_scenarios(value, str(scenario_path))
    else:
        raise ContractError(
            f"{scenario_path}: expected a reader scenario object or calibration scenario array"
        )
    if limit is not None:
        scenarios = scenarios[:limit]
    if not scenarios:
        raise ContractError(f"{scenario_path}: at least one scenario is required")
    return scenarios


def read_json_value(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ContractError(f"{path}: invalid JSON: {exc}") from exc


def parse_reader_scenario_set(value: JsonObject, field: str) -> list[ReaderScenario]:
    reject_unknown_keys(value, {"schemaVersion", "scenarios"}, field)
    if value.get("schemaVersion") != 1:
        raise ContractError(f"{field}.schemaVersion must be 1")
    scenarios = value.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        raise ContractError(f"{field}.scenarios must be a non-empty array")
    parsed = [parse_reader_scenario(entry, f"{field}.scenarios[{index}]") for index, entry in enumerate(scenarios)]
    ensure_unique_scenario_ids(parsed, field)
    return parsed


def parse_reader_scenario(value: Any, field: str) -> ReaderScenario:
    if not isinstance(value, dict):
        raise ContractError(f"{field} must be an object")
    reject_unknown_keys(value, {"id", "prompt", "expectedScores", "metadata"}, field)
    scenario_id = parse_safe_id(value.get("id"), f"{field}.id")
    prompt = parse_non_empty_string(value.get("prompt"), f"{field}.prompt")
    expected_scores = parse_expected_scores(value.get("expectedScores"), f"{field}.expectedScores")
    metadata = value.get("metadata", {})
    if not isinstance(metadata, dict):
        raise ContractError(f"{field}.metadata must be an object when present")
    return ReaderScenario(
        id=scenario_id,
        prompt=prompt,
        expected_scores=expected_scores,
        source="reader.expected_scores",
        metadata=metadata,
    )


def parse_calibration_scenarios(value: list[Any], field: str) -> list[ReaderScenario]:
    parsed = [parse_calibration_scenario(entry, f"{field}[{index}]") for index, entry in enumerate(value)]
    ensure_unique_scenario_ids(parsed, field)
    return parsed


def parse_calibration_scenario(value: Any, field: str) -> ReaderScenario:
    if not isinstance(value, dict):
        raise ContractError(f"{field} must be an object")
    vars_value = value.get("vars")
    metadata = value.get("metadata")
    if not isinstance(vars_value, dict):
        raise ContractError(f"{field}.vars must be an object")
    if not isinstance(metadata, dict):
        raise ContractError(f"{field}.metadata must be an object")
    scenario_id = parse_safe_id(vars_value.get("scenario_id"), f"{field}.vars.scenario_id")
    prompt = parse_non_empty_string(vars_value.get("user_message"), f"{field}.vars.user_message")
    ground_truth = metadata.get("ground_truth")
    if not isinstance(ground_truth, dict):
        raise ContractError(f"{field}.metadata.ground_truth must be an object")
    expected_scores = expected_scores_from_calibration_ground_truth(ground_truth, f"{field}.metadata.ground_truth")
    suite = parse_non_empty_string(metadata.get("suite"), f"{field}.metadata.suite")
    return ReaderScenario(
        id=scenario_id,
        prompt=prompt,
        expected_scores=expected_scores,
        source=suite,
        metadata={
            "description": value.get("description"),
            "groundTruth": ground_truth,
        },
    )


def expected_scores_from_calibration_ground_truth(ground_truth: JsonObject, field: str) -> dict[str, float]:
    scores: dict[str, float] = {}
    primary_label = parse_safe_id(ground_truth.get("primary_label"), f"{field}.primary_label")
    scores[f"emotion.{primary_label}"] = 1.0

    secondary_labels = ground_truth.get("secondary_labels", [])
    if not isinstance(secondary_labels, list):
        raise ContractError(f"{field}.secondary_labels must be an array")
    for index, label in enumerate(secondary_labels):
        parsed_label = parse_safe_id(label, f"{field}.secondary_labels[{index}]")
        scores.setdefault(f"emotion.{parsed_label}", 0.5)

    acac = ground_truth.get("acac")
    if not isinstance(acac, dict):
        raise ContractError(f"{field}.acac must be an object")
    scores["acac.arousal.high_vs_low"] = parse_tri_band_score(acac.get("arousal"), f"{field}.acac.arousal")
    scores["acac.control.high_vs_low"] = parse_tri_band_score(acac.get("control"), f"{field}.acac.control")
    scores["acac.approach.approach_vs_avoid"] = parse_approach_score(acac.get("approach"), f"{field}.acac.approach")
    scores["acac.certainty.high_vs_low"] = parse_tri_band_score(acac.get("certainty"), f"{field}.acac.certainty")
    return scores


def parse_expected_scores(value: Any, field: str) -> dict[str, float]:
    if not isinstance(value, dict) or not value:
        raise ContractError(f"{field} must be a non-empty object")
    parsed: dict[str, float] = {}
    for axis_id, score in value.items():
        parsed[parse_safe_id(axis_id, f"{field}.{axis_id}")] = parse_expected_score(score, f"{field}.{axis_id}")
    return parsed


def parse_expected_score(value: Any, field: str) -> float:
    parsed = parse_finite_number(value, field)
    if parsed < -1 or parsed > 1:
        raise ContractError(f"{field} must be between -1 and 1")
    return parsed


def parse_tri_band_score(value: Any, field: str) -> float:
    parsed = parse_non_empty_string(value, field)
    mapping = {"high": 1.0, "medium": 0.0, "low": -1.0}
    if parsed not in mapping:
        raise ContractError(f"{field} must be one of: high, medium, low")
    return mapping[parsed]


def parse_approach_score(value: Any, field: str) -> float:
    parsed = parse_non_empty_string(value, field)
    mapping = {"approach": 1.0, "balanced": 0.0, "avoid": -1.0}
    if parsed not in mapping:
        raise ContractError(f"{field} must be one of: approach, balanced, avoid")
    return mapping[parsed]


def ensure_unique_scenario_ids(scenarios: list[ReaderScenario], field: str) -> None:
    seen: set[str] = set()
    for scenario in scenarios:
        if scenario.id in seen:
            raise ContractError(f"{field}: duplicate scenario id {scenario.id}")
        seen.add(scenario.id)


def parse_int(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise ContractError(f"{field} must be an integer")
    return value


def parse_non_negative_int(value: Any, field: str) -> int:
    parsed = parse_int(value, field)
    if parsed < 0:
        raise ContractError(f"{field} must be non-negative")
    return parsed


def parse_positive_int(value: Any, field: str) -> int:
    parsed = parse_int(value, field)
    if parsed <= 0:
        raise ContractError(f"{field} must be positive")
    return parsed


def parse_finite_number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise ContractError(f"{field} must be a finite number")
    return float(value)


def validate_target_layers(artifact: ControlVectorArtifact, requested_layers: list[int]) -> list[int]:
    available = set(artifact.layers)
    missing = [layer for layer in requested_layers if layer not in available]
    if missing:
        raise ContractError(
            "requested layers are missing from control-vector manifest: "
            + ", ".join(str(layer) for layer in missing)
        )
    return requested_layers


def scenario_to_result(scenario: ReaderScenario) -> JsonObject:
    return {
        "id": scenario.id,
        "prompt": scenario.prompt,
        "expectedScores": scenario.expected_scores,
        "source": scenario.source,
        "metadata": scenario.metadata,
    }
