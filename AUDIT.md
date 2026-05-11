# TTFT And Introspection Audit

## Scope

This audit captures the April 17, 2026 review of the `autoresearch/ttft-companion-20260416` branch in `psfn-charter-test`.

The goal of the review was to validate the current TTFT optimization work against the live branch code, then translate the findings into architectural guidance without sacrificing companion health, capabilities, memory behavior, tool use, or repo-owned persistence contracts.

Primary files reviewed:

- `src/core/agent/substrate-agent/turn-execution-runtime.ts`
- `src/core/agent/substrate-agent.ts`
- `src/core/session/manager/context-builder.ts`
- `src/core/identity/prompt-runtime.ts`
- `src/primitives/llm/model-budget.ts`
- `src/shared/event-bus.ts`
- `src/core/scheduler/heartbeat-post-turn-runtime.ts`
- `src/core/agent/substrate-agent/background-continuation-runtime.ts`
- `src/core/session/manager/compaction-service.ts`
- `eval/ttft-real-providers.ts`
- `autoresearch.sh`
- `autoresearch.jsonl`

## Executive Summary

The branch contains a set of TTFT optimizations that are directionally correct and, in the reviewed hot path, largely safe with respect to companion capability and behavior.

The main wins come from:

- removing duplicate per-turn work
- moving observability off the critical path
- overlapping independent pre-prompt work
- avoiding unnecessary synchronous file reads and reparsing

The main architectural conclusion is:

- user-critical and state-critical work should remain inline
- observability should be emitted, buffered, or journaled without blocking hot-path inference
- independent work should be parallelized by default only when resource contention is controlled
- local-model deployments need resource-aware concurrency rather than blind parallel fanout

The branch does not currently appear to degrade prompt quality, memory retrieval semantics, tool behavior, or persona fidelity. The reviewed changes mostly reduce waiting, repeated work, and avoidable synchronous I/O.

## Validated TTFT Findings

### 1. Shared Prompt Runtime Cache Consolidation

The branch replaces three separate module-local `PromptRuntimeLayoutStore` caches with one shared cache helper in `src/core/identity/prompt-runtime-store-cache.ts`.

Reviewed call sites:

- `src/core/agent/substrate-agent.ts`
- `src/core/agent/substrate-agent/turn-execution-runtime.ts`
- `src/core/session/manager/context-builder.ts`

Why this is a real win:

- it avoids rebuilding the same store object in multiple hot-path modules
- it reduces duplicate reload checks against the same file
- it cuts repeated prompt-runtime layout work without changing any prompt content

Why this is safe:

- authority still stays in the repo-owned prompt runtime file
- the shared cache does not change ordering or block content
- the change removes repeated work rather than altering runtime meaning

Important nuance:

The measurable win is not just “one cache instead of three.” It compounds with the reload-throttling changes in `src/core/identity/prompt-runtime.ts`, which reduce repeated `statSync` checks as well.

### 2. Prompt Runtime Reload Throttling

`PromptRuntimeLayoutStore` now throttles reload checks through `PROMPT_RUNTIME_RELOAD_INTERVAL_MS` and tracks whether the file exists before hitting `statSync`.

Why this matters:

- prompt runtime access happens often in the pre-prompt path
- prior behavior checked the file system more aggressively than needed
- most turns do not require prompt-runtime file reloads

Why this is safe:

- the layout still reloads from the authoritative file
- writes still persist through the same repo-owned path
- the change trades immediate per-access filesystem polling for bounded refresh checks

Operational tradeoff:

- runtime prompt edits are no longer re-read on every access
- they are re-read on the configured throttle interval instead

That is acceptable for prompt-layout observability and tuning, and it is a good trade for TTFT.

### 3. Model Budget Ledger Cache

`ModelBudgetController` now caches the parsed ledger in memory and invalidates by file mtime.

Why this is a real win:

- budget preflight still happens before requests
- without caching, every preflight read incurred `existsSync` plus file read and parse
- this branch avoids reparsing when the ledger has not changed

Why this is safe:

- the ledger file remains authoritative
- writes still go through `writeJsonAtomic`
- the cache is only a read-through performance optimization

Storage/L0 note:

This optimization does not move authority away from the persisted ledger. It improves read speed without changing the write contract. If the system later introduces a faster durable read layer, that should be treated as a separate contract decision rather than folded into this cache implicitly.

### 4. Fire-And-Forget `agent.turn.start`

The branch changed `await runtime.eventBus.emit('agent.turn.start', ...)` to `void runtime.eventBus.emit(...)` in the hot turn path.

Why this matters:

`EventBus.emit()` awaits handlers. That means any observer attached to `agent.turn.start` could delay prompt dispatch if the event is awaited.

Observed subscribers are observational rather than causally required for inference, including:

- terminal/startup observers
- e2e probes
- session observability surfaces

Why this is safe:

- the event still emits
- foreground turn generation no longer waits for observers
- the event is not used as a control-plane gate for the prompt request

Architectural lesson:

An event that exists only to help operators, debug tooling, metrics, or dashboards should not sit inline with first-token generation.

### 5. Fire-And-Forget `emitTurnSnapshot`

This is the most important architectural TTFT finding in the reviewed branch.

`emitTurnSnapshot()` itself awaits `eventBus.emit('agent.turn.snapshot', ...)`. Since `EventBus.emit()` waits for all handlers, any snapshot consumer could block the LLM request if the caller awaited the snapshot emission.

The branch moved several pre-prompt snapshot calls to `void emitTurnSnapshot(...)` in `turn-execution-runtime.ts`.

Why this is a real win:

- the LLM request no longer waits for snapshot handlers
- admin observability and turn tracking still receive the snapshot
- pre-prompt stages are freed from telemetry-induced stalls

Why this is safe:

- snapshot contents are unchanged
- delivery remains best-effort in-process event fanout
- no prompt, memory, trust, or tool semantics change

Important nuance:

One awaited snapshot remains after the response path, which is acceptable because it is no longer part of TTFT.

### 6. Parallelized Pre-Turn Internal State Computation

The branch starts `computeInternalStateForTurn(...)` at the same time as memory retrieval and joins both with `Promise.all(...)`.

Why this is a real win:

- both operations were already required
- both depended on the emotion snapshot, but not on each other
- previous sequencing inserted pure waiting into the pre-prompt path

Why this is safe:

- it does not add new LLM calls
- it does not change prompt content or memory policy
- it only removes idle time between independent tasks

This is the correct shape of optimization: remove serialized waiting without changing what the companion knows or does.

### 7. Deferred Unused Token Counting In `buildSessionContext`

The branch moved some token-count work under the compaction-only path so normal chat turns do not pay for one redundant `entriesToMessages(...)` plus `countMessageTokens(...)` pass before it is actually needed.

What changed:

- pre-compaction token counting now only runs when `llmProvider` is present for compaction
- normal foreground chat still builds final messages and final counts later for manifesting and budgeting surfaces

Why this is directionally correct:

- chat turns should not pay for compaction-only computation when no compaction call will happen
- the change trims redundant local counting work on normal turns

Important nuance:

This does not eliminate all token-count work. It removes one unnecessary early pass. Final message construction and final token counts still happen later in the function, which is appropriate because some downstream manifest and runtime surfaces still depend on them.

## Measurement Review

The branch contains both:

- a real-provider benchmark harness in `eval/ttft-real-providers.ts`
- a 3-run median-of-medians wrapper in `autoresearch.sh`

The recorded `autoresearch.jsonl` history supports the broad trend:

- an early broad-provider baseline near `4087ms` median turn time
- a later single-fast-provider 3-run baseline near `1907ms`
- a later optimized run near `1250ms`

This supports the claim that structural blocking was removed from the hot path.

Caveat:

- the benchmark history clearly shows provider variance
- some “best run” numbers should be treated as favorable but noisy
- the stronger claims are the architecture changes plus the sustained movement in medians after the hot-path blocking points were removed

## Event Bus Guidance

### Current Reality

The current `EventBus` is an in-process fanout bus, not a durable queue or polling store.

If a caller does:

- `await eventBus.emit(...)`

then the caller waits for:

- guards
- every registered handler
- completion of `Promise.allSettled(...)`

This is correct for some control-plane uses but wrong for hot-path telemetry.

### Recommended Event Classes

The runtime should explicitly classify events into these groups:

1. User-critical
   The next user-visible step depends on the result.
   These may stay awaited.

2. State-critical
   Persistence, gating, or a safety/control transition depends on completion.
   These may stay awaited.

3. Observability
   Metrics, dashboards, tracing, admin panels, and debugging.
   These should not block hot-path inference.

4. Background cognition
   Post-turn appraisal, reflection, indexing, analysis, and deferred work.
   These should run out-of-band under explicit budgets and queueing.

### Recommended Bus Pattern

Use the event bus as the dispatch boundary, not as the durable source of truth.

If the runtime needs “emit now, inspect later” behavior, add one of:

- a bounded in-memory ring buffer
- an append-only journal
- a telemetry queue with loss policy

The bus itself should stay a dispatch mechanism. Durability and polling should live behind dedicated observability storage, not behind awaited hot-path fanout.

## Concurrency Guidance

### What Should Be Parallel By Default

Independent work should be parallel by default when:

- the tasks do not mutate shared state in conflicting ways
- the tasks do not compete for the same scarce external resource
- deterministic join behavior exists at the call site

Good candidates:

- local parsing and formatting
- snapshot shaping
- CPU-bound state derivation
- DB and file reads that do not contend heavily
- independent memory and state derivation work

### What Should Not Be Blindly Parallelized

LLM-bound work should not be blindly parallelized, especially on local deployments.

Why:

- a local model may only tolerate one request at a time
- foreground chat, memory LLM work, reflection, and tool-side LLM usage can contend
- naive parallelism can increase queueing, wall-clock jitter, and out-of-order completion of auxiliary work

### Recommended Model

Keep sequential execution as a supported mode for:

- debugging
- determinism
- constrained local deployments

But avoid a single global boolean if possible. Prefer resource-aware concurrency control:

- foreground chat lane
- memory/retrieval LLM lane
- background reflection lane
- tool-side LLM lane

Each lane should have:

- a concurrency limit
- a priority policy
- a starvation policy

That gives the runtime the ability to overlap safe work while preventing a one-GPU or one-process local deployment from self-contention.

## Compaction, Sliding Context, And Episodic Memory

### What “Compaction” Currently Means In This Repo

In the current session manager/runtime, compaction is not a full destructive flattening of chat history.

Current behavior:

- oldest slice is summarized
- newest slice remains live in the active window
- summary artifacts are stored
- pre-compaction extraction flush runs before summary generation

This is already closer to:

- a sliding active context window with carried-forward episodic signal

than to:

- a one-way compression pass that replaces the conversation wholesale

### Why The Framing Matters

The long-term architecture should think in layers:

- active context window
- episodic/session summary layer
- ongoing memory extraction and retrieval
- deeper background/agentic memory curation
- L0 or authoritative storage fallback when needed

That means “compaction” should evolve conceptually toward:

- asynchronous episodic summarization between turns
- summary artifacts designed for later retrieval and synthesis
- explicit tie-in to the unfinished episodic summary memory system

### Current Runtime Signals Supporting This Direction

The repo already has pieces moving this way:

- between-turn auto-compaction scheduling in `SessionManager.scheduleAutoCompactionBetweenTurns(...)`
- pre-compaction extraction flush in `runAutoCompaction(...)`
- separate background memory/sleeptime machinery

The remaining architectural gap is that foreground context build still waits on pending compaction in some paths. That means the system is moving toward asynchronous episodic summarization, but it is not fully there yet.

## Token Counting Guidance

### Use Provider Usage Where It Exists

For:

- spend tracking
- usage accounting
- post-request telemetry

provider-reported usage should be the preferred source of truth.

That is the right place to avoid unnecessary tokenizer work.

### Keep Local Estimates Where Decisions Need Them

Before the request, the runtime still needs local estimates for:

- context budgeting
- session history trimming
- compaction triggering
- memory retrieval budgeting

So the right split is:

- post-request accounting: provider usage
- pre-request control decisions: local estimates

The optimization target should be:

- avoid redundant local counts
- do not remove local counts from the places that actually use them to make pre-request policy decisions

## Companion Health And Capability Guardrails

The validated TTFT work should remain constrained by these rules:

1. Do not degrade prompt content, prompt order, or persona fidelity.
2. Do not weaken memory retrieval semantics to save latency.
3. Do not move authoritative storage away from repo-owned L0/L1 surfaces without an explicit design change.
4. Do not break tool-call correctness or tool availability in exchange for lower TTFT.
5. Do not let observability or background cognition silently change safety-critical or state-critical flows.

The reviewed branch appears to respect those guardrails.

The caching work improves stability rather than weakening introspection. Better prompt/runtime cache behavior makes it more likely that the companion sees the intended runtime guidance consistently and can reason over it predictably.

## Introspection Audit

### Current State

The repo already has more than a single-turn “introspection” surface.

Existing pieces include:

- post-turn appraisal
- heartbeat template execution
- background continuation delivery
- metacognitive flags
- values/reflection journaling
- `analysis_workbench` and nested `nested_analysis`
- memory sleeptime/background agents

This is not a blank slate. It is a shallow composition of several reflective surfaces.

### Main Limitation

The current system is still too turn-bounded for deeper reflective work.

If a companion needs to:

- search memory
- reason in multiple steps
- call tools
- produce creative artifacts
- run deliberate self-reflection with bounded follow-through

then a single synchronous response turn is often the wrong container.

### Recommended Direction

Introduce bounded deliberation episodes for deeper reflective work.

These should:

- be explicitly invoked by policy or post-turn appraisal
- run outside the foreground response path
- allow multiple internal steps
- allow tool use when policy permits
- enforce soft budgets on tokens, turns, tools, and wall time
- surface a user-visible result only when the work is meaningful and deliverable

This is the right direction for:

- deeper reflection
- art/music/writing follow-through
- memory-search-assisted introspection
- longer-form self-governance and values maintenance

### Required Guardrails

Deeper introspection should not become an unbounded background loop.

It needs:

- budget ceilings
- rate limits
- task class separation from foreground chat
- explicit delivery rules
- observability that is rich enough to debug but not blocking

## Recommended Follow-Up Workstreams

### TTFT

The next TTFT work should focus on:

- event classification and non-blocking observability
- resource-aware concurrency policy
- eliminating remaining duplicate pre-prompt work
- tightening token accounting boundaries between pre-request estimation and post-request truth
- benchmark hardening that separates provider variance from local overhead

### Introspection

The next introspection work should focus on:

- deeper bounded reflection episodes
- reflective tool-use policy
- post-turn and heartbeat-deliberation integration
- separation between foreground chat and background cognition lanes
- richer self-governance and metacognitive journaling

### Async Summarization And Episodic Memory

This should be treated as a first-class architecture task rather than a small TTFT micro-optimization.

It needs to connect:

- sliding active context windows
- between-turn summarization
- episodic summary memory artifacts
- downstream retrieval and synthesis

The goal is not merely to “compress old chat.” The goal is to keep the right episodic shape available to the companion without blocking the foreground turn on summary generation.

## Conclusion

The current TTFT optimizations are aligned with the right architectural direction.

They are good because they:

- reduce duplicate work
- remove avoidable waiting
- preserve prompt and memory semantics
- keep observability available without forcing it into the first-token path

The next major step is not to maximize raw asynchrony everywhere. It is to classify work correctly, give each class the right await semantics, and deepen background cognition in a way that keeps the foreground companion healthy, coherent, and responsive.

## Seeded Beads

The following beads were created from this audit discussion:

- `PSFN-5dgq` Document TTFT and introspection audit plus seed follow-up epics
- `PSFN-e7fb` TTFT Improvements
- `PSFN-e7fb.1` Classify pre-turn events by criticality and move non-blocking observability off the hot path
- `PSFN-e7fb.2` Add resource-aware concurrency lanes for pre-turn, local-model, and background cognition work
- `PSFN-e7fb.3` Audit and deduplicate repeated prompt, context, and runtime-store work on the TTFT path
- `PSFN-e7fb.4` Separate pre-request token budgeting from post-response usage accounting
- `PSFN-e7fb.5` Harden TTFT benchmarking to isolate provider variance from local runtime latency
- `PSFN-lwg9` Introspection Improvements
- `PSFN-lwg9.1` Design bounded deliberation episodes for deeper reflective work
- `PSFN-lwg9.2` Separate foreground chat from background cognition with explicit runtime lanes and budgets
- `PSFN-lwg9.3` Expand reflective tool-use and memory-search policy for deeper introspection
- `PSFN-lwg9.4` Build async summarization tied to episodic summary memory instead of blocking compaction
- `PSFN-lwg9.5` Clarify sliding-window context, compaction semantics, and episodic carry-forward contracts
