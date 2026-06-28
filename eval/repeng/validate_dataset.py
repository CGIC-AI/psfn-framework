#!/usr/bin/env python3
"""Validate PSFN RepE contrast datasets."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from repeng_contract import (
    ContractError,
    load_contrast_dataset,
    validate_contrast_dataset,
    validate_required_coverage,
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate repo-owned contrast datasets for control-vector training.",
    )
    parser.add_argument(
        "--dataset",
        action="append",
        required=True,
        help="Contrast dataset JSON path. Repeat to validate multiple datasets.",
    )
    parser.add_argument(
        "--require-core-emotion-coverage",
        action="store_true",
        help="Require all current core emotion axes to appear across the supplied datasets.",
    )
    parser.add_argument(
        "--require-acac-coverage",
        action="store_true",
        help="Require all ACAC binary axes to appear across the supplied datasets.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    summaries = []
    for dataset_path in args.dataset:
        path = Path(dataset_path).resolve()
        dataset = load_contrast_dataset(path)
        summary = validate_contrast_dataset(dataset, str(path))
        summary["path"] = str(path)
        summaries.append(summary)

    validate_required_coverage(
        summaries,
        require_core_emotion_coverage=args.require_core_emotion_coverage,
        require_acac_coverage=args.require_acac_coverage,
    )
    print(json.dumps({"schemaVersion": 1, "datasets": summaries}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except ContractError as exc:
        print(f"[eval/repeng] validation failed: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
