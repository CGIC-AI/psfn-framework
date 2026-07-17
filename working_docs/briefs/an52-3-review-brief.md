# Adversarial review brief — psfn-framework-an52.3 (P1)

You are reviewing commit `e147c43648` (range `main..work/an52-3-per-companion-tier`, single commit). The full diff is pre-exported at `working_docs/briefs/an52-3-review.diff` relative to this worktree root. You may also read any file in the tree.

## The bug being fixed (bead spec)

Gateway `capabilityTierProvider` was process-global: one `CapabilityRuntime` rooted at a single fixed `companionDataDir`, with the same closure handed to (1) the approval boundary's autonomous auto-clear (`approval-boundary.ts`), (2) the LLM/channel eligibility gate (`privileged-core.ts`), and (3) shard-backend admission (`shard-backends.ts`). In one-gateway/N-companion fleet topology, every companion has its own `capability-tier.json`, but all connected companions were treated as having the single hydrated companion's tier.

Required fix properties (acceptance):
- Tier resolved per authenticated connection's companion id in multi-companion mode, from that companion's own companionDataDir — mirroring the existing per-companion workspace/policy resolvers in `server.ts`.
- ALL THREE consumers covered (approvals, eligibility, shard backends) — not just shard backends.
- Fail closed when the authenticated companion or its tier file is unavailable — no silent fallback to the global root's tier in multi-companion mode.
- Single-companion behavior unchanged.
- Two-companion regression test (A autonomous, B apprentice): B denied autonomous-only paths (shard backend, approval auto-clear) while A admitted.

## Your task

Adversarial review. Do NOT approve-by-default; actively try to refute the fix. For every claimed defect, give a concrete failure scenario (inputs/state → wrong behavior) and file:line. Grade severity honestly against this Blocking Risk Standard — IMPORTANT (P0/P1) only for: partner-data security/privacy/isolation breaks, real data loss or secret exposure, a broken core acceptance path, or a mandatory gate failure. Everything else is a nonblocking observation.

Specific attack surfaces to probe:
1. **Spoofing/confusion**: can any caller influence which companion id the tier is resolved for (e.g. unauthenticated connections, correlation.companionId trust, connection rebinding)?
2. **Fail-open holes**: any path in multi-companion mode that still reaches the base/global runtime's tier (e.g. `resolveAccess(undefined)`, error swallowing, cache poisoning, companion missing from fleet map)?
3. **The three consumers**: is each one actually receiving the per-companion resolution at runtime (trace the wiring, not just types)? Does shard-backends still work with its zero-arg contract?
4. **Cache/lifecycle**: per-companion runtime caching — stale tier after hot-reload of capability-tier.json? (The base runtime hot-reloads on mtime; do per-companion runtimes?)
5. **Single-companion regressions**: any behavior change when multiCompanion is disabled?
6. **Test honesty**: do the new tests prove the acceptance criteria, or do they stub the very thing under test?

## Output format

Markdown report: verdict (SHIP / SHIP WITH FIXES / BLOCK), then findings ordered by severity, each with severity, file:line, concrete failure scenario, and suggested fix. Note explicitly which of the 6 attack surfaces you checked and found clean.
