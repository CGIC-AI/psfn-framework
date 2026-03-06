# Shard Session/Memory Sync Policy

- Status: Implemented
- Date: 2026-03-06
- Issue: `PSFN-17lw.3`

## Goal

Define explicit, deterministic boundaries for what can sync between the prime runtime and spawned shards, with fail-closed enforcement and auditable allow/deny decisions.

## Sync Classes

1. `transcript_fact`
   Immutable conversation facts copied from prime context into a shard context pack.
2. `derived_memory`
   Memory retrieval seeds from prime to shard and memory-write/import outputs from shard to prime memory index.
3. `runtime_state`
   Transient runtime/process state (never cross-shard synced).

## Authority Rules

| Direction | Class | Authority | Operation | Decision |
| --- | --- | --- | --- | --- |
| `prime_to_shard` | `transcript_fact` | `prime` | `context_pack_session` | ALLOW |
| `prime_to_shard` | `derived_memory` | `prime` | `context_pack_memory` | ALLOW |
| `shard_to_prime` | `derived_memory` | `shard` | `memory_write` | ALLOW |
| `shard_to_prime` | `derived_memory` | `shard` | `memory_import_batch` | ALLOW |
| `*` | `runtime_state` | `*` | `*` | DENY |
| `shard_to_prime` | `transcript_fact` | `*` | `*` | DENY |
| `shard_to_prime` | `derived_memory` | `shard` | `memory_redact` | DENY |

Any envelope with invalid required fields or mismatched authority is denied.

## Conflict Handling

- Transcript facts are one-way into shard context packs. Shards cannot write transcript/session state back to prime.
- Derived-memory conflicts are delegated to existing memory-writer semantics (dedupe/supersede), preserving one canonical merge path.
- Runtime-state sync is rejected to prevent hidden coupling across shards.

## Idempotency Model

Every sync attempt carries an envelope idempotency key:

- Context-pack session and memory seeds derive from shard id plus source request/turn identity.
- Shard memory writes/imports derive from shard id + tool call id + operation.

This gives deterministic replay identity for audit trails, while memory-level dedupe handles content-level repeats.

## Enforcement Points

- `src/gateway/policy.ts`
  `evaluateShardSessionMemorySyncPolicy(...)` validates envelope shape and applies allow/deny matrix.
- `src/shards/manager.ts`
  - Context-pack assembly enforces `prime_to_shard` policy before reading session or memory blocks.
  - Wrapped shard memory tools enforce `shard_to_prime` policy before executing tool handlers.
  - Denied sync attempts fail closed.

## Audit Contract

- Runtime appends `shard.sync.policy` audit events with envelope fields, `ALLOW`/`DENY`, and policy reason.
- Optional durable JSONL audit stream is persisted at:
  `resolveShardSessionMemorySyncAuditPath(companionDataDir)`
  -> `companion-data/shard-session-memory-sync-audit.jsonl`.

This captures accepted and rejected sync actions with deterministic metadata.
