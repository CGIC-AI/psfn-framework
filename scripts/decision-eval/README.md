# Decision backend evals (Jev vs local)

Offline tools for the optional Jev decision backend (epic psfn-framework-4lf3r). The fixture
paths make no network call; every live path needs an explicit `--live` flag and spends money on
OpenRouter.

These tools live in the root project, not `tools/evals`, because they drive framework runtime
code (the local decision backend, the Jev transport and the shadow record). Run them from the
repository root. The QAO judge reuses the rubric types from
`tools/evals/eval/companion-shape/qao-judge.ts`.

| Command | What it does |
| --- | --- |
| `npm run decision-eval:shadow-report -- --input <decision-shadow.jsonl> [--out report.json]` | Per-site agreement, confusion, latency p50/p95, Jev cost and failures from runtime shadow records (`<companionDataDir>/state/decision-shadow.jsonl`). |
| `npm run decision-eval:bakeoff -- [--live --local-endpoint <url> --local-model <id>] [--jev-model typesafe/jev-1.13] [--jev-snapshot <dated id>] [--run-id <id>] [--output-dir <dir>]` | Runs the labeled cases in `bakeoff-cases.ts` against a local OpenAI-compatible model and Jev; reports accuracy, Brier and reliability, latency and cost per site. Without `--live` it uses deterministic fixture backends. |
| `npm run decision-eval:qao-jev-judge -- --live --council <qao judge council run.json> [--out <path>]` | Scores each QAO rubric axis with Jev and compares it to the council mean (mean absolute difference, exact-level and pass/fail agreement). |

Live runs read `OPENROUTER_API_KEY` (and `LOCAL_DECISION_API_KEY` for a local endpoint that needs
one). Aliases such as `~typesafe/jev-latest` are rejected; each artifact records the requested model
and the dated snapshot that answered.

## Results and verdicts

Commit a result as `results/<run-id>.json` next to this file, named with the Jev snapshot and the
local model, and fill in the table from it.

| Site | Verdict | Evidence |
| --- | --- | --- |
| participation.appraise | Pending | No live run yet. |
| room.ambiguity | Pending | No live run yet. |
| memory.rerank | Pending | No live run yet. |
| intake.l2 | Pending | No live run yet. |
| QAO judge | Pending | No live run yet. |

Each verdict is one of adopt, shadow only or reject. A site moves from shadow to jev only when its
shadow report and bake-off show agreement, calibration and latency good enough for that site's
safe default.
