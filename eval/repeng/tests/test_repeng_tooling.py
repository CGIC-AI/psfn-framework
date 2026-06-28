#!/usr/bin/env python3
"""Smoke tests for PSFN RepE contrast tooling."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
VALIDATE_SCRIPT = REPO_ROOT / "eval" / "repeng" / "validate_dataset.py"
TRAIN_SCRIPT = REPO_ROOT / "eval" / "repeng" / "train_control_vectors.py"
SANITY_SCRIPT = REPO_ROOT / "eval" / "repeng" / "sanity_check.py"
CORE_DATASET = REPO_ROOT / "eval" / "repeng" / "datasets" / "core-emotion-contrasts.json"
ACAC_DATASET = REPO_ROOT / "eval" / "repeng" / "datasets" / "acac-axis-contrasts.json"
SMOKE_DATASET = REPO_ROOT / "eval" / "repeng" / "fixtures" / "smoke-contrasts.json"


class RepengToolingTests(unittest.TestCase):
    def run_script(self, args: list[str], *, cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, *args],
            cwd=cwd,
            check=True,
            text=True,
            capture_output=True,
        )

    def test_core_and_acac_datasets_have_required_coverage(self) -> None:
        result = self.run_script([
            str(VALIDATE_SCRIPT),
            "--dataset",
            str(CORE_DATASET),
            "--dataset",
            str(ACAC_DATASET),
            "--require-core-emotion-coverage",
            "--require-acac-coverage",
        ])

        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["schemaVersion"], 1)
        self.assertEqual(len(parsed["datasets"]), 2)
        self.assertEqual(parsed["datasets"][0]["axisCount"], 13)
        self.assertEqual(parsed["datasets"][1]["axisCount"], 4)

    def test_train_dry_run_reports_plan_without_artifacts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="psfn-repeng-dry-run-") as temp_dir:
            output_dir = Path(temp_dir) / "artifact"
            result = self.run_script([
                str(TRAIN_SCRIPT),
                "--dataset",
                str(SMOKE_DATASET),
                "--output-dir",
                str(output_dir),
                "--backend",
                "fixture",
                "--layers",
                "0,1",
                "--dry-run",
            ])

            parsed = json.loads(result.stdout)
            self.assertEqual(parsed["backend"], "fixture")
            self.assertEqual(parsed["axisCount"], 2)
            self.assertEqual(parsed["pairCount"], 4)
            self.assertFalse(output_dir.exists())

    def test_fixture_training_writes_manifest_and_passes_sanity_check(self) -> None:
        with tempfile.TemporaryDirectory(prefix="psfn-repeng-smoke-") as temp_dir:
            output_dir = Path(temp_dir) / "artifact"
            self.run_script([
                str(TRAIN_SCRIPT),
                "--dataset",
                str(SMOKE_DATASET),
                "--output-dir",
                str(output_dir),
                "--backend",
                "fixture",
                "--model-id",
                "fixture-hash-v1",
                "--layers",
                "0,1",
                "--vector-dim",
                "8",
                "--seed",
                "13",
                "--run-id",
                "psfn-repeng-smoke-test",
            ])
            sanity = self.run_script([
                str(SANITY_SCRIPT),
                "--artifact-dir",
                str(output_dir),
            ])

            manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
            sanity_result = json.loads(sanity.stdout)
            self.assertEqual(manifest["artifactId"], "psfn-repeng-smoke-test")
            self.assertEqual(len(manifest["vectors"]), 4)
            self.assertEqual(sanity_result["vectorCount"], 4)
            self.assertEqual(len(sanity_result["fixtureChecks"]), 4)


if __name__ == "__main__":
    unittest.main()
