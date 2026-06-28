#!/usr/bin/env python3
"""Train PSFN control vectors from contrast pairs."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import math
import sys
from pathlib import Path
from typing import Any

from repeng_contract import (
    ContractError,
    deterministic_text_vector,
    file_sha256,
    load_contrast_dataset,
    mean_vector,
    normalized_vector,
    pairs_by_axis,
    parse_layers,
    select_pairs_for_axis,
    subtract_vectors,
    vector_norm,
    write_json,
)


DEFAULT_MODEL_ID = "fixture-hash-v1"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train repeng-style control vectors from PSFN contrast datasets.",
    )
    parser.add_argument("--dataset", required=True, help="Contrast dataset JSON path.")
    parser.add_argument(
        "--output-dir",
        help="Artifact directory. Defaults to eval/repeng/artifacts/<dataset>-<backend>.",
    )
    parser.add_argument(
        "--backend",
        choices=("fixture", "transformers"),
        default="fixture",
        help="Training backend. fixture is deterministic and dependency-free.",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_MODEL_ID,
        help="Model id for artifact provenance or Transformers loading.",
    )
    parser.add_argument(
        "--model-cache",
        help="Optional Transformers cache directory for dense checkpoint loading.",
    )
    parser.add_argument(
        "--layers",
        default="0",
        help="Comma-separated non-negative layer indexes to train.",
    )
    parser.add_argument(
        "--vector-dim",
        type=int,
        default=16,
        help="Fixture backend vector dimension.",
    )
    parser.add_argument(
        "--limit-pairs-per-axis",
        type=int,
        help="Deterministically keep only the first N pairs per axis.",
    )
    parser.add_argument("--seed", type=int, default=0, help="Fixture backend deterministic seed.")
    parser.add_argument("--run-id", help="Stable artifact id. Defaults to a timestamped id.")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing manifest.")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs and print the plan only.")
    parser.add_argument(
        "--trust-remote-code",
        action="store_true",
        help="Pass trust_remote_code=True to Transformers. Disabled by default.",
    )
    parser.add_argument(
        "--dtype",
        default="bfloat16",
        choices=("bfloat16", "float16", "float32"),
        help="Transformers model dtype.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    dataset_path = Path(args.dataset).resolve()
    dataset = load_contrast_dataset(dataset_path)
    layers = parse_layers(args.layers)
    if args.limit_pairs_per_axis is not None and args.limit_pairs_per_axis <= 0:
        raise ContractError("--limit-pairs-per-axis must be positive")
    if args.vector_dim <= 0:
        raise ContractError("--vector-dim must be positive")

    output_dir = resolve_output_dir(args, dataset)
    grouped_pairs = pairs_by_axis(dataset)
    selected = {
        axis["id"]: select_pairs_for_axis(grouped_pairs, axis["id"], args.limit_pairs_per_axis)
        for axis in dataset["controlAxes"]
    }
    plan = {
        "schemaVersion": 1,
        "datasetId": dataset["datasetId"],
        "datasetPath": str(dataset_path),
        "backend": args.backend,
        "modelId": args.model_id,
        "layers": layers,
        "axisCount": len(dataset["controlAxes"]),
        "pairCount": sum(len(pairs) for pairs in selected.values()),
        "outputDir": str(output_dir),
    }
    if args.dry_run:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0

    manifest_path = output_dir / "manifest.json"
    if manifest_path.exists() and not args.force:
        raise ContractError(f"{manifest_path} already exists; pass --force to overwrite")

    if args.backend == "fixture":
        vector_records = train_fixture_vectors(
            dataset=dataset,
            selected_pairs=selected,
            layers=layers,
            vector_dim=args.vector_dim,
            seed=args.seed,
            model_id=args.model_id,
            output_dir=output_dir,
        )
    else:
        vector_records = train_transformers_vectors(
            dataset=dataset,
            selected_pairs=selected,
            layers=layers,
            args=args,
            output_dir=output_dir,
        )

    run_id = args.run_id or build_run_id(dataset["datasetId"], args.backend)
    manifest = {
        "schemaVersion": 1,
        "artifactType": "psfn.control_vector_manifest",
        "artifactId": run_id,
        "createdAt": utc_now_iso(),
        "dataset": {
            "datasetId": dataset["datasetId"],
            "path": str(dataset_path),
            "sha256": file_sha256(dataset_path),
        },
        "artifactLayout": {
            "manifestPath": "manifest.json",
            "vectorDirectory": "vectors",
            "vectorFilePattern": "vectors/{axisId}.layer_{layer}.json",
        },
        "training": {
            "backend": args.backend,
            "modelId": args.model_id,
            "layers": layers,
            "seed": args.seed if args.backend == "fixture" else None,
            "vectorDim": args.vector_dim if args.backend == "fixture" else None,
            "limitPairsPerAxis": args.limit_pairs_per_axis,
        },
        "vectors": vector_records,
    }
    write_json(manifest_path, manifest)
    print(json.dumps({"manifest": str(manifest_path), "vectorCount": len(vector_records)}, indent=2, sort_keys=True))
    return 0


def resolve_output_dir(args: argparse.Namespace, dataset: dict[str, Any]) -> Path:
    if args.output_dir:
        return Path(args.output_dir).resolve()
    return (Path.cwd() / "eval" / "repeng" / "artifacts" / f"{dataset['datasetId']}-{args.backend}").resolve()


def build_run_id(dataset_id: str, backend: str) -> str:
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{dataset_id}.{backend}.{timestamp}"


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def train_fixture_vectors(
    *,
    dataset: dict[str, Any],
    selected_pairs: dict[str, list[dict[str, Any]]],
    layers: list[int],
    vector_dim: int,
    seed: int,
    model_id: str,
    output_dir: Path,
) -> list[dict[str, Any]]:
    vector_records: list[dict[str, Any]] = []
    for axis in dataset["controlAxes"]:
        axis_id = axis["id"]
        for layer in layers:
            diffs = []
            source_pair_ids = []
            for pair in selected_pairs[axis_id]:
                positive = deterministic_text_vector(
                    text=pair["positive"],
                    axis_id=axis_id,
                    layer=layer,
                    vector_dim=vector_dim,
                    seed=seed,
                    model_id=model_id,
                )
                negative = deterministic_text_vector(
                    text=pair["negative"],
                    axis_id=axis_id,
                    layer=layer,
                    vector_dim=vector_dim,
                    seed=seed,
                    model_id=model_id,
                )
                diffs.append(subtract_vectors(positive, negative))
                source_pair_ids.append(pair["id"])
            vector = normalized_vector(mean_vector(diffs))
            vector_path = Path("vectors") / f"{axis_id}.layer_{layer}.json"
            write_vector_file(
                output_dir / vector_path,
                {
                    "schemaVersion": 1,
                    "artifactType": "psfn.control_vector",
                    "axisId": axis_id,
                    "layer": layer,
                    "backend": "fixture",
                    "modelId": model_id,
                    "vector": vector,
                    "sourcePairIds": source_pair_ids,
                },
            )
            vector_records.append(vector_record(axis_id, layer, vector_path, vector, source_pair_ids))
    return vector_records


def train_transformers_vectors(
    *,
    dataset: dict[str, Any],
    selected_pairs: dict[str, list[dict[str, Any]]],
    layers: list[int],
    args: argparse.Namespace,
    output_dir: Path,
) -> list[dict[str, Any]]:
    require_modules(("torch", "transformers"))
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    dtype_by_name = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }
    tokenizer_kwargs = {"trust_remote_code": args.trust_remote_code}
    model_kwargs = {
        "dtype": dtype_by_name[args.dtype],
        "device_map": "auto",
        "trust_remote_code": args.trust_remote_code,
        "low_cpu_mem_usage": True,
    }
    if args.model_cache:
        tokenizer_kwargs["cache_dir"] = args.model_cache
        model_kwargs["cache_dir"] = args.model_cache

    tokenizer = AutoTokenizer.from_pretrained(args.model_id, **tokenizer_kwargs)
    model = AutoModelForCausalLM.from_pretrained(args.model_id, **model_kwargs)
    model.eval()
    model_device = next(model.parameters()).device

    vector_records: list[dict[str, Any]] = []
    grouped_diffs: dict[tuple[str, int], list[list[float]]] = {
        (axis["id"], layer): [] for axis in dataset["controlAxes"] for layer in layers
    }
    grouped_pair_ids: dict[tuple[str, int], list[str]] = {
        (axis["id"], layer): [] for axis in dataset["controlAxes"] for layer in layers
    }

    for axis in dataset["controlAxes"]:
        axis_id = axis["id"]
        for pair in selected_pairs[axis_id]:
            positive_layers = transformers_activations(
                model=model,
                tokenizer=tokenizer,
                text=pair["positive"],
                layers=layers,
                device=model_device,
            )
            negative_layers = transformers_activations(
                model=model,
                tokenizer=tokenizer,
                text=pair["negative"],
                layers=layers,
                device=model_device,
            )
            for layer in layers:
                key = (axis_id, layer)
                grouped_diffs[key].append(subtract_vectors(positive_layers[layer], negative_layers[layer]))
                grouped_pair_ids[key].append(pair["id"])

    for axis in dataset["controlAxes"]:
        axis_id = axis["id"]
        for layer in layers:
            key = (axis_id, layer)
            vector = normalized_vector(mean_vector(grouped_diffs[key]))
            vector_path = Path("vectors") / f"{axis_id}.layer_{layer}.json"
            write_vector_file(
                output_dir / vector_path,
                {
                    "schemaVersion": 1,
                    "artifactType": "psfn.control_vector",
                    "axisId": axis_id,
                    "layer": layer,
                    "backend": "transformers",
                    "modelId": args.model_id,
                    "vector": vector,
                    "sourcePairIds": grouped_pair_ids[key],
                },
            )
            vector_records.append(vector_record(axis_id, layer, vector_path, vector, grouped_pair_ids[key]))
    return vector_records


def transformers_activations(*, model: Any, tokenizer: Any, text: str, layers: list[int], device: Any) -> dict[int, list[float]]:
    import torch

    inputs = tokenizer(text, return_tensors="pt")
    inputs = {name: value.to(device) for name, value in inputs.items()}
    with torch.inference_mode():
        outputs = model(**inputs, output_hidden_states=True, use_cache=False)
    hidden_states = outputs.hidden_states
    if not hidden_states:
        raise ContractError("Transformers returned no hidden states")
    activations: dict[int, list[float]] = {}
    attention_mask = inputs.get("attention_mask")
    for layer in layers:
        if layer >= len(hidden_states):
            raise ContractError(f"requested layer {layer}, but model returned {len(hidden_states)} hidden-state entries")
        layer_tensor = hidden_states[layer][0]
        if attention_mask is None:
            tensor = layer_tensor.mean(dim=0)
        else:
            weights = attention_mask[0].to(layer_tensor.dtype).unsqueeze(-1)
            token_count = weights.sum().clamp_min(1)
            tensor = (layer_tensor * weights).sum(dim=0) / token_count
        tensor = tensor.detach().float().cpu()
        activations[layer] = [float(value) for value in tensor.tolist()]
    return activations


def write_vector_file(path: Path, payload: dict[str, Any]) -> None:
    vector = payload["vector"]
    if not isinstance(vector, list) or not vector:
        raise ContractError(f"{path}: vector must be a non-empty list")
    for value in vector:
        if not isinstance(value, float) or not math.isfinite(value):
            raise ContractError(f"{path}: vector values must be finite floats")
    write_json(path, payload)


def vector_record(
    axis_id: str,
    layer: int,
    vector_path: Path,
    vector: list[float],
    source_pair_ids: list[str],
) -> dict[str, Any]:
    return {
        "axisId": axis_id,
        "layer": layer,
        "path": vector_path.as_posix(),
        "dim": len(vector),
        "norm": vector_norm(vector),
        "sourcePairIds": source_pair_ids,
    }


def require_modules(module_names: tuple[str, ...]) -> None:
    missing = [name for name in module_names if importlib.util.find_spec(name) is None]
    if missing:
        raise ContractError(
            "transformers backend blocked: missing Python dependencies: "
            + ", ".join(missing)
            + ". Install the pinned stack with: python3 -m pip install -r eval/repeng/requirements-control-vectors.txt"
        )


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ContractError as exc:
        print(f"[eval/repeng] training failed: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
