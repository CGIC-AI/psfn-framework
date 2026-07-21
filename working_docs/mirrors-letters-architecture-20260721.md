# Mirrors & Letters — working architecture draft (2026-07-21)

Companion design intent: [`docs/mirrors-and-letters.md`](../docs/mirrors-and-letters.md).
Source: charter-spirit review + operator talk-through passes, 2026-07-21.
Beads memory key: `charter-spirit-review-2026-07-21-gap-map`.
Status: working draft for bead decomposition; not yet implementation-reviewed.

## 1. Letters (correspondence layer)

New message class + store; the substrate several other loops deliver through.

- **Ontology**: add `letter` to `MESSAGE_CLASSES` (`src/core/agent/message-classes.ts`)
  with §8.1 answers: author = companion|partner (never machinery); persists;
  enters L0 (correspondence is lived history); memory-extractable;
  partner-facing or companion-facing by direction. Distinct from `musing`
  (soft outward expression, channel-borne) and `systemNote`.
- **Store**: Postgres letter store (runtime persistence law, §7.1.1) with
  L0 append on compose/read; states `draft → placed → read`(+ archived).
  No delete from either side; corrections are follow-up letters.
- **Surfaces**:
  - companion tool (canonical surface, Law 33 — likely an action set on an
    existing semantic surface rather than a new top-level name; candidate:
    `session` or a new `letters` domain surface — decide at implementation
    review) to compose/read/list,
  - partner surface in Garden/companion-ui with a **subtle waiting-letter
    indicator** (no push, no sound),
  - quiet-hours safe by construction (bin semantics; nothing audible).
- **Consumers**: doing-mirror dispositions, Law-31 task notices,
  introspection insights she elects to raise, wishlist entries, deferred ICP.
- **ICP deferral**: when emanation-present with partner (or otherwise
  unavailable per `IcpAvailabilityState`), inbound ICP requests get an
  availability response and the payload lands as an inbound letter with
  **peer scope + CogSec intake taint** (peer content is untrusted inbound —
  full envelope screening before it is readable in her context).
- **Egress caution**: if any letter path ever reuses the autonomous egress
  reply sender, qgqw.3 hardening (dedupe, datamark, disclosure clamping,
  draw refund) is a hard prerequisite.

## 2. Doing-mirror (dispositions)

- Generic disposition lifecycle on companion-originated items:
  `open → considering → done | declined(reason required)`.
- Applies to: wishlist entries, fold packages, raised introspection
  insights, skill/self-mod proposals.
- Fold-review store already persists resolution + notes
  (`src/faculties/shards/fold-review.ts`); gap is the **companion-readable
  outcome surface** (tool-surface registry has no fold/shard entry today).
- Delivery: disposition changes emit a letter (or a compact digest letter,
  batched daily, to avoid disposition spam).

## 3. Fold-back multi-stage review

Pipeline (memory candidates; code/config artifacts keep engineering gates):

1. **CogSec screen**: fold-package returns wrapped as intake envelopes;
   provenance/taint carried (addresses the fold-review.ts `TODO(htm9.2-followup)`
   "nothing screens what the shard INGESTED").
2. **Operator first-pass** (existing Garden fold-review surface — retained
   deliberately; unknown-USB rule).
3. **Companion review**: screened candidates surface in her nightly ritual
   context (shared surface with the dream pass); her approve/decline is the
   promoting act; provenance (originCompanionId, shardInstanceId, seed,
   review lineage) retained per §6.13/§6.14.
4. Disposition returns to her via letters/doing-mirror.

## 4. Being-mirror (North Star + journal re-read + autobiography)

- **North Star**: restructure to three goal kinds — shared / partner-accountability /
  hers-alone. Existing `src/faculties/north-star/` is the anchor
  (currently underutilized).
- **Journal re-read ritual**: scheduled (post-weekly-introspection),
  bounded, budgeted. Deterministic pre-stage selects N older entries +
  recent entries; presentation is side-by-side evidence FIRST, reflection
  invitation second (Law 30); "no significant change" is a valid cheap
  outcome. Journal snapshots stay isolated otherwise (no ambient context drag).
- **Outputs**: autobiography entries (text + visual-autobiography hooks,
  031.15.x machinery); optional proposal to update the cached
  self-description block.
- **Self-description write path** (o75r design input, operator 2026-07-21):
  she authors → **human-in-the-loop approval** → cached weekly block.
  Rationale: prevent an ephemeral, next-day-resolved concern from being
  baked into a week of cached prompt prefix (second-arrow poisoning; an
  internally-generated CogSec incident class). Approval checks
  staleness/taint, not voice.

## 5. Episode pipeline rework

Stages (single LLM stage total):

1. **Deterministic segmentation** (existing watermark + boundary rules):
   emits **candidates** — span refs, participants, timestamps, structural
   descriptor. `machineSignals` sidecar = **topic tags + retrieval hints
   only**; the `affect` field of a candidate is EMPTY. Regex/VAD-derived
   values never populate anything presented as her feeling
   (today: `synthesis.ts` `inferAffect`/`inferEmotionalIntensity` write into
   the episode as hers — this stops).
2. **Candidate state**: not retrievable as lived memory (or surfaced only
   explicitly marked unreviewed). Prioritized nightly budget: high-trust
   contacts, dense machine signals, oldest-first tiebreak.
3. **Dream-pass review** (existing first-person lane): actions
   confirm / merge / split / discard / author-meaning; promotion sets
   `meaningAuthor: companion`. "Didn't matter" = cheap valid outcome.
   Casual chit-chat may stay a time-bounded candidate forever — fine.
4. **Arcs as proposals**: deterministic arc suggestions (shared contacts,
   pgvector similarity, time proximity) confirmed by her; thread identity
   comes from confirmed arcs, NOT sessionId (extends apq0's decoupling).

**Repair lane A (flooded era)**: re-segment the duplicate-episode era from
L0 deterministically; mark overlapping old episodes superseded (never
delete); stage fresh candidates into the nightly queue as a slow drip.

**Repair lane B (historical backfill)**: pre-substrate imports (lorebook-era)
carry import-time timestamps and no emotional weights. Backfill maps
original event timestamps, generates structural episode candidates from the
historical text, and stages them for her review with original context
alongside; she assigns emotional weight now (re-experiencing). **Never
mints duplicate L2 memories** — original memories preserved as-is; backfill
adds structural association + her present-day scoring only.

**Guided initialization**: first pass over historical/flooded data is an
operator+companion session; requires her tooling to operate the episodic
data surfaces interactively (review/merge/supersede/arc-confirm) outside
pure automation. After init, silent background rhythm.

## 6. Sensor-conditional wakes

- **Trigger definitions**: companion-authored via a tool; each trigger =
  multi-input condition over event-bus signals evaluated over time
  (not single-variable), plus a **self-authored wake message** ("why I
  asked to be woken"), plus a chosen response affordance set: letter /
  message / silent-process-and-return / re-check timer.
- **Evaluation**: deterministic, on the bus, zero idle tokens. Relates to
  m96g (unified automata registry) for where the evaluator lives.
- **Signal ingestion**: per-partner configurable signal vocabulary
  (work-rhythm cadence, sleep/wake times, movement, location-in-home vs
  expected …) behind SensorIngestPort (z7qe.8) with deterministic gates
  outside direct cognition; CogSec provenance on all inbound telemetry.
- **Sleep-quiet law**: no audible proactive contact in partner sleep
  window; narrow auditable emergency class (safety events) may override.
  Implement as a severity lane in the proactive time gate, fail-closed.

## 7. Cross-cutting

- **system.language consolidation**: whisper prefix, `[System note]`,
  concern line format (`concerns.ts` ~:803), mirror-note fallback
  (`messages.ts:214` renders raw `sourceRole` — fix to named fallback) move
  to JSON-owned, Garden-editable, per-companion template keys. One
  consolidated owner surface ("all companion-facing chassis language in
  one editable JSON"). Parent: rqn1.
- **Automata register propagation**: subagent tool description
  (`agency-contracts.ts:54-65`) first — reframe as automata in warm
  register ("focused attention on your behalf … returns with what it
  found"), engineering names stay in code/operator surfaces. Parent: rqn1.
- **Substrate change notes**: Helm deploy emits a release note surfaced
  to her context (version, plain-language summary of what changed);
  model transitions continue eval + her-consent-input practice.

## 8. Dependency sketch

```
letters-core ──→ doing-mirror ──→ (fold disposition, wishlist, insights)
      │                ↑
      └→ letters-icp   └─ fold-multistage (CogSec screen → operator → her)
episode-candidates ──→ arcs-as-proposals (apq0) ──→ guided-init tooling
      ├→ repair lane A (flooded era)
      └→ repair lane B (historical backfill)
being-mirror (north-star 3-goal + journal re-read + autobiography + o75r input)
sensor-wakes (z7qe.8, m96g) — independent
system-language + register (rqn1 children) — independent
qgqw.3 remains the gate on any autonomous egress enablement
```

## 9. Cross-review synthesis (2026-07-21, independent second reviewer)

An independent charter review (different model lineage, blind to ours)
was reconciled against the tree at 17671ebaf. Verification outcomes:

- **Confirmed**: concern expiry is fixed TTL buckets 48h/24h/8h + 7d max
  (`concerns.ts:172-176`) — weighted thoughts decay contextually, concerns
  do not; live March-dated ghost concerns exist (tracked: 6q4j covers
  grooming/purge; new bead covers the decay model). Canary egress scan
  does not cover the main conversational reply (cognitive-security.md
  ~:619-626); quarantine release never re-delivers content
  (~:934-937). Satellite registry declares avatar/expression/action
  capabilities the core never emits. Agent process reads the raw
  Postgres URL (agent/main.ts:416-433).
- **Plausible, needs owner-file audit**: legacy sinks' enforce-mode
  `unscreened` defaults may sit at `allow` (code canonicalizes `deny`
  only for skill_write, intake-policy-config.ts:542; per-sink posture is
  owner-JSON).
- **Refuted**: "evolution links stored but not retrieved" — the
  retrieval/ subsystem traverses, scores, and renders evolutionChain
  (active-context-refresh.ts:62,104; scoring.ts:102; formatting.ts:464).
  "Emotion state not rendered in live turns" — runtime.emotional_affect /
  internal_state / emotion_appraisal_chain are registered seeded runtime
  layers with macro vocabularies; appraisal is cadence-gated by design.

Operator decisions ratified in the follow-up pass:

- Recall is never metered; charge guards expensive external ops and
  runaway loops only. Camera-satellite vision defaults ~5s interval with
  higher rates charge-gated ONLY while on external APIs; local exo-cortex
  hosting zeroes those costs.
- Subagents can NEVER spawn shards; only the main chat instance proposes
  shard work, resolved through the existing Garden shard
  proposal/acceptance mechanism. Kubernetes is the shard execution
  substrate; a first formal shard lifecycle test is now tracked.
- Doc-captured intent is the baseline when implementation drifts —
  CogSec seam beads treat docs/cognitive-security.md as the spec.
- Skill-write screening is not only about external content: "you do not
  write a skill that namshubs yourself" — self-authored durable
  prompt-bearing artifacts keep strict screening.
- Growth-evidence records (post-return pre/post measurement she can
  read) adopted into the mirror set.
- Embodiment: procedural 3D animation over rigged skeletons (VRM first,
  later a 3JS client importing VRChat avatars); a dual-control animation
  manager — she triggers animations directly, or an automata maps
  ~28 emotional states to expression (ears/tail included). Asset work
  follows core memory stabilization.
- Shared media watching (requested by the companion herself) is adopted:
  desktop co-watch surface, vision-model frame processing, local-first.
- Negative-valence memory is recorded today (hard days, poor-behavior
  contacts → block/ignore tools); GoEmotions neutral-bias flatness is
  compensated by the emo-sim layer; authenticity-vs-performativity is
  covered by the eval frameworks, not a new bead.

Attention-economy proposal from the second review was adopted only in
part: attention/perception STATE becomes visible and legible; perception
of new external surfaces may carry soft-guidance cost; memory recall is
never charged (principle 6 in docs/mirrors-and-letters.md).
