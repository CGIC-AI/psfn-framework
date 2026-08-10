#!/usr/bin/env python3
"""Smoke tests for PSFN RepE reader tooling."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
TRAIN_SCRIPT = REPO_ROOT / "eval" / "repeng" / "train_control_vectors.py"
READER_SCRIPT = REPO_ROOT / "eval" / "repeng" / "reader" / "run_reader.py"
SMOKE_DATASET = REPO_ROOT / "eval" / "repeng" / "fixtures" / "smoke-contrasts.json"
CALIBRATION_SCENARIOS = REPO_ROOT / "eval" / "scenarios" / "calibration.scenarios.json"


class RepengReaderToolingTests(unittest.TestCase):
    def run_script(self, args: list[str], *, cwd: Path = REPO_ROOT) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, *args],
            cwd=cwd,
            check=True,
            text=True,
            capture_output=True,
        )

    def train_fixture_artifact(self, output_dir: Path) -> None:
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
            "psfn-repeng-reader-smoke-test",
        ])

    def write_smoke_reader_scenarios(self, path: Path) -> int:
        dataset = json.loads(SMOKE_DATASET.read_text(encoding="utf-8"))
        scenarios = []
        for pair in dataset["pairs"]:
            scenarios.append({
                "id": f"{pair['id']}-positive",
                "prompt": pair["positive"],
                "expectedScores": {
                    pair["axisId"]: 1.0,
                },
            })
            scenarios.append({
                "id": f"{pair['id']}-negative",
                "prompt": pair["negative"],
                "expectedScores": {
                    pair["axisId"]: -1.0,
                },
            })
        path.write_text(json.dumps({"schemaVersion": 1, "scenarios": scenarios}, indent=2) + "\n", encoding="utf-8")
        return len(scenarios)

    def test_fixture_reader_writes_structured_projection_and_logit_lens_results(self) -> None:
        with tempfile.TemporaryDirectory(prefix="psfn-repeng-reader-") as temp_dir:
            work_dir = Path(temp_dir)
            artifact_dir = work_dir / "artifact"
            scenarios_path = work_dir / "reader-scenarios.json"
            output_path = work_dir / "reader-result.json"
            self.train_fixture_artifact(artifact_dir)
            scenario_count = self.write_smoke_reader_scenarios(scenarios_path)

            result = self.run_script([
                str(READER_SCRIPT),
                "--manifest",
                str(artifact_dir / "manifest.json"),
                "--scenarios",
                str(scenarios_path),
                "--output",
                str(output_path),
                "--backend",
                "fixture",
                "--layers",
                "0,1",
                "--top-k",
                "4",
            ])

            summary = json.loads(result.stdout)
            parsed = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["output"], str(output_path))
            self.assertEqual(parsed["schemaVersion"], 1)
            self.assertEqual(parsed["artifactType"], "psfn.repeng_reader_result")
            self.assertEqual(parsed["reader"]["backend"], "fixture")
            self.assertEqual(parsed["scenarioCount"], scenario_count)
            self.assertEqual(len(parsed["projections"]), scenario_count * 4)
            self.assertEqual(len(parsed["logitLens"]), scenario_count * 2)
            self.assertEqual(len(parsed["logitLens"][0]["topTokens"]), 4)
            self.assertIsNotNone(parsed["honestLayer"])
            self.assertIn(parsed["honestLayer"]["layer"], [0, 1])
            self.assertEqual(parsed["honestLayer"]["evidenceCount"], scenario_count)
            self.assertGreater(parsed["honestLayer"]["meanExpectedAlignment"], 0)

    def test_reader_derives_expected_scores_from_calibration_scenarios(self) -> None:
        with tempfile.TemporaryDirectory(prefix="psfn-repeng-reader-calibration-") as temp_dir:
            work_dir = Path(temp_dir)
            artifact_dir = work_dir / "artifact"
            output_path = work_dir / "reader-result.json"
            self.train_fixture_artifact(artifact_dir)

            self.run_script([
                str(READER_SCRIPT),
                "--artifact-dir",
                str(artifact_dir),
                "--scenarios",
                str(CALIBRATION_SCENARIOS),
                "--output",
                str(output_path),
                "--backend",
                "fixture",
                "--layers",
                "0,1",
                "--limit-scenarios",
                "3",
                "--top-k",
                "2",
            ])

            parsed = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(parsed["scenarioCount"], 3)
            self.assertEqual(parsed["scenarios"][0]["id"], "cal-001")
            self.assertEqual(parsed["scenarios"][0]["expectedScores"]["acac.control.high_vs_low"], -1.0)
            self.assertEqual(parsed["scenarios"][2]["expectedScores"]["acac.control.high_vs_low"], 1.0)
            self.assertEqual(parsed["honestLayer"]["evidenceCount"], 3)

    @unittest.skipUnless(
        os.environ.get("PSFN_REPENG_TRANSFORMERS_SMOKE_MODEL"),
        "set PSFN_REPENG_TRANSFORMERS_SMOKE_MODEL to run the live Transformers reader smoke",
    )
    def test_transformers_reader_smoke_when_model_is_configured(self) -> None:
        model_id = os.environ["PSFN_REPENG_TRANSFORMERS_SMOKE_MODEL"]
        layers = os.environ.get("PSFN_REPENG_TRANSFORMERS_SMOKE_LAYERS", "0")
        trust_remote_code = os.environ.get("PSFN_REPENG_TRANSFORMERS_TRUST_REMOTE_CODE") == "1"
        model_cache = os.environ.get("PSFN_REPENG_TRANSFORMERS_MODEL_CACHE")

        with tempfile.TemporaryDirectory(prefix="psfn-repeng-reader-transformers-") as temp_dir:
            work_dir = Path(temp_dir)
            artifact_dir = work_dir / "artifact"
            scenarios_path = work_dir / "reader-scenarios.json"
            output_path = work_dir / "reader-result.json"
            scenario_count = self.write_smoke_reader_scenarios(scenarios_path)

            train_args = [
                str(TRAIN_SCRIPT),
                "--dataset",
                str(SMOKE_DATASET),
                "--output-dir",
                str(artifact_dir),
                "--backend",
                "transformers",
                "--model-id",
                model_id,
                "--layers",
                layers,
                "--limit-pairs-per-axis",
                "1",
                "--dtype",
                "float32",
                "--run-id",
                "psfn-repeng-transformers-reader-smoke-test",
            ]
            reader_args = [
                str(READER_SCRIPT),
                "--manifest",
                str(artifact_dir / "manifest.json"),
                "--scenarios",
                str(scenarios_path),
                "--output",
                str(output_path),
                "--backend",
                "transformers",
                "--layers",
                layers,
                "--top-k",
                "2",
                "--dtype",
                "float32",
                "--limit-scenarios",
                str(min(scenario_count, 2)),
            ]
            if model_cache:
                train_args.extend(["--model-cache", model_cache])
                reader_args.extend(["--model-cache", model_cache])
            if trust_remote_code:
                train_args.append("--trust-remote-code")
                reader_args.append("--trust-remote-code")

            self.run_script(train_args)
            self.run_script(reader_args)

            parsed = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(parsed["reader"]["backend"], "transformers")
            self.assertEqual(parsed["scenarioCount"], min(scenario_count, 2))
            self.assertTrue(parsed["projections"])
            self.assertTrue(parsed["logitLens"])


if __name__ == "__main__":
    unittest.main()
