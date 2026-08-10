# Logprob Harness

This directory runs the Path 1 API calibration pass. It consumes the shipped scenario dataset plus the OpenRouter logprob support table and writes one JSON artifact per model/provider/scenario pair under `results/`.

## What It Measures

- per-token entropy on self-report emotion labels
- baseline entropy for a neutral factual control prompt
- entropy delta between scenario and baseline
- suppression signals when a strong alternative emotion label remains probable even though the sampled token differs

## Usage

```bash
npm run eval:logprob:collect -- --model moonshotai/kimi-k2.5 --max-scenarios 3
```

Required env:

- `OPENROUTER_API_KEY`

Optional flags:

- `--support-table <path>`
- `--scenarios <path>`
- `--results-dir <path>`
- `--model <id>` repeated as needed
- `--max-scenarios <n>`

## Output Contract

Each result file includes:

- model id
- provider id
- scenario id and description
- expected labels
- observed labels
- baseline observed labels
- average self-report entropy
- average baseline entropy
- entropy delta
- suppression signals
- raw output and token-level summaries
