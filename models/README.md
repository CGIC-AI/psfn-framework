This directory is a scoped local-model asset cache, not runtime architecture or
configuration authority. Model identities and cache settings are resolved from
canonical owner files (`settings.json` / `models.json`) and explicit runtime
wiring; this README only explains the repository-local cache layout.

- Default runtime cache path: `./models/transformers`
- Local GGUF cache path for eval/llama.cpp assets: `./models/gguf`
- Prefetch command: `npm run prefetch:hf-models`
- Prompt-injection classifier assets use `./models/prompt-injection-v2` by
  default (or `PSFN_INJECTION_MODEL_DIR`) and are provisioned separately with
  `npm run provision:injection-model`.

Do not commit model binaries. Keep only scaffolding/docs in git.
