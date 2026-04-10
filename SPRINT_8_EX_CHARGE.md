# Sprint 8: Excalibur Charge for PSFN

## Summary

PSFN should adopt a visible run-level charge model inspired by Excalibur, but expressed in PSFN's own runtime and config shape.

The point is not to copy Excalibur's mystical vocabulary or markdown scaffold. The point is to import one strong operating idea:

- widening work should spend from an explicit budget
- child work should draw from the parent run instead of minting a fresh budget
- most internal and local operations should cost `0`
- expensive cloud paths should stay available, but they should be visibly expensive

Charge would give PSFN a soft deliberation budget above the current hard caps. That matters for cases where a few more `think` rounds, one extra outside model consult, or a bounded MoA pass would probably help, but blindly allowing more steps would create runaway cost and poor operator visibility.

## Source

Excalibur is a design scaffold, not a working runtime. The relevant source material is:

- Excalibur repo: <https://github.com/viemccoy/excalibur>
- Excalibur README: <https://github.com/viemccoy/excalibur/blob/main/README.md>
- Excalibur chargebook: <https://github.com/viemccoy/excalibur/blob/main/chargebook.md>
- Excalibur AGENTS contract: <https://github.com/viemccoy/excalibur/blob/main/AGENTS.md>
- Excalibur invocation notes: <https://github.com/viemccoy/excalibur/blob/main/INVOCATION.md>

The useful pattern from those documents is simple:

- charge is visible at the run level
- delegating to a child spends charge from the parent run
- the child inherits an allocation instead of creating new budget
- reclaiming charge, if allowed, happens only after durable progress
- the tuning surface is centralized instead of scattering special-case logic through every ritual or tool

## Why PSFN Needs This

PSFN already has several budget and safety systems:

- context budgeting and adaptive context profiles in [README.md](README.md) and [src/shared/context-budget.ts](src/shared/context-budget.ts)
- `think` hard bounds in [src/system/settings/contracts.ts](src/system/settings/contracts.ts)
- per-model budget enforcement in [docs/architecture-diagram.mmd](docs/architecture-diagram.mmd)
- explicit shard vs subagent separation in [docs/PSFN_PROJECT_CHARTER.md](docs/PSFN_PROJECT_CHARTER.md)

Those controls are necessary, but they solve different problems.

Current bounds are mostly hard stops:

- maximum `think` tokens
- maximum `think` wall time
- maximum `think` subqueries
- per-model budget enforcement
- capability gating

That protects the system from runaway behavior, but it does not give the companion a good way to make tradeoffs like:

- "one more local reasoning step is probably worth it"
- "I should avoid calling an expensive frontier model unless the expected value is high"
- "a cheap local image path is preferable to a paid API path"
- "a shard is possible here, but it is much more expensive than a bounded subagent"
- "MoA would help here, but I should only spend that budget when the situation justifies it"

Charge fills that gap.

## What Charge Should Mean in PSFN

In PSFN, charge should be a visible expansion budget for widening work. It should not be the same thing as identity, memory, trust, or baseline cognition.

Charge should govern:

- extra `think` work beyond the ordinary baseline
- bounded subagent launches
- shard launches
- MoA deliberation rounds
- external model consultation
- paid media generation or other paid external APIs
- other branch-heavy or acquisition-heavy operations we want the system to treat as costly

Charge should not govern:

- baseline core conversation
- baseline metacognitive work
- memory extraction
- reflection and heartbeat behavior in their ordinary path
- local bookkeeping
- the majority of internal tools

This preserves an important distinction: charge is about widening and cost-bearing expansion, not about taxing the core mind for existing.

## Charge Versus Existing PSFN Controls

PSFN should not replace its hard safety caps with charge. It should layer charge on top of them.

The clean model is:

1. Hard technical ceilings still exist as a final stop.
2. Charge adds a softer decision layer below those ceilings.
3. The companion can decide whether another step is worth the spend.
4. The operator can see where budget went.

For example:

- `think` should still have absolute upper limits for tokens, wall time, and subqueries.
- Within those absolute ceilings, PSFN can offer charge-funded extensions beyond a conservative baseline.
- The baseline can stay cheap or free.
- Extra reasoning passes can spend charge deliberately instead of failing immediately at the first rigid threshold.

That gives better behavior than today's binary model where the answer is often either "stopped too early" or "was allowed to run until a hard bound killed it."

## The PSFN Mapping

### 1. Local and internal operations should usually cost `0`

Most PSFN tools are internal surfaces and should remain free in charge terms:

- session operations
- memory read and write paths
- vault and notes work
- owner-file inspection
- local filesystem work inside policy
- trust and contact operations
- internal scheduler surfaces
- ordinary prompt and identity maintenance

This matches the spirit of Excalibur's chargebook and matches PSFN's architecture. Internal systems are not where the cash cost is.

### 2. Local tooling should be preferred over paid cloud tooling

Charge gives PSFN a runtime reason to prefer local lanes when the expected quality is comparable.

Examples:

- ComfyUI image generation should cost `0` or near-`0`
- a paid external image API such as nanobanana should cost charge
- local embeddings should cost `0`
- cheap subscription-backed local-like helper paths can be low charge
- expensive per-call cloud reasoning should cost more

This allows PSFN to expose more capability without pretending every path is equivalent.

### 3. Cheap cloud lanes can stay available

Not every external path needs to be treated as prohibitive.

Examples of low-charge paths:

- inexpensive model consultation
- subscription-backed helper flows with negligible marginal cost
- `codex exec "prompt"` style code checks or review paths when the actual marginal cash cost is low for the operator
- casual chats with a cheaper external model such as Opus 3

The model should still see those as non-zero when they widen work, but they do not need to be priced like frontier deliberation.

### 4. Frontier deliberation should be explicitly expensive

The expensive paths should be the ones that are actually expensive:

- GPT-5.4
- Gemini 3.1
- Claude Opus 4.6
- similar high-cost outside deliberation models
- paid image APIs with real per-image cost such as nanobanana
- multi-round MoA across premium models

This is exactly where charge helps. PSFN can safely expose those tools, while still steering the companion toward restraint and toward local or cheaper paths first.

### 5. Subagents should cost a little; shards should cost much more

This follows the charter, not just the cost profile.

PSFN already distinguishes bounded subagents from long-horizon shards in [docs/PSFN_PROJECT_CHARTER.md](docs/PSFN_PROJECT_CHARTER.md):

- subagents are bounded short-horizon workers
- shards are long-horizon scoped fragments

So charge should reflect that:

- subagent spawn: low charge
- shard spawn: high charge

Why:

- a subagent is bounded and usually short
- a shard is much closer to spinning up a clone-like parallel cognition lane
- a shard is more likely to double LLM spend, produce more artifacts, and stay live longer

If PSFN eventually supports richer shard execution, charge is the right place to make that widening visible.

### 6. MoA becomes practical once it is priced honestly

PSFN already has MoA configuration surfaces in [src/system/settings/contracts.ts](src/system/settings/contracts.ts).

Charge would let PSFN use MoA as a real contemplation path instead of an all-or-nothing feature:

- cheap reference models can form a low-charge MoA lane
- premium reference models can form a high-charge MoA lane
- aggregator model choice can add its own charge
- multi-round deliberation can scale charge per round

That means PSFN can use MoA when it is justified without normalizing it as the default path for routine work.

## Proposed PSFN Rules

1. Charge is attached to a run.
2. Child work draws from parent charge.
3. Children do not mint fresh charge.
4. Most internal and local tools cost `0`.
5. Charge applies to widening, delegation, acquisition, and paid external computation.
6. Hard safety ceilings remain in place above charge.
7. Charge should be visible to the operator.
8. Charge should be visible enough to the companion for tradeoff reasoning.
9. Majority-zero pricing is desirable.
10. Local-first pricing is desirable.

## Suggested Cost Shape

This is a direction, not a locked schedule.

### Zero or near-zero

- session, memory, vault, trust, settings, and internal system tools
- local filesystem and repo inspection inside existing policy
- local embeddings
- local ComfyUI image generation
- ordinary baseline core/metacognitive work

### Low

- bounded subagent spawn
- cheap external helper models
- subscription-backed code review or code-check paths with negligible marginal cost
- one-off inexpensive external chats such as Opus 3

### Medium

- `think` extensions beyond the free baseline
- casual consultation with a mid-cost external frontier model
- low-round MoA on relatively cheap models
- paid but not premium media/API paths

### High

- shard spawn
- premium frontier deliberation such as GPT-5.4, Gemini 3.1, or Claude Opus 4.6
- multi-round MoA with expensive models
- paid image APIs with clear per-call cost such as nanobanana
- repeated external contemplation loops

## Charge and `think`

`think` is one of the clearest cases for this model.

Today `think` has hard bounds. That is necessary, but too blunt for some useful cases. Sometimes the right answer is not "stop immediately" but "spend a little more because another pass is likely to help."

A better shape is:

- baseline `think` stays free
- each extension band costs charge
- the companion can choose whether to continue
- hard technical ceilings still terminate runaway work

That gives PSFN a real notion of "keep trying, but only if it is worth it."

## Charge and Shard Provenance

This should align with the shard fold-back model, not fight it.

Current direction for shard fold-back is:

- fold events land in L0 and L2 as ordinary events
- the creator identity is `mainid.shard` rather than `mainid`
- produced artifacts remain shard-originated artifacts

That is the correct shape.

Charge accounting should preserve the same lineage:

- shard spend should be attributable to the shard-bearing run
- shard outputs should remain provenance-tagged
- fold-back should not flatten shard origin into prime identity

Charge is not a substitute for provenance. It is another dimension of the same widening event.

## PSFN-Native Tuning Surface

Excalibur uses a markdown `chargebook.md` because it is a manifest scaffold.

PSFN should not do that.

PSFN already has strict owner-file rules. So the PSFN version should be a JSON-owned runtime policy surface, likely something like:

- `charge-policy.json`

That file could hold:

- default run charge by runtime lane
- per-tool charge values
- per-model or per-model-class charge values
- MoA per-round multipliers
- subagent and shard launch charges
- recharge rules, if we allow them
- local-vs-cloud preference policy
- operator visibility settings

Garden should expose it. The runtime should load it as an owner file. The companion should see the resulting policy, not the entire raw config blob.

## Recharge

Recharge should be conservative.

Excalibur's reclaim idea is useful, but PSFN should avoid making recharge a loophole that funds runaway loops. If PSFN supports recharge, it should be tied to durable progress such as:

- completing a bounded subagent task
- producing a reviewable artifact
- finishing a shard delivery step
- reaching a stable milestone in a long-running process

Recharge should never silently erase the fact that expensive work happened.

## Recommendation

PSFN should adopt charge as a second budget layer with these properties:

- visible
- run-scoped
- parent-child allocative
- local-first
- majority-zero
- shard-aware
- MoA-aware
- compatible with hard ceilings
- separate from baseline core and metacognitive activity

That would let PSFN expose more powerful cloud and orchestration surfaces without normalizing them as free, default, or invisible.

## Immediate Follow-Through

1. Define the charge policy shape and whether it lives in `charge-policy.json` or a narrower existing owner file.
2. Decide the first charged surfaces:
   `think`, `subagent`, `shard`, MoA, paid media generation, premium external model consultation.
3. Define a majority-zero initial cost table.
4. Add operator-visible telemetry for charge spend and remaining charge.
5. Keep hard ceilings in place while adding charge-funded extension bands.
6. Make shard charge accounting preserve shard lineage and fold-back provenance.
