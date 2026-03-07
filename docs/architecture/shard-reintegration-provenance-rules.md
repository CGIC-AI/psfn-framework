# Shard Reintegration And Provenance Rules

- Status: Implemented
- Date: 2026-03-07
- Scope: PSFN-oft0.12

## Goal

Define fail-closed reintegration rules for shard outputs and provide an operator checklist to verify provenance before accepting shard-produced memory changes.

## Reintegration Contract

Shard results can re-enter prime runtime state only through approved memory operations. Session transcript state and runtime state are never reintegrated from shard to prime.

| Direction | Sync class | Operation | Decision |
| --- | --- | --- | --- |
| `shard_to_prime` | `derived_memory` | `memory_write` | ALLOW |
| `shard_to_prime` | `derived_memory` | `memory_import_batch` | ALLOW |
| `shard_to_prime` | `derived_memory` | `memory_redact` | DENY |
| `shard_to_prime` | `transcript_fact` | `*` | DENY |
| `*` | `runtime_state` | `*` | DENY |

Enforcement points:

- `src/shards/manager.ts`
  - `enforceShardToolSyncPolicy(...)` gates shard memory tools before execution.
  - `recordSyncPolicyDecision(...)` emits structured `shard.sync.policy` audit events.
- `src/gateway/policy.ts`
  - `evaluateShardSessionMemorySyncPolicy(...)` is the canonical allow/deny matrix.

## Required Provenance Fields

Every approved shard memory mutation must preserve:

1. **Shard identity**
   - `shardId` in `shard.sync.policy` audit payloads.
   - Internal source stamp `__psfnShardSource: "shard:<id>"` injected by `wrapShardTool(...)`.
2. **Source lineage**
   - `sourceContext.channelId` from shard spawn context when available.
   - Optional `sourceContext.requestId` and `sourceContext.turnId` for turn-level traceability.
3. **Memory-level attribution**
   - `sourceRef` format produced by memory tools:
     - `source:shard:<id>|tool:memory_write|invocation:<toolCallId>`
     - `source:shard:<id>|tool:memory_import:<source>|invocation:<toolCallId>`

## Operator Verification Runbook

Run these checks after shard-heavy sessions or before incident closure.

1. Validate policy decisions were recorded and denied operations stayed blocked.

```bash
rg '"shard.sync.policy"' companion-data/shard-session-memory-sync-audit.jsonl
rg '"decision":"DENY"' companion-data/shard-session-memory-sync-audit.jsonl
```

2. Confirm reintegrated memories are shard-attributed.

```bash
sqlite3 "$DATABASE_PATH" \
  "SELECT id, source_ref, created_at FROM l2_memories WHERE source_ref LIKE 'source:shard:%' ORDER BY created_at DESC LIMIT 25;"
```

3. Spot-check runtime audit ordering for a shard lifecycle:
   - `shard.spawn.start`
   - `shard.tool.start` / `shard.tool.end`
   - `shard.spawn.end`

If any shard memory row lacks `source:shard:<id>` attribution, treat it as provenance drift and investigate before continuing autonomous shard execution.

## Incident Rules

- Any denied operation (`decision=DENY`) is expected fail-closed behavior, not an auto-retry condition.
- Do not bypass `memory_redact` denial from shard contexts. Route redaction through prime runtime/operator workflows.
- If provenance is incomplete (`requestId`/`turnId` missing), allow only memory-level traceability and record the gap in incident notes.

## Test Coverage

- `src/shards/manager.test.ts`
  - `stamps shard source provenance on shard memory tools`
  - `denies disallowed shard-to-prime memory sync operations and audits the denial`
  - `logs shard provenance metadata in audit trail entries`
- `src/memory/tools.test.ts`
  - shard source override handling for `memory_write` and `memory_import_batch`
