# Talk-Audit Adjudication — 2026-08-02

Definitive disposition list for the simulated-panel release chat, after:
(1) read-only code/beads audit, (2) recovery of the full 427-line vision doc
(§7 restored, bead `abt1s`, branch `fix/restore-beyond-s12-vision-s7` @
dc390c988), (3) operator feedback dictation 2026-08-02.

Status legend: **KILLED** (operator ruling or refuted premise) · **DONE**
(true in code today) · **PLANNED** (beaded or in vision doc; leave it) ·
**GAP** (real, unbeaded — bead candidates after operator review).

## Killed / refuted — no work

| Suggestion | Why dead |
|---|---|
| Growth-evidence measurement from reflections | Operator: growth is measured by north-star goal progress, not self-report — "a semi-unreliable witness." Not plannable as code. |
| Memory-status tri-state (`pending/retrieved/not_found`) | Refuted: queries are synchronous (`memory/tools.ts`), the latency-confabulation path can't occur. The real one-turn-lag async loop is known and accepted. |
| Emanation dwell timer | Operator: no timer needed. Charter §6.10 deliberateness already solves flapping; she emanates until she doesn't; free time and summons cover the rest. |
| Edge "drop unknown persons, log nothing" | Operator ruling: rejected. Unknown persons MUST be represented — privacy gating and intruder awareness depend on it. Anonymous-presence doctrine (`identity-claim-resolver.ts`) is correct as built. |
| Omi speaker-attribution gate (PSFN side) | Not ours: diarization is an Omi-app feature; operator is a contributor and fixes there. Noted complication: his register shifts read as ~4 speakers to diarization. |
| Fold-review prompt audit | Refuted premise: no LLM fold-review prompt exists; candidates are review-pending by construction, operator-gated (`fold-review.ts`). BUT operator ruling 2026-08-02 upgrades the underlying concern: fold-back needs a PR-like formal process — see gap 6 (`sx2sc`). |
| Suppress empty-response WARN | Refuted: split mode returns `notification_ack` with suppression marker; warn is anomaly-only (`sj4i` closed long ago). |
| R7 downstream consumer audit | Refuted: the one consumer flags only positive assertions; null reflections produce zero warnings. |

## Done / verified in code — nothing to add

- Intake firewall: taint envelopes, provenance, sink gates, quarantine, honest
  re-delivery, fixed notice templates with module-load wording assert
  ("contract-breaking wording prevents startup" — verified).
- Shadow mode pinned; enforce implemented; one lethal-trifecta egress deny
  already hard-blocks in shadow.
- `world.control` exists, capability-token + trust gated, lights-only for
  autonomous turns. Operator will add security-camera access (for the bit).
- Unknown-participant no-profiling + anonymous presence (doctrine confirmed
  by operator this session).
- Authoring/dataset firewall is charter law (Law 17, §8.2/§8.3); store-boundary
  writer-class enforcement is the phase-start acceptance check (vision §7.8).
- 38 charter laws confirmed; Law 23 asymmetry confirmed (human-facing) with
  companion-welfare mitigations elsewhere (Laws 24–27/29, §8.8, CogSec language
  contract).

## Planned — leave it where it is

- **Energy-based affect appraiser** — vision §7.4 (restored), bead `7qeo1.5.4`
  (deferred). Operator connects this line to Partner Affect / welfare.
- **Pre-registration discipline** — vision §7.1 + `65rk.15` (open).
- **Productivity Pack + Partner Affect** — paired build, possibly S12.
  Biometric data = highest taint tier; operator self-consent model ("I'm
  building it for me"). The operator-welfare charter amendment lands WITH the
  Partner Affect feature, not standalone.
- **Goodhart/flattening guard** — already a written principle (§7.8
  preserve-rejections); attach to `7qeo1.10` when that phase wakes.
- **Biometrics consent machinery** — scoped down to: highest-tier taint +
  provenance/confidence on inferences. No extra consent theater for
  self-owned data.

## Gaps — bead candidates (awaiting operator review)

1. **Monthly two-tier meta-review** (replaces the panel's "reportability
   diff"). Tier 1: deterministic scan/diff of daily vs weekly introspection
   logs (sentiment/analysis pass, no LLM required). Tier 2: her own review
   and commentary over the same window. Compare the two — do they line up?
   Design constraint: don't generate information that isn't useful. Needs
   implementation thought before beading.
2. **Self-report calibration logging** (under `7qeo1` lineage), expanded by
   operator: emo_sim proactive triggers (social weight/need, missing-him) as
   calibration signals; emo_sim-vs-GoEmotions deltas; deep-research other
   emotion classifiers; offline replay over historical chats (fast) BEFORE
   any two-week live sidecar; analyze HER responses too, not only his;
   more instrumentation on these paths.
3. **Predictive memory pre-fetch (new research, operator-originated)** —
   the async memory loop runs one turn behind by construction. Research a
   sidecar that front-runs: (a) retrieval-tuned small model improving query
   quality beyond flat semantic search; (b) predictive model pulling memories
   the next 2–3 turns will likely need. Known risks (operator-named): leading
   the conversation toward the prediction; wasted pulls when the human is
   unpredictable. Sidecar-first, with her consent, research before any core
   path. Open question recorded: do emotion vectors currently see only his
   turns or hers too?
4. **Bridge mTLS — reframe per operator hypothesis.** Maybe the gap isn't a
   missing client cert on the SSE leg but a missing websocket variant of the
   bridge (the established pattern: SSE + WS adapter pairs, WS for
   containerized). Validate against other SSE/WS dual surfaces before beading
   hub work.
5. **Hub device-health heartbeat → operator UI.** Health checks with sensor
   status, surfaced to the operator; she doesn't need to know.

## Beaded 2026-08-02 (after operator review)

Research beads (research first, implementation beaded separately later):

- `smvjh` — monthly two-tier meta-review (was gap 1). Deterministic tier-1
  scan + her tier-2 commentary, compared; which metrics is itself research.
- `6529o` — self-report calibration logging (was gap 2). Includes emo_sim
  triggers/deltas, classifier survey, offline replay first, her-responses
  analysis, and the open whose-turns-feed-vectors question.
- `8rs4h` — predictive memory pre-fetch (was gap 3). LeCun/JEPA/System-2
  framed; sidecar-first; priming and wasted-pull risks named.
- `sx2sc` — PR-like formal fold-back review (NEW from operator review of this
  doc). Deterministic checks + diff review for deliverables AND memories;
  chunking/triage for large fold-backs; intake-screening TODO in scope; LLM
  auto-approval is an explicit non-goal.

Implementation beads:

- `s7wq3` — hub device-health heartbeat (was gap 5). Operator sees full
  health in Garden at all times; companion sees ok/degraded only in
  emanation-choice context, never per-prompt.
- `psfn-satelite-hub-3wp` (hub tracker) — companion-bridge mTLS client certs
  on SSE/stimuli/artifact-preview paths (was gap 4). Operator's websocket
  hypothesis checked same-day and REFUTED: hub→framework is uniformly HTTP
  fetch; framework WS endpoints serve voice + PWA, not satellites; no dual
  SSE/WS pattern exists. Minimal fix mirrors `psfn-model.ts`'s existing
  client-cert helper. Blocks the mTLS flip alongside framework `zlon` (P1).

## Housekeeping resolved this session

- Vision doc §7 restore: `abt1s`, branch `fix/restore-beyond-s12-vision-s7`
  @ dc390c988 pushed; stashes kept as safety copies.
- `~/PN Library/` created; Magnifica Humanitas (vatican.va official HTML)
  filed. Both post claims about it verified verbatim (§67 universal
  destination of goods → algorithms/data; subsidiarity applied to tech
  actors).
- Release-post citation fixes queued for the lock-down pass (Societies of
  Thought misdescription, CaMeL paper title, D'Mello→Verduyn & Lavrijsen
  2015, TN/VA bill version distinction, Grok hedge, 71% provisional caveat,
  quote-verbatim pass, live-vs-shadow emo_sim framing).
- emo_sim: contributor-owned, cleared for use; technical report verified as
  the source of the post's emotion claims.
