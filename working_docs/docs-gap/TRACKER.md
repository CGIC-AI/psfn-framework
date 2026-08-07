# Docs Gap Tracker — Missing & Expansion Review

> Created 2026-08-06. Working copy in `working_docs/docs-gap/` — promote to `docs/` after review.
> Source of truth for system → doc mapping: `AGENTS.md` `system:` labels (20 systems) + `src/` runtime.

## How to use this file
- **Missing** = no dedicated doc exists; draft lives in `working_docs/docs-gap/<system>.md` for review.
- **Needs expansion** = doc exists but covers only a slice; notes describe what to add before promotion.
- **Covered** = narrative + reference meets the bar; no action.
- Promote by moving/copying `working_docs/docs-gap/<system>.md` → `docs/<system>.md` and updating cross-links in `docs/architecture.md`, `docs/development-status.md`, `docs/specifications.md`.
- Keep this file in `working_docs/` — do not publish to `docs/` until gaps are closed.

## Missing (no doc) — placeholders created, drafts in progress

| # | System | Placeholder | Draft status | Code anchor | What draft must cover to pass review |
|---|--------|-------------|--------------|-------------|--------------------------------------|
| 1 | `scheduler` | `scheduler.md` | drafting | `src/core/scheduler/` (ambient-presence, free-time, post-turn-lanes, reflection-policy, rest-window, background-maintenance, scheduled-prompt-store) | Runtime scheduler vs Gateway timers, ambient presence, free-time debate/chooser, post-turn lanes (reflection/intention/social-desire), rest-window policy, scheduled prompts persistence + rehydration, background maintenance |
| 2 | `channels` | `channels.md` | drafting | `src/channels/{api,backplane,discord,telegram,shared}` + `src/boundary/integrations/` | Channel adapter registry, backplane places/satellite registry, Discord/Telegram/Wyoming host adapters, external channel claim, http policy / SSRF, companion relay |
| 3 | `icp` | `icp.md` | drafting | `src/core/icp/` (initiation-candidate, felt-impulse, autonomy-store, weighted-thought, co-location-thought, social/speaking precedence) | ICP quadrants (intentions/concerns/plans), weighted thoughts, initiation candidates, felt-impulse, consent evaluator, precedence resolvers, store ports |
| 4 | `voice` | `voice.md` | drafting | `src/primitives/voice/` (pipeline, deepgram, elevenlabs, reply-stream, transports, policy) | STT/TTS providers, frame pipeline, agent-stream bridge, transports, reliability/security policy, latency/turn observers |
| 5 | `world` | `world.md` | drafting | `src/boundary/integrations/world/` + `docs/world-map.mmd` + `src/faculties/wiki/` | World model, places, integrations/world boundary, wiki/productivity-pack relation, mermaid map narrative |

## Needs expansion / review (doc exists — slice coverage)

| # | System | Current doc(s) | Gap | Action before promotion |
|---|--------|----------------|-----|-------------------------|
| 6 | `session` | `docs/chat-turn-lifecycle.md`, `docs/context-envelope.md`, `docs/attribution.md` | Turn lifecycle is excellent but `SessionManager` (compaction, context-manifest, continuity-artifacts, channel-bond, cross-channel continuity) has no dedicated reference. Envelope covers classification, attribution covers speaker prefix. | Create `docs/session.md` extracting SessionManager contract; keep lifecycle as narrative, session as reference. Cross-link from `architecture.md#Sessions`. |
| 7 | `emotion` | `docs/partner-affect.md` | Covers Partner Affect slice 1 (signal observations, fail-closed guard) only. Omits `src/core/emotion/{appraisal,acac,observer,calibration,participant-trends,persona-adaptation}`. | Expand `partner-affect.md` or add `docs/emotion.md` as index linking appraisal/acac/observer docs. |
| 8 | `metacog` | `docs/observer-eval-sidecar.md`, `docs/self-eval-prompt-audit.md` | Eval sidecar + prompt audit only. Missing `src/faculties/{values,north-star,introspection,self-model}` and reflection guardrails. | Add `docs/metacog.md` hub; keep sidecars as deep dives. |
| 9 | `persistence` | `docs/memory-persistence-authority.md`, `docs/operations.md` (backups) | Authority decision ratified, but `src/persistence/layout.ts`, `runtime-factory.ts` (Postgres-only), `artifact-lifecycle`, `jsonl-segments`, `sessions` have no standalone reference. | Add `docs/persistence.md` runtime reference; keep authority as ADR. |
| 10 | `prompts` | `docs/prompt-macros.md` (generated, 189 macros) | Table only. Missing prompt runtime (`PROMPT_RUNTIME_MACRO_HINTS` in `src/core/identity/prompt-runtime.ts`), purity rule, macro generation contract. | Add narrative header to `prompt-macros.md` or split `docs/prompts.md` (runtime) vs generated table. |
| 11 | `shards` | `docs/shard-capability-tier-derivation.md`, `docs/multi-companion.md` | Tier derivation is a design note (`psfn-framework-yijy.1`). Missing manager lifecycle, `fold-review`, `output-review`, artifact policy, context-pack. | Promote tier note to `docs/shards.md` hub; fold derivation as appendix. |
| 12 | `companion-ui` | `docs/approval-envelope.md` | Approval envelope only. Missing Atrium/companion PWA/chat UI (`PSFNLIVE-70nb`, `src/operator/garden/` + `admin-ui/`). | Create `docs/companion-ui.md`; keep approval-envelope as deep dive. |
| 13 | `garden` | `docs/garden-control-plane.md` | Control-plane topology only (2026-07-18). Missing Garden pages (memory/episodes/sessions/scheduler/settings/charge). | Expand `garden-control-plane.md` with page catalogue or add `docs/garden.md` index. |
| 14 | `testing` | `docs/shakedown.md`, `docs/adversarial-review-and-bugfixing-practices.md` | Shakedown is a runbook, adversarial doc is practice. No `testing.md` for strategy, conformance harnesses (`tool-call` eval, `integration-timeout-registry.json`). | Create `docs/testing.md` or fold into `shakedown.md` pt 2. |

## Covered — no action

`memory`, `cogsec`, `fleet-auth`, `helm-ops`, `agent-tooling`, `docs` (process). Each has ≥1 narrative + reference doc meeting the bar.

## Promotion checklist (per draft)

- [ ] Draft lifts code quotes, not hallucinated APIs (verify `src/` paths in draft header)
- [ ] First 3 paragraphs: what/why/who + mental model diagram
- [ ] ≥1 runnable example or config snippet
- [ ] Cross-links to `architecture.md`, `specifications.md`, `development-status.md`
- [ ] Pitfalls / fail-closed behaviour documented
- [ ] Reviewed by code owner; `frame-claims` clean

## History

- 2026-08-06: Initial gap scan (`docs/` 34 md + 2 mmd vs 20 systems). Placeholders seeded for `scheduler/channels/icp/voice/world`.
- 2026-08-06: Content-review pass filled gaps — icp motivational-stores section + 8-field shared-metadata projection; scheduler background-maintenance subsection; channels companion-relay definition + Wyoming corrected to gateway voice-routing boundary; reason-code count fixed (25→33). See `working_docs/docs-gap/` drafts.
