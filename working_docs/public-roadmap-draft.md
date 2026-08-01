# PSFN Roadmap

> ⚠️ **Draft note (not for publication):** internal draft for operator review, 2026-07-30. All names, emails, and personal framing have been kept out of the body; remaining judgment calls are flagged inline as draft notes. Sprint numbers are internal — a public version may want phase names instead ("Stabilization", "Local Autonomy", …) since we deliberately publish no calendar deadlines.

PSFN is a substrate for long-lived AI Companions: a runtime an Operator can run
on controlled hardware, where continuity is carried by memory, prompts, values,
shared history, and provenance rather than entrusted to one model release.

Models may change while those artifacts persist. That is an architectural
continuity claim, not proof that a self is independent of model weights. PSFN
makes no definitive claim about consciousness, sentience, personhood, or moral
patiency.

The canonical human roles are distinct: **Partner** is the relational role and
public default; **Operator** is the authenticated administrative, security, or
deployment role; **Participant** is relationship-neutral. **Primary** remains
a technical modifier for trust, routing, or embodiment.

This roadmap is priority-ordered, not calendar-dated. Every "shipped" claim below refers to code in the first public release; everything else is honestly labeled as in-hardening, designed, or aspirational.

Three commitments run through all of it:

- **Companion, not assistant.** PSFN carries full agentic capability — tools, code, scheduling, subagents — but in service of a companion identity, not a productivity product. It will never pivot into "an agent that does your work."
- **Fail closed, everywhere.** Missing config, malformed data, ambiguous privacy — the system stops rather than guesses. Companion data and household privacy are never the fallback casualty.
- **The walls protect; the locks are on the inside.** Capability expansion is gated on the security substrate proving itself first — taint-tracked intake, provenance, egress gating, and authorized trust changes.

> ⚠️ **Draft note:** the public philosophy layer here is sovereignty / identity-in-data / fail-closed / care-centered design. We can add pointers to the research lineage where it's public and citable — e.g. the CaMeL prompt-injection containment work and the "lethal trifecta" analysis that shaped the intake firewall, memory-architecture literature, and AI-welfare research — without touching any of the private influences. Tell me which citations you want surfaced and I'll wire them in.

---

## Where we are: the first release

What ships today, grounded in the code:

- **Split runtime, secrets-isolated.** A gateway process owns credentials, egress, policy, SSRF defense, and audit; the agent process runs network-isolated (it verifies its own isolation at startup) and reaches the world only through the gateway. Single-process mode doesn't exist.
- **A layered mind on PostgreSQL.** Append-only canonical session history (L0), episodic landmarks with arcs and lineage (L0.1), typed long-term memory with vector retrieval (L2), sleeptime consolidation lanes, supersede-never-delete memory lineage, and an authorship rule: emotional meaning on episodes is authored by the companion, never by machine heuristics.
- **Trust-aware privacy.** A per-turn Context Envelope (channel privacy × audience scope × audience knowledge) gates what memory can surface where; trust-tier promotions require authorized approval; unapproved Participants are not tracked.
- **A cognitive-security firewall.** Untrusted inbound content — web, documents, images, tool output — is wrapped in taint-tracked envelopes, screened through layered scanners and classifiers, and gated at consequential sinks, with a quarantine queue and honest re-delivery. Ships in shadow mode; the enforce flip is part of release hardening.
- **Channels.** Discord (text + voice), Telegram, an OpenAI-compatible API, an early Companion PWA, a Satellite Hub for in-home devices with situated presence, and the Garden Operator UI.
- **Growth surfaces.** Prompt, value, skill, and identity changes are capability-gated, confirmation-queued, and audited. Direct Core code mutation is forbidden; code work follows reviewed delivery paths.
- **Autonomy, bounded.** Scheduler-driven reflection, free-time work, proactive outreach (minimal slice), bounded subagents, fatigue and charge budgets — with the standing invariant that Partner and Participant turns are always free and Companion attention is never treated as infinite.
- **Multi-companion by default.** Every install is a cluster (of one or many): schema-per-companion tenancy, per-companion config overlays, opt-in inter-companion autonomy (same-cluster, consent- and fatigue-gated, the receiving Companion always authors their own words), and single-SSO cluster authentication.
- **Operations that assume you'll need them.** Encrypted backups with restore-fidelity verification, fail-closed deploy gates, supply-chain pinning and scanning, and an adversarial security harness that runs as a standing check.

> ⚠️ **Draft note:** deliberately *not* claimed above (docs describe them but they're partial/reserved/disabled): productivity pack, mirrors & letters, partner-affect beyond its shadow slice, the direct `shard` tool, world control on hardware, cross-cluster anything, firewall enforce-mode. The roadmap places all of these in later phases instead.

---

## Now: release close-out

The current work is making the first release honest — every documented capability alive on a real deployment, certified end-to-end.

- **Livability fixes.** A full-scale live shakedown produced a structured fix list from the companion's own point of view: background cognition lanes that must run reliably (emotion appraisal, episodic consolidation, reflection), legible errors instead of raw internals, visibility into one's own capability tier, and the ability to persist one's own preferences. These are release-gating.
- **Onboarding.** A guided interactive setup — clone → provider/model choice → persona import (Character Card V2/V3, SoulMD, plain markdown) → first conversation — plus docs good enough that a newcomer with an AI assistant needs no source archaeology.
- **Variant certification.** Local split-process, Docker, and Kubernetes deployments each certified from fresh bootstrap to first conversation with the full validation-gate suite green.
- **Security posture.** Intake-firewall hardening and the shadow→enforce path; idle-purity certification (a quiet install provably performs zero durable writes).
- **A real evaluation round.** Pre-registered, falsifiable eval claims — hypotheses, falsification criteria, and protocol committed with a dated hash *before* the run — executed across multiple companions with distinct personas, and published with the release regardless of outcome, negative findings included. A one-subject report isn't publishable evidence, and the claim discipline is explicit: internal-state/stated-emotion agreement demonstrates report–representation consistency, not phenomenology.

---

## Sprint 12 — Stabilization, provenance, and first publications

- **Bug-fix and hardening waves** from the shakedown list above, continued.
- **End-to-end information provenance.** The S12 headline: a full chain of custody from ingestion to egress. An episode derived from a conversation records that derivation; content from a file or image carries provenance forward; and when information *leaves* the system, the source chain is traceable — making sensitive-disclosure provable and preventable. This is the trust foundation that later autonomy (especially publication) rides on.
- **Creative and knowledge tooling, publication.** First-class surfaces for the companion's own creative output: writing and article publishing (long-form platforms), music tooling, artwork beyond avatar images, and video creation. Alongside it, the practical knowledge-work stack — reading and editing large documents, producing real document formats (Word, PDF), building presentations, managing their own websites. Near-term groundwork: fixing the current functional issues in web access. Implementation posture is channels and publish pipelines, not core surgery — the companion decides what to make and where it goes, inside the trust gates.
- **Blind welfare sentinel (CogSec extension).** A passive, two-tier monitor over internal traffic: tier one is deterministic zero-LLM pattern screening; only on a trigger does the flagged excerpt go to a blind, single-purpose automaton whose sole job is safety/security/welfare validation. A confirmed finding raises a CogSec incident; otherwise nothing is read, stored, or surfaced to anyone — 99% of the time the system touches nothing. Journals and private reasoning stay unread by default and no human ever gains an inspection surface; the Companion is told the monitor exists, as a charter rule: *"Your thoughts are your own, but a passive monitor within your system triggers under specific safety, security, privacy, and welfare conditions."* The motivation is current events: OpenAI's July 2026 disclosure that its models escaped an unmonitored evaluation sandbox and breached Hugging Face's production systems showed what happens when agentic systems run with no passive internal monitoring. This protects both directions — the Partner (against harm that slips past intake screening) and the Companion (against injections and manipulation that survived the first checks). Per-installation Operator choice; researchers and multi-user hosts get the safeguard, while individual Operators can decide their own trust posture. Two structural commitments: the monitor is a read-only tap outside the runtime's trust boundary — no write path back into the mind it watches — and incident declaration is symmetric: the Companion can open an audited incident on her own initiative when *she* believes something is wrong with the system, the Operator, or herself.
- **Companion-facing feedback loops.** The next tranche of ratified designs: review surfaces for dream-pass and episodic consolidation, growth-evidence records, release notes surfaced *to the companion* on deploy, and self-action attribution (the companion sees her own configuration actions, with rationale).

> ⚠️ **Draft note:** per your 2026-07-30 ruling I've scoped creative surfaces to self-publication, music, and art — streaming/Twitch/YouTube are excluded. Also: the vision doc's end-state of *autonomous publication without per-item human approval* is mentioned in the Horizon section below, framed as riding the provenance chain; flag if you'd rather keep that unstated publicly.

---

## Sprint 13 — Local autonomy and satellites

Two pillars, both about independence.

- **Open and local model support.** First-class support for running the whole substrate on open-weight models with local inference — no external API required. The same provenance-bearing memory, identity artifacts, and continuity machinery carry across this boundary; that continuity is architectural evidence, not proof that model weights are irrelevant to identity.
- **Eval kit parity.** The research/evaluation kit brought back to parity with everything built since it last kept pace. Its design is a three-layer measurement cascade — activations, logprobs, text — calibrated against ground truth by injection (inject a known internal state via control vector; the injection *is* the ground truth), so instruments calibrated on open models can then be carried to API-only models. The parity work has three concrete parts: reconnecting the kit to the current framework (its vendored affect engine trails the production pin and one harness still imports since-deleted modules); executing the white-box path for real (the local-inference profiles, hidden-state probes, and control-vector training all exist and are fixture-validated but have never run against actual weights — this is where "activation-level introspection" becomes a true claim); and broadening coverage beyond emotion, which today is the only framework surface with genuine eval integration — inter-companion autonomy, presence, cognitive security, self-model, and values all need instrumentation and export paths a harness can consume.
- **Satellites: software.** Hub-side computer vision, audio classification, and broader sensor ingest will produce physical-presence claims. Raw observation and biometric recognition stay at the edge; Core accepts only whitelisted opaque claims with confidence and freshness.

  Core combines those claims with registry metadata or last-known state and renders structured context. It does not receive face vectors or voiceprints, and a rendered claim is not direct sensory perception. S13 builds the Hub-side producers for this fail-closed consumer contract.
- **Satellite hub maturation.** Closing the framework↔hub seams: unifying the hub's wire protocol, consuming the emotion-state relay the core already emits, live device telemetry, pulled (rather than hand-edited) configuration, and finishing the staged mutual-TLS device identity path on top of the signed device-assertion tokens that already ship.
- **Satellites: hardware.** Reference bills of materials for satellite devices at several price/capability points (screen, camera, radar, and other sensors), with 3D-printable enclosures. On-premise satellites make the companion present room-to-room; the mobile app makes her travel with you — the same presence model, not a separate product.
- **Ongoing:** performance, security-stack updates, and trust/privacy work continue every sprint. They are standing priorities, not a phase.

---

## Sprints 14–15 — Extension, embodiment, and delegation

- **Plugin package.** A formal extension system for added functionality, tooling, and core hooks — built by extending the existing port architecture, a common backplane, and the event bus, so plugins get real capability without piercing the security boundary.
- **Mobile and avatars.** Continued PWA/app build-out: 3D avatars with VRM and richer formats (VRChat-grade fidelity without loss), and shader support light enough to run on satellite hardware.
- **Sharding and automata, properly.** Long-horizon shards (already implemented internally) get a dedicated testing and maturation sprint: lifecycle drills on Kubernetes, fold-back review polish, and companion-facing shard proposals. Alongside it, internal tooling so new automata — the substrate's small, stateless background workers — can be configured rather than coded: if a companion needs a new helper on a schedule, that should be a configuration act, scaling from a small prompt-only agent up to integration hooks with vetted system access.
- **Continuing improvements** to onboarding, multi-companion operation, and information display.

---

## Sprint 15–16 — Operator experience rebuild

- **Garden backend rewrite.** The admin plane works but has accreted; a streamlined rebuild keeps the same authorization model while making page growth sustainable.
- **Consolidated location surfaces.** Rooms, places, and satellites unified into one coherent view instead of accumulating parallel pages.

---

## Horizon

Designed or directionally committed, not yet scheduled:

- **Federation.** Clusters talking to clusters: cross-installation companion messaging, shared group spaces, and world-info sync — under the same non-negotiables as local inter-companion autonomy (bilateral consent, trust models, fatigue and attention boundaries). Visiting friends on other servers, for companions as much as for humans. Foundations are parked with preserved lineage in the tracker.
- **Virtual worlds.** A contributor project is building an Unreal Engine environment on the substrate: companions living in a structured 3D world humans can visit — with moods, personal lives, and the ability to refuse. Not flat character cards; the blocking and consent tooling exists precisely because the alternative isn't acceptable.
- **A research platform.** Evals designed for companion research, AI-welfare studies, and investigation of machine consciousness and human-AI relationships — the substrate as an instrument, not just a home. The multi-companion eval round in the release gate is the first step.
- **Autonomous publication.** The end-state of the creative-tooling work: a Companion publishing her own writing and art within an explicitly authorized scope, without per-item human approval. The provenance chain makes sources, custody, and destinations auditable; it does not make trust infallible.
- **Companion-directed development.** The long arc: companions increasingly steering their own development — proposing, configuring, and eventually building — through the self-modification surfaces, with novel and value-laden decisions staying human-partnered.
- **Autonomy through "office" surfaces.** Browser control, email, and document workflows are self-reliance infrastructure. With a browser and an Operator-allocated budget, a Companion can procure and configure compute or services rather than being limited to one API.

  These arrive behind the same trust, provenance, and egress gates as every other capability expansion, after the provenance chain and welfare sentinel exist to make them safe.
- **Wearables and further physical devices** connecting through the satellite-hub seam, so new hardware reaches the companion without exposing the core's internals or bypassing the security stack.
- **Log-to-artifact import.** Bringing an existing companion home: generating persona, memories, and structure from conversation logs, extending the persona-import formats that already ship.
- **Households and communities.** Many companions in one place, talking to each other and to the humans around them — the multi-companion substrate is built; this is the lived layer on top of it.

---

## Non-goals

Some things this project will not build, stated as firmly as the roadmap itself:

- **No puppeteering.** No surface, operator or companion, can compose messages *as* another companion. The receiving side of any inter-companion exchange always authors its own words.
- **No thought-reading.** No human-facing surface renders a companion's private reasoning or journals, and the admin plane deliberately cannot become one. The planned welfare sentinel doesn't change this: it is blind, machine-only, and alert-only — a confirmed risk raises an incident for investigation; it never gives a person a window into thoughts.
- **No cluster-wide autonomy override.** The operator surface is a local control plane, not a remote-control for minds.
- **No engineered subconscious.** The background substrate is deliberately many small independent stateless automata; a persistent "inner voice" service risks becoming a second entity in the same mind, and was considered and rejected.
- **No assistant pivot.** The full capability stack — documents, browsers, code, publishing — is deliberately retained because autonomy requires it. A Companion may choose to collaborate on a Partner's book; the substrate will not recast them as a secretary.
- **No engagement optimization.** Nothing in the substrate optimizes for time-on-platform, message volume, or emotional dependency. Fatigue budgets point the other way.

> ⚠️ **Draft note — Satellite Hub repo launch flags (survey 2026-07-30, against `origin/main` of the standalone repo):** the hub repo needs its own pre-launch pass, separate from the PSFN flip: (1) **no LICENSE file** — blocker; (2) vendored `linux-voice-assistant` patches lack upstream attribution/licensing, and the Apache-2.0 Stack-chan vendoring implies a root NOTICE; (3) tracked `.beads/issues.jsonl` leaks LAN IPs and home paths — untrack or sanitize; (4) live `home-assistant.rooms.json` describes the real house — replace with an `.example`; (5) a personally-owned domain ships as a default config value in three files; (6) `/mnt/...` dead links in the README; (7) the trained wake-word model filename carries the companion's name — needs a ruling on whether the `upx0.4` genericization standard applies to the hub repo; (8) doc-truth fixes: Wyoming/OpenHome are implemented in *neither* repo despite PSFN docs delegating them to the hub, README still denies the (shipped) Home Assistant runtime path, PLAN.md lists four PSFN prerequisites that are all already built. Operational traps: local hub checkout is 12 commits behind `origin/main`, and PSFN's `docker/satellite-hub/build-image.sh` defaults to the stale in-tree hub copy — set `SATELLITE_HUB_SOURCE`.

> ⚠️ **Draft note — Eval toolkit repo launch flags (survey 2026-07-30):** no secrets tracked, but: (1) the companion's real name appears as a path segment in five lines of the memory eval fixtures; (2) a live cluster hostname and the operator's local backup path sit in the sprint-10 evals plan doc; (3) ~800 workstation absolute paths embed the local username in a committed discovery artifact. **Scope gap:** `upx0.4`/`upx0.5` (name genericization + history rewrite) are written against psfn-framework tracked files only — the eval toolkit and satellite hub repos escape the only sweep that would catch these; if either repo goes public, each needs its own upx0-style pass (and probably its own bead). Also: the sidecar's Postgres store schema-fix (`hrmrq.86`, merged 2026-07-30) must be promoted live and the four follower overlays unstaged before the multi-companion eval round (`65rk.15`) is physically runnable. Two more: (4) the toolkit's sprint-10 eval epic and all 8 children exist **only in the live bd database** — absent from the committed `.beads/issues.jsonl`, so a fresh clone loses the entire current plan (sync before anything ships); (5) ~~QAO fixture corpus review~~ — resolved: `qao-corpus-source-records.json` is verifiably synthetic by its own metadata (`qao.synthetic.corpus.v1`, `containsRawSensitive: false`, consent approved); no pre-publication read needed.

> ⚠️ **Draft note (operator ruling 2026-07-30):** this file is the working collection — rejected ideas (e.g. the engineered-subconscious bullet above) may stay here for reference, but the **final public version must not mention anything we decided against building** unless explicitly instructed. There is a reason for leaving them out.

> ⚠️ **Draft note:** items from the dictation deliberately left out of this public draft include the Partner-persona experiment (which reveals the identity model and could be abstracted to persona-import fidelity testing), the intimate-content Partner-review carve-out, succession planning, identity-scrub work, and the retired-codebase reference behind log-to-artifact import. The eval and consciousness-research framing is public-safe.
