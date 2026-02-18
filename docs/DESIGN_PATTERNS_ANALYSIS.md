# PSFN Codebase Design Pattern Analysis

This analysis maps concrete implementation patterns to source files in `src/`.

## 1) Observer / Event Bus (Pub-Sub)

The system uses a typed event bus as a decoupling backbone.

- Event contracts: `src/event-bus.ts:8`
- Subscribe/unsubscribe API: `src/event-bus.ts:42`, `src/event-bus.ts:50`
- Emission with guard hooks and fan-out: `src/event-bus.ts:67`
- Cross-module usage examples: `src/runtime.ts:230`, `src/channels/api/server.ts:268`, `src/channels/admin/handlers.ts:240`

## 2) Ports and Adapters (Hexagonal Style)

Core logic depends on interfaces, while concrete integrations implement them.

- Port interfaces: `src/agent-loop.ts:20`, `src/agent-loop.ts:25`, `src/channels/types.ts:5`
- Adapter implementation for Discord: `src/channels/discord/adapter.ts:18`
- Gateway client as remote adapter implementing both AI ports: `src/gateway/client.ts:24`

## 3) Dependency Injection + Composition Root

Entry points assemble dependencies and inject them into runtime components.

- Runtime composition root: `src/runtime.ts:52`
- Gateway process composition root: `src/gateway-main.ts:22`
- Agent process composition root: `src/agent-main.ts:35`

## 4) Command Pattern (Tool Invocation)

Tools are represented as command objects with `name`, schema, and `execute`.

- Tool contract: `src/types.ts:37`
- Registration and dispatch: `src/agent-loop.ts:67`, `src/agent-loop.ts:168`
- Concrete commands: `src/repl/tools.ts:8`, `src/shards/tools.ts:7`

## 5) Proxy Pattern (Gateway RPC Boundary)

The agent talks to external capabilities through a proxy boundary.

- Gateway server exposing methods: `src/gateway/server.ts:245`
- Agent-side proxy wrapper: `src/gateway/client.ts:62`
- Wire protocol contract: `src/gateway/protocol.ts:123`

## 6) Decorator-like Handler Wrapping (Cross-Cutting Concerns)

Gateway methods are wrapped for audit and policy enforcement.

- Auditing wrapper: `src/gateway/server.ts:186`
- Policy-gated wrapper with approval flow: `src/gateway/server.ts:208`
- Wrapped method registration: `src/gateway/server.ts:250`, `src/gateway/server.ts:326`

## 7) Policy/Gatekeeper Pattern

A centralized policy evaluator controls allowed/denied/approval decisions.

- Policy decisions and context types: `src/gateway/protocol.ts:142`
- Decision engine: `src/gateway/server.ts:85`
- URL policy checks: `src/gateway/url-policy.ts:41`, `src/gateway/server.ts:328`

## 8) Pipeline / Layered Sanitization

Untrusted web content is sanitized through explicit multi-stage processing.

- Structural cleanup: `src/gateway/sanitize.ts:37`
- Pattern-based filtering: `src/gateway/sanitize.ts:54`
- Untrusted content tagging: `src/gateway/sanitize.ts:64`
- Pipeline orchestration: `src/gateway/sanitize.ts:86`

## 9) Repository / Data Access Layer

Persistence concerns are concentrated in store classes.

- Session repository: `src/session/store.ts:26`
- Memory repository: `src/memory/store.ts:5`
- Gateway audit repository: `src/gateway/audit.ts:17`

## 10) Stateful Scheduler (State Machine Style)

Tasks move through explicit states and are executed on due checks.

- Task state model (`idle`, `active`, `complete`) handling: `src/scheduler/scheduler.ts:69`, `src/scheduler/scheduler.ts:95`
- Tick-driven execution loop: `src/scheduler/scheduler.ts:64`

## 11) Interpreter / REPL Loop Pattern

The think tool uses an iterative loop that parses model output into actions.

- Parse actions (`code`, `final`, `final_var`): `src/repl/parse.ts:4`
- Iterative LLM -> parse -> execute cycle: `src/repl/loop.ts:28`
- VM-backed execution sandbox: `src/repl/sandbox.ts:30`

## 12) Factory Pattern

Factory functions create configured tools/models.

- LiteLLM model factories: `src/llm/models.ts:24`, `src/llm/models.ts:54`
- Tool factories: `src/repl/tools.ts:8`, `src/shards/tools.ts:7`

## 13) Caching Pattern (TTL Cache)

Model discovery caches external metadata with explicit TTL and invalidation.

- TTL and cache state: `src/llm/discovery.ts:31`, `src/llm/discovery.ts:36`
- Cache hit path: `src/llm/discovery.ts:45`
- Invalidation: `src/llm/discovery.ts:82`

## 14) Concurrency Limiter / Worker Pool Control

Shard execution is parallelizable but bounded with explicit active-count control.

- Max concurrency guard: `src/shards/manager.ts:46`
- Active shard tracking: `src/shards/manager.ts:39`, `src/shards/manager.ts:59`

## Summary

The dominant architectural style is event-driven, port-and-adapter composition with explicit policy boundaries and command-style tool execution. Data persistence and external integrations are strongly separated from orchestration logic.
