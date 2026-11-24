# `@psfn/core`

Standalone companion core runtime, typed host-injection ports, lifecycle contracts, Light Garden operator services, and canonical policy seeds built from `CGIC-AI/psfn-framework`.

## Entrypoints

- **`@psfn/core`** — `startCompanionRuntime`, `loadInnerLifeConfig`, policy defaults, session integrity helpers, embedding contracts, `HostedAutomataExecutor`, and `COMPANION_SEED_DIR`.
- **`@psfn/core/ports`** — Typed port interfaces for injecting optional host subsystems (LLM provider, stream transport, embeddings, notifications, outbound messaging, CogSec intake screening & sink gates, wiki & personal projects, channel prompts, skills prompt index, session tail cache, memory deletion approval, and hosted automata execution).
- **`@psfn/core/lifecycle`** — Stream transport, turn records, explicit tool contracts, request context, memory deletion approval contracts, and hosted automata execution APIs.
- **`@psfn/core/operator`** — Light Garden route builders, request authorization/context utilities, admin data services, companion stores, and owner-file config loaders/savers.
- **`@psfn/core/seeds`** — `COMPANION_SEED_DIR` and `COMPANION_SEED_FILES` pointing at the bundled canonical `config/*.seed.json` policy files.

## Dependencies

`@psfn/core` depends only on the 8 core runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@huggingface/transformers`, `@sinclair/typebox`, `js-tiktoken`, `pg`, `uuid`, `winston`) and Node.js 24 built-ins. It carries zero Discord, Redis, PDF, character-card parser, or gateway-server dependencies.

## License

AGPL-3.0-only
