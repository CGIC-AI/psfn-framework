#!/usr/bin/env python3
"""Build an auditable microWakeWord corpus, features, and training config."""

from __future__ import annotations

import argparse
import os
import random
import subprocess
import sys
from pathlib import Path

import numpy as np
import yaml


def synthesize_corpus(workspace: Path, definitions: Path, generator: Path, model: Path) -> None:
    synthesize_samples(
        definitions / "pronunciations.txt",
        workspace / "positives",
        generator,
        model,
        count=3000,
        phoneme_input=True,
    )
    synthesize_samples(
        definitions / "hard-negatives.txt",
        workspace / "hard-negatives",
        generator,
        model,
        count=2400,
        phoneme_input=False,
    )


def synthesize_samples(
    definitions: Path,
    output: Path,
    generator: Path,
    model: Path,
    *,
    count: int,
    phoneme_input: bool,
) -> None:
    require_absent(output)
    require_file(definitions)
    require_file(model)
    command = [
        sys.executable,
        "-c",
        (
            "import random, runpy, numpy as np, torch; "
            "random.seed(42); np.random.seed(42); torch.manual_seed(42); "
            "torch.cuda.manual_seed_all(42); "
            "runpy.run_module('piper_sample_generator', run_name='__main__')"
        ),
        str(definitions),
        "--model", str(model),
        "--max-samples", str(count),
        "--batch-size", "100",
        "--max-speakers", "500",
        "--output-dir", str(output),
    ]
    if phoneme_input:
        command.append("--phoneme-input")
    run_generator(command, generator)


def augment_corpus(workspace: Path, generator: Path) -> None:
    for source_name, output_name in (
        ("positives", "positives-16k"),
        ("hard-negatives", "hard-negatives-16k"),
    ):
        source = workspace / source_name
        output = workspace / output_name
        require_absent(output)
        if not source.is_dir():
            raise SystemExit(f"Missing synthesized corpus: {source}")
        run_generator(
            [
                sys.executable,
                "-c",
                (
                    "import random, runpy, numpy as np; "
                    "random.seed(42); np.random.seed(42); "
                    "runpy.run_module('piper_sample_generator.augment', run_name='__main__')"
                ),
                "--sample-rate", "16000",
                str(source),
                str(output),
            ],
            generator,
        )


def run_generator(command: list[str], generator: Path) -> None:
    if not generator.is_dir():
        raise SystemExit(f"Missing pinned Piper Sample Generator checkout: {generator}")
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        filter(None, (str(generator), environment.get("PYTHONPATH", "")))
    )
    subprocess.run(command, check=True, env=environment)


def require_file(path: Path) -> None:
    if not path.is_file():
        raise SystemExit(f"Missing required input: {path}")


def require_absent(path: Path) -> None:
    if path.exists():
        raise SystemExit(f"Refusing to overwrite existing generated data: {path}")


def feature_set(source: Path, output: Path) -> None:
    from mmap_ninja.ragged import RaggedMmap
    from microwakeword.audio.augmentation import Augmentation
    from microwakeword.audio.clips import Clips
    from microwakeword.audio.spectrograms import SpectrogramGeneration

    require_absent(output)
    random.seed(42)
    np.random.seed(42)
    clips = Clips(
        input_directory=str(source),
        file_pattern="*.wav",
        max_clip_duration_s=None,
        remove_silence=False,
        random_split_seed=42,
        split_count=0.1,
    )
    augmenter = Augmentation(
        augmentation_duration_s=3.2,
        augmentation_probabilities={
            "SevenBandParametricEQ": 0.15,
            "TanhDistortion": 0.1,
            "PitchShift": 0.15,
            "BandStopFilter": 0.1,
            "AddColorNoise": 0.4,
            "Gain": 1.0,
        },
        impulse_paths=[],
        background_paths=[],
        background_min_snr_db=-5,
        background_max_snr_db=10,
        min_jitter_s=0.195,
        max_jitter_s=0.205,
    )

    for split in ("training", "validation", "testing"):
        split_name = {"training": "train", "validation": "validation", "testing": "test"}[split]
        repetition = 2 if split == "training" else 1
        slide_frames = 1 if split == "testing" else 10
        spectrograms = SpectrogramGeneration(
            clips=clips,
            augmenter=augmenter,
            slide_frames=slide_frames,
            step_ms=10,
        )
        destination = output / split / "samples_mmap"
        destination.parent.mkdir(parents=True, exist_ok=True)
        RaggedMmap.from_generator(
            out_dir=str(destination),
            sample_generator=spectrograms.spectrogram_generator(
                split=split_name,
                repeat=repetition,
            ),
            batch_size=100,
            verbose=True,
        )


def write_config(workspace: Path) -> Path:
    config = {
        "window_step_ms": 10,
        "train_dir": str(workspace / "trained-model"),
        "features": [
            {
                "features_dir": str(workspace / "positive-features"),
                "sampling_weight": 3.0,
                "penalty_weight": 1.0,
                "truth": True,
                "truncation_strategy": "truncate_start",
                "type": "mmap",
            },
            {
                "features_dir": str(workspace / "hard-negative-features"),
                "sampling_weight": 8.0,
                "penalty_weight": 2.0,
                "truth": False,
                "truncation_strategy": "random",
                "type": "mmap",
            },
            *negative_features(workspace),
        ],
        "training_steps": [15000],
        "positive_class_weight": [1],
        "negative_class_weight": [24],
        "learning_rates": [0.001],
        "batch_size": 128,
        "time_mask_max_size": [5],
        "time_mask_count": [1],
        "freq_mask_max_size": [3],
        "freq_mask_count": [1],
        "eval_step_interval": 500,
        "clip_duration_ms": 1500,
        "target_minimization": 0.5,
        "minimization_metric": "ambient_false_positives_per_hour",
        "maximization_metric": "average_viable_recall",
    }
    path = workspace / "training-parameters.yaml"
    path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    return path


def negative_features(workspace: Path) -> list[dict[str, object]]:
    root = workspace / "negative-datasets"
    specs = (
        ("speech", 12.0, "random"),
        ("dinner_party", 12.0, "random"),
        ("no_speech", 6.0, "random"),
        ("dinner_party_eval", 0.0, "split"),
    )
    missing = [name for name, _, _ in specs if not (root / name).exists()]
    if missing:
        raise SystemExit(f"Missing extracted negative datasets: {', '.join(missing)}")
    return [
        {
            "features_dir": str(root / name),
            "sampling_weight": sampling_weight,
            "penalty_weight": 1.0,
            "truth": False,
            "truncation_strategy": truncation,
            "type": "mmap",
        }
        for name, sampling_weight, truncation in specs
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "stage",
        choices=("synthesize", "augment", "positive-features", "hard-negative-features", "config"),
    )
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--definitions", type=Path)
    parser.add_argument("--piper-generator", type=Path)
    parser.add_argument("--piper-model", type=Path)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    if args.stage in ("synthesize", "augment") and args.piper_generator is None:
        parser.error(f"{args.stage} requires --piper-generator")
    if args.stage == "synthesize" and args.piper_model is None:
        parser.error("synthesize requires --piper-model")
    if args.stage == "synthesize" and args.definitions is None:
        parser.error("synthesize requires --definitions from an ignored local directory")
    if args.stage == "synthesize":
        synthesize_corpus(
            workspace,
            args.definitions.resolve(),
            args.piper_generator.resolve(),
            args.piper_model.resolve(),
        )
    elif args.stage == "augment":
        augment_corpus(workspace, args.piper_generator.resolve())
    elif args.stage == "positive-features":
        feature_set(workspace / "positives-16k", workspace / "positive-features")
    elif args.stage == "hard-negative-features":
        feature_set(workspace / "hard-negatives-16k", workspace / "hard-negative-features")
    else:
        print(write_config(workspace))


if __name__ == "__main__":
    main()
