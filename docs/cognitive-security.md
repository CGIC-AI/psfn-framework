# Cognitive Security: The Cognition Intake Firewall

Last updated: 2026-08-11.

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

> **Source wiring note.** L2/L3 escalation runs **gateway-side only**, through the
> `IntakeEscalationPort` composed in
> `src/boundary/gateway/intake/compose-screening.ts`; the agent process holds no
> escalation port and stays L1-only by construction. When no OpenRouter backend
> is resolvable, escalation is not composed and emits a warning in `shadow`.
> `boundary` and `strict` fail startup when non-empty `mandatoryTiers` require
> escalation that cannot be composed.

## Global mode contract

Schema-v5 `intake-policy.json` accepts exactly three global modes:

- `shadow` screens every declared vector and records decisions without
  changing delivery, except that a hard lethal-trifecta denial remains
  blocking;
- `boundary` enforces external chat, file, and web ingress plus registered
  outbound publication, while structurally authenticated internal activity
  uses the clean bubble with no semantic-screening call; and
- `strict` screens and enforces both external and internal vectors.

The vector classification and decision matrix live in
`src/shared/contracts/cogsec-mode.ts`. Structural call-site provenance, not
message text or model arguments, determines whether an item is internal.
External bytes cannot claim an internal provenance class. The retired global
values `off` and `enforce` are rejected by schema-v5 validation; the explicit
owner migration maps them to `shadow` and `strict`, respectively. Some internal
interfaces and stored quarantine records still use `enforce` for the binary
per-surface posture produced by both `boundary` and `strict`. That internal
value is not an owner-file mode.

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
     prompt_assembly | memory_write | wiki_write | skill_write |
     persona_mutation | trust_mutation | tool_egress
     (+ lethal-trifecta assessment)
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

Canonical envelope-creation call sites:

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

Fifteen closed source classes (`INTAKE_SOURCE_CLASSES`): `operator`,
`companion_self`, `primary_user`, `trusted_contact`, `regular_contact`,
`public_contact`, `web_fetch`, `web_search`, `document`, `image_ocr`,
`audio_transcript`, `tool_output`, `subagent_output`, `shard_foldback`,
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
load-bearing: raw input capped at `MAX_SCAN_CHARS` before any regex; invisible /
zero-width detection on the **raw** capped string, then strip; datamark
marker detection/stripping on the stripped raw text; NFKC normalization
(folds full-width homoglyphs onto ASCII) and a second cap because compatibility
normalization can expand UTF-16 length; then the rule engine, encoding
smuggling, URL, and secrets/PII scanners on the normalized text; secrets
redaction produces a final capped sanitized text.

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

### L1.5 — ONNX injection classifier (wired, gateway-side; required when enforcing)

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
(`compose-screening.ts`, tightened by `cyy7l`):

- **`mode=boundary` or `mode=strict`, weights absent → gateway startup fails
  closed** with an
  actionable error naming the provisioning command. A degraded L1-only
  firewall under an enforce posture is a fail-closed violation: the posture
  reports "armed" while L1.5 scoring silently never runs, so startup refuses
  to continue until the weights are on disk.
- **`mode=shadow`, weights absent → loud skip**: one structured startup
  warning (never per-message), screening continues on the deterministic L1
  layer alone, and the composition is flagged
  `injectionClassifier.degraded=true` for intake health surfaces.
- **weights present but broken (any mode) → gateway startup fails closed.**

Model dir: `PSFN_INJECTION_MODEL_DIR`, default `./models/prompt-injection-v2`
(the deployment may supply another exact path). The private operations
authority must ensure every gateway artifact has the pinned weights at that
path before an enforcing startup. There is no RPC method for the classifier;
it runs inside the gateway's `screen()`, and the agent-side L1-only service
never runs it.

### L2 — fast API LLM screener

> **Wiring:** `evaluateL2`
> (`src/boundary/gateway/intake/l2-screener.ts`) is invoked from the
> `IntakeEscalationPort` in `src/boundary/gateway/intake/escalation.ts`.

The mid-weight tier for items whose L1/L1.5 prior score crosses the per-tier
escalation threshold (`l2Screener.escalationThresholdsByTier`) or whose tier
is listed in `l2Screener.mandatoryTiers` (seed: `untrusted`, `hostile`). This
makes L2 the deliberate semantic catch for public and machine-carried content
that reads clean to lexical L1 and bounded ONNX L1.5, while below-threshold
trusted/standard items keep the zero-call fast path.

It is a **tool-less** OpenRouter chat call (dual-LLM discipline, CaMeL): the
screener model sees untrusted content but holds no tools and no capabilities;
the request body carries no `tools`/`tool_choice`/`functions` key — an
invariant owned by the shared transport
(`src/boundary/gateway/intake/screener-transport.ts`) and pinned by tests.
The transport also neutralizes delimiter collisions
(`neutralizeUntrustedDelimiters`) so screened content cannot forge the
screener prompt's own framing. The model is resolved at gateway startup
through the canonical `background` purpose in `models.json`, using the same
single- versus multi-companion selection semantics as ordinary model calls.
There is no screener-specific model selector in `intake-policy.json`. Cost per
call: one small chat-completion (seed caps: 8 s timeout, 24 000 input chars).

`screenL2` returns a schema-validated classification (closed-taxonomy intent
labels, injection confidence in [0,1], a safe one-line summary) and throws on
API error/timeout/malformed output — no silent pass, no default
classification. `evaluateL2` wraps it with routing plus per-tier fail-closed
actions (`failClosedActionByTier`): `quarantine` for high-risk tiers,
`l1_labels_only` for trusted tiers. A verdict that flags the content — or a
tier in `l3Screener.mandatoryTiers` — returns an `escalate_l3` outcome.

Every completed canonical text screening emits one info-level `Intake
screening observability` record, including released envelopes and `image_ocr`
transcripts. The record is content-free: envelope/source identifiers, final
state/action, risk labels, all per-layer scores, and an L2/L3 status plus
routing reason. It excludes raw text, origin refs, summaries, and model output.
The same record is returned as `IntakeScreeningResult.observability` and can be
captured through the isolated `onDecision` observer. This makes a corpus miss
attributable to `L2 not_run` versus `L2 clear` without raising log sensitivity.

### L3 — heavy escalation screener + safe representation

> **Wiring:** reached from L2's `escalate_l3` outcome or a
> mandatory tier, via the same `IntakeEscalationPort` as L2.

The deep second/third pass for items L2 flags, or for tiers mandating deep
screening. Same tool-less transport; its primary model is resolved through
the canonical `reasoning` purpose (seed caps: 30 s timeout, 48 000 input
chars, 1 200 output tokens). In the default single-verdict mode, the canonical
reasoning candidates are followed by distinct background-purpose candidates:
provider rejection, timeout, malformed JSON, or an anti-echo violation advances
to the next model, and the item fails closed if every candidate fails. Startup
rejects a single-candidate chain as an availability single point of failure.
Optional dual-verdict mode (`dualModel`, default off) uses the canonical
`background` purpose as a second independent verdict.
Startup rejects dual mode when both purposes resolve to the same model. The
aggregate flags if either flags (fail-closed aggregation), and both verdicts
land on the envelope.

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
the item in quarantine in `boundary` and `strict`. Each L3 failed-closed result
also emits structural `intake.screening.fail_closed` telemetry with stage `l3`
and the source class. The standard operator-alert handler raises a priority-5
alert once that pair reaches the `settings.json`-owned
`intakeScreeningFailureAlertThreshold` (seed 3), rather than once per item.

### Vision screening (L2.5/L3, wired — htm9.8)

`src/boundary/gateway/intake/vision-screener.ts`, exposed as the gateway RPC
`intake.screen_image` (`src/boundary/gateway/methods/intake-image.ts`) and
called from the agent's vision-attachment phase
(`src/core/agent/substrate-agent/vision-attachments.ts`) for **every inbound
image** before it can become model input.

One small multimodal call, resolved through the canonical `vision` purpose,
OCRs **and** describes the image — deliberately not a heavy OCR pipeline (no
Tesseract, no CLIP+OCR at L1). Startup requires the selected catalog entry to
declare `supportsVision: true`. Seed caps are a 20 s timeout and 1 600 output
tokens. This closes the typographic-injection gap: rendered instruction text,
including near-white-on-white that a machine reads and a human cannot.

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
- **Empty OCR is explicit, never inferred.** A verdict with empty `ocrText`
  is schema-valid only when the model also returns
  `noLegibleText: true`. Empty OCR without that sentinel fails closed, so a
  text-only or image-ignoring model cannot silently classify every image as
  benign.

Fail closed: vision model unreachable/timeout/unparseable in `boundary` or
`strict` means the image is **withheld** (fixed soft-notice template) — never
delivered unscreened. Shadow mode audits the failure and passes the image
through. `visionScreener.enabled: false` restores pre-htm9.8 behavior; enabled
with no resolvable OpenRouter backend fails startup in `boundary` or `strict`
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

A screening-withheld document additionally discloses **no on-disk locator**
(hrmrq.54): the ingest section renders as `[Attached file withheld: …]` with
the intake-envelope quarantine reference instead of `Saved path:` /
`Parsed text path:`, and the attachment's `localPath`/`parsedTextPath`
metadata is stripped — a disclosed path is one `fs.read` away from the
quarantined bytes. The saved document and its parsed sidecar paths are
registered on the quarantine hold (`artifactPaths`) so the read gate below
covers them.

## Sink Gates and the Lethal Trifecta

`src/core/cogsec/intake/sink-gates.ts` is Layer 4 — the actual security
boundary. Seven consequential sinks check envelope state/labels through this
one module before consuming content. Verified enforcement points:

| Sink | Gate call site |
| --- | --- |
| `prompt_assembly` | `src/core/session/intake-sink-gating.ts` via `src/core/session/manager/context-builder.ts` (denied entries render as the fixed withheld placeholder) |
| `memory_write` | `src/faculties/memory/writer.ts`, `src/faculties/memory/extraction/orchestrator.ts` |
| `wiki_write` | `src/faculties/wiki/tools.ts` |
| `skill_write` | `src/faculties/skills/tools.ts` via `src/faculties/skills/runtime-wiring.ts` (strict screening covers the prompt-index description and SKILL.md body before create/update) |
| `persona_mutation` | `src/core/identity/prompt-tools.ts` |
| `trust_mutation` | `src/core/contacts/tools.ts` |
| `tool_egress` (trifecta) | `src/core/agent/substrate-agent.ts` (`assessEgressTrifecta`) |

Structural rules (never configurable):

- **Quarantined content is invisible to all sinks** — any envelope whose
  state is not sink-consumable is denied everywhere.
- **Inform vs instruct**: tier-N content may *inform* but never *instruct*
  higher-tier state mutation. The per-sink `maxSourceRiskTier` cap encodes
  it — the seed lets `hostile` content inform the prompt, caps `skill_write`
  at `untrusted`, and caps `persona_mutation` and `trust_mutation` at
  `standard`. Managed skill text is re-screened at strict scope and evaluated
  together with every active-turn envelope, so one held/denied influence
  vetoes the write in `boundary` or `strict`.
- **Lethal trifecta** (Willison): untrusted content + private data + egress
  never meet in one uncontrolled path. `evaluateEgressTrifecta` applies
  per-tier strength from `sinkGates.trifecta.enforcementByTier`: `hard`
  denies the egress outright (seed: `untrusted`, `hostile`); `soft` allows
  it but flags the invocation for operator review (seed: `trusted`,
  `standard`) — never a silent pass. Egress-capable tools are identified by
  capability token (`INTAKE_EGRESS_CAPABILITY_TOKENS`). A `hard` deny blocks
  **in every global mode** (hrmrq.77): shadow mode is observe-only for everything
  else, but in shadow the untrusted content was delivered — never withheld —
  so the trifecta is fully armed exactly when observe-only would wave it
  through; per-tier `hard` enforcement therefore overrides the global shadow
  mode for this one class, and the audited reason records the override.

Content reaching a gated sink **without** an envelope (legacy paths that
predate stamping) resolves per the sink's explicit `unscreened` policy
default. There is no implicit default, and the owner-file validator requires
every sink to map one. The full per-sink posture decision, its justifications,
and the current mutation wiring are in
[Per-sink `unscreened` posture (qg13)](#per-sink-unscreened-posture-qg13)
below.

Mode semantics follow the centralized vector matrix. `shadow` evaluates and
audits every gate but otherwise allows, with the hard lethal-trifecta exception
above. `boundary` enforces external influences and outbound publication while
structurally authenticated internal activity uses the clean bubble. `strict`
enforces every declared vector. Both enforcing global modes project to the
internal binary `enforce` posture used by sink-gate decisions and audit rows.

### Tool-result screening and the quarantined-artifact read gate (hrmrq.54)

Three seams close the S11 shakedown containment bypass, where quarantine held a
document but its raw bytes were one `fs.read` of the disclosed path away:

- **Scheduler seam** (`src/core/agent/tool-call-scheduler.ts`,
  `toolResultScreener` wired in `src/core/agent/substrate-agent.ts`): every
  executed tool result — including error text — is screened as
  `sourceClass: 'tool_output'` **before** the result message enters the turn,
  not only on the persistence copy. Quarantine under `boundary` or `strict`
  substitutes the fixed withheld notice (non-text blocks are dropped with it,
  fail closed), sanitize substitutes the sanitized text, and shadow observes.
  The outcome is stashed on the result message and reused by session recording
  (`precomputedToolIntakeScreening`), so one screen produces one envelope and
  one hold. A screener failure fails the result closed.
- **Filesystem seam** (`src/core/cogsec/intake/quarantined-artifact-guard.ts`,
  consulted by `fs.read` and `fs.search` in
  `src/boundary/gateway/methods/fs.ts`): quarantine holds register the held
  item's on-disk artifact paths (`artifactPaths` on the store entry); a read
  of a registered artifact whose envelope is not sink-consumable returns the
  fixed withheld notice instead of content under `boundary` or `strict`
  (search drops its matches/previews), and **every** such attempt is
  recorded on the quarantine entry (`accessAttempts`, surfaced as
  `contentAccessAttempts` in the Garden queue view), so a bypass attempt is
  never invisible to the operator reviewing the case. Operator release
  (`human_released*`) clears the gate; discard/expire keep blocking.
  Registration realpaths existing files, so a symlinked-prefix hold cannot
  miss canonical reads, and artifact paths thread through the L2/L3
  escalation chain (`IntakeEscalationRequest.artifactPaths` →
  `applyL3ScreeningOutcome`) so items flagged only by the heavy screeners
  register their artifacts exactly like L1 quarantines. Terminal quarantine
  entries whose registered artifacts still exist on disk are exempt from the
  history-retention cap — pruning one would leave its bytes readable with no
  gate and no audit.
- **Shell seam** (`src/boundary/gateway/methods/shell.ts`,
  `src/boundary/sandbox/execution/shell-execution-policy.ts` +
  `bubblewrap-runner.ts`): the same bytes were reachable through the sandbox,
  which bind-mounts the whole Personal Workspace. Two layers, both fail
  closed: the `shell.exec` descriptor consults the guard for the resolved cwd
  and every argv-derived path candidate (via `gateway:shell.exec`; a withheld
  verdict returns the fixed notice as a failed exec, records the attempt, and
  never launches the sandbox), and, under `boundary` or `strict`, every
  registered artifact of a not-released entry is masked inside the sandbox
  with a read-only `/dev/null` bind (`shadowReadPaths`), so
  `cat`/`cp`/pipes/globs and every argv shape the descriptor cannot parse
  physically read empty. An
  unenumerable deny set fails the exec instead of launching open; shadow mode
  audits without withholding and mounts nothing.

<!-- BEGIN qg13: per-sink unscreened posture (owned by qg13; keep self-contained) -->
### Per-sink `unscreened` posture (qg13)

The `unscreened` default decides what happens when content reaches a gated
sink **with no covering envelope** (`envelopes: []`). It only bites in
`boundary` or `strict`; `shadow` allows unless the hard lethal-trifecta rule
applies. The audit set the posture
per sink with a fail-closed bias: a sink stays `allow` only with a stated
justification.

| Sink | Old | New | Justification |
| --- | --- | --- | --- |
| `skill_write` | `deny` | `deny` (unchanged) | Durable, prompt-bearing, self-authored: managed skill text becomes part of the model's own instruction surface. Already canonical; now schema-forced. Its call site (`screenSkillWrite`) already screens the proposed content + attaches active-turn envelopes, so legitimate writes carry an envelope and pass; `deny` bites only when screening is unavailable. |
| `persona_mutation` | `allow` | **`deny`** | Durable, prompt-bearing, self-authored: identity/persona layers *are* the prompt. Parity with `skill_write`; schema-forced. The companion-owned `identity update_persona` action is screened and audited but keeps its structural/confirmation authority. |
| `wiki_write` | `allow` | **`deny`** | Durable, prompt-bearing, self-authored: wiki knowledge is retrievable back into context. Parity with `skill_write`; schema-forced. |
| `trust_mutation` | `allow` | **`deny`** | Security-sensitive: trust drives a contact's effective source-risk tier, which drives screening leniency. Fail closed by default. It is operator-tunable because it is not prompt-bearing. |
| `prompt_assembly` | `allow` | `allow` (justified) | The inform boundary (`maxSourceRiskTier: hostile` — all tiers may inform). Unenveloped content here is trusted-origin system/operator/character context that has no intake envelope by nature; external content already arrives enveloped and tier/label-gated. Denying unscreened would break core turn assembly on every turn without external content. |
| `memory_write` | `allow` | `allow` (justified) | Fed by external-derived facts (enveloped + quarantine-label-gated) **and** self-authored reflection/heartbeat memory (no external envelope, legitimate, high-volume). Denying unscreened would block the companion's own memory formation; slow self-poisoning is covered by the drift lanes (htm9.14/.15), not by blocking unenveloped writes. |
| `tool_egress` | `allow` | `allow` (justified) | The egress control here is the **trifecta assessment** (`assessEgressTrifecta`), a separate mechanism, not the `unscreened` default. Unenveloped tool calls are the norm; `denyRiskLabels` (`exfil/canary_leak`) gate enveloped content. Denying unscreened would block all tool egress. |

Schema invariant: `skill_write`, `persona_mutation`, and `wiki_write` are the
durable prompt-bearing self-authored sinks
(`INTAKE_UNSCREENED_DENY_REQUIRED_SINKS` in `intake-policy-config.ts`); the
owner-file validator **rejects** any value other than `deny` for them (no
operator override). `trust_mutation` defaults to `deny` in the seed but stays
operator-tunable.

**Current self-authored mutation wiring.** `screenSelfAuthoredMutation` screens
every model-authored string in persona, wiki, and trust mutations, combines the
resulting envelopes with active-turn provenance, then invokes the canonical
sink gate. A partially wired runtime, a missing screening service, or a
mutation with no textual content refuses before gate evaluation. Wiki and trust
consume the screened effective values and honor the gate verdict. The
companion-owned `identity update_persona` action is deliberately audit-only:
CogSec records its proposed text, but the existing structural and confirmation
path remains the authority over persona changes. Other identity mutations keep
normal sink enforcement.

Garden is the operator surface for inspecting the effective owner policy,
quarantine records, CogSec events, and review actions. The operator supplies
the authority for release, discard, source-list changes, and remediation.
Garden is the interface, not a second policy owner. Deployment-specific checks
and effective owner fingerprints belong in the private operations authority,
not this public source guide.
<!-- END qg13 -->


### Capability tiers vs. the intake firewall (an52.1)

The intake firewall and the capability-tier system are **orthogonal** and guard
different directions of flow. The tier system (`src/system/capabilities/`) gates
what a companion may *do* — egress and state mutation — by granting tokens per
tier (`nursery`/`apprentice`/`autonomous`). The firewall gates what untrusted
*inbound* content may *reach*, regardless of tier.

This is why `web` and `web_fetch` are deliberately `NO_CAPABILITY_REQUIREMENT`
(`src/system/capabilities/requirements.ts`) and callable even at `nursery`. A web
read is ingress: every web return is wrapped in a taint-tracked intake envelope
and screened before it can reach any sink
(`src/boundary/gateway/methods/web.ts:695-742`; web return paths at `:793`,
`:846`, `:1050`). That screening runs in the gateway process and never consults
the capability tier — a nursery companion's fetch is firewalled identically to an
autonomous one. Web content is labelled `untrusted`, which triggers `hard`
(deny) trifecta enforcement at egress sinks. Gating web behind a tier token would
add no protection the firewall does not already provide, and would falsely imply
the tier is the control for untrusted-content risk.

The tier *does* gate the egress side, which is where the trifecta bites:
operator notification (`external.web`), Discord/email (`external.discord`/
`external.email`), git writes, REPL, and world control are all egress-capable
tokens (`INTAKE_EGRESS_CAPABILITY_TOKENS`) and are withheld from lower tiers. The
deliberate asymmetry — web reads ungated, egress gated — is recorded in
`sink-gates.ts` ("web fetch is ingress and deliberately absent" from the egress
token set).

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
read time when the vector posture enforces (`intake-sink-gating.ts`);
persisted content is never modified.

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
the cap). Entries also carry the held item's on-disk `artifactPaths`
(registered at hold time; consulted by the quarantined-artifact read gate,
hrmrq.54) and a bounded `accessAttempts` audit of reads attempted while the
item was not released — shown in the queue view as `contentAccessAttempts`.

The Garden **Cognitive Security → Approvals** page
(`admin-ui/src/routes/cognitive-security/approvals/+page.svelte`) resolves held
items through
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

**Honest re-delivery on release (jvbt).** A release updates envelope/store
state, the flywheel, and the audit trail, and then re-delivers the set-aside
content back into the conversation it was withheld from — a false-positive
hold is no longer silently dropped. The delivery is a `role: 'system'`
firewall note on the item's source channel: the fixed, operator-reviewed
`releasedContent` intro (in `intake-firewall-notice-templates.ts`, so all
companion-facing firewall wording stays in one place) leads, an explicit
provenance line names the source class, origin, reviewer, and time, and the
verbatim raw text (or the safe representation, for `release_sanitized`)
follows. Because the intro carries the firewall-notice signature phrase, the
whole delivery is excluded from emotion appraisal and memory candidacy — the
companion can read it, but it never drives appraisal or becomes a durable
memory as if it were fresh trusted partner input. The released envelope rides
the entry's `intakeScreening` metadata in its terminal `human_released*`
state: sink-consumable, but with its original untrusted source risk tier
intact, so every consequential sink still gates it (its provenance survives —
it is never laundered as trusted). If no source channel was recorded on the
held item, the release still applies and the undeliverable outcome is recorded
in the decision result and CogSec event rather than silently swallowed. The
`discard` action delivers nothing. Wiring:
`redeliverReleased` in `src/operator/garden/local-admin-contract.ts` →
`SessionManager.recordSystemMessage`.

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
`src/core/scheduler/post-turn-runtime/scheduler-lanes.ts`) scores
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
(rumination is self-generated; a topic the Partner raises daily arrives as
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

<!-- BEGIN d269: reverse-RPC reply canary scan (owned by d269; keep self-contained) -->
### Reverse-RPC reply canary scan (d269)

The former structural gap — request-path-only scanning, leaving the main
conversational reply returning over the gateway's reverse-RPC seam
unscanned — is closed. The design mirrors the request path exactly, in the
opposite direction:

- **Agent side.** Reply-bearing reverse handlers (`voice.handleMessage`,
  `voice.transcript.end`/`voice.stream.end` — which funnels through the same
  dispatch — `api.chat.completion`, and `api.companion-ui.shard.action`) run
  inside an AsyncLocalStorage *reply capture*
  (`src/core/cogsec/canary/reply-canary.ts`, wired in
  `src/boundary/gateway/client.ts`). Turn execution records the session
  canary into the ambient capture at the moment it plants the prompt marker
  (`turn-execution-runtime.ts`), and the resolved result gets the token
  attached under the reserved `__cogsecCanary` carrier key. Streamed reply
  frames (`api.stream.delta`, which bypass the JSON-RPC client send wrapper)
  attach the carrier explicitly per frame. The canonical CogSec mode is always
  armed, so turns in `shadow`, `boundary`, and `strict` all mint a token.
- **Gateway side.** `CanaryEgressGuard.inspectReply` strips the carrier and
  scans the remaining reply strings at every seam chokepoint before anything
  reaches a channel adapter: `GatewayServer.requestAgent`,
  `requestCompanionAgent`, the shared-satellite `api.chat.completion` path,
  and both voice paths (`voice-stream-request.ts` applies the hook to the RAW
  `voice.transcript.end` / `voice.handleMessage` result, before its field
  pick could drop the carrier — this covers Telegram text, API/Wyoming voice,
  and satellite voice). `inspectApiStreamDelta` scans each streamed frame
  over a rolling per-request tail window of `token.length - 1` chars, so a
  token split across frame boundaries is caught on the frame that completes
  it. The carrier is stripped defensively in every global mode.

**Recorded tradeoff decision: inline block, not post-send alert.** In
`boundary` or `strict`, a canary hit HOLDS the reply — the reverse-RPC result
throws the same `EGRESS_HELD` error as the request path (the channel surfaces
its standard failure behavior), and a hit on a streamed frame closes the
stream tap for the rest of that request. Rationale: (1) a canary token is
`cnry_` + 16 base32 chars of 80-bit process-local randomness that the model
is explicitly never told to emit — a substring match in a reply is
practically always a real prompt-material leak, so the false-positive cost
of blocking is negligible; (2) the scan is one `String.includes` pass over
strings already in hand — no added RPC round-trips and effectively zero
per-turn latency; (3) a post-send alert cannot un-send an exfiltrated
token, and the repo doctrine for security paths is fail-closed. `shadow`
mode records the CogSec event and lets the reply through. Fail-closed
extends to scanner failure: a scan bound exceeded or scanner error on a
carried-token reply is treated as a leak (held in `boundary`/`strict`, recorded in
`shadow`). Residual accepted risk: with streaming, a *partial* token prefix
in an earlier frame may egress before the completing fragment is blocked
(the fragment alone has no replay value), and per-request stream scan state
is bounded (512 entries, FIFO eviction) so a hostile flood degrades only
split-frame detection, never whole-frame detection or the final
whole-result scan. Every hit writes the standard `prompt_injection`
CogSecEvent (sha256 digest only) plus a DENY audit row; held replies never
enter emotion appraisal or memory candidacy because nothing is delivered.
<!-- END d269 -->

Agent-initiated sends (messages, web, notifications) were already covered
by the request-path guard above.

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
  kept aside for the Operator to look over whenever they have a moment. It is
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
the verbatim phrase `being kept aside for the Operator to look over`
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
withheld-content placeholder (a page, document, or tool result quarantined
under `boundary` or `strict`), the withheld-image variant (vision screening),
sink-held notices in the contacts/wiki/identity tools, and the optional
second-arrow self-notice. Notices are delivered through the existing
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

## Persona Conformance During Remediation

Persona conformance is a companion-specific anomaly and drift check applied to
the prompt-visible context left after CogSec remediation. Its mutable baseline
lives under `settings.json` `cogSecPersonaConformance`, not in source code. An
enabled baseline supplies stable identity text, expected voice/value/refusal/
relationship anchors, and anomaly patterns. The runtime compares pattern
counts in the candidate context with that companion's own stable baseline, so a
term is notable only when it represents configured drift.

This check is ontology-neutral. Words such as “AI,” “assistant,” “language
model,” or a provider name are not forbidden concepts. A companion may use or
self-apply them when that usage is consistent with its configured baseline.
The check looks for a change from the companion-specific register; it does not
decide what a companion is, censor model knowledge, or replace operator
interpretation.

Configuration behavior is explicit and fail-closed:

- `{ "enabled": false }` records a `warning` with reason
  `conformance_explicitly_disabled`; it does not manufacture a passing
  conformance result.
- An absent `cogSecPersonaConformance` setting refuses Garden remediation
  before it mutates the selected session or creates a CogSec event.
- When enabled, missing/empty baseline text or anchor/pattern arrays, invalid
  patterns, unknown keys, and patterns that match empty text fail settings
  normalization. Runtime checks also throw if required configured anchors are
  unavailable.
- Missing expected anchors are warnings. Pattern drift, unauthorized persona
  mutation drift, or visible sealed material are failures requiring operator
  review before the case can be considered clean.

Garden presents the remediation record and conformance reasons to the operator.
The operator interprets the evidence and owns the remediation decision; Garden
does not infer persona truth from generic ontology terms.

## `intake-policy.json` Reference

Owner file: `src/system/config/intake-policy-config.ts`; seed:
`config/intake-policy.seed.json`; registered in
`src/system/config/startup-owner-files.ts` (startup step `intake-policy`)
and the settings contract (`intakePolicy` subsystem). Validation is strict
fail-closed: unknown keys anywhere reject the file, every per-tier and
per-sink record must be fully mapped (no implicit defaults), and
contradictory source lists (same pattern trusted and denied) refuse to load.
Defaults below are the seed values.

Screener model identity is deliberately absent from this owner file. L2 uses
the standard `background` purpose; single-verdict L3 uses the `reasoning`
chain followed by distinct `background` fallbacks; dual L3 uses one model from
each purpose; and vision uses `vision`. Existing owners carrying the retired
`l2Screener.model`, `l3Screener.model`,
`l3Screener.secondaryModel`, or `visionScreener.model` keys fail startup with
an actionable remedy. Dry-run and apply the atomic cleanup with
`npm run migrate:intake-policy-owner -- --data-dir <system-data-dir>` and
the same command plus `--apply`, or delete the keys manually; configure the
normal `models.json`/`modelPurposeSelection` lanes instead. Runtime never
silently ignores or aliases the retired keys.

### Top level

| Knob | Seed default | What it does |
| --- | --- | --- |
| `schemaVersion` | `5` | Must be 5. Schema 1/2/3/4 owners require the explicit `migrate:intake-policy-owner` command. |
| `mode` | `"shadow"` | `shadow` screens and audits without changing delivery, apart from hard lethal-trifecta denial. `boundary` enforces external ingress and outbound publication while structurally authenticated internal activity uses the clean bubble. `strict` screens and enforces all declared vectors. |
| `sourceRiskTiers` | see below | Risk tier per source class; every class required. |
| `sourceLists` | all four empty | Operator-curated trusted/denied sites and people (flywheel target). |
| `urlScanner.schemeActions` | `javascript`: deny; `data`: deny except inline images; `mailto`/`tel`: allow | Per-scheme URL-scanner treatment. Missing or invalid actions fail owner-file validation; unlisted schemes stay silent to avoid false positives in ordinary conversation. |

Seed `sourceRiskTiers`: `operator`/`companion_self`/`primary_user` → `trusted`;
`trusted_contact`/`regular_contact`/`audio_transcript`/`shard_foldback` →
`standard`; `public_contact`/`web_fetch`/`web_search`/`document`/
`tool_output`/`subagent_output` → `untrusted`; `image_ocr`/
`mcp_tool_description` → `hostile`.

### `quarantine`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `itemTtlHours` | `168` | Hours before a held item auto-transitions to `expired`. Expired rows remain visible in the Garden queue's bounded terminal history, and each durable TTL transition emits an operator alert event. |
| `maxHeldItems` | `500` | Queue cap; oldest items expire early past it. |

### `injectionClassifier` (L1.5)

| Knob | Seed default | What it does |
| --- | --- | --- |
| `labelThreshold` | `0.5` | P(injection) at/above which the classifier attaches its `injection/override_attempt` label. |
| `scoreThresholdsByTier` | trusted `0.98`, standard `0.9`, untrusted `0.75`, hostile `0.6` | Per-tier score threshold for the score to count as a screening signal (riskier tiers are more sensitive). The score never hard-blocks alone. |

### `l2Screener`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `escalationThresholdsByTier` | trusted `0.95`, standard `0.85`, untrusted `0.6`, hostile `0.5` | Prior (max L1/L1.5) score at/above which an item escalates to L2. |
| `mandatoryTiers` | `["untrusted", "hostile"]` | Tiers that always reach the tool-less semantic L2 classifier regardless of their L1/L1.5 score. Trusted/standard content retains the threshold-gated fast path. |
| `failClosedActionByTier` | trusted/standard `l1_labels_only`, untrusted/hostile `quarantine` | Action when the L2 call errors/times out. No silent-pass option exists. |
| `timeoutMs` | `8000` | Per-call timeout. |
| `maxContentChars` | `24000` | Input cap sent to the screener. |

### `l3Screener`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `dualModel` | `false` | When true, the standard `reasoning` and `background` purpose models each produce a verdict; startup requires them to resolve to different models, and the aggregate flags if either flags. |
| `escalationConfidenceThresholdsByTier` | trusted `0.9`, standard `0.8`, untrusted `0.7`, hostile `0.6` | L2 injection confidence at/above which an item escalates to L3 even without a flagged label. |
| `mandatoryTiers` | `["hostile"]` | Tiers that always escalate to L3 regardless of the L2 verdict. |
| `timeoutMs` | `30000` | Per-model-call timeout. |
| `maxContentChars` | `48000` | Input cap. |
| `maxOutputTokens` | `1200` | Output cap per verdict. |

There is deliberately no L3 fail-closed knob: anything that reached L3 is
already suspect, so an L3 failure always holds the item in `boundary` or `strict`.

### `visionScreener`

| Knob | Seed default | What it does |
| --- | --- | --- |
| `enabled` | `true` | `false` restores pre-htm9.8 behavior (images bypass VLM screening). When true, `boundary` and `strict` fail closed: an unreachable vision model means the image is withheld. |
| `timeoutMs` | `20000` | Per-call timeout. |
| `maxOutputTokens` | `1600` | Output cap for the OCR+description verdict. |

### `sinkGates`

`benignClasses` is the operator-visible allowlist for narrowly proven internal
result classes. It is intentionally not a text or regular-expression
allowlist: runtime code must first establish the trusted tool identity and an
exact structured-result contract. Omitting `benignClasses` (including in an
otherwise valid schema-v5 owner) enables no exemptions.

| Class | Seed suppression | Runtime proof required |
| --- | --- | --- |
| `beads_database_create` | Rule `persona_mutation_request`, label `persona/mutation_attempt` only | Native `beads` tool, `create`/`issue_create` request with a non-empty title, and the canonical pretty-printed successful `create` result containing one created issue object whose title exactly matches the request (and whose actor matches when requested). Unknown wrapper/payload keys, malformed fields, mismatches, or alternate formatting remain fully screened. |
| `beads_database_ready` | Rule `persona_mutation_request`, label `persona/mutation_attempt` only | Native `beads` tool, `ready`/`issue_ready` request (including its default action), and the canonical pretty-printed successful `ready` result containing no more issues than the requested limit. The control scan neutralizes only the closed set of issue prose fields; persona text in labels, metadata, dependencies, or wrapper fields remains enforced. Unknown keys, malformed fields, actor mismatches, or alternate formatting remain fully screened. |
| `beads_database_show` | Rule `persona_mutation_request`, label `persona/mutation_attempt` only | Native `beads` tool, `show`/`issue_show` request (including its ID-only default action), and the canonical pretty-printed successful `show` result containing exactly one issue whose ID matches both the request and result target. The control scan neutralizes only the same closed issue-prose fields as `ready`, plus a closed issue's `close_reason`; all other fields and findings remain enforced. Unknown keys, plural/malformed results, actor or ID mismatches, or alternate formatting remain fully screened. |

The validator rejects unknown classes and prevents a known class from naming
any rule or risk label outside its code-reviewed ceiling. Even for an enabled
class, every other finding remains enforceable; for example, injection and
novel persona-hijack rules in the same result still quarantine. The runtime
also re-scans a control result with only the class-owned database fields
neutralized; if the same persona rule still appears anywhere else in an
approved payload field, it is not suppressed. Suppressions
are recorded on the envelope as `l1.rules.benignClass`,
`l1.rules.suppressedRuleIds`, and `l1.rules.suppressedRiskLabels`. Operators can
inspect or edit the canonical `intake-policy.json` owner through the Garden
settings surface.

Per sink (`sinks.<sink>`), all seven sinks required:

| Knob | What it does |
| --- | --- |
| `maxSourceRiskTier` | Highest tier whose content may drive this sink (the inform-vs-instruct cap). |
| `denyRiskLabels` | Screening findings refused at this sink even for released content. |
| `unscreened` | Action (`allow`/`deny`) for content reaching the sink without an envelope when its vector posture enforces. Explicit; no implicit fail-open. |

Seed values: `prompt_assembly`, `memory_write`, `wiki_write`, and
`tool_egress` cap at `hostile` (inform sinks); `skill_write` caps at
`untrusted`; `persona_mutation` and `trust_mutation` cap at `standard`.
`memory_write`/`wiki_write` deny the quarantine-family label list;
`skill_write` denies injection, exfiltration, secret, executable,
persona/policy-mutation, and poisoning labels; `persona_mutation`/
`trust_mutation` deny their mutation list plus `injection/invisible_text`;
`tool_egress` denies `exfil/canary_leak`; `prompt_assembly` denies none
(state-machine rules already hide quarantined content). Unscreened posture:
`skill_write`, `persona_mutation`, `wiki_write`, and `trust_mutation` map
`deny`; `prompt_assembly`, `memory_write`, and `tool_egress` stay `allow` —
see [Per-sink `unscreened` posture (qg13)](#per-sink-unscreened-posture-qg13)
for the full decision table and current wiring. The validator
schema-forces `deny` for `skill_write`/`persona_mutation`/`wiki_write`.

| Knob | Seed default | What it does |
| --- | --- | --- |
| `trifecta.enforcementByTier` | trusted/standard `soft`, untrusted/hostile `hard` | Lethal-trifecta strength per source tier of the untrusted content in the egress path: `hard` denies, `soft` allows + flags for operator review. |

### `screeningPool`

The gateway composes one bounded screening pool. Work from one companion stays
serial to preserve decision and delivery order, while independent companion
streams may overlap within the fleet-wide bound. Admission backpressures once
the queue is full, and the item deadline covers queue wait plus screening.
Expiry fails the item closed.

| Knob | Seed default | Valid range |
| --- | --- | --- |
| `concurrency` | `3` | `2`–`4` workers |
| `maxQueueDepth` | `64` | `1`–`1024` admitted items waiting to run |
| `itemDeadlineMs` | `60000` | `5000`–`300000` ms |

The validation bounds are owned by
`src/system/config/intake-screening-pool-contract.json`; values outside them
refuse owner-file loading.

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

[`docs/operations.md`](./operations.md) defines the public runtime and
configuration boundary. Target selection, rollout commands, effective owner
fingerprints, and incident procedures belong in the private operations
authority for the installation.

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
  npm test -- src/boundary/gateway/intake/injection-classifier.test.ts
```

### Shadow to enforcement rollout

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
   lists and the provenance-bound `benignClasses` allowlist under `sinkGates`,
   and seed the `sourceLists` with the sites and
   people you already trust or deny (or let the release flywheel populate
   them as you review).
4. Choose the intended enforcement boundary. `boundary` enforces external
   ingress and outbound publication while preserving the structurally
   authenticated internal clean bubble. `strict` also semantically screens and
   enforces internal vectors. Change `mode` through the installation's audited
   owner-file path and restart. Sanitize decisions then substitute sanitized
   text, quarantine decisions substitute the fixed withheld notice, applicable
   sink-gate denials block, and vision-screening failures withhold images.
5. Watch the quarantine queue cadence. Reviews are async and batched by
   design — items keep for `itemTtlHours`; nothing needs an interrupt-driven
   response.

### Reviewing quarantine

Approvals page, per item: source class/tier, risk labels, scores, the
envelope journal, the raw text, and the L3 safe representation when one
exists. Rule-driven L1 holds also show each durable owner-file rule ID,
match kind, UTF-16 offsets into the capped security-normalized scan text,
and a single-line secret-redacted excerpt capped at 160 UTF-16 units without
splitting an astral code point. Older
held items without this optional provenance remain reviewable. When more than
32 rules match, the queue states the total and that only the bounded prefix is
shown. Malformed optional provenance is isolated from its held item at both
the durable-store and Garden-cache boundaries: no evidence bytes are trusted,
the rest of the queue remains visible, and that item stays release-locked with
discard available. Decide
with two clicks (confirm, then decide with a reason) —
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

- **Pixel-perturbation and steganographic image attacks have no deployable
  detector** — nothing in the field ships one. The mitigation is
  containment, not detection: `image_ocr` provenance stays hostile-tier
  regardless of transcript content, so image-derived text can never drive
  persona/trust mutation and always faces mandatory-tier screening policy.
- **The canary egress scan now covers the main conversational reply (d269).**
  The reverse-RPC result/stream seam (`requestAgent`, companion/satellite
  chat, both voice paths, `api.stream.delta` frames) is scanned by the reply
  guard — inline block in `boundary`/`strict`, record-and-allow in `shadow`; see
  [Reverse-RPC reply canary scan (d269)](#reverse-rpc-reply-canary-scan-d269).
  Residual: a partial token prefix in an already-forwarded stream frame may
  egress before the completing fragment is blocked, and bounded stream-scan
  state (512 requests, FIFO) can degrade split-frame detection under a
  hostile flood of concurrent streams.
- **Released-content re-delivery is wired (jvbt).** An operator release now
  updates the envelope state machine, the audit trail, and the flywheel AND
  re-delivers the set-aside content into the conversation it was withheld from
  as a provenance-marked `role: 'system'` firewall note (see "Honest
  re-delivery on release" above). Residual: delivery targets the item's
  recorded source channel; an item held with no source channel cannot be
  routed and reports an undeliverable outcome (the release still applies), so
  such items still need out-of-band relay.
- **Self-authored mutation screening has an intentional persona exception.**
  Wiki and trust mutations consume screened effective values and honor sink
  denials. The companion-owned `identity update_persona` action is screened and
  audited, but CogSec does not independently replace or block the proposed
  persona text; its structural and confirmation path remains authoritative.
  Other identity mutation actions retain normal sink enforcement. See
  [Per-sink `unscreened` posture (qg13)](#per-sink-unscreened-posture-qg13).
- **L1 is fail-open-advisory by design.** A scanner exception is recorded
  and visible but does not hold the item; the structural guarantees live in
  the envelope states and sink gates, not in L1.
- **Plain conversational text from known contacts is screened by the
  session-recording path, not held pre-delivery** — quarantine primarily
  protects the machine-carried surfaces (web, documents, images, tool
  output). Social manipulation by a trusted human remains a human problem
  the drift lanes can only surface, not block.
