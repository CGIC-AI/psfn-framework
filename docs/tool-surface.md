# Tool Surface Contract

This document defines the target model-facing tool stack for PSFN and maps the current first-party names to that target.

The goal is not to expose more tools. The goal is to reduce tool-choice entropy while preserving semantic companion-state surfaces that must stay explicit.

## Target Stack

### Always-On Primitives

- `fs`
- `repo`
- `shell`
- `web`
- `think`
- `tool_search`
- `toolset`

### Semantic Companion Tools

- `memory`
- `orient`
- `scratchpad`
- `contact`
- `session`
- `schedule`
- `north_star`
- `identity`
- `subagent`
- `shard`
- `vault`
- `beads`
- `skill`
- `system`
- `notify`
- `media`

## Live Identity Surface

The runtime now exposes a single model-facing `identity` tool for prompt-layer and persona work.

- Read actions: `list_layers`, `get_layer`, `diff_layer`, `history`
- Prompt mutation actions: `update_layer`, `rollback_layer`, `toggle_layer`, `commit_stage`, `cancel_stage`
- Persona mutation action: `update_persona`

The surface is always on so the model does not have to discover or choose among prompt-stack micro-tools. Write actions remain capability-gated, and the existing confirmation/cooling-off safeguards still apply.

## Live Schedule Surface

The runtime now exposes a unified model-facing `schedule` tool for time-based continuity and scheduling work.

- Continuity actions: `list`, `create_follow_up`, `activate_follow_up`, `create_reminder`, `trigger_reminder`
- Scheduler/template actions: `list_templates`, `update_template`, `run_template`, `schedule_prompt`
- Legacy migration aliases remain available inside the same tool:
  `get_policy` -> `list_templates`
  `update_policy` -> `update_template`
  `schedule_task` -> `schedule_prompt`

This keeps durable reminders, proactive follow-ups, birthdays, anniversaries, self-reminders, and timed work under one semantic faculty instead of scattering them across ad hoc timer micro-tools.

## Live Session Surface

The runtime now exposes a unified model-facing `session` tool for continuity, transcript lookup, resumption, and focus workflow.

- Primary actions: `list`, `new`, `resume`, `search`, `grep`, `start_focus`, `complete_focus`
- Migration aliases remain available inside the same tool:
  `session_list` -> `list`
  `session_new` -> `new`
  `session_resume` -> `resume`
  `session_search` -> `search`
  `session_grep` -> `grep`
  `focus_start` -> `start_focus`
  `focus_complete` -> `complete_focus`

This keeps continuity choice simple for the model while preserving the existing session-management invariants and focus lifecycle behavior.

### Hidden Or Background-Only Surfaces

- reflection internals
- heartbeat plumbing that should not be model-selected directly
- maintenance workers
- operator/debug surfaces
- autoload bookkeeping

## Naming Rules

- Prefer one top-level tool per semantic domain.
- Prefer an `action` parameter over a family of near-duplicate verbs.
- Keep `north_star` separate from the core always-on set.
- Use `orient` as the active-orientation surface; it is not deep archival memory.
- Keep `scratchpad` as the ephemeral long-context workspace for large temporary material such as PDFs, articles, working notes, and rolling source summaries.
- Keep scratchpad distinct from `orient` and `memory`: it is for temporary working context, not active canon or durable recall.
- Promote scratchpad content only when it hardens into stable facts (`memory`), durable notes/artifacts (`vault` or repo docs), or orientation state (`orient`).
- Use `think` as an explicit fallback for deep reasoning, not as the default escape hatch.
- Keep bounded worker control on `subagent` with `action=spawn|message|wait|cancel|status`.
- Keep shard and subagent names distinct because they model different work durations and isolation semantics.
- Keep forked shard generation explicit so inherited parent context stays in shard prompt discipline rather than leaking into bounded subagent control.

## Current-To-Target Migration Map

The table below maps current first-party tool names to the target surface. "Keep" means the target name is already effectively present. "Collapse" means multiple current tools should become one semantic tool family. "Hide" means the surface should move behind toolset/background control.

| Current name | Target surface | Exposure | Notes |
| --- | --- | --- | --- |
| `memory` | `memory` | always-on | Unified long-term memory surface with `action=write|search|import|redact|delete|restore`; capability gating still distinguishes read/write/delete-sensitive paths. |
| `scratchpad` | `scratchpad` | always-on | Unified ephemeral workspace with `action=list|add|replace|append|remove`; short-lived working notes stay explicit and non-canonical. |
| `core_memory_append` | `orient` | always-on | Now maps to `orient action="append"` for incremental orientation updates. |
| `core_memory_replace` | `orient` | always-on | Now maps to `orient action="replace"` for single-block rewrites. |
| `memory_rethink` | `orient` | background-only | Now maps to `orient action="reorient"` for holistic orientation refresh. |
| `values_list` | `orient` | always-on | Values are part of active self-orientation, not a separate tool family. |
| `values_add` | `orient` | extended | Append-only value journaling stays on the orientation surface. |
| `values_update` | `orient` | extended | Revisions stay append-only and provenance-aware. |
| `create_concern` | `orient` | background-only | Active concerns are orientation data, not a task board. |
| `list_concerns` | `orient` | background-only | Concern visibility belongs to the same active-state lane. |
| `resolve_concern` | `orient` | background-only | Concern resolution closes the loop on active-state tracking. |
| `prompt_layer_list` | `identity` | always-on | Collapsed into `identity action=list_layers`. |
| `prompt_layer_get` | `identity` | always-on | Collapsed into `identity action=get_layer`. |
| `prompt_layer_update` | `identity` | always-on | Collapsed into `identity action=update_layer`; capability gating still distinguishes write scope. |
| `prompt_layer_rollback` | `identity` | always-on | Collapsed into `identity action=rollback_layer`. |
| `prompt_layer_toggle` | `identity` | always-on | Collapsed into `identity action=toggle_layer`. |
| `identity_diff` | `identity` | always-on | Collapsed into `identity action=diff_layer`. |
| `identity_changelog` | `identity` | always-on | Collapsed into `identity action=history`. |
| `persona_update` | `identity` | always-on | Collapsed into `identity action=update_persona` with the existing review guards preserved. |
| `character_card_update` | `identity` | extended | Character-card mutation belongs to identity. |
| `north_star` | `north_star` | extended | Unified long-horizon guiding-intent surface with `action=list|create|update|delete|reorder`; keep it semantic and non-core. |
| `settings_get` | `system` | always-on | Runtime-setting reads are system guidance, not identity. |
| `tool_search` | `tool_search` | always-on | Primary discovery surface for non-default tools; pair it with `toolset` for activation or pinning. |
| `promoted_tools_list` | `toolset` | hidden | Legacy promoted-tool helper now collapses into `toolset action="list"`. |
| `promoted_tools_add` | `toolset` | hidden | Legacy promoted-tool helper now collapses into `toolset action="pin"`. |
| `promoted_tools_remove` | `toolset` | hidden | Legacy promoted-tool helper now collapses into `toolset action="unpin"`. |
| `promoted_tools_swap` | `toolset` | hidden | Legacy slot-reorder helper is no longer model-facing. |
| `load_tools` | `toolset` | hidden | Legacy exact-name activation path now collapses into `toolset action="activate"`. |
| `fs_read` | `fs` | always-on | File read/list/search collapse into one primitive family. |
| `fs_list` | `fs` | always-on | Same family. |
| `repo_status` | `repo` | always-on | Repository inspection belongs under one primitive. |
| `repo_diff` | `repo` | always-on | Same family. |
| `repo_apply_patch` | `repo` | extended | Mutation stays gated. |
| `repo_commit` | `repo` | extended | Mutation stays gated. |
| `repo_create_branch` | `repo` | extended | Mutation stays gated. |
| `repo_open_pr` | `repo` | extended | Mutation stays gated. |
| `issue_ready` | `beads` | always-on | Current tracked-work operations collapse into `beads`. |
| `issue_show` | `beads` | always-on | Same family. |
| `issue_create` | `beads` | extended | Mutation stays explicit. |
| `issue_update` | `beads` | extended | Same family. |
| `issue_close` | `beads` | extended | Same family. |
| `issue_sync` | `beads` | background-only | Sync is maintenance, not a companion turn action. |
| `session_new` | `session` | always-on | Continuity and conversation workflow belong together. |
| `session_list` | `session` | always-on | Same family. |
| `session_resume` | `session` | extended | Resume is a workflow action, not a read-only query. |
| `session_search` | `session` | always-on | Same family. |
| `session_grep` | `session` | always-on | Same family. |
| `start_focus` | `session` | extended | Focus sessions are workflow state. |
| `complete_focus` | `session` | extended | Same family. |
| `heartbeat_get_policy` | `schedule` | background-only | Policy reads belong to scheduling, but not as a frequent turn action. |
| `heartbeat_update_policy` | `schedule` | extended | Same family. |
| `heartbeat_run_template` | `schedule` | background-only | Template execution is a background worker concern. |
| `schedule_task` | `schedule` | extended | Durable tasking belongs here. |
| `self_restart` | `system` | extended | Runtime control belongs under system. |
| `self_rebuild` | `system` | extended | Same family. |
| `notify_operator` | `notify` | extended | Operator escalation is its own primitive. |
| `subagent` | `subagent` | extended | Unified bounded-worker control plane; keep distinct from long-horizon shard work. |
| `spawn_shard` | `shard` | extended | Long-horizon clone work is shard work, not subagent work; forked shards intentionally inherit typed parent context snapshots and a stable prompt prefix. |
| `think` | `think` | always-on | Keep as an explicit fallback for deep reasoning. |
| `skill_list` | `skill` | always-on | Skill management stays explicit. |
| `skill_view` | `skill` | always-on | Same family. |
| `skill_create` | `skill` | extended | Mutation stays explicit. |
| `skill_update` | `skill` | extended | Same family. |
| `vault_write` | `vault` | extended | Vault mutations stay explicit. |
| `vault_read` | `vault` | always-on | Vault reads remain a semantic tool. |
| `vault_search` | `vault` | always-on | Same family. |
| `vault_daily` | `vault` | extended | Daily journal emission belongs with the vault surface. |
| `image_create` | `media` | extended | Media generation should sit behind a single media surface. |
| `image_edit` | `media` | extended | Same family. |
| `image_analyze` | `media` | extended | Same family. |

## Configuration Guidance

- Keep `promotedExtendedTools` small. It is a short-term exposure mechanism, not the long-term taxonomy.
- Do not add more micro-tool-specific config keys as a substitute for `toolset`.
- Treat `tool_search` as the first discovery step for non-default tools and `toolset` as the semantic control plane for activating, pinning, and unpinning them.
- Keep `shardToolsets` shard-specific. It should not become a general companion tool-selection mechanism.
- Preserve `north_star` as a dedicated semantic surface rather than folding it into `identity` or `orient`.
- Leave `think` available as a fallback, but do not use it to hide missing tool taxonomy.

## Practical Rule Of Thumb

If the task is world execution, use a primitive. If it is companion state, use a semantic companion tool. If it is workflow strategy, encode it in a skill. If it is long-tail or special-case tool selection, use `tool_search`/`toolset`. If none of that fits, `think` is the fallback.
