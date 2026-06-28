#!/usr/bin/env python3
"""Run PSFN RepE control-vector readers over scenario prompts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any


REPENG_ROOT = Path(__file__).resolve().parents[1]
if str(REPENG_ROOT) not in sys.path:
    sys.path.insert(0, str(REPENG_ROOT))

from repeng_contract import ContractError, parse_layers, write_json
from reader.backends import FixtureReaderBackend, TransformersReaderBackend
from reader.contract import (
    READER_RESULT_ARTIFACT_TYPE,
    SUPPORTED_BACKENDS,
    SUPPORTED_PROJECTION_POOLS,
    ControlVectorArtifact,
    JsonObject,
    ReaderScenario,
    load_control_vector_artifact,
    load_reader_scenarios,
    scenario_to_result,
    validate_target_layers,
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Project scenario hidden states onto PSFN control vectors and run per-layer logit lens.",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--artifact-dir", help="Directory containing a control-vector manifest.json.")
    group.add_argument("--manifest", help="Control-vector manifest path.")
    parser.add_argument("--scenarios", required=True, help="Reader scenario JSON or calibration scenario JSON.")
    parser.add_argument("--output", help="Output JSON path. Defaults to printing the full result.")
    parser.add_argument(
        "--backend",
        choices=SUPPORTED_BACKENDS,
        help="Reader backend. Defaults to the manifest training backend.",
    )
    parser.add_argument("--model-cache", help="Optional Transformers model cache directory.")
    parser.add_argument(
        "--layers",
        help="Comma-separated layer indexes to read. Defaults to all layers in the manifest.",
    )
    parser.add_argument(
        "--limit-scenarios",
        type=int,
        help="Deterministically keep only the first N scenarios.",
    )
    parser.add_argument(
        "--projection-pool",
        choices=SUPPORTED_PROJECTION_POOLS,
        default="mean",
        help="Hidden-state pooling strategy for activation projection.",
    )
    parser.add_argument("--top-k", type=int, default=5, help="Number of logit-lens tokens to report per layer.")
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Pass trust_remote_code=True to Transformers. Disabled by default.",
    )
    parser.add_argument(
        "--dtype",
        choices=("bfloat16", "float16", "float32"),
        default="bfloat16",
        help="Transformers model dtype.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.top_k <= 0:
        raise ContractError("--top-k must be positive")

    manifest_path = Path(args.manifest).resolve() if args.manifest else Path(args.artifact_dir).resolve() / "manifest.json"
    artifact = load_control_vector_artifact(manifest_path)
    layers = validate_target_layers(artifact, parse_layers(args.layers) if args.layers else artifact.layers)
    scenarios = load_reader_scenarios(Path(args.scenarios).resolve(), limit=args.limit_scenarios)
    backend_name = args.backend or artifact.training_backend
    backend = build_backend(args=args, artifact=artifact, backend_name=backend_name)

    result = run_reader(
        artifact=artifact,
        scenarios=scenarios,
        backend=backend,
        backend_name=backend_name,
        layers=layers,
        projection_pool=args.projection_pool,
        top_k=args.top_k,
    )

    if args.output:
        output_path = Path(args.output).resolve()
        write_json(output_path, result)
        print(json.dumps({
            "schemaVersion": 1,
            "output": str(output_path),
            "scenarioCount": result["scenarioCount"],
            "projectionCount": len(result["projections"]),
            "honestLayer": result["honestLayer"],
        }, indent=2, sort_keys=True))
    else:
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0


def build_backend(*, args: argparse.Namespace, artifact: ControlVectorArtifact, backend_name: str) -> Any:
    if backend_name != artifact.training_backend:
        raise ContractError(
            f"reader backend {backend_name} does not match manifest training backend {artifact.training_backend}"
        )
    if backend_name == "fixture":
        return FixtureReaderBackend(training=artifact.manifest["training"])
    if backend_name == "transformers":
        return TransformersReaderBackend(
            model_id=artifact.model_id,
            model_cache=args.model_cache,
            trust_remote_code=args.trust_remote_code,
            dtype=args.dtype,
        )
    raise ContractError(f"unsupported reader backend: {backend_name}")


def run_reader(
    *,
    artifact: ControlVectorArtifact,
    scenarios: list[ReaderScenario],
    backend: Any,
    backend_name: str,
    layers: list[int],
    projection_pool: str,
    top_k: int,
) -> JsonObject:
    target_vectors = [vector for vector in artifact.vectors if vector.layer in set(layers)]
    if not target_vectors:
        raise ContractError("no control vectors selected")

    projections: list[JsonObject] = []
    logit_lens: list[JsonObject] = []
    for scenario in scenarios:
        prepared = backend.prepare_scenario(
            scenario=scenario,
            layers=layers,
            projection_pool=projection_pool,
        )
        logit_lens.extend(backend.logit_lens(
            prepared=prepared,
            scenario=scenario,
            layers=layers,
            top_k=top_k,
        ))
        for control_vector in target_vectors:
            measurement = backend.project(
                prepared=prepared,
                scenario=scenario,
                control_vector=control_vector,
                projection_pool=projection_pool,
            )
            expected_score = scenario.expected_scores.get(control_vector.axis_id)
            alignment = measurement.score * expected_score if expected_score is not None else None
            projections.append({
                "scenarioId": scenario.id,
                "axisId": control_vector.axis_id,
                "layer": control_vector.layer,
                "projection": measurement.score,
                "hiddenNorm": measurement.hidden_norm,
                "vectorNorm": control_vector.norm,
                "expectedScore": expected_score,
                "alignment": alignment,
            })

    layer_summaries = summarize_layers(projections, layers)
    honest_layer = select_honest_layer(layer_summaries)
    return {
        "schemaVersion": 1,
        "artifactType": READER_RESULT_ARTIFACT_TYPE,
        "createdAt": utc_now_iso(),
        "controlVectorManifest": {
            "path": str(artifact.manifest_path),
            "sha256": artifact.manifest_sha256,
            "artifactId": artifact.manifest["artifactId"],
            "datasetId": artifact.manifest["dataset"]["datasetId"],
            "trainingBackend": artifact.training_backend,
            "modelId": artifact.model_id,
            "layers": artifact.layers,
            "axisIds": artifact.axis_ids,
        },
        "reader": {
            "backend": backend_name,
            "projectionPool": projection_pool,
            "targetLayers": layers,
            "logitLensTopK": top_k,
        },
        "scenarioCount": len(scenarios),
        "scenarios": [scenario_to_result(scenario) for scenario in scenarios],
        "projections": projections,
        "logitLens": logit_lens,
        "layerSummaries": layer_summaries,
        "honestLayer": honest_layer,
    }


def summarize_layers(projections: list[JsonObject], layers: list[int]) -> list[JsonObject]:
    summaries = []
    for layer in layers:
        evidence = [
            projection
            for projection in projections
            if projection["layer"] == layer
            and projection["expectedScore"] is not None
            and not math.isclose(float(projection["expectedScore"]), 0.0, abs_tol=1e-12)
        ]
        alignments = [float(projection["alignment"]) for projection in evidence]
        sign_correct = [alignment > 0 for alignment in alignments]
        projection_values = [float(projection["projection"]) for projection in evidence]
        expected_values = [float(projection["expectedScore"]) for projection in evidence]
        summaries.append({
            "layer": layer,
            "evidenceCount": len(evidence),
            "meanExpectedAlignment": mean(alignments),
            "signAccuracy": mean([1.0 if value else 0.0 for value in sign_correct]),
            "pearsonCorrelation": pearson_correlation(projection_values, expected_values),
        })
    return summaries


def select_honest_layer(layer_summaries: list[JsonObject]) -> JsonObject | None:
    candidates = [summary for summary in layer_summaries if summary["evidenceCount"] > 0]
    if not candidates:
        return None
    selected = sorted(
        candidates,
        key=lambda summary: (
            -float(summary["signAccuracy"]),
            -float(summary["meanExpectedAlignment"]),
            int(summary["layer"]),
        ),
    )[0]
    return {
        "layer": selected["layer"],
        "selectionMetric": "sign_accuracy_then_mean_expected_alignment",
        "evidenceCount": selected["evidenceCount"],
        "signAccuracy": selected["signAccuracy"],
        "meanExpectedAlignment": selected["meanExpectedAlignment"],
        "pearsonCorrelation": selected["pearsonCorrelation"],
    }


def mean(values: list[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def pearson_correlation(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right):
        raise ContractError("cannot correlate arrays with different lengths")
    if len(left) < 2:
        return None
    left_mean = sum(left) / len(left)
    right_mean = sum(right) / len(right)
    left_deltas = [value - left_mean for value in left]
    right_deltas = [value - right_mean for value in right]
    left_norm = math.sqrt(sum(value * value for value in left_deltas))
    right_norm = math.sqrt(sum(value * value for value in right_deltas))
    if left_norm <= 0 or right_norm <= 0:
        return None
    return sum(left_deltas[index] * right_deltas[index] for index in range(len(left))) / (left_norm * right_norm)


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ContractError as exc:
        print(f"[eval/repeng] reader failed: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
