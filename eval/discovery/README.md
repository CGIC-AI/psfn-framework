# OpenRouter Logprob Discovery

This directory contains a low-cost discovery harness for checking which OpenRouter models and upstream providers actually return `logprobs`.

The harness uses three OpenRouter surfaces:

- `GET /api/v1/models`
- `GET /api/v1/models/<author>/<slug>/endpoints`
- `POST /api/v1/chat/completions`

It keeps probe cost low by using a tiny prompt, `max_tokens=16`, deterministic sampling, bounded concurrency, and per-provider routing isolation.

## Default target set

If no models are passed on the CLI, the script extracts the current OpenRouter-backed model roster from [config/models.seed.json](/mnt/samesung/ai/psfn-worktrees/eval-l5f6-2tk7-s1/config/models.seed.json).

Override that with either:

- repeated `--model <author/slug>`
- `--models-file <path>`

`--models-file` accepts either a plain array of model ids:

```json
[
  "z-ai/glm-5",
  "deepseek/deepseek-v3.2"
]
```

Or an object with `models` or `targets`, where each entry may also pin provider slugs:

```json
{
  "targets": [
    { "model": "z-ai/glm-5" },
    { "model": "deepseek/deepseek-v3.2", "providers": ["deepseek", "deepinfra"] }
  ]
}
```

## Usage

Metadata-only discovery works without credentials:

```bash
npx tsx eval/discovery/openrouter-logprob-discovery.ts \
  --out eval/discovery/artifacts/openrouter-logprob-support.json
```

Live completion probing requires `OPENROUTER_API_KEY`:

```bash
OPENROUTER_API_KEY=sk-or-... \
npx tsx eval/discovery/openrouter-logprob-discovery.ts \
  --live \
  --out eval/discovery/artifacts/openrouter-logprob-support.json
```

Target a custom model list:

```bash
OPENROUTER_API_KEY=sk-or-... \
npx tsx eval/discovery/openrouter-logprob-discovery.ts \
  --live \
  --models-file eval/discovery/my-target-models.json \
  --out eval/discovery/artifacts/openrouter-logprob-support.json
```

## Output

The output artifact is JSON and includes:

- the exact CLI settings used for the run
- model-level metadata claims from `/models`
- per-provider endpoint metadata from `/models/<author>/<slug>/endpoints`
- a router-level live probe using `provider.require_parameters=true`
- per-provider live probes using `provider.only=[slug]` and `allow_fallbacks=false`
- probe status classification: `supported`, `unsupported`, `blocked`, `skipped`, or `error`

Provider breakdown is automatic when OpenRouter exposes endpoint data for the model. If the endpoint list is unavailable, the harness still records the model-level metadata and router probe result.
