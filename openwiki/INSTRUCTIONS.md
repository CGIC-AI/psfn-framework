# PSFN documentation brief

This wiki is the source for `docs/`. A sync script copies Markdown into `docs/`
after every run. It does not replace the companion wiki faculty.

## Hard rules

- `docs/PSFN_PROJECT_CHARTER.md` is operator-owned law. Never generate,
  summarize, rewrite, or emit it. Link to it.
- Do not document live deployments, real identities, credentials, private
  addresses, kubeconfigs, or operator machine names.
- Source and tests are authority. If prose and code disagree, write the code.
- Fail-closed. No SQLite runtime. Split runtime only.
- Leave `docs/architecture-diagram.mmd` and `docs/world-map.mmd` alone.
- Follow the charter's ubiquitous language. In particular:

### Automata, not "subagents"

Charter §6.28: **automata** is the name (invariant singular and plural) for
internal components that act on the companion's behalf. Memory extraction,
concern formation, appraisal, whisper emitters, and the bounded workers whose
code currently lives under `src/faculties/subagents/` are all automata. They
are not the companion's world-facing voice.

**Do not title pages, headings, or prose "subagents."** Cite
`src/faculties/subagents/` only as a filesystem path. The page is Automata.

Shards are **not** automata (charter §6.12 / §6.28). A shard is a scoped
continuation that folds through review.

The Automata Bus is a separate mechanism (findings bus). It gets its own page.
It does not replace the Automata page.

### Journal

Charter §6.27: **journal** means companion-authored personal Markdown writing.
Do not call L0, reflection ledgers, values history, or memory mutation logs a
journal.

### Memory layers

Spell **L0**, **L0.1**, and **L2**. L0.1 is not "L1". Filenames: `l0`, `l01`,
`l2`. No `SPEC_*` memory filenames.

## Voice / Wyoming (do not get this wrong)

Gateway-hosted Wyoming is **retired**. `createGatewayVoiceSurfaces`
(`src/boundary/gateway/voice-surfaces.ts`) **throws** if `WYOMING_ENABLED` is
set.

Live voice:

- Discord voice (gateway module host)
- API voice websocket `/v1/voice/ws`
- Satellite Hub: ESPHome Native API + Hub realtime websocket; Deepgram STT +
  ElevenLabs TTS (`apps/satellite-hub/`)

Leftover names, not a setup path: `wyomingShardRouting` (default off),
`wyoming.*` events, `api:wyoming:…` channel ids, Garden telemetry category
`wyoming`.

Do not emit a Wyoming how-to. Do not say the gateway starts Wyoming.

## Target tree

This update **must** regroup onto this tree. Include `/openwiki/quickstart.md`.
Delete every old path this list replaces. No duplicates at the wiki root.

### Root (orientation)

- `/openwiki/architecture.md` — split runtime map. Must not say the gateway
  starts Wyoming. Point voice at `channels/voice.md` and Hub at
  `apps/satellite-hub.md`.
- `/openwiki/specifications.md` — config, persistence, fail-closed contracts
- `/openwiki/setup.md`
- `/openwiki/operations.md`
- `/openwiki/development-status.md`

### memory/

| Path | Title |
| --- | --- |
| `/openwiki/memory/overview.md` | Memory |
| `/openwiki/memory/l0-archive.md` | Memory L0 |
| `/openwiki/memory/l01-episodes.md` | Memory L0.1 |
| `/openwiki/memory/l2-typed.md` | Memory L2 |
| `/openwiki/memory/projection.md` | Memory projection |
| `/openwiki/memory/persistence-authority.md` | Memory persistence authority |

Delete `/openwiki/memory.md`, `/openwiki/SPEC_L01_LANDMARK_SCHEMA.md`,
`/openwiki/SPEC_MEMORY_PROJECTION_LAYER.md`,
`/openwiki/memory-persistence-authority.md`.

### runtime/

- `/openwiki/runtime/chat-turn-lifecycle.md`
- `/openwiki/runtime/session.md` — `src/core/session/`
- `/openwiki/runtime/scheduler.md` — `src/core/scheduler/` heartbeat, reflection, rest-window, free-time, post-turn lanes
- `/openwiki/runtime/tool-surface.md`
- `/openwiki/runtime/prompt-macros.md`
- `/openwiki/runtime/identity.md` — character card, prompt stack, `src/core/identity/`
- `/openwiki/runtime/analysis-workbench.md` — `src/core/tools/analysis-workbench/`
- `/openwiki/runtime/sandbox.md` — `src/boundary/sandbox/`

### security/

- `/openwiki/security/cognitive-security.md`
- `/openwiki/security/cogsec-corpus-coverage.md`
- `/openwiki/security/context-envelope.md`
- `/openwiki/security/approval-envelope.md`
- `/openwiki/security/attribution.md`

### faculties/

- `/openwiki/faculties/wiki.md` — companion personal + shared-world wiki, `src/faculties/wiki/` (not this code wiki)
- `/openwiki/faculties/skills.md` — `src/faculties/skills/`
- `/openwiki/faculties/automata.md` — automata (bounded workers; code path `src/faculties/subagents/`)
- `/openwiki/faculties/automata-bus.md` — findings bus, `src/faculties/automata/`
- `/openwiki/faculties/shards.md` — `src/faculties/shards/` including capability-tier derivation; not automata
- `/openwiki/faculties/icp-intentions.md` — `src/core/icp/`, `src/core/intention/`
- `/openwiki/faculties/contacts.md` — `src/core/contacts/`
- `/openwiki/faculties/north-star-and-values.md` — `src/faculties/north-star/`, `src/faculties/values/`
- `/openwiki/faculties/core-memory.md` — `src/faculties/core-memory/`
- `/openwiki/faculties/emotion.md` — companion emotion, `src/core/emotion/`
- `/openwiki/faculties/partner-affect.md`
- `/openwiki/faculties/file-ingest.md` — `src/faculties/file-ingest/`
- `/openwiki/faculties/mirrors-and-letters.md` — introspection / context-feedback
- `/openwiki/faculties/journal.md` — companion-authored Markdown journal only

### channels/

- `/openwiki/channels/overview.md` — Discord, Telegram, API as first-class adapters
- `/openwiki/channels/plugins.md`
- `/openwiki/channels/multica.md`
- `/openwiki/channels/voice.md` — live PSFN voice surfaces; Wyoming retired on gateway
- `/openwiki/channels/companion-ui.md` — `companion-ui/`
- `/openwiki/channels/world-and-presence.md` — `places.json`, situated presence, world tool

### apps/

- `/openwiki/apps/satellite-hub.md` — **required.** The Satellite Hub application
  in `apps/satellite-hub/`: Python hub (ESPHome Native API, Deepgram, ElevenLabs),
  TypeScript hub (realtime websocket, Voxta SignalR facade), device studio,
  satellite claims, Hub device assertions, Voxta relay, building satellites.
  This is the endpoint/embodiment runtime. It is not a gateway Wyoming server.
  Seed: `apps/satellite-hub/README.md`, `apps/satellite-hub/docs/`,
  `apps/satellite-hub/hub/`, `apps/satellite-hub/src/ts/`.
- `/openwiki/apps/garden.md` — Garden operator UI `admin-ui/` plus
  `src/operator/garden/`

### tools/

- `/openwiki/tools/evals.md` — **required.** Offline eval toolkit `tools/evals/`:
  scenarios, promptfoo, memory evals, emotion measurement harness, TTFT, logprob,
  local profiles. Seed: `tools/evals/README.md`, `tools/evals/eval/`,
  `tools/evals/docs/`.

### operator/

- `/openwiki/operator/fleet-auth.md`
- `/openwiki/operator/certificates.md`
- `/openwiki/operator/multi-companion.md`
- `/openwiki/operator/observer-eval-sidecar.md`

### process/

- `/openwiki/process/orchestration.md`
- `/openwiki/process/internal-review.md`
- `/openwiki/process/adversarial-review.md`
- `/openwiki/process/shakedown.md`
- `/openwiki/process/public-history-rewrite.md`
- `/openwiki/process/maintenance-scripts.md`
- `/openwiki/process/self-eval-prompt-audit.md`
- `/openwiki/process/productivity-pack.md`

## Deletes

Delete relocated root files, including at least:

`memory.md`, `SPEC_L01_LANDMARK_SCHEMA.md`, `SPEC_MEMORY_PROJECTION_LAYER.md`,
`memory-persistence-authority.md`, `chat-turn-lifecycle.md`, `tool-surface.md`,
`prompt-macros.md`, `cognitive-security.md`, `cogsec-corpus-coverage.md`,
`context-envelope.md`, `approval-envelope.md`, `attribution.md`,
`channel-plugins.md`, `multica-channel.md`, `eidoverse-hub-integration.md`,
`partner-affect.md`, `shard-capability-tier-derivation.md`,
`automata-bus-contract.md`, `mirrors-and-letters.md`, `garden-control-plane.md`,
`fleet-auth-authority-model.md`, `certificates.md`, `multi-companion.md`,
`observer-eval-sidecar.md`, `orchestration-process.md`,
`internal-review-workflow.md`, `adversarial-review-and-bugfixing-practices.md`,
`shakedown.md`, `public-history-rewrite.md`, `maintenance-scripts-inventory.md`,
`self-eval-prompt-audit.md`, `productivity-pack.md`.

## This run is incomplete unless

- Automata has a page and no page is titled Subagents
- Automata Bus is a separate page
- `apps/satellite-hub.md` documents the Hub application from `apps/satellite-hub/`
- `tools/evals.md` documents `tools/evals/`
- Memory L0, L0.1, and L2 each have their own page under `memory/`
- `channels/voice.md` states gateway Wyoming is retired
