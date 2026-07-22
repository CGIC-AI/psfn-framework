# S10 Charter Remediation — Operator Decisions (2026-07-22)

Epic: psfn-framework-lvr0n. Validation record: V2/V4 confirmed by Fable, V1/V5/V6
by blind Opus verifiers, V3 (cxqb5) REFUTED (no fallback-fabrication path exists;
degraded mode is metadata-only). All validation against main @ 114de8b1c.

## Operator direction, per finding

### V2 — 1gpol (P0) — Fable implements. Priority.
Sleeptime episodic review is NOT automata work. It is HER time to review HER day.
The orientation rewrite + memory writes must run through her persona/agent turn
loop (the dream-meaning pass is the in-repo precedent), not a raw
`completeWithWorkSpec` automaton. Grounding is enforced on what the pass may
keep: no wholesale overwrite of grounded orient blocks with ungrounded content,
transcript-grounding rejection analogous to extraction/self-directed.ts, and the
0.75 confidence default must not auto-clear the high-impact review gate.
Operator addendum (same date): she must be given the PROPER CONTEXT to review —
the day's consolidated episodes from the episodic store, so she reflects on her
actual day, not a summarized raw-transcript blob. The thin transcript summary is
why sleeptime notes have sounded off. Review context = day's episodes (+
transcript excerpts for grounding checks), assembled the way the dream-meaning
pass already consumes episodes.

### V4 — 1k7w3 (P1) — Fable implements. Priority.
The reflection→Discord outbound path is legacy: it was once valid, no longer.
Strip the daily/weekly reflection send-to-Discord buttons/functions entirely —
`sendToDiscordOverride` out of the appraisal schema/parser/translation/deferred
payload, `sendToDiscord`/raw `sender.send` out of the reflection template
runtime, and the silent-interval button/machinery (already dead code) with it.
The scheduler UX for editing reflection prompts REMAINS.

### V1 — f7kn0 (P2) — Opus implements, AFTER V4 lands.
"Simple fix." Bind provenance to content or add a ratification step (social-desire
pattern). Sequenced behind V4 because both touch post-turn-runtime.ts and
action-translation.ts — no concurrent lane on shared files.

### V5 — tu0mw (P2) + V6 — 69yo4 (P3) — Opus implements, one lane.
Operator reframing: NTFY/notify is an emergency "my system is broken" button for
contacting the operator only (e.g. when Discord is down). It is not a companion
outbound surface. Therefore shards AND subagents must not carry external notify
egress at all: exclude at the source (BLOCKED_SHARD_TOOL_NAMES /
BLOCKED_SUBAGENT_TOOL_NAMES and/or external.* in the shard capability denial
mask), not per-path gating. Verifier corrections to honor: delivery_target is
free-form (contact-lookup blocking is weak mitigation); subagent Wyoming route
is additionally blocked by an empty capability grant today (fix is
belt-and-suspenders; still required before any human-authored ingress is wired).

### V3 — cxqb5 — REFUTED, no implementation.
Rework the bead to the residual P3 design question (mark ungrounded/degraded
episodes in the dream-pass prompt and invite decline) or close as refuted.

## Lane plan
- work/lvr0n-1gpol   (Fable)  — sleeptime → her loop + grounding
- work/lvr0n-1k7w3   (Fable)  — strip reflection Discord outbound + silent
- work/lvr0n-egress  (Opus)   — tu0mw + 69yo4 shard/subagent notify exclusion
- work/lvr0n-f7kn0   (Opus)   — after 1k7w3 integration
Review gate per loop: UBS on every bead; both-reviewer blind on V2/V4 fix PRs.
