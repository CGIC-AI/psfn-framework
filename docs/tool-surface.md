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
- `shard`
- `vault`
- `beads`
- `skill`
- `system`
- `notify`
- `media`

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
- Rename `core_memory` to `orient`; the companion should read that as active orientation, not deep archival memory.
- Keep `scratchpad` as the ephemeral long-context workspace for large temporary material such as PDFs, articles, and working notes.
- Use `think` as an explicit fallback for deep reasoning, not as the default escape hatch.
- Keep shard and subagent names distinct because they model different work durations and isolation semantics.

## Current-To-Target Migration Map

The table below maps current first-party tool names to the target surface. "Keep" means the target name is already effectively present. "Collapse" means multiple current tools should become one semantic tool family. "Hide" means the surface should move behind toolset/background control.

| Current name | Target surface | Exposure | Notes |
| --- | --- | --- | --- |
| `memory_write` | `memory` | always-on | Core write path for durable memories. |
| `memory_import_batch` | `memory` | always-on | Bulk import belongs to the same semantic family. |
| `memory_redact` | `memory` | extended | Mutation stays explicit and capability-gated. |
| `memory_delete` | `memory` | extended | Mutation stays explicit and capability-gated. |
| `undo_memory_delete` | `memory` | extended | Restore path stays under the same family. |
| `scratchpad_read` | `scratchpad` | always-on | Ephemeral working notes stay explicit. |
| `scratchpad_write` | `scratchpad` | always-on | Short-lived working notes are not canonical memory. |
| `core_memory_append` | `orient` | always-on | Collapse the hot canon into `orient`. |
| `core_memory_replace` | `orient` | always-on | Same orientation surface, different action. |
| `memory_rethink` | `orient` | background-only | Re-orienting the hot canon is reflective work, not a routine turn action. |
| `values_list` | `orient` | always-on | Values are part of active self-orientation, not a separate tool family. |
| `values_add` | `orient` | extended | Append-only value journaling stays on the orientation surface. |
| `values_update` | `orient` | extended | Revisions stay append-only and provenance-aware. |
| `create_concern` | `orient` | background-only | Active concerns are orientation data, not a task board. |
| `list_concerns` | `orient` | background-only | Concern visibility belongs to the same active-state lane. |
| `resolve_concern` | `orient` | background-only | Concern resolution closes the loop on active-state tracking. |
| `prompt_layer_list` | `identity` | always-on | Prompt/identity state should be one semantic surface. |
| `prompt_layer_get` | `identity` | always-on | Same family. |
| `prompt_layer_update` | `identity` | extended | Mutation remains explicit and gated. |
| `prompt_layer_rollback` | `identity` | extended | Versioned rollback belongs with identity state. |
| `prompt_layer_toggle` | `identity` | extended | Same family. |
| `identity_diff` | `identity` | always-on | Identity introspection belongs with the identity surface. |
| `identity_changelog` | `identity` | always-on | Same family. |
| `persona_update` | `identity` | extended | Persona mutation remains explicit and guarded. |
| `character_card_update` | `identity` | extended | Character-card mutation belongs to identity. |
| `north_star_list` | `north_star` | always-on | Keep this as its own semantic surface. |
| `north_star_create` | `north_star` | extended | Same family. |
| `north_star_update` | `north_star` | extended | Same family. |
| `north_star_delete` | `north_star` | extended | Same family. |
| `north_star_reorder` | `north_star` | extended | Same family. |
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
| `spawn_shard` | `shard` | extended | Long-horizon clone work is shard work, not subagent work. |
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
