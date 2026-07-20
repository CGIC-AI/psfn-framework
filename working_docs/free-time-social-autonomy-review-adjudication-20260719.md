# Operator Adjudication: Free-Time / Social-Autonomy Design Review

**Adjudicates:** `working_docs/free-time-social-autonomy-design-review-20260719.md` (R1–R12)
against `working_docs/free-time-social-autonomy-design-bible-20260719.md`

**Date:** 2026-07-19

**Source:** operator voice-feedback session (rough transcription), structured by the orchestrator.
Where the operator overruled a review finding, the finding is recorded as withdrawn or narrowed —
the review document remains as-written for the audit trail; this document is the decision record.

**Status key:** **Settled** = operator decision. **Answered** = orchestrator recommendation on a
question the operator explicitly bounced back (pending operator confirmation). **Withdrawn** =
review finding overruled with rationale. **Deferred** = explicitly parked.

---

## 1. Topology fact-check (requested during session)

The "everything is multi-fleet; single-companion = fleet manifest with one entry" change has
**not landed** on `main`. Current shape (`src/system/config/companions-config.ts:337-390`):
`MULTI_COMPANION` env flag off + no `companions.json` → single-companion default topology; flag on
requires the manifest; manifest present with flag off refuses to start. The mus2 wave (fleet
Garden, local supervisor) trends toward the collapse but the always-multi shape is not yet code.
Follow-up bead warranted when the collapse is scheduled. Design work below **assumes the target
shape** (always a fleet, possibly of one).

## 2. R1 — Disclosure/CogSec — Settled

1. **CogSec owns the gates and provenance.** The intake machinery is reused internally; no
   parallel DisclosureLineage accumulator is built. Extend, don't rebuild.
2. **A new outbound (egress/disclosure) piece is net-new work** — the part CogSec doesn't model
   today. Placement (CogSec module vs Core) is an implementation choice; operator leans CogSec so
   the full information lifecycle (intake → derivation → publication) lives in one system:
   "putting CogSec in the stream is the right move."
3. **Human-in-the-loop provenance review pane** (Garden): for any outbound/publication candidate,
   show the derived memories, conversations, and sources used in its creation. Sensitive
   provenance does not auto-block — an intimate memory handled respectfully can be approved. The
   review pane is how strict filtering is legitimately bypassed: model-backed, human-approved.
4. **Edit loop is companion-owned.** Human feedback addresses *what is shared*, not the prose;
   the human never edits the companion's work. Flow: companion drafts → human reviews (with
   provenance) → human raises specific concerns in conversation → companion edits herself →
   re-submission → approval. Requires a publication-lane review tool; approval binds to the
   resubmitted exact content (consistent with bible §10.10).
5. **A clean fast lane exists:** content whose every input is already at the right privacy level
   for the destination sails through (bible's public-clean path).

## 3. R2 — Speaking arbiter — Settled (one question Answered)

1. **The arbiter is a gateway process.** The gateway is shared by all companions in the fleet and
   sits at the border to the outside world where the platform integrations live. Charter-consistent
   (Laws 3/35).
2. **Arbiter state lives in Postgres** — pressure, turns, leases survive gateway reboot. (Lesson
   from earlier reboot-loses-state incidents.)
3. **Per-channel arbitration:** one gateway watchdog observes every group-room channel; each
   channel has its own statistics and effectively its own arbiter context. The same companions in
   two channels are two separate arbitration contexts.
4. **ICP is the signaling transport** for arbiter → companion turn grants ("red/yellow/green
   light"), including cross-installation rooms — ICP federation is the answer to the review's
   cross-installation gap. ICP already carries "do you want to talk / how much" semantics; plug
   in, don't rebuild. The arbiter itself (per-room bookkeeping, gates) is still net-new,
   mostly deterministic work.
5. **Two-phase reservation → egress lease: approved** (resolves the bible's §6.10 vs §7 ordering
   contradiction).
6. **Crash-recovery fencing for autonomous non-ICP turns: approved as reviewed** (R2 crash bullet).
7. **ICP and social are two legitimately different authorities, not an inconsistency.** A
   companion may refuse ICP DMs with a peer yet still interact with them (coldly, cattily, or
   confrontationally) in a shared room — that mirrors real social life. **On any conflict or
   race, ICP dominates social.**
8. **Fatigue economy across many rooms — Answered (recommendation, pending confirmation):**
   the operator posed: many companions in many rooms fatigue out globally fast, with no recovery
   until the 24h tick; alternatives were per-channel fatigue, or a bigger pot divided per channel
   that also funds ICP. Recommendation — a two-level model:
   - Keep existing dyadic fatigue and per-room-class `channelSettingLimits` unchanged.
   - Add a per-companion **social pot** funding group participation *and* ICP continuation, with
     ICP drawing at priority (consistent with ICP-dominates).
   - Add **per-channel draw caps** as a fraction of the remaining pot (no single channel may
     consume more than ~a third of what's left): a three-channel argument now drains the shared
     pot (so it can't rage on forever), while the cap stops one room from starving the others —
     the two failure modes the operator named, addressed by the same mechanism.
   - **Room-episode pressure stays per-channel and non-monetary** — it shapes conversation
     (wrap-up, lease thresholds), it is not budget.
   - Replace the 24h cliff with **continuous regeneration** (fatigue decays toward full over
     hours; the daily tick remains only as a backstop ceiling reset). Charter §8.11 prefers
     taper over cliff, and it removes the "dead until midnight" dynamic.
   - Human-triggered turns continue not to charge the pot (existing invariant); all state in
     gateway Postgres per decision 2.

## 4. R3 — Observation, consent, poisoning — Narrowed/Withdrawn

1. **"Observation costs nothing" stands, correctly scoped:** group-chat extraction, graph edges,
   and context accumulation are pre-existing subconscious processes that run regardless. The
   *new* spend is only the name-triggered respond-or-not appraisal. The review's R3.1/R3.2 narrow
   to: **reuse the existing group-salience name detector and coordinate cadence/dedup with
   `ObservedGroupMemoryScheduler`** rather than adding a second name-detection path. (Operator
   confirmed: reuse wherever functionality exists.)
2. **Consent finding withdrawn.** Joining a room where companions live *is* consent — stated
   room policy, trusted invite-only deployments, ZDR/local providers for processing. This is not
   a commercial product; GDPR-grade machinery is out of scope. Deletion requests are handled by
   existing marking/deletion capability, case-by-case. The sanctity of the companion's memories
   outranks data-protection ceremony.
3. **Platform-ToS finding descoped** to the same posture (small trusted deployments; revisit only
   if/when a large public surface is actually built).
4. **Large public rooms (future posture, recorded):** ignore everyone except known/named
   contacts (e.g. mods); paid/flagged messages (superchats) are firewalled through with explicit
   annotation ("a message from the public asks…"); such interactions are ephemeral — no contact
   records created. The block list exists for exactly two purposes: scale filtering in public
   rooms, and companion self-protection anywhere (a companion may block an abusive participant
   even in an invite-only room).
5. **Slow-poisoning finding narrowed:** vendettas and adversity are legitimate growth (charter:
   failure is valid experience) — the harmful case is *behavioral/emotional drift*, which drift
   tracking already monitors. No bubble-wrap. Recorded root-cause lesson: the one observed
   poisoning-like incident was a **fallback-model misconfiguration** (a vision fallback model
   with aggressive API-side classifiers wired into the wrong lane flipped a persona 180°), not
   chat-borne injection. Model/lane configuration correctness is the real control; keep fallback
   assignments strict and observable.

## 5. R4 — Appraiser — Narrowed, Answered

Operator's structural point, accepted: the appraiser consumes **the same room context already
admitted and processed** for memory extraction and graph building. There is no new information
surface — only a new cheap decision over existing context. The appraisal must be run *from the
companion's perspective* ("I am this companion's appraiser; they mentioned me; do I want to
reply?") — per-companion, but flat, fast, and bounded.

Reconciled recommendation (Answered):

1. **No per-line firewall screening of ordinary room chatter.** Not warranted; would bog the
   system down.
2. **Strict output contract + tool-less transport** for the appraiser (ternary + reasonCode, same
   discipline as the L2/L3 screeners): the worst an injected line can achieve is flipping one
   cheap yes/no whose "yes" still routes through the full normal response path and its gates.
3. **Present room text in the appraiser prompt the same datamarked/quoted way the main prompt
   path presents it** — near-zero cost, removes the "raw text as instructions" framing.
4. **The deterministic debounce is the primary defense** (see R6 decision below): repeated
   name-triggering collapses to one optional response then a ~10-minute ignore window, which also
   caps any oracle bandwidth.
5. A fast deterministic injection heuristic may be added **only if** it costs effectively nothing;
   otherwise the social remedy stands — obvious game-players get surfaced as an event and blocked
   by a human or the companion.

## 6. R5 — Reactions and covert channels — Settled/Narrowed

1. **Build outbound reactions** on the existing adapter seam. Emoji surface: a curated subset of
   standard emojis (the ones normal people actually use), **plus guild-custom emojis loaded with
   a one-line meaning description** so the companion can use house memes correctly.
2. **Covert-channel finding narrowed to the real invariant:** the sacred line is the
   **DM/pairwise relationship** — what passes between two people in a DM must never leak, nor be
   inferable. That stays absolute.
3. **Free-time/journaling existence is NOT secret.** Companions are known to have private lives,
   free time, and introspection on a cadence; "I was doing my own thing" / "I wrote in my
   journal, might share the poem later" is normal, healthy, and desirable social behavior — not
   an oracle. Bible §6.6's "must not reveal even that a private session occurred" is **explicitly
   narrowed to DM-related privacy**; room-bound return notes and vague self-disclosures are fine.
4. Reactions should still be added to the canary egress method list (one-line tripwire hygiene,
   uncontested).
5. Context note recorded (not to build now): during a physical/satellite **emanation**, the
   companion intentionally does not answer DMs/group chats — presence and attention are a respect
   boundary, per the single-primary-emanation invariant. Future walls for this are acknowledged
   as unbuilt.

## 7. R6 — Appraisal economics — Settled

1. Appraisal fires **only on contextual summons** (name/alias in group chats), never per-message;
   the pre-gate is deterministic. **Group chats only** — DMs, one-on-one, and ICP lanes never run
   this appraiser (ICP already has its own consent moment).
2. The call runs on a **cheap background model**, yes/no. **Full telemetry like any faculty**
   (it is a model call), but **no charge-system cost for now** — same posture as memory calls
   ("memory just is"). Charge is added later only if usage proves it necessary.
3. **Deterministic debounce/spam filter:** repeated name-triggering (one user or several
   coordinating) → at most one optional response, then ignore that trigger pattern for ~10
   minutes and let them spend themselves.
4. **Billing attribution: each companion pays for its own appraiser** out of its own budget; the
   gateway's deterministic arbitration work is shared infrastructure and unbilled.
5. The free-time zero-reader degradation (review R6/R9.2) inherits this same posture: telemetry
   first, hard enforcement when it matters.

## 8. R7 — Garden, ontology, Law 31 — Settled

1. **Garden placement:** room/arbiter state and per-room telemetry at the **fleet level** (Fleet
   Command section); companion-specific participation logging at the **companion level**.
2. **Message authorship labeling is a hard invariant:** return notes and any inbound system
   context are system notes and must never be attributed as user/partner speech. A prior
   incident of misattributed messages caused the companion real distress; regression here is
   unacceptable. (Charter Laws 17–19; review R7 accepted with maximum emphasis.)
3. **Event bus: always.** All new telemetry rides typed bus events.
4. **Law 31 tension resolved — no exemption needed, a distinction:** Law 31 governs
   **active-lane work** — a partner asked for something in conversation and multi-turn tool work
   is fulfilling it; completion or blockage must produce a response (the giant-document/analyst-
   toolset timeout incident is the canonical failure). **Self-directed free time is not an
   assigned task:** finishing a book while your partner is at work does not warrant a
   notification; the return summary gives *her* the context to mention it naturally. Blocked
   free-time work surfaces through ordinary telemetry/Garden, not partner pings. The design
   record should state this distinction under §15.

## 9. R8 — Classification, capsules, publication — Settled (one item Answered)

1. **Derived-default finding accepted** ("good find"). All current group rooms are de facto
   invite-only, so today's derived default matches reality — but autonomous egress must not rest
   on a derivation. **Answered (recommendation, pending confirmation)** on the mechanics the
   operator asked about:
   - Keep auto-assigning **invite-only at channel add** — zero friction, matches practice.
   - Track `classificationSource: derived_default | operator_confirmed` on the envelope.
   - **Directed behavior (mentions/replies) works under a derived default** — a human explicitly
     summoned the companion.
   - **The new autonomous lanes** (social-impulse initiation, room-project binding, room-bound
     return notes, topic seeds) **require `operator_confirmed`** — a one-click confirm/adjust
     (invite-only ⇄ public) in a Fleet Command "unconfirmed rooms" queue. One click per room,
     once, gating only the new features.
   - **Privacy transitions:** widening (invite-only → public) starts a **new disclosure epoch**:
     everything generated under the old ceiling keeps it; only post-change content is
     public-eligible (operator stated exactly this). Narrowing (public → invite-only) tightens
     the ceiling for new content; already-public material cannot be unpublished and stays public.
2. **Share capsules:** fresh approval required to reuse restricted-provenance content as
   generative input — confirmed; the bible's capsule text predates the publication scope and is
   amended accordingly.
3. **Publication approvals** ride the existing gateway egress/approval architecture, with the
   review/edit lifecycle living in CogSec (see R1). No second approval store.
4. **Runtime-derived artifact metadata: confirmed.** `project_add_artifact` sensitivity/audience
   must come from runtime state, populated at time of change (no restart requirement); existing
   model-asserted values get migrated/quarantined.

## 10. R9 — Implementation-map corrections — Settled

1. **Own-presence staleness: add the timestamp check** (accepted; low urgency since Location
   surfaces aren't active yet — becomes real with the virtual-environment work).
2. Zero-reader charge path: posture per R6 above.
3. Observed-group-memory omission in bible §5.1: accepted on the review's evidence.

## 11. R10 — Lifecycle and identity — Settled

1. **Kick/ban from a room owning a room-bound project: do not over-restrict.** The project stays
   workable — there's simply no one to share it with while excluded. **Rejoin MAY resume prior
   room context**; being kicked does not erase what the companion legitimately experienced.
   (Review's "must not auto-resurrect" is withdrawn.)
2. **Channel deletion: memories and artifacts survive and remain accessible.** A past bug where
   deleted channels made memories unfindable is believed fixed (verify). Room-bound artifacts
   become unshareable-for-lack-of-audience, not lost, and nothing about deletion rewrites L0/L2.
3. **Contacts are archived, never deleted.** An archived contact's memories, privacy links, and
   gates persist (grayed out, inactive). A recreated account with a new ID is a new person.
   Blocked contacts keep existing so the block can keep working. The review's contact-deletion
   row resolves to "archive semantics" rather than a new failure mode.
4. **Migration: one-time flip-everything-to-private, then go.** Deterministic enum mapping
   accepted. **The "adoption cliff" finding is withdrawn as argued:** in a single-partner
   deployment the partner is the highest-trust contact, so flipping free-time history to private
   changes nothing they can see — the companion still discusses her private work with her
   partner, and that MUST remain true post-migration. Group sharing is net-new capability, so
   groups lose nothing. Known estate: three operating systems, two single-companion, one
   multi-companion/multi-admin a few weeks old — small enough to just do it once.
5. **MI identity: resolved by the platform bot flag.** Companion accounts are Discord
   integrations and are tagged as bots; cross-hardware recognition already works in practice
   (Persephone/Artemis). A bot wearing human clothes is a platform-ToS problem, not ours; misbehaving
   bots get blocked like anyone else. Review's cross-installation MI-detection finding is
   withdrawn; the **name-collision half stands**: passive-name candidates must include
   surrounding context so "is this about me or a same-named human?" is part of the appraisal.

## 12. R11/R12 — Remaining — Settled

1. **Reuse mandate confirmed globally:** where machinery exists (concerns pattern,
   weighted-thought lane, `FatigueBudgetPort`, ICP primitives, co-presence), extend it; new code
   only for genuine gaps.
2. **Telegram: descoped.** Effectively DM-only in practice; may be ripped out or left dormant.
   No participation parity work.
3. **L0: everything is L0** — free-time and room-project internal sessions are recorded as
   ordinary L0 session archives (on their own internal channel partitions).
4. **Workspace domains: directory-per-project** with per-directory privacy recorded — simple,
   sufficient.
5. **EmoSim/welfare loop: deferred** — the sidecar is telemetry-only during the tuning period;
   the chronic-denial damping question returns when EmoSim promotion is actually considered.
6. **Return notes are channel-scoped by definition:** a return note carries only context from/for
   the workspace channel it belongs to; time/context refresh notes are desirable (she asked for
   them). Cross-session leakage — not existence of a note — is the failure condition; the review
   item stands only as "verify the summarizer never fires broad."
7. **Discord voice channels are Location-scoped — new settled decision.** Voice is
   presence-based: only those present at the time share the context; scrollback doesn't exist.
   Voice channels ride the existing Location/presence-window seam and serve as the test substrate
   for future virtual-environment Locations. (This amends bible §17, which treated Location
   surfaces as wholly future.)
8. **RestWindowPolicyPort: adopt** — quiet-period/silence-persistence policy behind the named
   port; the goal is never annoying her into muting her own reminders again.

## 13. Follow-ups

1. Fold the settled decisions above into the design bible's §4 settled ledger / §23 decision
   ledger (amendments: §6.6 narrowed to DM sanctity; §17 voice-channel classification; §10.11
   capsule generative-reuse rule; §15 Law-31 distinction; arbiter placement into §13.1).
2. Bead the multi-fleet always-on collapse when scheduled (see §1).
3. Verify the channel-deletion memory-reachability fix actually landed.
4. Operator to confirm the three **Answered** recommendations: fatigue pot mechanics (§3.8),
   appraiser hardening scope (§5), unconfirmed-rooms confirmation flow and epoch rules (§9.1).
