# OpenRouter Logprob Discovery

This directory contains an observed-behavior harness for checking which OpenRouter models and upstream providers actually return token logprobs.

The harness intentionally treats OpenRouter metadata and provider docs as context only. The support index is built from live `POST /api/v1/chat/completions` responses when `OPENROUTER_API_KEY` is available.

## Probe Suite

Each live target uses the same canonical probes:

| Probe | Prompt | Purpose |
| --- | --- | --- |
| `basic_generated_logprobs` | `Reply with exactly one word: blue` | Generated-token logprobs |
| `top_alternatives` | `Reply with exactly one word: blue` | Alternate candidate tokens from `top_logprobs` |
| `streaming` | `Reply with exactly one word: blue` | Per-chunk streaming logprobs |
| `prompt_scoring` | `Reply with exactly one word: blue` | Prompt/input token logprobs |
| `deterministic_classification` | `Answer only yes or no: Is Paris in France?` | Label probability usefulness |
| `tokenization_edge` | `Reply with exactly this string: unbelievable` | Multi-token output shape |
| `top_logprobs_max` | `Reply with exactly one word: blue` | Observed max `top_logprobs` behavior |

The request settings are deterministic and small: `temperature=0`, `top_p=1`, `seed=1`, `max_tokens=1..5`, tools off, JSON mode off, and no reasoning flags.

## OpenRouter Routing Layers

For every model, the tool tests:

- OpenRouter default routing
- OpenRouter routing with `provider.allow_fallbacks=false` and `provider.require_parameters=true`
- Each healthy endpoint provider pinned with `provider.order`, `provider.only`, `allow_fallbacks=false`, and `require_parameters=true`

Provider pinning follows OpenRouter's documented provider-selection request body. The index still records observed behavior only.

## Usage

Metadata-only discovery works without credentials:

```bash
npm run eval:discover:logprobs -- --probe-mode none
```

Live probing requires `OPENROUTER_API_KEY`:

```bash
OPENROUTER_API_KEY=sk-or-... \
npm run eval:discover:logprobs -- \
  --model moonshotai/kimi-k2.5 \
  --output eval/discovery/artifacts/openrouter-logprob-support.json
```

Options:

```text
--api-base-url <url>   Override API base URL
--output <path>        Output index JSON
--raw-dir <path>       Sanitized raw response archive directory
--probe-mode <mode>    none, ambiguous, supported, all
--model <id>           Restrict to a model id; repeatable
```

Default live mode is `all`, which probes every healthy endpoint provider returned by OpenRouter. Use `supported` to limit provider-pinned probes to endpoints that claim `logprobs` or `top_logprobs`, plus endpoints with no parameter metadata.

## Output

The output JSON includes:

- Canonical test definitions
- Model and endpoint metadata context
- Router-level observations
- Provider-pinned observations
- Sanitized raw response archive paths
- Compatibility fields for the calibration collector
- `engineerView`: provider/model/endpoint support rows
- `useCaseView`: recommendations for label confidence, calibration experiments, scoring, and router exploration

Raw archives are sanitized recursively for keys containing `key`, `authorization`, or `token`.

Retest monthly, and immediately when a provider changes model versions, adds reasoning behavior, changes pricing, or moves endpoints.
