# Wyoming Shard Routing Policy

- Status: Implemented
- Date: 2026-02-26
- Issue: `PSFN-slsv.7`

## Goal

Make Wyoming-to-shard delegation explicit, default-safe, and auditable.

## Policy Model

Routing policy is configured through `SubstrateConfig.wyomingShardRouting`.

- `enabled`: boolean, default `false`
- `siteAllowlist`: optional list of allowed Wyoming `siteId` values
- `satelliteAllowlist`: optional list of allowed Wyoming `satelliteId` values

Environment variables:

- `WYOMING_SHARD_DELEGATION_ENABLED` (or legacy alias `WYOMING_SHARD_ROUTING_ENABLED`)
- `WYOMING_SHARD_DELEGATION_SITE_ALLOWLIST`
- `WYOMING_SHARD_DELEGATION_SATELLITE_ALLOWLIST`

When `enabled=false`, delegation is denied (`policy_disabled`) even for valid Wyoming sessions.

## Runtime Routing Flow

1. Gateway receives a voice request and detects Wyoming identity (`api:wyoming:*` and/or routing metadata).
2. Gateway evaluates allowlists and stamps `message.routing.wyoming.shardDelegation` with:
   - `eligible: true|false`
   - `reason: eligible | policy_disabled | site_not_allowlisted | satellite_not_allowlisted`
3. Agent receives the message and evaluates delegation again:
   - local config must be enabled
   - gateway hint must be `eligible: true`
4. If both pass, `ShardManager.delegateWyomingSession()` runs the turn in a delegated shard.
5. If delegation is denied or fails, agent uses the primary `agentLoop.handleMessage()` path.

## Continuity Guarantees

Delegated Wyoming turns keep the original message identity context:

- same `channelId` (`api:wyoming:<site>:<satellite>`)
- same `authorId` / `authorName`
- same Wyoming routing context (`connectionId`, `sessionId`, `turnId` when provided)

This keeps session history and identity classification aligned across delegated and non-delegated turns.

## Auditability

Audit trail events capture both decisions and execution path:

- `wyoming.routing.decision`
- `wyoming.routing.delegated`
- `wyoming.routing.primary`
- `wyoming.routing.fallback`
- `wyoming.shard.delegate.start`
- `wyoming.shard.delegate.end`

These events include Wyoming identity context fields when available (`connectionId`, `sessionId`, `turnId`, `siteId`, `satelliteId`).
