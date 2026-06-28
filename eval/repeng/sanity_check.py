#!/usr/bin/env python3
"""Validate generated PSFN control-vector artifacts."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

from repeng_contract import (
    ContractError,
    deterministic_text_vector,
    dot_product,
    load_contrast_dataset,
    pairs_by_axis,
    read_json_object,
    vector_norm,
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sanity-check PSFN control-vector artifacts.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--artifact-dir", help="Directory containing manifest.json.")
    group.add_argument("--manifest", help="Manifest path.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    manifest_path = Path(args.manifest).resolve() if args.manifest else Path(args.artifact_dir).resolve() / "manifest.json"
    artifact_dir = manifest_path.parent
    manifest = read_json_object(manifest_path)
    validate_manifest(manifest, manifest_path)

    vector_summaries = []
    for entry in manifest["vectors"]:
        vector_path = artifact_dir / entry["path"]
        vector_payload = read_json_object(vector_path)
        vector = validate_vector_payload(vector_payload, entry, vector_path)
        vector_summaries.append({
            "axisId": entry["axisId"],
            "layer": entry["layer"],
            "dim": len(vector),
            "norm": vector_norm(vector),
        })

    fixture_checks = []
    if manifest["training"]["backend"] == "fixture":
        fixture_checks = run_fixture_direction_checks(manifest, artifact_dir)

    print(json.dumps({
        "schemaVersion": 1,
        "manifest": str(manifest_path),
        "vectorCount": len(vector_summaries),
        "vectors": vector_summaries,
        "fixtureChecks": fixture_checks,
    }, indent=2, sort_keys=True))
    return 0


def validate_manifest(manifest: dict[str, Any], manifest_path: Path) -> None:
    required = {
        "schemaVersion",
        "artifactType",
        "artifactId",
        "createdAt",
        "dataset",
        "artifactLayout",
        "training",
        "vectors",
    }
    unknown = sorted(set(manifest) - required)
    if unknown:
        raise ContractError(f"{manifest_path}: manifest contains unknown keys: {', '.join(unknown)}")
    if manifest["schemaVersion"] != 1:
        raise ContractError(f"{manifest_path}: schemaVersion must be 1")
    if manifest["artifactType"] != "psfn.control_vector_manifest":
        raise ContractError(f"{manifest_path}: artifactType must be psfn.control_vector_manifest")
    if not isinstance(manifest["vectors"], list) or not manifest["vectors"]:
        raise ContractError(f"{manifest_path}: vectors must be a non-empty array")
    if not isinstance(manifest["training"], dict):
        raise ContractError(f"{manifest_path}: training must be an object")
    if manifest["training"].get("backend") not in {"fixture", "transformers"}:
        raise ContractError(f"{manifest_path}: unsupported training.backend")
    if not isinstance(manifest["dataset"], dict) or not manifest["dataset"].get("path"):
        raise ContractError(f"{manifest_path}: dataset.path is required")


def validate_vector_payload(
    payload: dict[str, Any],
    manifest_entry: dict[str, Any],
    vector_path: Path,
) -> list[float]:
    required = {
        "schemaVersion",
        "artifactType",
        "axisId",
        "layer",
        "backend",
        "modelId",
        "vector",
        "sourcePairIds",
    }
    unknown = sorted(set(payload) - required)
    if unknown:
        raise ContractError(f"{vector_path}: vector payload contains unknown keys: {', '.join(unknown)}")
    if payload["schemaVersion"] != 1:
        raise ContractError(f"{vector_path}: schemaVersion must be 1")
    if payload["artifactType"] != "psfn.control_vector":
        raise ContractError(f"{vector_path}: artifactType must be psfn.control_vector")
    if payload["axisId"] != manifest_entry["axisId"] or payload["layer"] != manifest_entry["layer"]:
        raise ContractError(f"{vector_path}: vector identity does not match manifest")
    vector = payload["vector"]
    if not isinstance(vector, list) or len(vector) != manifest_entry["dim"]:
        raise ContractError(f"{vector_path}: vector length does not match manifest dim")
    parsed = []
    for index, value in enumerate(vector):
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ContractError(f"{vector_path}: vector[{index}] must be finite")
        parsed.append(float(value))
    observed_norm = vector_norm(parsed)
    if not math.isclose(observed_norm, float(manifest_entry["norm"]), rel_tol=1e-6, abs_tol=1e-6):
        raise ContractError(f"{vector_path}: vector norm does not match manifest")
    if observed_norm <= 0:
        raise ContractError(f"{vector_path}: vector norm must be positive")
    return parsed


def run_fixture_direction_checks(manifest: dict[str, Any], artifact_dir: Path) -> list[dict[str, Any]]:
    training = manifest["training"]
    dataset_path = Path(manifest["dataset"]["path"])
    dataset = load_contrast_dataset(dataset_path)
    grouped_pairs = pairs_by_axis(dataset)
    pair_lookup = {
        pair["id"]: pair
        for pairs in grouped_pairs.values()
        for pair in pairs
    }
    checks = []
    for entry in manifest["vectors"]:
        vector_payload = read_json_object(artifact_dir / entry["path"])
        vector = [float(value) for value in vector_payload["vector"]]
        margins = []
        for pair_id in entry["sourcePairIds"]:
            pair = pair_lookup[pair_id]
            positive = deterministic_text_vector(
                text=pair["positive"],
                axis_id=entry["axisId"],
                layer=entry["layer"],
                vector_dim=training["vectorDim"],
                seed=training["seed"],
                model_id=training["modelId"],
            )
            negative = deterministic_text_vector(
                text=pair["negative"],
                axis_id=entry["axisId"],
                layer=entry["layer"],
                vector_dim=training["vectorDim"],
                seed=training["seed"],
                model_id=training["modelId"],
            )
            margins.append(dot_product(vector, positive) - dot_product(vector, negative))
        mean_margin = sum(margins) / len(margins)
        if mean_margin <= 0:
            raise ContractError(
                f"{entry['axisId']} layer {entry['layer']} fixture direction margin must be positive"
            )
        checks.append({
            "axisId": entry["axisId"],
            "layer": entry["layer"],
            "meanDirectionMargin": mean_margin,
        })
    return checks


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ContractError as exc:
        print(f"[eval/repeng] sanity check failed: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
