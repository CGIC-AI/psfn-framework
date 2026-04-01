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

## Live Filesystem Surface

The runtime now exposes a single model-facing `fs` tool for common workspace inspection and safe file mutation.

- Inspection actions: `list`, `read`, `search`
- Mutation actions: `write`, `edit`

The surface is designed to keep routine codebase inspection out of `think`:

- use `fs action="list"` for bounded discovery
- use `fs action="search"` for targeted content lookup before broad reasoning
- use `fs action="read"` for bounded file inspection

Mutation guardrails remain explicit:

- `write` refuses to overwrite changed files unless `overwrite=true`
- `edit` requires an exact `old_text` match and fails closed on ambiguous replacements unless `replace_all=true`
- gateway-side path policy and workspace boundaries remain authoritative

## Live Shell Surface

The runtime now exposes a unified model-facing `shell` tool for direct command execution outside `think`.

- Action: `exec`

The surface stays intentionally narrow:

- commands run without a shell parser; callers must pass explicit `command` and `args`
- gateway policy remains authoritative for enablement, executable allowlists, cwd bounds, timeouts, and output caps
- confirmation, auditing, and fail-closed denial stay on the underlying `shell.exec` gateway path
- `shell` remains distinct from `fs` and `repo`; use those primitives for structured workspace and git operations instead of shelling out by default
- `shell_exec` inside `think` remains a bounded helper, not the primary model-facing surface

## Live Session Surface

The runtime now exposes a unified model-facing `session` tool for continuity, transcript lookup, resumption, and focus workflow.

- Primary actions: `list`, `new`, `resume`, `search`, `grep`, `list_continuity`, `checkpoint`, `wake_return`, `start_focus`, `complete_focus`
- Migration aliases remain available inside the same tool:
  `session_list` -> `list`
  `session_new` -> `new`
  `session_resume` -> `resume`
  `session_search` -> `search`
  `session_grep` -> `grep`
  `continuity_list` -> `list_continuity`
  `wake_return_summary` -> `wake_return`
  `focus_start` -> `start_focus`
  `focus_complete` -> `complete_focus`

This keeps transcript lookup, gentle checkpointing, wake/return recaps, and focus lifecycle behavior under one continuity surface instead of turning them into generic assistant status chatter.

## Live Notify Surface

The runtime now exposes a unified model-facing `notify` tool for operator briefs, lightweight outbound delivery, and approval escalation.

- Actions: `brief`, `send`, `approval_request`
- `brief` is the direct replacement for legacy `notify_operator`
- `send` requires an explicit delivery channel and explicit external target; it does not infer the current channel
- `approval_request` keeps operator-review details explicit instead of hiding them behind implicit side effects

The surface keeps lightweight visible tool output separate from the heavier internal delivery work. Briefs remain fail-closed for scheduled/internal contexts, outbound sends require explicit delivery targets, and approval escalation stays explicit about what is awaiting review.

## Live Skill Surface

The runtime now exposes a unified model-facing `skill` tool for skill discovery, inspection, and managed-skill mutation.

- Actions: `list`, `view`, `create`, `update`
- Legacy migration aliases remain accepted at the action level for compatibility, but the model-facing tool name is now just `skill`
- `list` preserves discovery metadata, eligibility outcomes, and filtered-skill reasons
- `view` loads one skill's full YAML + Markdown body on demand
- `create` and `update` write managed skills under `data/skills/<category>/<name>/SKILL.md` and refresh the runtime snapshot

## Live Media Surface

The runtime now exposes a unified model-facing `media` tool for image-backed generation, transformation, and inspection.

- Actions: `generate`, `edit`, `analyze`
- `generate` creates a new image from a prompt
- `edit` transforms one or more existing input URLs
- `analyze` inspects visible contents or appearance consistency on explicit inputs
- Detailed composition guidance, prompt craft, and provider/model quirks belong in creator skills loaded with `skill action="view"`; the top-level tool surface stays intentionally generic

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
- Keep creative prompt craft, appearance heuristics, and provider/model quirks in creator skills rather than top-level tool descriptions.
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
| `fs_read` | `fs` | always-on | Collapsed into `fs action="read"`. |
| `fs_list` | `fs` | always-on | Collapsed into `fs action="list"`. |
| `shell_exec` | `shell` | always-on | Direct command execution now belongs on `shell action="exec"`; the `think` helper remains bounded and secondary. |
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
| `continuity_list` | `session` | always-on | Session-scoped low-stress continuity lookup now maps to `action="list_continuity"`. |
| `wake_return_summary` | `session` | always-on | Wake/return continuity summaries now map to `action="wake_return"`. |
| `start_focus` | `session` | extended | Focus sessions are workflow state. |
| `complete_focus` | `session` | extended | Same family. |
| `heartbeat_get_policy` | `schedule` | background-only | Policy reads belong to scheduling, but not as a frequent turn action. |
| `heartbeat_update_policy` | `schedule` | extended | Same family. |
| `heartbeat_run_template` | `schedule` | background-only | Template execution is a background worker concern. |
| `schedule_task` | `schedule` | extended | Durable tasking belongs here. |
| `self_restart` | `system` | extended | Runtime control belongs under system. |
| `self_rebuild` | `system` | extended | Same family. |
| `notify` | `notify` | extended | Unified notify surface with `action=brief|send|approval_request`. |
| `notify_operator` | `notify` | hidden | Legacy operator alert behavior now maps to `notify action="brief"`. |
| `subagent` | `subagent` | extended | Unified bounded-worker control plane; keep distinct from long-horizon shard work. |
| `spawn_shard` | `shard` | extended | Long-horizon clone work is shard work, not subagent work; forked shards intentionally inherit typed parent context snapshots and a stable prompt prefix. |
| `think` | `think` | always-on | Keep as an explicit fallback for deep reasoning. |
| `skill` | `skill` | always-on | Unified surface with `action=list|view|create|update`; skills stay discoverable and managed-skill mutation remains explicit on the same semantic tool. |
| `vault_write` | `vault` | extended | Vault mutations stay explicit. |
| `vault_read` | `vault` | always-on | Vault reads remain a semantic tool. |
| `vault_search` | `vault` | always-on | Same family. |
| `vault_daily` | `vault` | extended | Daily journal emission belongs with the vault surface. |
| `image_create` | `media` | extended | Collapsed into `media action="generate"`; detailed prompt craft belongs in creator skills, not runtime context. |
| `image_edit` | `media` | extended | Collapsed into `media action="edit"` on the same surface. |
| `image_analyze` | `media` | extended | Collapsed into `media action="analyze"` on the same surface. |

## Configuration Guidance

- Keep `promotedExtendedTools` small. It is a short-term exposure mechanism, not the long-term taxonomy.
- Do not add more micro-tool-specific config keys as a substitute for `toolset`.
- Treat `tool_search` as the first discovery step for non-default tools and `toolset` as the semantic control plane for activating, pinning, and unpinning them.
- Keep `shardToolsets` shard-specific. It should not become a general companion tool-selection mechanism.
- Preserve `north_star` as a dedicated semantic surface rather than folding it into `identity` or `orient`.
- Leave `think` available as a fallback, but do not use it to hide missing tool taxonomy.

## Practical Rule Of Thumb

If the task is world execution, use a primitive. If it is companion state, use a semantic companion tool. If it is workflow strategy, encode it in a skill. If it is long-tail or special-case tool selection, use `tool_search`/`toolset`. If none of that fits, `think` is the fallback.
