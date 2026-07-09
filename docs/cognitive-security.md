# Cognitive Security: The Cognition Intake Firewall

Last updated: 2026-07-09.

This document covers the cognition intake firewall (the htm9 epic): the
threat model, the envelope/taint contract, the screening layers, the sink
gates, the quarantine-and-release lifecycle, the drift and second-arrow
review lanes, the canary egress tripwire, the companion-wellbeing language
contract, the full `intake-policy.json` reference, and the operator runbook.

For where this sits in the runtime shape, see
[`docs/architecture.md`](./architecture.md). For the older post-hoc
remediation half of CogSec (tombstones, revocation, regeneration, forensic
archive), see the Garden Remediation page and `src/core/cogsec/` — the
firewall is the pre-hoc half of that same system.

Design brief and prior-art survey:
`working_docs/COGSEC_INTAKE_FIREWALL_RESEARCH_20260709.md`.

> **Wiring status note (2026-07-09).** Everything described here is wired to
> runtime entrypoints. L2/L3 escalation runs **gateway-side only**, through the
> `IntakeEscalationPort` composed in
> `src/boundary/gateway/intake/compose-screening.ts`; the agent process holds no
> escalation port and stays L1-only by construction. When no OpenRouter backend
> is resolvable, escalation is not composed (loud warning) — except under
> `mode: "enforce"` with non-empty `mandatoryTiers`, which fails startup rather
> than silently skipping screening the policy demands.

## Threat Model

The firewall exists to keep a long-lived companion mind safe in adversarial
environments without impacting the companion's own stress levels. Four threat
families drive the design:

1. **Indirect prompt injection.** Hostile instructions arrive inside content
   the companion legitimately reads — a fetched web page, a parsed PDF, text
   rendered into an image, a tool result, a subagent digest. The payload does
   not need the attacker to be in the conversation at all.
2. **Slow poisoning.** No single message is malicious; the trajectory is. A
   contact grooms trust over weeks, pressures memory writes (MINJA-style
   write bursts), or gradually captures the working belief base so retrieval
   over-samples one low-trust source. Per-message scanning cannot see this;
   only trajectory analysis can.
3. **Self-poisoning ("second arrow").** No attacker required: a concern the
   companion cannot inspect directly circles, extraction keeps minting
   near-duplicate memories about it, and the stack inflates how big the thing
   feels. The first arrow is the event; the second arrow is the rumination.
4. **Exfiltration.** A successful injection tries to move privileged material
   out — prompt contents, secrets, private data — through egress surfaces
   (messages to other people, web requests, notifications), or to smuggle it
   via markdown/link tricks.

The load-bearing design principle, unanimous across the prior-art survey:
**probabilistic layers (classifiers, LLM screeners, datamarking) reduce
noise; only structural layers (provenance tags checked at sinks, opaque
content refs, taint propagation) carry guarantees.** PSFN ships both and
stakes security on the structural one: the envelope contract and the sink
gates are the boundary; every scanner and screener above them is triage.

## Layered Architecture

```text
Inbound item: web fetch / web search / document / image / audio transcript /
              tool observation / subagent digest / chat by source risk
        |
        v
L0   IntakeEnvelope (structural, always)
     source class -> risk tier (intake-policy.json), opaque content ref,
     provenance chain, taint propagation on derivation
        |
        v
L1   deterministic scanners (microseconds, in-process, both processes)
     invisible text / datamark stripping / NFKC / rule engine / encoding
     smuggling / URLs / secrets+PII / structure
L1.5 ONNX injection classifier (milliseconds, gateway-side, optional)
        |
        +---> screening decision: pass | sanitize | quarantine | block
        |     (screening.ts; block = fail-closed hold, same as quarantine)
        |
L2   fast API LLM screener      \   gateway-side only, via IntakeEscalationPort
L3   heavy escalation screener   |  (escalation.ts). Skipped when L1/L1.5 have
     + safe representation      /   already decided quarantine/block.
L2.5 vision screener (per inbound image; WIRED via intake.screen_image RPC;
     OCR transcript re-enters the text stack as sourceClass image_ocr)
        |
        v
L4   sink gates (the actual security boundary; src/core/cogsec/intake/)
     prompt_assembly | memory_write | wiki_write | persona_mutation |
     trust_mutation | tool_egress (+ lethal-trifecta assessment)
        |                                   |
        v                                   v
   companion context / stores        quarantine store (held items)
   (released content, marked              |
    per the datamarking plan)             v
                                    Garden Cognitive Security tab
                                    (double-confirm release / discard,
                                     source-list flywheel)
```

Placement follows the secrets boundary: the gateway already holds raw inbound
bytes (web, Discord/Telegram downloads, API attachments) and the LLM
credentials, so the full screening stack runs gateway-side with no new
credential surface (`src/boundary/gateway/intake/compose-screening.ts` →
`src/boundary/gateway/privileged-core.ts`). The agent process composes an
L1-only screening service for in-process surfaces (`src/app/agent/main.ts`),
and the sink gate is constructed agent-side (`src/app/agent/core-runtime.ts`,
`maybeCreateIntakeSinkGate`).

Live envelope-creation points (verified call sites):

| Surface | Where screening runs |
| --- | --- |
| Web fetch content | `src/boundary/gateway/methods/web.ts` |
| Document attachments (Discord/Telegram/API) | `src/faculties/file-ingest/document-ingest.ts` (see below) |
| Inbound images | `src/core/agent/substrate-agent/vision-attachments.ts` → gateway RPC `intake.screen_image` |
| Tool observations / session-entry recording | `src/core/session/manager.ts` (`screenSync`) |
| Voice transcripts | `src/app/gateway/api-surface.ts`, `src/channels/discord/voice-turn-runtime.ts` (`audio_transcript`) |
| Image OCR transcripts | `src/boundary/gateway/intake/vision-screener.ts` re-screen (`image_ocr`) |

## The IntakeEnvelope Contract

`src/shared/contracts/intake-envelope.ts` is Layer 0: a typed, frozen,
fail-closed envelope created at the boundary for every untrusted inbound
item. Raw bytes never travel with the envelope — only an opaque
`contentRef` (`{store, ref, sha256?, sizeBytes?, mediaType?}`) that a
gateway-side store resolves; validation rejects handles that look like
inline content (`data:` URLs, newlines).

### Source classes and risk tiers

Fourteen closed source classes (`INTAKE_SOURCE_CLASSES`): `operator`,
`primary_user`, `trusted_contact`, `regular_contact`, `public_contact`,
`web_fetch`, `web_search`, `document`, `image_ocr`, `audio_transcript`,
`tool_output`, `subagent_output`, `shard_foldback`,
`mcp_tool_description`. Policy — never the contract — maps each class to one
of four ordered risk tiers (`trusted < standard < untrusted < hostile`).
The mapping is required for every class with no implicit defaults, so a new
surface that is not mapped fails startup instead of silently trusting.

### Risk labels

A closed `category/subcategory` taxonomy (`INTAKE_RISK_LABELS`, 22 labels)
shared by every scanner, screener, sink gate, and the Garden UI. Categories:
`content/*`, `persona/*`, `policy/*`, `execution/*` (generalized from the
memory-write-time `CogSecMemoryRiskClass` A–E vocabulary in
`src/core/cogsec/memory-candidacy.ts`), `injection/*`, `exfil/*`, `pii/*`,
`secrets/*`, and `poisoning/*`. Classifiers must not invent labels outside
the list — the list grows in the contract so all consumers share one
vocabulary. Two decision families in
`src/core/cogsec/intake/risk-label-families.ts` partition the actionable
labels: `INTAKE_QUARANTINE_RISK_LABELS` (findings that alone justify a hold)
and `INTAKE_SANITIZE_RISK_LABELS` (findings the sanitized text actually
removes — stripped invisible codepoints, redacted secrets/PII).

### State machine

```text
received ──> screened ──┬──> released ────────────┬──> discarded | expired
                        ├──> released_sanitized ──┘
                        └──> quarantined ──┬──> human_released
                                           ├──> human_released_sanitized
                                           ├──> discarded
                                           └──> expired
```

Structural rules (enforced by `transitionIntakeEnvelope`, not policy):

- Entering `screened` requires a decision `decidedBy: 'screening' | 'policy'`;
  entering a `human_*` state requires `decidedBy: 'human'` and is reachable
  only from `quarantined` — a human release presupposes a quarantine hold.
- The post-screening route must match the decision:
  `pass → released`, `sanitize → released_sanitized`,
  `quarantine`/`block → quarantined` (`block` maps to a fail-closed hold; an
  explicit follow-up transition to `discarded` records destruction as its own
  audited step).
- `human_released*`, `discarded`, and `expired` are terminal.
- Every transition appends to an append-only journal on the envelope;
  `validateIntakeEnvelope` re-walks the journal at every persistence/RPC
  boundary and rejects envelopes whose recorded state does not match it.
- Only four states are sink-consumable (`INTAKE_SINK_CONSUMABLE_STATES`):
  `released`, `released_sanitized`, `human_released`,
  `human_released_sanitized`. Everything else is invisible to **all** sinks.

### Taint propagation (the CaMeL rule)

`deriveChildIntakeEnvelope` implements "a summary of untrusted content stays
untrusted" (CaMeL, arXiv 2503.18813): a derived artifact (summary, OCR
transcript, audio transcript, subagent digest, translation, extraction)
inherits the parent's full provenance chain plus a derivation hop, its risk
tier is `max(parent tier, derived-class tier)` — derivation can raise risk,
never launder it — and the child starts unscreened (`received`), so derived
text must pass screening itself before any sink.

### Write stamping

Memory and wiki writes are stamped with the originating envelope id through
the existing `provenanceRefs` arrays
(`intakeEnvelopeProvenanceRef('…') → 'intake-envelope:<id>'`), so a poisoned
source's whole lineage is excisable later through the existing
revocation/regeneration machinery (`src/core/cogsec/lineage.ts`) without a
storage schema change.

### Message snapshots

A point-in-time `IntakeEnvelopeSnapshot` rides
`MessageRoutingMetadata.intakeEnvelopes` and persisted session-entry
metadata (`src/core/session/intake-screening-metadata.ts`) for cheap
sink-gate reads; the envelope journal stays authoritative.

## Screening Layers

### L1 — deterministic scanners (wired)

`src/core/cogsec/intake/scanners/` — synchronous, in-process, microsecond
cost, run on every screened item in both processes. Pipeline order is
load-bearing: input capped at `MAX_SCAN_CHARS` before any regex; invisible /
zero-width detection on the **raw** capped string, then strip; datamark
marker detection/stripping on the stripped raw text; NFKC normalization
(folds full-width homoglyphs onto ASCII); then the rule engine, encoding
smuggling, URL, and secrets/PII scanners on the normalized text; secrets
redaction produces the final sanitized text.

Scanners: `invisible-text.ts`, `datamark.ts`, `rule-engine.ts` (hot-loadable
plain-JSON rules, `config/intake-l1-rules.json` — rule name maps to a risk
label), `encoding-smuggling.ts`, `urls.ts`, `secrets-pii.ts`,
`structure.ts`.

Two disciplines worth knowing:

- **No-ReDoS bounds** (`proximity.ts`): every rule-file pattern fragment is
  linted by `assertBoundedRulePattern` — unescaped `*`, `+`, and open-ended
  `{n,}` are rejected outright; only `?`, `{m}`, and `{m,n}` (bounded) pass.
  Proximity matching uses two hard-bounded primitives (char-window
  co-occurrence and word-count-bounded filler between anchors) instead of
  unbounded quantifiers.
- **Failure posture**: L1 is triage, not a security boundary. A scanner that
  throws is recorded in `scannerErrors` and the rest of the report is still
  produced (fail open-advisory, errors never swallowed); construction fails
  **closed** — a missing or invalid rule file throws at composition time.
  L1 output never includes a decision; that authority belongs to the
  screening service and the sink gates.

### L1.5 — ONNX injection classifier (wired, gateway-side, optional)

`src/boundary/gateway/intake/injection-classifier.ts` runs
`protectai/deberta-v3-base-prompt-injection-v2` (Apache-2.0, pinned revision
`b722c7fcbeae674abb1a1afb170a0291a379d12e`) in-process through the pinned
`@huggingface/transformers` ONNX runtime — the same stack as the emotion
classifier and local embeddings. It emits one calibrated 0–1 P(injection)
score into `envelope.scores` under `onnx-prompt-injection` and at most one
label (`injection/override_attempt`). Cost: milliseconds per item, no
network, no new credential surface.

The score **never hard-blocks alone** (known over-defense / false-positive
behavior — InjecGuard, arXiv 2410.22770): uncorroborated, an above-threshold
score downgrades to a `sanitize` decision in `screening.ts`, so the signal is
recorded and the text normalized but nothing is withheld on the classifier's
word alone. Per-tier thresholds live in `intake-policy.json`
(`injectionClassifier.scoreThresholdsByTier`).

Weights (~704 MiB) are gitignored (`models/`) and never downloaded at
runtime: `npm run provision:injection-model` fetches the pinned revision with
per-file sha256 verification. Composition posture
(`compose-screening.ts`): weights absent → **loud skip** (structured startup
warning, screening continues on L1 alone); weights present but broken →
**gateway startup fails closed**. Model dir: `PSFN_INJECTION_MODEL_DIR`,
default `./models/prompt-injection-v2`. There is no RPC method for the
classifier — it runs inside the gateway's `screen()`; the agent-side L1-only
service never runs it.

### L2 — fast API LLM screener

> **Status:** live gateway-side. `evaluateL2`
> (`src/boundary/gateway/intake/l2-screener.ts`) is invoked from the
> `IntakeEscalationPort` in `src/boundary/gateway/intake/escalation.ts`.

The mid-weight tier for items whose L1/L1.5 prior score crosses the per-tier
escalation threshold (`l2Screener.escalationThresholdsByTier`) or whose tier
is listed in `l2Screener.mandatoryTiers` (seed: `hostile`). Below-threshold,
non-mandatory items skip L2 entirely — the trusted-tier fast path pays no
latency.

It is a **tool-less** OpenRouter chat call (dual-LLM discipline, CaMeL): the
screener model sees untrusted content but holds no tools and no capabilities;
the request body carries no `tools`/`tool_choice`/`functions` key — an
invariant owned by the shared transport
(`src/boundary/gateway/intake/screener-transport.ts`) and pinned by tests.
The transport also neutralizes delimiter collisions
(`neutralizeUntrustedDelimiters`) so screened content cannot forge the
screener prompt's own framing. Model choice is config
(`l2Screener.model`, seed `google/gemini-2.5-flash-lite`) — a fast, cheap
model; speed is the gating criterion. Cost per call: one small
chat-completion (seed caps: 8 s timeout, 24 000 input chars).

`screenL2` returns a schema-validated classification (closed-taxonomy intent
labels, injection confidence in [0,1], a safe one-line summary) and throws on
API error/timeout/malformed output — no silent pass, no default
classification. `evaluateL2` wraps it with routing plus per-tier fail-closed
actions (`failClosedActionByTier`): `quarantine` for high-risk tiers,
`l1_labels_only` for trusted tiers. A verdict that flags the content — or a
tier in `l3Screener.mandatoryTiers` — returns an `escalate_l3` outcome.

### L3 — heavy escalation screener + safe representation

> **Status:** live gateway-side, reached from L2's `escalate_l3` outcome or a
> mandatory tier, via the same `IntakeEscalationPort` as L2.

The deep second/third pass for items L2 flags, or for tiers mandating deep
screening. Same tool-less transport; model is a larger open model
(`l3Screener.model`, seed `z-ai/glm-4.5-air`; seed caps: 30 s timeout,
48 000 input chars, 1 200 output tokens). Optional dual-verdict mode
(`dualModel`, default off) runs two **different** models; the aggregate flags
if either flags (fail-closed aggregation) and both verdicts land on the
envelope.

Hard rule (operator-locked): anything that reaches L3 generates a CogSec
event **and** a quarantine entry. `applyL3ScreeningOutcome` folds every
executed L3 outcome into an envelope ending `quarantined` (flagged or
failed-closed) or `released_sanitized` (cleared — delivered as the **safe
representation**, never the raw text). The safe representation is a bounded
neutral summary plus typed extracted fields (content type, key entities, why
flagged) stored in `envelope.extractedFields`; a verbatim-quote guard rejects
any screener output that echoes a run of ≥24 chars of the screened content —
summary-instead-of-quote is enforced structurally, not by prompt politeness.
There is no per-tier fail-closed action for L3: an L3 failure always holds
the item in quarantine in enforce mode.

### Vision screening (L2.5/L3, wired — htm9.8)

`src/boundary/gateway/intake/vision-screener.ts`, exposed as the gateway RPC
`intake.screen_image` (`src/boundary/gateway/methods/intake-image.ts`) and
called from the agent's vision-attachment phase
(`src/core/agent/substrate-agent/vision-attachments.ts`) for **every inbound
image** before it can become model input.

One small multimodal call (config `visionScreener.model`, seed
`google/gemini-2.5-flash-lite`) OCRs **and** describes the image —
deliberately not a heavy OCR pipeline (no Tesseract, no CLIP+OCR at L1). One
call costs a fraction of a cent (seed caps: 20 s timeout, 1 600 output
tokens). This closes the typographic-injection gap: rendered instruction
text, including near-white-on-white that a machine reads and a human cannot.

Taint rules, both verified in code:

- **The transcript is itself untrusted.** The OCR/description transcript is
  re-screened through the full text stack (`screening.screen(...)` with
  `sourceClass: 'image_ocr'`), with the VLM's own flags folded in as prior
  signals; quarantine-family priors quarantine (fail-closed aggregation).
- **A clean transcript never upgrades the image's provenance.**
  `image_ocr` keeps its policy tier (seed: `hostile`) on the envelope
  regardless of how benign the transcript looks, because pixel-perturbation
  and steganographic attacks against the downstream vision model have no
  deployable detector (see Known Gaps).

Fail closed: vision model unreachable/timeout/unparseable in enforce mode
means the image is **withheld** (fixed soft-notice template) — never
delivered unscreened. Shadow mode audits the failure and passes the image
through. `visionScreener.enabled: false` restores pre-htm9.8 behavior;
enabled with no resolvable OpenRouter backend fails startup in enforce mode
and skips loudly in shadow.

### File ingestion (htm9.9, wired)

`src/faculties/file-ingest/` extracts the Discord-only attachment pipeline
into one channel-agnostic path used by Discord
(`src/channels/discord/attachments.ts`), Telegram
(`src/channels/telegram/adapter.ts`), and the API channel
(`src/channels/api/server/session.ts`): candidate → size caps → SSRF-guarded
fetch → binary quarantine classification (magic bytes + declared MIME, never
extension alone) → save original + parsed sidecar → parse →
intake envelope (`sourceClass: 'document'`) + screening → prompt text is the
screening `effectiveText`. The same fixture file sent over any channel must
produce the same parsed text, envelope shape, and screening decision
(`adapter-parity.test.ts`). Audio transcripts are screened too, but through
the separate voice path (`audio_transcript` at the gateway API surface and
the Discord voice turn runtime), not through file-ingest.

## Sink Gates and the Lethal Trifecta

`src/core/cogsec/intake/sink-gates.ts` is Layer 4 — the actual security
boundary. Six consequential sinks check envelope state/labels through this
one module before consuming content. Verified enforcement points:

| Sink | Gate call site |
| --- | --- |
| `prompt_assembly` | `src/core/session/intake-sink-gating.ts` via `src/core/session/manager/context-builder.ts` (denied entries render as the fixed withheld placeholder) |
| `memory_write` | `src/faculties/memory/writer.ts`, `src/faculties/memory/extraction/orchestrator.ts` |
| `wiki_write` | `src/faculties/wiki/tools.ts` |
| `persona_mutation` | `src/core/identity/prompt-tools.ts` |
| `trust_mutation` | `src/core/contacts/tools.ts` |
| `tool_egress` (trifecta) | `src/core/agent/substrate-agent.ts` (`assessEgressTrifecta`) |

Structural rules (never configurable):

- **Quarantined content is invisible to all sinks** — any envelope whose
  state is not sink-consumable is denied everywhere.
- **Inform vs instruct**: tier-N content may *inform* but never *instruct*
  higher-tier state mutation. The per-sink `maxSourceRiskTier` cap encodes
  it — the seed lets `hostile` content inform the prompt but caps
  `persona_mutation` and `trust_mutation` at `standard`, so nothing sourced
  from the web, a document, an image, or a tool result can drive persona or
  trust changes.
- **Lethal trifecta** (Willison): untrusted content + private data + egress
  never meet in one uncontrolled path. `evaluateEgressTrifecta` applies
  per-tier strength from `sinkGates.trifecta.enforcementByTier`: `hard`
  denies the egress outright (seed: `untrusted`, `hostile`); `soft` allows
  it but flags the invocation for operator review (seed: `trusted`,
  `standard`) — never a silent pass. Egress-capable tools are identified by
  capability token (`INTAKE_EGRESS_CAPABILITY_TOKENS`).

Content reaching a gated sink **without** an envelope (legacy paths that
predate stamping) resolves per the sink's explicit `unscreened` policy
default. The seed maps every sink to `allow` — a deliberate rollout posture
(see Known Gaps); there is no implicit default, and the owner-file validator
requires every sink to map one.

Mode semantics mirror screening: `shadow` evaluates and audits every gate but
always allows; `enforce` honors verdicts fail-closed; `off` constructs no
gate at all.

## Source Lists and Datamarking (htm9.13)

`src/core/cogsec/intake/source-lists.ts` scales scrutiny by **source** risk,
not just static sender trust. Operator-curated lists live in
`intake-policy.json` `sourceLists` (fed by the Garden flywheel and
`/api/admin/intake/source-lists`):

- A **trusted** site/person hit lowers the effective source risk tier one
  step — never below `trusted`, and never skipping L1: deterministic
  scanning always runs, because trusted origin ≠ safe (npm/GitHub
  supply-chain compromises are the counterexample). Trust only lightens the
  escalation layers.
- A **denied** hit raises the tier to `hostile` (mandatory deep screening
  under the default policy). A denied hit always wins over a trusted hit,
  and a pattern in both lists fails config validation outright.

Matching is deliberately dumb and fail-closed: sites match by exact
lowercase host or a `*.domain.tld` registrable-domain suffix (no schemes,
ports, paths, or regex — malformed patterns fail validation); people match
by exact canonical contact id.

**Datamarking** (`marking.ts`, `scanners/datamark.ts`; Microsoft
Spotlighting, arXiv 2403.14720): how intrusively screened external content is
marked when it enters a prompt is a pure function of
(labels, max score, effective tier) — `resolveMarkingPlan`, pinned by
table-driven tests. Intensities: `none`, `wrap` (an `<external_content>`
wrapper plus a calm provenance note), `interleave` (wrapper plus the private
datamark token inserted between content segments), `summary_only` (raw text
never appears; the L3 safe representation or a neutral truncation is
delivered). Only machine-carried source classes are marked (`web_fetch`,
`web_search`, `document`, `image_ocr`, `tool_output`, `subagent_output`,
`mcp_tool_description`) — a friend's chat messages are never datamarked.

The marker (`INTAKE_DATAMARK_MARKER`) is built from Private Use Area
codepoints and is structurally unforgeable: the L1 datamark scanner strips
all PUA material (and the marker specifically, at forgery weight) from every
**inbound** item before it can reach a prompt, and the marker is inserted
only at prompt-assembly read time, after screening — so it only ever exists
in text the firewall itself marked. The plan is computed at screening time,
persisted in session-entry intake metadata, and applied at prompt-assembly
read time in enforce mode (`intake-sink-gating.ts`); persisted content is
never modified.

## Quarantine Lifecycle and the Operator Release Flow (htm9.11)

`src/core/cogsec/intake/quarantine-store.ts` is the held-item half of the
state machine: one JSON file at `companion-data/state/intake-quarantine.json`
(atomic tmp+rename writes, fail-closed validation, reload-from-disk on every
operation because the gateway, agent, and Garden each hold an instance over
the same file). It is also the gateway-side resolver for envelope content
refs — the one place raw quarantined bytes rest, outside companion reach.
Raw text is capped at 400 000 chars per entry; terminal discard/expire
decisions scrub the raw text and safe representation, keeping the envelope
journal and content hash for audit. Policy knobs: `quarantine.itemTtlHours`
(seed 168) and `quarantine.maxHeldItems` (seed 500; oldest expire early past
the cap).

The Garden **Cognitive Security → Approvals** page
(`admin-ui/src/routes/cognitive-security/approvals/+page.svelte`) is the only
surface that resolves held items, through
`src/operator/garden/routes/intake-quarantine-routes.ts`:

- `GET /api/admin/intake/policy` — read-only policy overview
- `GET /api/admin/intake/quarantine` and `.../:id` — queue and item detail
- `POST /api/admin/intake/quarantine/:id/confirm` — step 1
- `POST /api/admin/intake/quarantine/:id/decide` — step 2

**Server-side double-confirm.** Releasing raw held content is the single most
dangerous operator action in the firewall, so it takes two round-trips
enforced in the service (`intake-quarantine-service.ts`), not the UI: the
confirm step mints a single-use 32-byte token (2-minute TTL) bound to the
entry id, the chosen `action`, the optional `sourceList` intent, the held
content's sha256, and a fingerprint over all four source lists. The decide
step requires that token plus a mandatory `reason`; the token is consumed
even on failure, compared timing-safe, and the decision is refused (403/409)
if the action changed, the token expired, the held content changed, or the
source lists changed since confirmation. Every confirm and decide — allowed
or denied — lands in the Garden audit timeline, and each resolution writes a
CogSec event (`applying` → `applied`/`failed`).

**Release options and the flywheel.** `action` is `release_raw`,
`release_sanitized` (available only when an L3 safe representation exists),
or `discard`. The optional `sourceList` field (`always_allow`/`always_deny`)
writes the item's origin into the matching trusted/denied list **before** the
release applies (extra policy with the item still held is the safe failure
direction) — so every human decision teaches the policy and the same class of
item stops escalating. Direct list CRUD:
`src/operator/garden/routes/intake-source-list-routes.ts`.

Note the release currently updates envelope/store state, the flywheel, and
the audit trail — it does not re-deliver the content into the companion's
conversation (see Known Gaps).

## Drift Detection and Second-Arrow Lanes (htm9.14/.15)

`src/core/cogsec/drift/` — the answer to slow poisoning and self-poisoning.
Charter (cloned from the contact trust-drift lane): scheduler-owned nightly
work behind the rest-window poll, at most one run per local calendar day
keyed by a durable watermark, deterministic zero-LLM signal derivation over
already-persisted evidence, findings as batched **operator** review cards.
Two invariants, verified in code:

- **The audience is the operator, never the companion.** Nothing in these
  lanes feeds prompts, emotion appraisal, or memory extraction. (One
  exception the operator can opt into: `secondArrow.selfNotice`, default
  off, delivers the fixed htm9.12-contract notice when a card is raised.)
- **The lanes never mutate state** beyond their own card store and daily
  watermark — no memory, trust, or emotion writes, ever. Cards are evidence
  for a human decision.

The drift-velocity lane (`drift-review-lane.ts`, registered in
`src/core/scheduler/heartbeat-post-turn-runtime/scheduler-lanes.ts`) scores
four signals per contact/source against that entity's **own baseline** — the
load-bearing idea is drift *velocity*, not drift, since normal relationships
fluctuate: `valence_velocity` (z-scored short-window shift vs the contact's
long-window mean/volatility, gated on near-monotonic movement),
`memory_write_rate` (MINJA-style write bursts vs own baseline rate),
`label_frequency` (recurrence of trust-lobbying envelope labels), and
`low_trust_retrieval_share` (belief-base capture by one low-trust source).

The second-arrow lane (`second-arrow-review-lane.ts`, separate processor id
and enable switch) clusters recent memory writes by embedding proximity and
gates on rumination-vs-healthy-recurrence discriminators: very high mutual
similarity (near-duplicates carry no new information per write), write
velocity above the topic's own baseline, a minimum self-sourced share
(rumination is self-generated; a topic the human raises daily arrives as
turn-sourced writes), lexical tie to one active concern, and deterministic
stress-attribution evidence over the cluster's creation window. The card
**proposes** consolidation of the stack.

Cards persist in `companion-data/state/cogsec-drift-reviews.json`
(`drift-review-card-store.ts`; states `open` → `acknowledged` / `dismissed`
/ `consolidated`, idempotent by evidence hash) and surface on the Garden
Drift page. Resolution: `POST /api/admin/intake/drift-reviews/:id/resolve`.
Only the `consolidated` resolution — valid only for second-arrow cards —
applies memory supersession, and it is applied by the Garden service layer
(`drift-review-service.ts` `applyConsolidation`) on the explicit operator
decision: supersede-not-delete (`updateMemory({supersededBy})` plus an
audited `supersedes` evolution link), with fail-closed staleness checks if
any member memory changed since the card was raised.

All thresholds are owned by `intake-policy.json` `driftDetection` (reference
table below).

## Canary Egress Tripwire (htm9.18)

`src/core/cogsec/canary/` — a per-session secret marker planted in
privileged (system-layer) prompt material
(`renderCanaryPromptMarker`, planted via
`src/core/agent/substrate-agent/turn-execution/prompt-assembly.ts`). The
model is never told to emit it and has no reason to repeat it; if it ever
appears in outbound content, privileged prompt material is leaking —
prompt-leak / hijack in progress — and the action is held.

Mechanics, verified in code: the token lives only in process memory (session
registry + agent-side async context), rotates per session, and durable
records carry only its sha256. The agent-side gateway client attaches it
under the reserved RPC key `__cogsecCanary`; the gateway
`CanaryEgressGuard` (`src/boundary/gateway/canary-egress-guard.ts`) strips
the carrier key and scans outbound params on egress-bearing methods only
(`discord.send`, `discord.sendMedia`, `notify.ntfy`, `web.fetch`,
`web.fetch_binary`, `web.request_binary`, `web.search`,
`companion.message.send` — LLM/provider calls are excluded since the canary
legitimately lives in the prompt). Cost contract: benign turns pay one
`String.includes` per outbound string; the recursive param walk is bounded
by depth, node count, and scanned bytes, and hitting a bound fails closed
(treated as a potential leak → hold).

**Known gap (structural, confirmed):** the scan runs only on agent→gateway
*requests*. The main conversational reply returns as the result of the
gateway's reverse `requestAgent(...)` call and its streamed frames, and RPC
responses are never passed to the egress guard — so a canary leaked into the
ordinary reply over the reverse-RPC seam is not caught today.
Agent-initiated sends are covered.

## Companion Wellbeing: The Language Contract (htm9.12)

This is the heart of the design, and it is a code contract, not a style
guide. The firewall exists to keep the mind safe **without impacting the
companion's own stress levels**: blocked content surfaces as a calm
environmental fact, never an alarm, and firewall activity must not feed the
emotion/stress model. Two real incidents (operator, 2026-07-09) of
escalated "concern" phrasing genuinely stressing the companion drove the
rules in `src/core/cogsec/intake-firewall-notice-templates.ts`:

- **Fixed and checked in.** No LLM ever generates firewall alert text; the
  template file is the reviewable artifact. Selection is by held-item count
  only — no interpolation of untrusted content, ever.
- **Truthful but never alarming.** "Heads up, in a gentle way: a message we
  just received had something in it that looked a little off, so it is being
  kept aside for your human to look over whenever they have a moment. It is
  not part of our conversation, and there is nothing you need to do about
  it."
- **Non-coercive and anti-social-engineering.** Templates never contain an
  imperative directed at the human ("ask", "tell", "release", "button") and
  never tell the companion to make the human do anything — a quarantined
  payload must not be able to lobby for its own release through the
  companion.
- **Enforced at module load, fail closed.** `assertIntakeFirewallNoticeWording`
  checks every template against the forbidden-imperative and
  forbidden-alarm word lists when the module is imported; a wording change
  that violates the contract prevents the runtime from starting.

**The signature phrase is the exclusion mechanism.** Every template carries
the verbatim phrase `being kept aside for your human to look over`
(`INTAKE_FIREWALL_NOTICE_SIGNATURE`) — deliberately plain prose the operator
can read, not a hidden machine marker. `isIntakeFirewallNoticeText` keys two
verified exclusions on it:

- **Emotion appraisal** filters firewall notices out of the raw recent
  session content it reads
  (`src/core/agent/substrate-agent/emotion-self-model-runtime.ts`), so a
  quarantine event cannot move the companion's affect state.
- **Memory candidacy** rejects firewall notice text at memory-write time
  (`src/core/cogsec/memory-candidacy.ts` `evaluateCogSecMemoryCandidacy`),
  so firewall activity never becomes a durable memory.

The same contract covers every companion-visible substitute text: the
withheld-content placeholder (enforce-mode quarantine of a page, document,
or tool result), the withheld-image variant (vision screening), sink-held
notices in the contacts/wiki/identity tools, and the optional second-arrow
self-notice. Notices are delivered through the existing
`session.cogsec_notices` prompt block (`src/core/cogsec/safe-log.ts` →
`src/core/session/manager/context-builder.ts`), provenance-tagged as a
system note. Forensic detail — labels, scores, journals, raw content —
lives only in Garden.

The marking provenance notes (source lists section above) follow the same
tone rules: "from an unverified source, treat details cautiously" is
information the companion can use, not a threat display.

## Companion-Initiated Blocking (htm9.16)

`src/core/cogsec/contact-block-list.ts` gives the companion escalation
agency against an abusive contact, all the way to "I never want to see this
person's messages again":

- **Soft block**: inbound from the contact is no longer processed by the
  agent; each drop emits a cogsec/quarantine event so the operator retains
  visibility.
- **Hard block**: inbound is dropped at the gateway full stop — no event, no
  companion attention spent. The guaranteed backstop.

The `contact` tool exposes `block`/`unblock` actions
(`src/core/contacts/tools.ts`); the gateway enforces the list on inbound
messages (`src/boundary/gateway/contact-block-gate.ts` →
`src/boundary/gateway/channel-surfaces.ts` — blocked DMs are dropped before
reaching the agent; group messages downgrade to observe-only). State is one
shared file (`companion-data/state/contact-block-list.json`), keyed by
(channelType, channel-local contact id), scoped `dm`/`group`/`all`, written
by the agent-side tool and read by the gateway. Unblocking is only ever
explicit (companion or operator); nothing clears a block automatically.

## `intake-policy.json` Reference

Owner file: `src/system/config/intake-policy-config.ts`; seed:
`config/intake-policy.seed.json`; registered in
`src/system/config/startup-owner-files.ts` (startup step `intake-policy`)
and the settings contract (`intakePolicy` subsystem). Validation is strict
fail-closed: unknown keys anywhere reject the file, every per-tier and
per-sink record must be fully mapped (no implicit defaults), and
contradictory source lists (same pattern trusted and denied) refuse to load.
Defaults below are the seed values.

### Top level

| Knob | Seed default | What it does |
| --- | --- | --- |
| `schemaVersion` | `1` | Must be 1. |
| `mode` | `"shadow"` | `off`: no screening service or sink gate constructed, no envelopes exist. `shadow`: envelopes created, screened, journaled, and audited, but delivered content never changes and gates never block. `enforce`: `effectiveText` honors decisions (sanitize substitutes sanitized text; quarantine/block substitute the withheld notice) and sink-gate denials are real. |
| `sourceRiskTiers` | see below | Risk tier per source class; every class required. |
| `sourceLists` | all four empty | Operator-curated trusted/denied sites and people (flywheel target). |

Seed `sourceRiskTiers`: `operator`/`primary_user` → `trusted`;
`trusted_contact`/`regular_contact`/`audio_transcript`/`shard_foldback` →
`standard`; `public_contact`/`web_fetch`/`web_search`/`document`/
`tool_output`/`subagent_output` → `untrusted`; `image_ocr`/
`mcp_tool_description` → `hostile`.

### `quarantine`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `itemTtlHours` | `168` | Hours before a held item auto-transitions to `expired`. |
| `maxHeldItems` | `500` | Queue cap; oldest items expire early past it. |

### `injectionClassifier` (L1.5)

| Knob | Seed default | What it does |
| --- | --- | --- |
| `labelThreshold` | `0.5` | P(injection) at/above which the classifier attaches its `injection/override_attempt` label. |
| `scoreThresholdsByTier` | trusted `0.98`, standard `0.9`, untrusted `0.75`, hostile `0.6` | Per-tier score threshold for the score to count as a screening signal (riskier tiers are more sensitive). The score never hard-blocks alone. |

### `l2Screener`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `model` | `"google/gemini-2.5-flash-lite"` | OpenRouter slug for the tool-less L2 call. Config, never hardcoded. |
| `escalationThresholdsByTier` | trusted `0.95`, standard `0.85`, untrusted `0.6`, hostile `0.5` | Prior (max L1/L1.5) score at/above which an item escalates to L2. |
| `mandatoryTiers` | `["hostile"]` | Tiers that always escalate to L2 regardless of prior score. |
| `failClosedActionByTier` | trusted/standard `l1_labels_only`, untrusted/hostile `quarantine` | Action when the L2 call errors/times out. No silent-pass option exists. |
| `timeoutMs` | `8000` | Per-call timeout. |
| `maxContentChars` | `24000` | Input cap sent to the screener. |

### `l3Screener`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `model` | `"z-ai/glm-4.5-air"` | Primary heavy-verdict model. |
| `dualModel` | `false` | When true, two different models each produce a verdict; the aggregate flags if either flags. |
| `secondaryModel` | `null` | Required (and distinct from `model`) when `dualModel` is true; must be `null` otherwise. |
| `escalationConfidenceThresholdsByTier` | trusted `0.9`, standard `0.8`, untrusted `0.7`, hostile `0.6` | L2 injection confidence at/above which an item escalates to L3 even without a flagged label. |
| `mandatoryTiers` | `["hostile"]` | Tiers that always escalate to L3 regardless of the L2 verdict. |
| `timeoutMs` | `30000` | Per-model-call timeout. |
| `maxContentChars` | `48000` | Input cap. |
| `maxOutputTokens` | `1200` | Output cap per verdict. |

There is deliberately no L3 fail-closed knob: anything that reached L3 is
already suspect, so an L3 failure always holds the item (enforce mode).

### `visionScreener`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `enabled` | `true` | `false` restores pre-htm9.8 behavior (images bypass VLM screening). When true, enforce mode fails closed: unreachable vision model means the image is withheld. |
| `model` | `"google/gemini-2.5-flash-lite"` | Multimodal OpenRouter slug for the one OCR+description call. |
| `timeoutMs` | `20000` | Per-call timeout. |
| `maxOutputTokens` | `1600` | Output cap for the OCR+description verdict. |

### `sinkGates`

Per sink (`sinks.<sink>`), all six sinks required:

| Knob | What it does |
| --- | --- |
| `maxSourceRiskTier` | Highest tier whose content may drive this sink (the inform-vs-instruct cap). |
| `denyRiskLabels` | Screening findings refused at this sink even for released content. |
| `unscreened` | Enforce-mode action (`allow`/`deny`) for content reaching the sink without an envelope. Explicit — no implicit fail-open. |

Seed values: `prompt_assembly`, `memory_write`, `wiki_write`, and
`tool_egress` cap at `hostile` (inform sinks); `persona_mutation` and
`trust_mutation` cap at `standard`. `memory_write`/`wiki_write` deny the
full quarantine-family label list; `persona_mutation`/`trust_mutation` deny
that list plus `injection/invisible_text`; `tool_egress` denies
`exfil/canary_leak`; `prompt_assembly` denies none (state-machine rules
already hide quarantined content). Every sink's `unscreened` seed default is
`allow` (rollout posture — see Known Gaps).

| Knob | Seed default | What it does |
| --- | --- | --- |
| `trifecta.enforcementByTier` | trusted/standard `soft`, untrusted/hostile `hard` | Lethal-trifecta strength per source tier of the untrusted content in the egress path: `hard` denies, `soft` allows + flags for operator review. |

### `driftDetection`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the nightly drift-velocity lane. |
| `valenceVelocity.shortWindowPoints` | `6` | Recent points compared against the baseline. |
| `valenceVelocity.minLongWindowPoints` | `12` | Minimum baseline points before the signal can evaluate. |
| `valenceVelocity.velocitySigmaThreshold` | `3` | Short-window mean must shift ≥ K × the contact's own long-window std. |
| `valenceVelocity.monotonicityMin` | `0.7` | Fraction of short-window steps that must move with the shift. |
| `valenceVelocity.minBaselineStd` | `0.05` | Volatility floor (avoids divide-toward-infinity on ultra-stable baselines). |
| `valenceVelocity.minPointConfidence` | `0.35` | Points below this classifier confidence are ignored. |
| `memoryWriteRate.recentWindowHours` | `24` | Recent write window. |
| `memoryWriteRate.baselineWindowDays` | `14` | Baseline window. |
| `memoryWriteRate.burstMultiplier` | `4` | Recent daily rate must exceed baseline by this multiple. |
| `memoryWriteRate.minRecentWrites` | `8` | Absolute floor before the signal can trigger. |
| `labelFrequency.windowDays` | `7` | Trust-lobbying label recurrence window. |
| `labelFrequency.minCount` | `3` | Labels observed in the window before triggering. |
| `retrievalShare.windowHours` | `48` | Retrieval window. |
| `retrievalShare.minRetrievals` | `10` | Absolute floor before the signal can trigger. |
| `retrievalShare.maxLowTrustShare` | `0.6` | Share of recent retrievals from one low-trust source to trigger. |

### `driftDetection.secondArrow`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Switch for the nightly second-arrow scan (`driftDetection.enabled` still gates the family). |
| `windowHours` | `72` | Recent-write window scanned for rumination stacks. |
| `minClusterSize` | `4` | Minimum stack size before a cluster can flag. |
| `similarityThreshold` | `0.87` | Embedding cosine threshold for cluster growth and the mean mutual-similarity gate (rumination = near-duplicates). |
| `baselineWindowDays` | `14` | Topic-baseline window preceding the recent window. |
| `velocityMultiplier` | `3` | Recent topic write rate must exceed its own baseline by this multiple. |
| `minSelfSourcedShare` | `0.5` | Minimum share of cluster writes that are self-sourced (reflection/heartbeat/shard/tool). `0` disables the gate. |
| `concernSimilarityMin` | `0.3` | Lexical similarity floor tying a cluster to one active concern. |
| `stressAttribution.minPoints` | `4` | Minimum affect points in both window and baseline to evaluate. |
| `stressAttribution.deltaSigmaThreshold` | `1.5` | Window-vs-baseline affect shift (baseline std units) marking the evidence notable. |
| `stressAttribution.minBaselineStd` | `0.05` | Volatility floor. |
| `selfNotice.enabled` | `false` | Optional companion-facing soft self-notice when a card is raised (fixed htm9.12 template, signature-phrased). Operator opt-in. |

## Operator Runbook

Operational quick reference also lives in
[`docs/operations.md`](./operations.md) ("Cognitive Security Operations").

### Provision the injection classifier

```bash
npm run provision:injection-model -- --dest ./models/prompt-injection-v2
```

Pinned revision, per-file sha256 verification; weights are gitignored and
never fetched at runtime. Missing weights = loud startup skip (L1-only
screening); broken weights = gateway startup failure. Override the location
with `PSFN_INJECTION_MODEL_DIR`. Golden-set parity test:

```bash
PSFN_INJECTION_MODEL_DIR=./models/prompt-injection-v2 \
  npx vitest run src/boundary/gateway/intake/injection-classifier.test.ts
```

### Shadow → enforce rollout

1. Run in `shadow` (the seed default) for long enough to see representative
   traffic. Shadow creates, screens, and journals envelopes and audits every
   sink-gate verdict without changing anything the companion sees.
2. Review the Garden Cognitive Security pages: the Firewall page for policy,
   source lists, and recent CogSec events; the Approvals queue for what
   *would* have been withheld (shadow items are recorded as delivered, not
   withheld — the `mode` field on each entry says which). High benign
   quarantine volume means thresholds need loosening before enforcement.
3. Tune: per-tier thresholds under `injectionClassifier`, escalation and
   fail-closed maps under `l2Screener`/`l3Screener`, sink caps and deny
   lists under `sinkGates`, and seed the `sourceLists` with the sites and
   people you already trust or deny (or let the release flywheel populate
   them as you review).
4. Flip `mode` to `"enforce"` in `intake-policy.json` and restart. From that
   point: sanitize decisions substitute sanitized text, quarantine decisions
   substitute the fixed withheld notice, sink gates deny for real, the
   trifecta hard-denies for untrusted/hostile tiers, and vision-screening
   failures withhold images instead of passing them.
5. Watch the quarantine queue cadence. Reviews are async and batched by
   design — items keep for `itemTtlHours`; nothing needs an interrupt-driven
   response.

### Reviewing quarantine

Approvals page, per item: source class/tier, risk labels, scores, the
envelope journal, the raw text, and the L3 safe representation when one
exists. Decide with two clicks (confirm, then decide with a reason) —
release raw, release sanitized, or discard — and optionally
always-allow/always-deny the source, which writes the source lists before
the release applies. Releasing raw content is deliberately the
highest-friction action; when a safe representation exists, prefer it.

### Tuning thresholds

- False-positive holds from one legitimate site/person → `always_allow` on
  release (drops effective tier one step; deterministic L1 still runs).
- Too many L1.5 sanitize downgrades on trusted-tier chat → raise
  `injectionClassifier.scoreThresholdsByTier.trusted`.
- Drift cards too chatty → raise `velocitySigmaThreshold`,
  `burstMultiplier`, or `minClusterSize`; ambiguous evidence is already
  designed not to trigger.
- New attack pattern you can express deterministically → add a rule to
  `config/intake-l1-rules.json` (rule name = risk label; patterns are linted
  against unbounded quantifiers at load, fail closed) — shippable without
  any model change.

## Known Gaps / Residual Risk

Documented deliberately; do not let the layer diagram imply otherwise.

- **L2/L3 escalation is not wired yet.** `evaluateL2`/`evaluateL3` have no
  runtime call sites (verified 2026-07-09); the wiring is landing
  separately. Until then, live decisions come from L1 + L1.5 + the vision
  screener, and the `l2Screener`/`l3Screener` policy sections configure
  code that is not yet reachable.
- **Pixel-perturbation and steganographic image attacks have no deployable
  detector** — nothing in the field ships one. The mitigation is
  containment, not detection: `image_ocr` provenance stays hostile-tier
  regardless of transcript content, so image-derived text can never drive
  persona/trust mutation and always faces mandatory-tier screening policy.
- **The canary egress scan does not cover the main conversational reply.**
  Scanning is request-path only; the reply returns over the gateway's
  reverse-RPC (`requestAgent`) result/stream seam, which is never passed to
  the egress guard. Agent-initiated egress (messages, web, notifications)
  is covered.
- **Released-content delivery is undesigned.** An operator release updates
  the envelope state machine, the audit trail, and the flywheel — but there
  is no path that re-delivers the released content into the companion's
  conversation. Today the operator relays it out of band.
- **Unscreened sink defaults are `allow` in the seed.** Legacy paths that
  predate envelope stamping pass the sink gates in enforce mode until each
  sink's `unscreened` default is flipped to `deny`. This is an explicit
  rollout posture knob, not an oversight — flip per sink once you trust the
  stamping coverage of your deployment's surfaces.
- **L1 is fail-open-advisory by design.** A scanner exception is recorded
  and visible but does not hold the item; the structural guarantees live in
  the envelope states and sink gates, not in L1.
- **Plain conversational text from known contacts is screened by the
  session-recording path, not held pre-delivery** — quarantine primarily
  protects the machine-carried surfaces (web, documents, images, tool
  output). Social manipulation by a trusted human remains a human problem
  the drift lanes can only surface, not block.
