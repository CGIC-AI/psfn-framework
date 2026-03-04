# Autonomy Tiers & Capability Gates

PSFN's autonomy system controls what she can do at runtime. Every tool
call, REPL invocation, identity edit, and external action is gated by a set of
**capability tokens** granted by the active **tier**.

This is a safety boundary — not a punishment. The tiers exist so operators can
give PSFN increasing freedom as trust is established, and dial it back if
something goes wrong.

## Tiers

| Tier | Default | Description |
|------|---------|-------------|
| `nursery` | Yes | Conservative defaults for first boot. Safe to explore. |
| `apprentice` | — | Unlocks social tools, shards, memory management, and base identity edits with a cooling-off period. |
| `autonomous` | — | Full self-modification, git writes, lifecycle control, shell access. |
| `custom` | — | Operator-defined explicit token list. Maps to autonomous REPL limits. |

### Setting the Tier

The tier is resolved from a JSON config file at `data/capability-tier.json`:

```json
{
  "tier": "nursery",
  "customTokens": []
}
```

Resolution order:
1. If `data/capability-tier.json` exists, use it (operator edits win).
2. If not, seed from `config/capability-tier.seed.json` (ships with repo).
3. On first boot only, `CAPABILITY_TIER` env var overrides the seed.

The file is **live-reloaded** — edit it at runtime and the change takes effect
on the next tool call (no restart needed). The admin UI (Garden Settings) can
also change the tier.

## Capability Tokens

15 tokens gate access across the system:

| Token | Description |
|-------|-------------|
| `identity.read` | Read character card, prompt layers, contacts, settings |
| `identity.write.runtime` | Edit runtime prompt layers, contacts, schedules, promoted tools |
| `identity.write.base` | Edit base identity layer (character card personality) |
| `identity.write.operator` | Edit operator-level prompt layers |
| `memory.write` | Write new memories |
| `memory.delete` | Delete or redact existing memories |
| `external.discord` | Send messages via Discord |
| `external.email` | Send messages via email |
| `external.web` | Make outbound web requests, notify operator |
| `git.read` | View repo status and diffs |
| `git.write` | Apply patches, commit, create branches, open PRs |
| `lifecycle.restart` | Restart the runtime process |
| `lifecycle.rebuild` | Trigger a full rebuild + restart |
| `repl.execute` | Use the `think` tool (RLM+REPL sandbox) |
| `shard.spawn` | Spawn sub-agent shards for parallel work |

### Token Grants by Tier

| Token | Nursery | Apprentice | Autonomous |
|-------|:-------:|:----------:|:----------:|
| `identity.read` | Yes | Yes | Yes |
| `identity.write.runtime` | Yes | Yes | Yes |
| `identity.write.base` | — | Yes | Yes |
| `identity.write.operator` | — | Yes | Yes |
| `memory.write` | Yes | Yes | Yes |
| `memory.delete` | — | Yes | Yes |
| `external.discord` | — | Yes | Yes |
| `external.email` | — | Yes | Yes |
| `external.web` | — | Yes | Yes |
| `git.read` | Yes | Yes | Yes |
| `git.write` | — | — | Yes |
| `lifecycle.restart` | — | — | Yes |
| `lifecycle.rebuild` | — | — | Yes |
| `repl.execute` | Yes | Yes | Yes |
| `shard.spawn` | — | Yes | Yes |

**Nursery** grants 5 token classes: read identity, write runtime config,
write memories, read git, and execute REPL.

**Apprentice** adds 7: base/operator identity writes, memory delete, all
external channels, and shard spawning.

**Autonomous** adds the final 3: git writes, lifecycle restart, and rebuild.

**Custom** uses an explicit list of tokens from `customTokens` in the config.

## Tool Requirements

Every tool declares which capability token(s) it needs. The system evaluates
eligibility before execution — if the active tier doesn't grant the required
token, the tool returns a structured denial:

```
Capability denied: tool "repo_commit" requires git.write,
but tier "nursery" only grants identity.read, identity.write.runtime, ...
```

Full tool-to-token mapping (from `src/capabilities/requirements.ts`):

| Tool | Required Token |
|------|---------------|
| `contact_list`, `contact_lookup` | `identity.read` |
| `contact_note`, `contact_link_identity`, `contact_set_channel_privacy`, `contact_set_trust` | `identity.write.runtime` |
| `heartbeat_get_policy`, `identity_changelog`, `identity_diff` | `identity.read` |
| `heartbeat_run_template`, `heartbeat_update_policy` | `identity.write.runtime` |
| `prompt_layer_list`, `prompt_layer_get` | `identity.read` |
| `prompt_layer_update`, `prompt_layer_toggle` | `identity.write.runtime` |
| `settings_get`, `session_list` | `identity.read` |
| `session_new`, `session_resume`, `schedule_task` | `identity.write.runtime` |
| `promoted_tools_list` | `identity.read` |
| `promoted_tools_add`, `promoted_tools_remove`, `promoted_tools_swap` | `identity.write.runtime` |
| `scratchpad_read` | `identity.read` |
| `scratchpad_write` | `memory.write` |
| `memory_write`, `memory_import_batch` | `memory.write` |
| `memory_redact`, `memory_delete`, `undo_memory_delete` | `memory.delete` |
| `notify_operator` | `external.web` |
| `repo_status`, `repo_diff` | `git.read` |
| `repo_apply_patch`, `repo_commit`, `repo_create_branch`, `repo_open_pr` | `git.write` |
| `self_restart` | `lifecycle.restart` |
| `self_rebuild` | `lifecycle.rebuild` |
| `spawn_shard` | `shard.spawn` |
| `think` | `repl.execute` |

## REPL Budget Limits

The `think` tool (RLM+REPL sandbox) has per-tier hard ceilings on compute:

| Limit | Nursery | Apprentice | Autonomous |
|-------|--------:|----------:|-----------:|
| Max iterations | 5 | 10 | 15 |
| Wall time | 30s | 60s | 120s |
| Sub-queries (llm_query) | 10 | 15 | 20 |
| Tool calls | 25 | 40 | 50 |
| Memory ceiling | 128 MB | 192 MB | 256 MB |

### Cost Caps

| Tier | Daily Cap | Behavior |
|------|-----------|----------|
| Nursery | $0.50 hard cap | REPL invocation blocked when exceeded |
| Apprentice | None | No cost enforcement |
| Autonomous | $5.00 warning | Logged warning, not blocked |

Rate limit: 5 `think` invocations per minute across all tiers.

### Sandbox Capabilities

| Capability | Nursery | Apprentice | Autonomous |
|------------|---------|------------|------------|
| `shell_exec()` | Denied | Denied | Available |
| `module_install()` | Denied | Queued for operator approval | Immediate |

## Shard Toolsets

When PSFN spawns sub-agent shards via `spawn_shard`, the tools available
to the shard are restricted by tier. Recursive spawning (`spawn_shard`,
`load_tools`) is always blocked in shards.

| Tier | Available Shard Tools |
|------|----------------------|
| Nursery | `memory_write`, `contact_lookup`, `repo_status`, `repo_diff` (4 tools) |
| Apprentice | Nursery set + `contact_list`, `memory_import_batch` (6 tools) |
| Autonomous | All registered tools (except spawn_shard, load_tools) |
| Custom | Same as autonomous |

Configurable via `shardToolsets` in `SubstrateConfig` for per-tier overrides.

## Safeguards

Safeguards apply regardless of tier (though some only matter once the
relevant capability is unlocked):

### Identity Cooling-Off Period

Base/operator prompt layer edits go through a staged commit pipeline:

- **Autonomous**: Immediate (no cooling-off).
- **Apprentice**: 5-minute cooling-off period. Edit is staged, must be committed
  after the cooldown expires. Can be cancelled during the wait.
- **Nursery**: Cannot edit base/operator layers (token not granted).

Default cooldown: 5 minutes. Override: `SAFEGUARD_IDENTITY_COOLDOWN_MS` env var.

### Lifecycle Restart Rate Limiter

Prevents runaway restart loops:

- Minimum 60-second cooldown between restarts.
- Maximum 5 restarts per rolling hour.
- Reason string required (empty reason → blocked).
- Override: `SAFEGUARD_RESTART_COOLDOWN_MS`, `SAFEGUARD_MAX_RESTARTS_PER_HOUR`.

### External Communication Rate Limiter

Caps outbound message volume per channel type per rolling hour:

| Channel | Default Limit |
|---------|--------------|
| Discord | 30 messages/hour |
| Email | 10 messages/hour |

Override: `SAFEGUARD_DISCORD_MESSAGES_PER_HOUR`, `SAFEGUARD_EMAIL_MESSAGES_PER_HOUR`.

### Tool Reversibility Tagging

Every tool is tagged `reversible` or `irreversible`. This metadata informs the
confirmation queue — irreversible actions in non-autonomous tiers may require
operator approval before execution.

### Confirmation Queue

Non-autonomous tiers route certain operations through an operator approval
pipeline. Pending confirmations:
- Expire after 24 hours by default.
- Can be approved, denied, or modified (params adjusted before execution).
- Visible in the admin UI.

### Audit Trail

All safeguard decisions (identity staging, restart evaluation, rate limit
checks) are logged to `data/safeguards-audit.jsonl` as structured JSONL entries
with timestamps.

## Gateway Policy Integration

The gateway policy engine respects capability tier indirectly via YOLO mode:

- **Standard split mode**: `fs.read` is workspace-scoped. `fs.write` is
  workspace-scoped. Paths outside workspace return `NEEDS_APPROVAL`.
- **YOLO mode**: `fs.read` is broadened to the full codebase root. `fs.write`
  remains workspace-scoped. See below.

---

## YOLO Mode

YOLO mode is a **gateway policy relaxation** for local development. It is
orthogonal to the capability tier system — YOLO affects filesystem read scope,
tiers affect tool access.

### What YOLO Mode Does

In standard `split` mode, the gateway policy restricts all filesystem operations
(reads and writes) to the workspace directory. This is correct for production
but inconvenient during development when PSFN needs to read reference
code, documentation, or other projects on the same machine.

YOLO mode broadens `fs.read` (and `fs.list`) to the full codebase root
directory while keeping `fs.write` strictly workspace-scoped:

```
                    Standard split          YOLO mode
  ──────────────────────────────────────────────────────
  fs.read           workspace only          full codebase root
  fs.list           workspace only          full codebase root
  fs.write          workspace only          workspace only (unchanged)
```

**YOLO mode does NOT:**
- Grant additional capability tokens
- Bypass tool-level capability gates
- Allow filesystem writes outside workspace
- Affect the capability tier or any safeguards

### Enabling YOLO Mode

```bash
# Option 1: npm script
npm run yolo

# Option 2: npm script with debug logging
npm run yolo:debug

# Option 3: env var with existing startup
PSFN_RUNTIME_MODE=yolo npm run split
```

The startup script (`scripts/start-gateway-agent.sh`) accepts `--yolo` flag:

```bash
./scripts/start-gateway-agent.sh --yolo
./scripts/start-gateway-agent.sh --yolo --debug
```

### How It Works

1. `start-gateway-agent.sh` sets `PSFN_RUNTIME_MODE=yolo`.
2. `gateway-main.ts` calls `resolveFullCodebaseReadRootFromEnv()` which returns
   the codebase root path when mode is `yolo`, or `undefined` otherwise.
3. The `fullCodebaseReadRoot` is passed into the gateway `PolicyConfig`.
4. The policy engine adds the codebase root to allowed prefixes for `fs.read`
   operations (alongside the workspace path).
5. `fs.write` operations are NOT affected — they still check only workspace
   prefix.

### Runtime Mode vs YOLO

YOLO is an alias for `split` mode in the runtime mode system — it resolves to
`RUNTIME_MODE.SPLIT` in `src/lifecycle/runtime-mode.ts`. The distinction only
exists in the gateway policy layer:

```typescript
// runtime-mode.ts — YOLO normalizes to split
yolo: RUNTIME_MODE.SPLIT,

// policy-config.ts — but the env var string is checked directly
return normalizeRuntimeMode(env.PSFN_RUNTIME_MODE) === 'yolo'
  ? resolve(codebaseRoot)
  : undefined;
```

### Self-Restart in YOLO Mode

When YOLO mode is active, the lifecycle restart command is automatically set to
`npm run yolo` (or `npm run yolo:debug` with `--debug`), so `self_restart`
preserves the YOLO context across restarts.

### When to Use YOLO Mode

- **Local development**: When you want PSFN to read reference code,
  previous project implementations, or documentation outside her workspace.
- **Pair programming**: When working alongside PSFN on tasks that
  require reading from multiple directories.
- **NOT for production**: Production deployments should use standard `split`
  mode with workspace-scoped reads.

### Env Var Reference

```bash
# .env
PSFN_RUNTIME_MODE=yolo                     # enable YOLO mode
LIFECYCLE_RESTART_COMMAND=npm run yolo      # preserve YOLO across restarts
```

## Configuration Reference

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CAPABILITY_TIER` | `nursery` | First-boot tier (ignored after config file exists) |
| `PSFN_RUNTIME_MODE` | `split` | Runtime mode (`split`, `yolo`, `single`) |
| `SAFEGUARD_IDENTITY_COOLDOWN_MS` | `300000` | Identity edit cooling-off period (ms) |
| `SAFEGUARD_RESTART_COOLDOWN_MS` | `60000` | Minimum time between restarts (ms) |
| `SAFEGUARD_MAX_RESTARTS_PER_HOUR` | `5` | Max restart count per rolling hour |
| `SAFEGUARD_DISCORD_MESSAGES_PER_HOUR` | `30` | Discord outbound rate limit |
| `SAFEGUARD_EMAIL_MESSAGES_PER_HOUR` | `10` | Email outbound rate limit |

### Files

| File | Description |
|------|-------------|
| `data/capability-tier.json` | Active tier config (live-reloaded) |
| `config/capability-tier.seed.json` | Default seed for first boot |
| `data/safeguards-audit.jsonl` | Safeguard decision audit log |

### Source Files

| File | What it defines |
|------|----------------|
| `src/capabilities/tokens.ts` | 15 capability token definitions |
| `src/capabilities/tiers.ts` | Per-tier token grants |
| `src/capabilities/requirements.ts` | Tool → token mapping |
| `src/capabilities/gate.ts` | Runtime gating (`gateToolWithCapabilities`) |
| `src/capabilities/runtime.ts` | `CapabilityRuntime` with live-reload |
| `src/capabilities/safeguards.ts` | Identity cooling-off, restart limiter, comms rate limiter |
| `src/capabilities/confirmation-queue.ts` | Operator approval pipeline |
| `src/repl/types.ts` | Per-tier REPL budget definitions |
| `src/shards/manager.ts` | Per-tier shard toolset definitions |
| `src/gateway/policy-config.ts` | YOLO mode fs.read broadening |
| `src/gateway/policy.ts` | Gateway policy engine |
| `src/lifecycle/runtime-mode.ts` | Runtime mode normalization |
