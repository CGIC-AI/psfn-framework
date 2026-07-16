# Design note: supervisor-granted `preemptionProtected` (psfn-framework-fxt1)

Produced 2026-07-16 by the orchestration design pass (deep-reasoner over main @ e255ed464e). This note is authoritative for the fxt1 implementation.

## 1. Conclusion

Only mechanism **(a) — gateway verifies `welfare_claimed` in the background-work store** — is a real fix. It is the *only* option that actually distinguishes a genuine welfare-escalated call from a forged one, because welfare eligibility is dynamic runtime state that lives solely in the store; no lane, transport-identity, or self-signed token the caller can present manufactures that authority. Enforce it by **stripping `preemptionProtected` at the gateway RPC handler (`methods/llm.ts`) before the workSpec reaches the gateway-side gate**, honoring it only when a wire-carried welfare job id verifies as `welfare_claimed = true AND state='running' AND owned by the authenticated companion`. Fail closed = strip to unprotected.

## 2. Established facts (traced on main)

**Where the flag becomes effect.** Consumed at exactly one place: `ModelCallGate.grant()`, `src/primitives/llm/model-call-gate.ts:368` — `preemptable: isPreemptableLane(runtimeClass) && !preemptionProtected`. The gate lives on the LLMClient (`src/primitives/llm/client.ts:251`). In the split topology the **gateway-side** LLMClient owns the meaningful gate; `methods/llm.ts` invokes it with the parsed wire spec (`llm.complete` handler `src/boundary/gateway/methods/llm.ts:222,258`; `llm.chat` `:131,178`).

**Legit welfare path, end to end.** Supervisor claims a job welfare and sets `welfare_claimed` (`background-work-store.ts` claimNext, cols at `:62,120,228`; supervisor policy `supervisor.ts:265-280,495-501`). The **agent** process reads `job.welfareClaimed` and passes `preemptionProtected: job.welfareClaimed` at `src/core/agent/background-work/post-turn-runtime.ts:268` (extraction) and `:319` (appraisal) → `extraction.ts:320/514/624` → `buildLLMWorkSpec` (`src/primitives/llm/work-spec.ts:62`) → `completeWithWorkSpec` → agent GatewayClient serializes via `toWorkSpecWireParams` (`src/boundary/gateway/client.ts:644,754`) → wire → `parseWorkSpecWireParams` (`work-spec-wire.ts:141-143`, bare boolean passes through) → gateway LLMClient options.workSpec → `runWithFallback` (`client.ts:1903,1578,2081`) → `runWithModelCallGate` (`client.ts:773`) → gate. Welfare escalation **does** cross the same wire as any other call — a blanket strip kills welfare.

**Trust model.** Gateway RPC is authenticated per connection (`server.ts:66 verifyCompanionAuthToken`; connection-bound `companionId`, mismatch → disconnect `protocol.ts:98-104`). The gateway has `authenticatedCompanionId()` per call (`methods/types.ts:65`). External API traffic never sets a workSpec directly. The "forger" is a buggy or non-welfare agent code path, or a compromised agent — defense-in-depth, not anonymous-attacker.

**Store ownership.** The background-work store is agent-side only (constructed in `src/app/agent/core-runtime.ts` / `core-bootstrap.ts`); `GatewayMethodRuntime` (`methods/types.ts:31-95`) has no store — but the gateway process already connects to Postgres and constructs several `PostgresXStore.connect(databaseUrl)` stores (`app/gateway/main.ts:380-381` etc.), so a narrow read-only welfare-verify accessor is feasible.

## 3. Why the alternatives lose

- **(b) lane/identity scoping is a no-op.** The flag is already inert on every non-preemptable lane (`isPreemptableLane` false for `foreground_chat`, `post_turn_appraisal` — `worker-lanes.ts:122,135`). It only bites on `background_continuation` and `maintenance_reflection` (`worker-lanes.ts:148,162`) — exactly the welfare-eligible lanes, same lane and same authenticated identity for legit and forged alike. (b) strips only where the flag was already dead. False security.
- **(c) grant handle reduces to (a) with more moving parts.** A token transports authority, it can't create it; the mint decision still needs store state — plus a TTL/nonce/keyring surface (second credential system, Law 12.4-disfavored) and a stale-grant race. Rejected.
- **(a) is the d8vq.2 pattern applied correctly** — caller declares, server re-verifies against the single authority (for `lane` that's the resolver, `client.ts:647-665`; for `preemptionProtected` it's the store's `welfare_claimed`), fail closed on mismatch. Not a second admission system.

## 4. Blast radius (context)

A forged flag makes an in-flight background-lane call non-preemptable for its own duration only. No queue-priority jump; no foreground-reserved-slot capture (`effectiveCapacity` excludes non-foreground lanes from `reservedForegroundSlots`, `model-call-gate.ts:298-303`). Exposure: default single-slot/zero-reservation endpoints, where foreground waits at most one model-call duration. Bounded, self-healing, reachable only by trusted agent code — but it inverts the welfare guarantee, hence this fix.

## 5. Implementation plan

1. `src/shared/contracts/runtime.ts` (LLMWorkSpec, ~:1512) + `src/primitives/llm/work-spec.ts` (`LLMWorkSpecInput`, `buildLLMWorkSpec`): add `welfareGrantJobId?: string`. Purpose-built field; do NOT overload `workloadId`.
2. `src/primitives/llm/work-spec-wire.ts`: carry `welfareGrantJobId` on the wire; `parseWorkSpecWireParams` validates fail-closed (must be a non-empty string when present; reject non-string).
3. `src/core/agent/background-work/post-turn-runtime.ts:268,319`: set `welfareGrantJobId: job.jobId` **only** when `job.welfareClaimed`, paired with `preemptionProtected`, threaded through extraction/appraisal options into `buildLLMWorkSpec`. Add an AST/lint backstop (mirror the existing autonomous-workspec-enforcement pattern) making the sanctioned path the only setter of `preemptionProtected`.
4. `src/boundary/gateway/methods/types.ts`: add `verifyWelfareGrant(jobId: string, companionId: string): Promise<boolean>` to `GatewayMethodRuntime`.
5. `src/app/gateway/main.ts`: construct a narrow read-only welfare-verify accessor over the existing `databaseUrl` (single indexed SELECT on `agent_background_work_jobs`). Rows carry `logical_session_id`, not companionId — resolve companion ownership via the gateway-side session→companion resolution, or scope the check accordingly. VERIFY during build which binding is available; the ownership clause is mandatory (without it, companion A can borrow companion B's genuinely-welfare-claimed job id on a shared endpoint).
6. `src/boundary/gateway/methods/llm.ts` (`resolveRpcWorkSpec` + both handlers): when `preemptionProtected === true`, verify; on ANY failure (absent/invalid grant id, `welfare_claimed=false`, wrong state, companion mismatch, DB/verify error) **delete the key from the forwarded workSpec** so the gate never sees unverified `true`. Query only when the flag is true — the hot path pays nothing.

**Fail-closed semantics:** every failure strips → call proceeds preemptable. Degradation equals pre-welfare FIFO behavior (`supervisor.ts:269` `reserveSlots:0` is the same degradation) — correctness intact, only the anti-starvation optimization lost, self-healing on next claim. No path fails toward protected.

**Race:** supervisor sets `welfare_claimed=true` + `state=running` before dispatch, resets only after the call returns. As implemented, the gateway verifies at RPC-handler entry (`resolveRpcWorkSpec`), which is earlier than the gate-acquire inside the provider call — a supervisor reset in that gap leaves the call protected for its own duration on a now-invalid grant. Accepted: the window is still inside the sanctioned `[dispatch, reset-after-return]` lifecycle and the blast radius is bounded to the call's own duration (§4). Reset before handler entry (abandoned/expired) → verify fails → strip.

## 6. Test plan

- **Adversarial:** forged `preemptionProtected=true` with (i) no `welfareGrantJobId`, (ii) grant id whose row has `welfare_claimed=false`, (iii) a valid welfare job id owned by a different companion → each stripped; assert the gateway gate grants the slot `preemptable=true` (a subsequent foreground acquire preempts). Extend the real-boundary harness in `src/boundary/gateway/model-call-preempt-boundary.test.ts`.
- **Legit:** welfare-claimed job (own companion, `state=running`) retains protection end-to-end — gate `preemptable=false`, foreground acquire does not abort it. Prove the full agent→wire→gateway→gate path.
- **DB-error fail-closed:** `verifyWelfareGrant` throws → stripped, call proceeds, no exception propagates.
- **Inert-lane no-op:** protected flag on `foreground_chat`/`post_turn_appraisal` inert regardless of verification.
- **Unit:** wire parse rejects non-string grant id; round-trip through `toWorkSpecWireParams`.

## 7. Version skew / deploy order

Deploy the **gateway first**. Old-agent/new-gateway: welfare calls transiently unprotected (optimization lost, correctness intact — fail-closed). New-agent/old-gateway: unknown key ignored, today's behavior. Document in deploy notes.

## 8. Build-time verification points

(1) Confirm `agent_background_work_jobs` rows can be bound to a companion gateway-side (via `logical_session_id` → companion resolution); if not directly, add companion scoping to the check rather than trusting the caller. (2) Confirm the agent-side job object at `post-turn-runtime.ts:268` exposes the store `job_id`; if named differently, thread the store id explicitly.
