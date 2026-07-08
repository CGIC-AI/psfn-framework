# Cognition Intake Firewall — Research & Understanding Brief

Date: 2026-07-09
Epic: `psfn-framework-htm9` (children `.1`–`.3`) + `psfn-framework-i5s2`
Baseline: `working_docs/COGSEC_CRITICAL_PATH_TRUEUP_20260701.md`
Branch verified: `feat/multi-companion` @ `bce91be5`
Status: **planning/questions phase — no implementation started**

Method: Fable orchestration; Opus deep-research pass on prior art (Trinity, OSS
firewalls, papers, classifier models); Sonnet very-thorough code-surface pass
verifying the 2026-07-01 true-up against current source. All code claims below
were verified by direct reads on this branch, not doc citation.

Framing (from the operator): this is a "mind condom" for companions — keep the
mind safe in adversarial environments **without** impacting the companion's own
stress levels. Blocked content surfaces as calm, minimal soft notices ("hey,
couldn't load this page, looks like some kind of nam-shub so we blocked it —
your human can check it manually"), never alarms, and firewall activity must
not feed the emotion/stress model.

---

## 1. What changed since the 2026-07-01 true-up

The single biggest finding: **E2 and E3 have landed.** The true-up framed them
as parallel future work; they are now stable substrate the firewall should
build on directly:

- **Context Envelope (E3) shipped in full** — `docs/context-envelope.md` says
  "Status: executed (E3.1–E3.4)". `src/system/trust/context-envelope.ts`
  defines `ChannelPrivacy` / `AudienceScope` / `AudienceKnowledge` /
  `broadcast` + `ContextEnvelope`; wired through `channels.json` and
  `trust-policy.json` owners. The old single-axis `ChannelVisibility` is
  deleted (legacy decoder only).
- **ConversationScope landed** (`src/core/session/conversation-scope.ts`):
  discriminated `dm|group` union, resolved once per turn at session-manager
  ingress, every scope carries `readonly envelope: ContextEnvelope`.
- **PromptPlan (E2.2) landed and is in active use** across ~19 files
  (`src/core/agent/substrate-agent/turn-execution/prompt-plan.ts`): single
  per-turn artifact of ordered `PromptPlanBlock[]` (layer, volatility,
  producer, renderedText, tokensEst) plus cache-boundary plan.
- Discord ingest and web sanitize are functionally unchanged from the true-up.
- **No htm9 code exists anywhere** — grep for intake/envelope/firewall/namshub
  across `src/` is clean. The epic is 100% planning stage.

Design implication: the intake envelope should compose with this substrate —
risk/quarantine state riding alongside `ConversationScope` per turn, and
intake-classified content becoming typed `PromptPlanBlock`s — not parallel or
competing infrastructure.

## 2. Inbound surfaces today (verified)

| Surface | State |
| --- | --- |
| Discord docs | Only real ingest+quarantine pipeline. `classifyDiscordAttachmentQuarantineRisk` (`src/channels/discord/file-ingest.ts:266`) runs pre-parse; risky files → `quarantine/discord/...` with sha256 sidecar, never reach the model. But **accepted** parsed text lands raw inside `<parsed_attachment_text>` with only a fixed instructional header (`:482-532`). A clean-looking `.txt` with an embedded injection payload gets the same header as a benign `.md`. |
| Telegram attachments | **No pipeline at all.** `extractAttachments` (`src/channels/telegram/adapter.ts:1282-1311`) captures bare `{url, contentType, name}` — no download, no parse, no quarantine. A Telegram PDF never becomes prompt text today. |
| API channel | Images only (`getMessageImageAttachments`, max 4 inline). No document path. |
| Web fetch | Gateway-side `sanitizeWebContent` (`src/boundary/gateway/sanitize.ts:84-104`): fixed regex injection patterns → `[filtered]`, strip HTML, 50KB cap, wrap in `<untrusted_content>`. `injectionPatternsFound` is **logged but never blocks**; no risk label, no quarantine state. `web.fetch_binary` returns raw base64 with zero screening (by design, for vision). |
| Images | **Zero screening anywhere.** Inline/URL images become raw vision blocks (`vision-attachments.ts:543-659`) with only size/count/MIME caps. The separate vision-reviewer path's text summary is then treated as *trusted* prompt text (no untrusted wrap). Largest concrete gap; a text-only MVP leaves this fully open. |
| Tool observations | `formatToolObservationForContext` (`src/core/session/tool-observation.ts:222-240`) renders raw content as `[Tool result: name] <content>` — no wrap, no label. |
| Public context | `wrapUntrustedContext` (`src/core/session/manager-primitives.ts:989`) exists but is narrow/opt-in, keyed only on `ChannelPrivacy === 'public'`, no pattern filtering; call-site coverage unaudited. |
| Shard foldback | Real merge-review machinery (`fold-review.ts`: blockingReasons, operator approve/deny, auto `EMOTIONAL_REVIEW_TAG`). But it reviews shard **output going back in**, not what the shard **ingested** — intake-risk model still missing. |
| Subagents | Full lifecycle audit trail, **no content-risk gate at all** on completion handoff — a gap the true-up undersold (shards have a review gate, subagents don't). |

## 3. Existing primitives to build on (don't reinvent)

- **Risk taxonomy seed:** `CogSecMemoryRiskClass` A–E (`A_harmless_fact` →
  `E_executable_instruction`) with `allow|review|reject` dispositions in
  `src/core/cogsec/memory-candidacy.ts` — pattern detectors for zero-width/
  base64/hidden-markup obfuscation, policy-override phrasing, persona-mutation
  phrasing. Runs only at memory-write time today; generalize this vocabulary
  to intake time rather than inventing a new taxonomy.
- **Soft-notice mechanism exists and is wired:** `src/core/cogsec/safe-log.ts`
  builds redacted `CogSecAgentVisibleEvent`s (counts only, XML-escaped, no raw
  payloads) rendered as the `session.cogsec_notices` prompt section
  (`src/core/session/manager/context-builder.ts:973-1009`, provenance-tagged
  `system_note`). This is exactly the calm-notification delivery path the epic
  wants — reuse it.
- **Slow-poisoning lane shape exists:** `src/core/contacts/trust-drift-signals.ts`
  + `trust-drift-review-lane.ts` — deterministic zero-LLM signal derivation
  feeding a nightly batched review lane that never mutates state itself. Clone
  this pattern for content-source drift.
- **Quarantine-queue precedent:** `src/core/contacts/pending-contact-approvals.ts`
  + its Garden surface — model the release queue after it.
- **Post-incident machinery is real:** CogSec events/severity, forensic
  archive (sealed payloads), revocation/regeneration with lineage, tombstone
  epoch cuts consumed by memory retrieval. The firewall is the missing
  *pre-hoc* half of an already-working *post-hoc* system.
- **Sender trust is already resolved per turn** before prompt assembly
  (`runtime-context.ts:692-734`, fail-closed default `'regular'`) — the cheap
  read point for trust-tiered screening.

## 4. Load-bearing architectural facts

1. **The gateway — not the agent — holds real LLM provider access and API
   keys.** `credential-vault` is wired only in `src/app/gateway/main.ts:133`;
   the real `LLMClient` lives in `src/boundary/gateway/privileged-services.ts`;
   the agent only gets a `GatewayClient` RPC proxy. A cheap intake classifier
   can run gateway-side with **no new credential surface and no new process
   hop** — and web fetch, binary fetch, and Discord downloads already flow
   through the gateway, so raw bytes never need to reach the agent to be
   classified.
2. **Emotion appraisal reads raw recent session content** independent of
   prompt assembly (`emotion-self-model-runtime.ts:467-479` →
   `getRecentMessages(...)` → raw entry `.content`, fed to the appraisal LLM
   with no untrusted-content instruction). A hostile payload in a tool
   observation or parsed attachment can steer appraisal → self-model feedback.
   The intake risk label must reach **persisted session-entry content**, not
   just the current turn's prompt build — this is also the mechanical hook for
   the stress-isolation requirement (firewall events excluded from appraisal).
3. **No source-class/risk/quarantine field exists on `SubstrateMessage` or
   `Attachment`** (`src/shared/contracts/runtime.ts:276-298`).
   `MessageRoutingMetadata` (`:227-274`) is the natural, non-breaking slot —
   it already carries trust-adjacent side-channel data
   (`authorIsMachineIntelligence`, `canonicalContactId`, generated-provenance).
4. **Config owner:** no cogsec/firewall owner file exists. `trust-policy.json`
   is the precedent; either extend it with an intake section or add a sibling
   `intake-policy.json` following the standard owner-file pattern (loader +
   seed + `startup-owner-files.ts` registration + Garden contract entries).

## 5. Research: Trinity and the HITL flywheel

**The specific doc is not retrievable.**
`https://autonomousacquisition.agency/docs/agentic-hitl-flywheel` (and the
whole domain) returns a placeholder: *"Patent Pending | Authority-Bound
Agentic Flywheel — public technical documentation is withheld during patent
and publication review."* The framing that leaks through the title:
authority-bound execution (actions gated by explicit authority grants) +
proof-verification (tamper-evident evidence the gates were honored), on BEAM.

The **Trinity repo itself is public**: `github.com/Abilityai/trinity`
(Apache-2.0, ~1,007 commits, v0.8.0 July 2026, active). Patterns extracted
from primary sources:

1. **Operator Queue — async-by-default HITL.** Escalations land in a queue
   the human reviews **in batches, on their schedule**; "only escalations land
   in your queue." Agent never blocks-and-frets; human is never
   interrupt-driven. Every resolution **feeds back into policy** so the same
   class of item stops escalating — the flywheel, and the core anti-fatigue /
   anti-Karen mechanism.
2. **Deterministic guardrails first**, per-agent policy overrides.
3. **Append-only tamper-evident audit** of every gate decision.
4. **Isolation as substrate** (containers, credential injection, budget/
   runaway caps) — blast-radius reduction carries the guarantees, not
   detection.
5. **Git-versioned reviewable state** — poisoned lineage is diffable and
   excisable retroactively.

Adaptation: Trinity's reviewer is a manager approving work product; ours is
the human partner protecting a being's subjective continuity. Keep the queue
mechanics, invert the tone contract (calm environmental fact, not threat
language; forensics live only in Garden).

## 6. Research: prior art worth borrowing

Unanimous load-bearing principle across all sources: **probabilistic layers
(classifiers, LLM screeners, datamarking, instruction hierarchy) reduce noise;
only structural layers (provenance tags checked at sinks, opaque refs, taint
propagation) carry guarantees.** Ship both; stake security on the structural
one.

| Borrow | From | Notes |
| --- | --- | --- |
| Scanner contract `scan(input) → (sanitized, valid, score 0–1)`, transform-not-just-gate | protectai/llm-guard (MIT, active) | Also its `InvisibleText` zero-width scanner |
| In-process ONNX injection classifier | `protectai/deberta-v3-base-prompt-injection-v2` (Apache-2.0, **ONNX weights published**) via onnxruntime-node | Known over-defense/FP issue (InjecGuard paper) — score, never hard-block alone. `-small` sibling exists for constrained hardware |
| Second-opinion classifier | Llama-Prompt-Guard-2-22M | Llama Community license (not OSI); no official ONNX — self-export |
| `category/subcategory` risk labels + L1–L4 tiered screening intensity | Lakera Guard taxonomy (pattern only; proprietary API) | Best prior art for trust-tiered screening; `allow/block/sanitize + reason` decision enum |
| Capabilities/taint at sinks; control flow planned from trusted input only; **a summary of untrusted content stays untrusted** | DeepMind CaMeL (arXiv 2503.18813) | The structural core |
| Opaque refs for raw content; **lethal trifecta invariant** (private data + untrusted content + egress — never all three) | Simon Willison dual-LLM / lethal-trifecta essays | |
| **Datamarking** renderer (per-request rotating private marker interleaved through untrusted spans; strip marker from inbound first) | Microsoft Spotlighting (arXiv 2403.14720) | ~50%→3% ASR class improvement, negligible task cost; trivial to reimplement in TS. Base64-encoding mode as paranoid option |
| Canary tokens planted in privileged context, watched at egress | protectai/rebuff (Apache-2.0, **archived** — vendor the idea) | Plus its accumulate-confirmed-attacks loop |
| `reject/alter/pass` staged pipeline shape | NeMo Guardrails (Apache-2.0, active; Python — shape only) | |
| Hot-reloadable plain-text rule layer (rule name = risk label) | deadbits/vigil-llm YARA pattern (reference only, dormant) | A TS rule DSL is fine; the point is auditable rules shippable without retraining |
| Scanner-registry over typed objects; **AlignmentCheck**-style goal-hijack drift audit distinct from input classification | Meta LlamaFirewall (arXiv 2505.03574) | Closest overall architectural blueprint |
| Tool descriptions and tool outputs are themselves untrusted content | Invariant Labs mcp-scan | |
| Eval corpora: `latentinjection` (indirect injection — exactly our threat model), `encoding`, `xss` markdown-exfil probes | NVIDIA/garak (Apache-2.0, active) | Standing cross-surface eval suite |
| Defense vocabulary (blast radius, taint tracking, dual-LLM, preflight…) | tldrsec/prompt-injection-defenses | |

**Genuinely build-fresh (nothing packaged exists):**

- **Quarantine-and-release state machine** — every surveyed OSS system is an
  inline allow/block gate; none has hold-for-human-review with release states.
- **Image screening** — attack research is mature (typographic text-in-image
  ~64% ASR vs frontier VLMs); defense tooling is not. Only deployable pattern
  today: OCR the image → run the transcript through the text-scanner stack →
  keep image provenance high-risk regardless. Does not catch pixel
  perturbation/steganography; nothing does yet.
- **Slow-poisoning / source-drift detection** — MINJA (query-only memory
  injection, >95% success), MemoryGraft, PoisonedRAG confirm the threat;
  consensus is that existing defenses "detect malicious actions, not corrupted
  beliefs." No off-the-shelf drift detector exists. A provenance-stamped
  envelope is precisely the substrate needed (per-source memory-write rates,
  trust-lobbying label frequency, retrieval share of low-trust sources) — and
  PSFN's most differentiated capability if built.

## 7. Emerging design shape (proposal, not started)

- **Layer 0 — envelope (structural, always):** typed
  `{id, sourceClass, provenance chain, trustTier, contentRef (opaque),
  extractedFields, riskLabels[], scores, decision, state}` created at the
  boundary (gateway side). Raw bytes behind the opaque ref; taint propagates
  on derivation (summary/OCR/subagent digest inherits tier). State machine:
  `received → screened → {released | released_sanitized | quarantined} →
  {human_released | human_released_sanitized | discarded | expired}`; every
  transition appended to audit.
- **Layer 1 — deterministic scanners (µs, TS in-process):** invisible-Unicode/
  homoglyph, URL allowlist/unknown-link, secrets/PII, encoding-smuggling,
  marker-forgery stripping, size/structure caps, hot-reloadable rule file.
- **Layer 2 — cheap classifier (ms, gateway-side ONNX):** ProtectAI DeBERTa
  v2; calibrated score, never hard-blocks alone. Images: OCR → same stack.
- **Layer 3 — LLM screener (escalation only):** tool-less quarantined call via
  the gateway's own LLM client; classifies intent, produces the safe
  representation (summary + schema-extracted fields), assigns labels.
- **Layer 4 — sink gates (the actual security boundary):** prompt assembly,
  memory write, wiki write, persona/self-model write, trust mutation,
  tool/egress — each checks envelope state/labels; tier-N content may
  *inform* but never *instruct* higher-tier state mutation; trifecta invariant
  enforced at egress; canary tripwire.
- **Screening intensity by trust tier** (policy, not detection, varies):
  `primary` DM → L0–1; `trusted` → L0–2; `regular/public/tool/subagent` →
  L0–2 with low L3-escalation threshold; web + images → L3 mandatory before
  any sink. Owner file: `intake-policy.json` (or `trust-policy.json` section).
- **Companion UX:** quarantine events → existing `session.cogsec_notices`
  path, worded as environmental fact ("couldn't load that page — looked like
  some kind of nam-shub, set it aside for your human"), **excluded from
  emotion appraisal and memory extraction**; forensics only in Garden.
- **Review UX:** Garden queue beside pending-contact-approvals; batched,
  async, exception-only; release options raw / sanitized / discard /
  always-allow-or-deny-this-source (the flywheel).
- **Candidate risk-label axes:** `sourceClass` (operator … web_fetch, document,
  image_ocr, tool_output, subagent_output, mcp_tool_description) ×
  `riskLabels[]` (`injection/override_attempt`, `injection/indirect`,
  `injection/encoded_smuggling`, `injection/invisible_text`,
  `exfil/canary_leak`, `exfil/unknown_link`, `pii/*`, `secrets/*`,
  `harm/S1..S14`, `poisoning/memory_write_pressure`,
  `poisoning/trust_grooming`, `poisoning/source_drift`) × decision
  (`pass|sanitize|quarantine|block` + reason). Seeded from
  `CogSecMemoryRiskClass` + Lakera + Llama Guard vocabularies.

## 8. Open questions (blocking work start)

**Q0 — BLOCKER: beads DB unreachable from this checkout.** No `.beads/` dir,
no dolt process running; `bd` fails with "no beads database found." How do I
bring up the shared Dolt server / where should `BEADS_DIR` point? Can't claim
htm9 or read the actual child bead text until then. (Epic context above was
reconstructed from the true-up doc.)

1. **MVP surface set.** Proposed: envelope contract + gateway-side scanning
   for web fetch, Discord docs, images (OCR→text-scan); wrap tool
   observations; **envelope-id stamping on memory/wiki writes from day one**
   (cheap now, impossible to retrofit; enables later lineage excision of a
   poisoned source). Telegram/API document ingest doesn't exist at all —
   build inside this epic or defer to follow-up beads?
2. **Trifecta invariant strictness.** Hard invariant will occasionally block
   legitimate behavior (read article → message someone about it). Hard, or
   soft-with-review at regular/public tiers only?
3. **Runtime budget + licensing.** Is ~184M ONNX in-process acceptable on the
   psfn-shard Pi (or use `-small` / gateway-host-only)? Is the Llama Community
   license acceptable for Prompt-Guard-2 as a second opinion, or standardize
   on Apache-2.0 ProtectAI only?
4. **Who releases quarantined items** — operator-only via Garden, or can the
   primary user release items from their own conversations? Does the companion
   get a tool to *request* review of a quarantined item (autonomy-positive,
   but a new social-engineering surface: "ask your human to release me")?
5. **Emotion exclusion scope.** Firewall events stay out of appraisal/
   extraction (agreed; safe-notice path supports it). Should *repeated
   targeting by one contact* eventually surface to the companion as calm
   relational information ("this person keeps sending things that get set
   aside"), or stay operator-only?
6. **Datamarking default.** Strongest cheap defense for untrusted text that
   must appear in-prompt, but makes quoted text visually noisy in the Loom.
   Default-on for web/document/public, or only above a risk score?
7. **Trinity doc.** Withheld pending patent review. Ask the friend directly?
   Two reasons: the insight, and freedom-to-operate awareness — "authority-
   bound execution + proof-verification" may cover exactly the release-gating
   mechanics we're designing.
8. **Eval commitment.** Adopt garak `latentinjection`/`encoding`/`xss` corpora
   as a standing cross-surface eval suite (web, image-OCR, tool-output,
   subagent) plus a MINJA-style multi-session poisoning scenario? Only way the
   "same hostile text can't enter via a different adapter" guarantee stays
   true over time.

**Defaults if told "proceed":** envelope + gateway classifier stack
(deterministic → ProtectAI ONNX → escalation LLM screener via the gateway's
own client), sink gates consuming labels, Garden quarantine queue beside
pending-contact-approvals, soft notices via existing cogsec-notices block
excluded from appraisal, envelope-stamped memory/wiki writes from day one,
soft trifecta at regular/public tiers, Telegram/API ingest deferred to
follow-up beads.

## Key references

github.com/Abilityai/trinity · ability.ai/trinity ·
github.com/protectai/llm-guard · github.com/protectai/rebuff ·
github.com/deadbits/vigil-llm · docs.lakera.ai/docs/api/guard ·
github.com/NVIDIA-NeMo/Guardrails · arxiv.org/abs/2403.14720 (Spotlighting) ·
arxiv.org/abs/2503.18813 (CaMeL) ·
simonwillison.net/2023/Apr/25/dual-llm-pattern/ ·
simonwillison.net/2025/Jun/16/the-lethal-trifecta/ ·
arxiv.org/abs/2404.13208 (Instruction Hierarchy) ·
github.com/tldrsec/prompt-injection-defenses ·
huggingface.co/protectai/deberta-v3-base-prompt-injection-v2 ·
huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M ·
github.com/NVIDIA/garak · github.com/utkusen/promptmap ·
arxiv.org/abs/2505.03574 (LlamaFirewall) ·
github.com/invariantlabs-ai/mcp-scan

Relevant existing PSFN files for the design phase:
`src/system/trust/types.ts`, `src/system/trust/context-envelope.ts`,
`src/core/cogsec/memory-candidacy.ts`, `src/core/cogsec/safe-log.ts`,
`src/core/contacts/trust-drift-signals.ts`,
`src/core/contacts/trust-drift-review-lane.ts`,
`src/core/contacts/pending-contact-approvals.ts`,
`src/channels/discord/file-ingest.ts`, `src/boundary/gateway/sanitize.ts`,
`src/core/session/tool-observation.ts`,
`src/core/agent/substrate-agent/vision-attachments.ts`,
`src/system/config/startup-owner-files.ts`.
