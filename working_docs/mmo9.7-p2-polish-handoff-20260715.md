# mmo9.7 P2 polish wave — handoff (2026-07-15)

Five beads (mmo9.7.3/.5/.6/.7/.8) implemented, adversarially reviewed (single-pass Pi @ high per operator direction), remediated, and merged to `feat/mmo9-performance` → PR #84. Two P1s were found by review, independently verified, and fixed in scoped remediation passes. Everything below is **nonblocking** — recorded here per the delivery loop, deliberately NOT filed as beads.

## Verified-and-fixed (for the record)
- **.7.7 P1:** mid-turn cancel zeroed the accumulated partial (accumulators declared inside the `try`). Fixed `c935b3be8b` + regression test.
- **.7.6 P1:** chat-turn correlation carried no `companionId` (ICP-only), so the hardened fail-closed affinity derivation silently withheld the session-keyed cache token on every human turn. Fixed `c46cd8f048` (companion's configured identity as fallback; ICP wins) + regression tests + report-truthfulness corrections.

## Nonblocking P2 observations

### mmo9.7.5 (voice control guard)
1. Bare single-word controls that double as semantic verbs (`pause`, `cancel`, `wait`, `again`) are exact-match swallowed; the realistic false-positive path. Consider requiring a trailing deictic ("pause that") or dropping the bare forms.
2. WS multi-final sessions: only the classified final is guarded; a "stop" arriving as a *second* STT final in one session can still reach the model (safe direction — model handles it; content never swallowed). Document the single-final assumption or classify the last final.
3. Discord `lastAssistantUtterance` never cleared on `leaveChannel` — same-user stale replay after rejoin, not a privacy cross.
4. Spoken stop/interrupt cannot interrupt in-progress Discord playback (pre-existing capture suppression); the guard fires only when the companion is idle. Don't over-read the bead's claim.
5. Streaming path records the utterance for repeat only on full completion (arguably desirable).

### mmo9.7.3 (boundary accounting)
1. The fail-closed accountability guard enforces **in-process only** — `workSpec` is not in the gateway RPC contract, so in the split topology the gateway-side client never sees it. Spend is still recorded (gateway wires the recorder); either thread the spec/lane through `LLMCompleteParams` or narrow the claim to in-process.
2. Add a test asserting `Object.values(RUNTIME_LANE_CLASSES)` ⊆ the migration CHECK list (enum↔CHECK drift guard).
3. Reconsider the `(companion_id, runtime_lane_class, model, recorded_at_ms)` index column order vs. actual Garden query shapes.
4. Legacy direct (non-workSpec) autonomous `complete()`/`stream()` calls remain unguarded; forcing all autonomous paths through `completeWithWorkSpec` is a broader migration.
5. Event fingerprint intentionally excludes `runtime_lane_class` (replay-safety across the migration boundary) — two events differing only in lane dedup-collide by design; revisit if lane ever becomes identity-bearing.

### mmo9.7.7 (subagent workspec)
1. `telemetryVisibility` lane-reconciliation: the parity-safety comment in `work-spec.ts` overclaims; a spawn whose context correlation carries `companion_private` would throw non-retryably at spawn. Force the field off in the spec or fix the comment. (Latent — no confirmed reachable path.)
2. `budget_limited` maps to registry `lifecycleState:'failed'` (`stateReason:'budget_exhausted'`); a future resume feature needs a budget terminal on the registry state machine.
3. Subagent stream accounting purpose changed `chat` → `background` (deliberate correction — worker already models on the background slot); flagging since it's an attribution reclassification.
4. Every non-cancel error collapses to `outcome:'blocked'`; taxonomy lacks an `error` outcome.

### mmo9.7.6 (prompt cache)
1. Cross-contact scoping is defense-in-depth **requiring `viewerMemorySubjectContactId` population** — unknown speakers in shared rooms fold to the same empty contact scope (byte-prefix-matching providers can't leak content across identical bytes; key-only-affinity providers are the exposure class).
2. Token format rotation (16→24 hex) orphans warm provider cache entries once on deploy — one-time cost blip, expected.
3. Appraisal's system prompt is 100 % stable but not wired to a cache plan (latent ~78 % savings on that lane) — candidate future bead.
4. Live benchmark (provider round-trip, cache_read pricing) deliberately not run — owned by psfn-framework-9hyv on one companion before any broadening.

### mmo9.7.8 (scheduler)
1. No `runAt` finiteness check in `register()`/`updateTask()` for one-shots — benign (arms at ceiling), pre-existing, unreachable from the sandbox layer.

## Process notes
- UBS criticals on every bead were blame-verified pre-existing (connectionId equality, test-fixture tokens, etc.); zero criticals on new lines across all five diffs.
- `feat/mmo9-performance` carries a known pre-existing dirty repo-wide tsc baseline (ICP/e2e/kube branded-type errors); all touched files are type-clean.
- mmo9.7.4 (welfare) landed on main from the other session mid-wave; reconciled into this branch with both new Postgres migrations verified coexisting (750 tests incl. both real-PG integration suites).
