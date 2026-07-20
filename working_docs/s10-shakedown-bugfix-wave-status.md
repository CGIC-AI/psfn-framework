# S10 Shakedown Bugfix Wave (epic ahxy) — status

Date: 2026-07-20. Branch: `feat/ahxy-s10-shakedown-fixes` @ 30a6e6c6f (base origin/main a3363dba3).

## Implementation: COMPLETE — 11/11 children closed with evidence

| Bead | What shipped | Review outcome |
| --- | --- | --- |
| jsdc | Garden SPA login loop: auth resolves only on probe success or 401/403 | dual PASS |
| uf2h | memory_patch re-embeds atomically; lexical lane on generated tsvector + GIN | dual PASS |
| ervg + sm9l | CogSec tombstone propagation to every persisted turn-record/continuity surface (origin-channel L0 resolver seam) | dual PASS |
| k6tm | skill_write intake sink (schema v2 + migration CLI) + gateway write-protects the skills root | Pi blocker (fs bypass) verified → remediated |
| fpiu | Attachment-claim guard heals instead of replacing the reply | Pi blocker (multi-marker escape) verified → remediated |
| u4v0 | Shared-satellite response arbitration replaces presence auto-follow | Pi blocker (telemetry ack-and-drop) verified → remediated |
| 189d | Open-threads language at the source; softening shim deleted | Pi blocker (tool-surface prose) verified → remediated |
| dcnu | Wake-orientation anchor deleted; large gaps via temporal note lanes | 2 verified blockers (morning suppression, restart window) + rules cleanup → remediated |
| vinz.29 | Dual-presence classification + latent-space twin mapping (operator blend decision) | dual PASS |
| x6ig | Explicit captured-owner read contract replaces ambient ALS resolution | BOTH reviewers found distinct verified blockers (every-turn-throw; cross-session extraction attribution) → remediated + mock/tool-handler follow-through |

Reparented out mid-wave per operator: w05a.11 (operator-led analysis). q9ra remains an open child epic holding only P3 q9ra.4 (retention automation) — the ahxy epic stays open for that scope alone; implementation is done.

## Wave metrics

- 8 verified P1/P0-class blockers caught by the dual-blind gate after implementer self-validation passed; every one independently verified (file:line or mechanical repro) before remediation. Zero unverified blocker claims accepted.
- 1 merge conflict (tool-schema token-cost golden; constants regenerated from merged truth).
- Follow-up beads filed: 970c (P2, dead Garden admin patch route, discovered-from uf2h), inxe (P1 wave validation, below).

## Deploy prerequisites (live rollout — see validation bead psfn-framework-inxe)

1. `migrate:intake-policy-owner` dry-run/apply BEFORE deploying (v2 boot is fail-closed).
2. Migrate `satellites.json` legacy companionId bindings to sharedDevice form (boot fail-closed).
3. `l2_memories` gains a STORED tsvector column: one-time table rewrite under lock.
4. Expect redaction placeholders on legacy cross-channel continuity until the window rolls.
5. Intake policy seed ships shadow mode — skill_write enforcement requires flipping to enforce.

## Nonblocking observations (report-only, no beads per policy)

- Auth store: no retry after transient 5xx leaves auth unresolved until reload (jsdc).
- In-memory memory-store test double lacks the text-requires-embedding invariant; non-authorized searchByText still substring-ranks; participant-name repair raw-SQL text update bypasses re-embed (pre-existing class) (uf2h).
- Loom over-redaction blanks the whole orientation view on one withheld entry (deliberate fail-closed); pre-plumbing-vintage records' top-level copies cannot be re-resolved (ervg/sm9l).
- Garden operator skill routes are intentionally unscreened (trusted tier — confirm posture); agent-side screening is L1-only like sibling sinks; SkillsRuntime/SkillStore write surfaces remain public at the store layer (k6tm).
- Voice reply-stream aborts rather than heals on attachment claims (pre-existing, invariant-preserving) (fpiu).
- productivityCompanionId is validated/displayed but not yet consumed by arbitration; arbiter is single-process (u4v0).
- Concern lifecycle tool ACTION names (create_concern etc.) remain by contract; stored concern text renders verbatim (189d).
- scheduler.json temporalWakeup.wakeSummary is now an unwired owner knob — needs a config-owner retirement migration (dcnu).
- Twin resolver would benefit from a kind==='virtual' assertion; session presence override needs clear-on-session-end before assertion wiring lands (vinz.29).
- Escape hatch resolveForeignSessionForTurn validates but does not emit its reason to an audit sink (x6ig).
- Cross-wave: work/s10p2-session (u8iv) touches cross-channel-continuity-port.ts/composition.ts — PR-time reconciler must preserve both the redaction seam and u8iv's channel scoping.

## Gates

Per-bead: focused suites + lint on every bead; real-Postgres for uf2h; UBS change-range scans clean; hygiene/settings-contract/hardcoded-settings verifiers green where touched. Integrated: cross-bead suites re-run at each merge; final integrated sweep 173/173 (incl. Postgres integration) + x6ig suites 347/347. Epic seam review: single focused adversarial pass over merge-resolution code, 9 shared files, and composite interaction hypotheses (lean per operator instruction 2026-07-20; per-bead tier was dual-blind throughout).
