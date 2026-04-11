# Tool Surface Contract

This document defines the target model-facing tool stack for PSFN and maps the current first-party names to that target.

The goal is not to expose more tools. The goal is to reduce tool-choice entropy while preserving semantic companion-state surfaces that must stay explicit. Unless a section explicitly says "current stabilized branch", treat the unified names below as target taxonomy, not a claim that every target tool is already registered in the live runtime.

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

## Current Stabilized Branch

The stabilized `refactor-pt3` branch still ships a mixed direct tool surface. The target stack above is architectural direction; the live runtime is only partially collapsed today.

Always-on adaptive control:

- `tool_search`
- `toolset`

Already unified top-level direct tools in the current runtime:

- `shell`
- `skill`
- `orient`
- `memory`
- `scratchpad`
- `session`
- `identity`
- `north_star`
- `system`
- `subagent`

Still-split first-party direct tools in the current runtime:

- memory mutation legacy aliases: `memory_import_batch`, `memory_redact`, `memory_delete`, `undo_memory_delete`, `scratchpad_write`
- filesystem: `fs_list`, `fs_read`
- contacts: `contact_list`, `contact_lookup`, `contact_note`, `contact_set_trust`, `contact_link_identity`, `contact_set_channel_privacy`
- repository: `repo_status`, `repo_diff`, `repo_apply_patch`, `repo_commit`, `repo_create_branch`, `repo_open_pr`
- session continuity helpers: `session_new`, `session_resume`, `start_focus`, `complete_focus`
- identity and direction legacy aliases: `prompt_layer_*`, `identity_diff`, `identity_changelog`, `character_card_update`, `north_star_*`
- heartbeat and values: `heartbeat_get_policy`, `heartbeat_update_policy`, `heartbeat_run_template`, `schedule_task`, `values_add`, `values_update`
- vault: `vault_write`, `vault_read`, `vault_search`, `vault_daily`
- beads: `issue_ready`, `issue_show`, `issue_create`, `issue_update`, `issue_close`, `issue_sync`
- lifecycle and operator control legacy aliases: `settings_get`, `promoted_tools_*`, `self_restart`, `self_rebuild`, `notify_operator`
- images: `image_create`, `image_edit`, `image_analyze`
- shards: `spawn_shard`

Important current-state notes:

- `load_tools` is no longer a live runtime control tool. Tool discovery and activation now run through `tool_search` and `toolset`.
- Transcript lookup now stays on the direct `session` tool; the split `session_search`, `session_grep`, and `session_list` registrations are no longer live.
- Unified `memory`, `scratchpad`, `session`, and `orient` are live direct tools on this branch, while only the remaining write/mutation helpers stay split during migration.
- Unified `identity`, `north_star`, and `system` are live direct tools on this branch, while their legacy split aliases remain registered during migration.
- A unified `schedule` tool exists in code, but the stabilized agent entrypoint still wires the split heartbeat/scheduling tools through `src/app/startup/composition/parity.ts`.

## Target Identity Surface

The target model-facing `identity` surface collapses prompt-layer and persona work into one tool.

- Read actions: `list_layers`, `get_layer`, `diff_layer`, `history`
- Prompt mutation actions: `update_layer`, `rollback_layer`, `toggle_layer`, `commit_stage`, `cancel_stage`
- Persona mutation action: `update_persona`

The surface is always on so the model does not have to discover or choose among prompt-stack micro-tools. Write actions remain capability-gated, and the existing confirmation/cooling-off safeguards still apply.

## Target Schedule Surface

The target model-facing `schedule` surface collapses time-based continuity and scheduling work into one tool.

- Continuity actions: `list`, `create_follow_up`, `activate_follow_up`, `create_reminder`, `trigger_reminder`
- Scheduler/template actions: `list_templates`, `update_template`, `run_template`, `schedule_prompt`
- Legacy migration aliases remain available inside the same tool:
  `get_policy` -> `list_templates`
  `update_policy` -> `update_template`
  `schedule_task` -> `schedule_prompt`

This keeps durable reminders, proactive follow-ups, birthdays, anniversaries, self-reminders, and timed work under one semantic faculty instead of scattering them across ad hoc timer micro-tools.

## Target Filesystem Surface

The target model-facing `fs` surface collapses common workspace inspection and safe file mutation into one tool.

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

## Target Repo Surface

The target model-facing `repo` surface collapses git-backed repository inspection and mutation into one tool.

- Actions: `inspect`, `patch`, `branch`, `commit`, `publish`
- `inspect` keeps repository state and diff lookup on one primitive instead of splitting them across read-only micro-tools
- `patch`, `branch`, and `commit` keep destructive mutation explicit and capability-gated
- `publish` remains distinct from shell and still routes through the guarded GitHub publication path instead of raw command execution

This keeps repository work on one primitive while preserving the existing protected-branch checks, allowlisted patch paths, and gateway approval policy for write and publish flows.

## Target Shell Surface

The current runtime already exposes a unified model-facing `shell` tool for direct command execution outside `think`, and that remains the target shape.

- Action: `exec`

The surface stays intentionally narrow:

- commands run without a shell parser; callers must pass explicit `command` and `args`
- gateway policy remains authoritative for enablement, executable allowlists, cwd bounds, timeouts, and output caps
- confirmation, auditing, and fail-closed denial stay on the underlying `shell.exec` gateway path
- `shell` remains distinct from `fs` and `repo`; use those primitives for structured workspace and git operations instead of shelling out by default
- `shell_exec` inside `think` remains a bounded helper, not the primary model-facing surface

## Target Session Surface

The target model-facing `session` surface collapses continuity, transcript lookup, resumption, and focus workflow into one tool.

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

## Target Contact Surface

The target model-facing `contact` surface collapses relationship operations and canonical contact continuity into one tool.

- Actions: `list`, `lookup`, `note`, `set_trust`, `link_identity`, `set_channel_privacy`
- Legacy migration aliases remain available inside the same tool:
  `contact_list` -> `list`
  `contact_lookup` -> `lookup`
  `contact_note` -> `note`
  `contact_set_trust` -> `set_trust`
  `contact_link_identity` -> `link_identity`
  `contact_set_channel_privacy` -> `set_channel_privacy`

This keeps contact lookup, typed notes, trust drift handling, cross-channel identity linking, and per-channel privacy on one semantic relationship surface instead of scattering them across micro-tools. Trust/disclosure invariants and typed contact semantics remain enforced by the underlying contact store.

## Target Notify Surface

The target model-facing `notify` surface collapses operator briefs, lightweight outbound delivery, and approval escalation into one tool.

- Actions: `brief`, `send`, `approval_request`
- `brief` is the direct replacement for legacy `notify_operator`
- `send` requires an explicit delivery channel and explicit external target; it does not infer the current channel
- `approval_request` keeps operator-review details explicit instead of hiding them behind implicit side effects

The surface keeps lightweight visible tool output separate from the heavier internal delivery work. Briefs remain fail-closed for scheduled/internal contexts, outbound sends require explicit delivery targets, and approval escalation stays explicit about what is awaiting review.

## Target Skill Surface

The current runtime already exposes a unified model-facing `skill` tool for skill discovery, inspection, and managed-skill mutation, and that remains the target shape.

- Actions: `list`, `view`, `create`, `update`
- Legacy migration aliases remain accepted at the action level for compatibility, but the model-facing tool name is now just `skill`
- `list` preserves discovery metadata, eligibility outcomes, and filtered-skill reasons
- `view` loads one skill's full YAML + Markdown body on demand
- `create` and `update` write managed skills under `companion-data/skills/<category>/<name>/SKILL.md` and refresh the runtime snapshot
- Creator workflows such as image creation, music creation, and future media variants belong here as creator-category skills loaded with `skill action="view"`

## Target Media Surface

The target model-facing `media` surface collapses media generation, transformation, and inspection into one tool.

- Actions: `generate`, `edit`, `analyze`
- `generate` creates a new media artifact from a prompt
- `edit` transforms one or more existing input URLs
- `analyze` inspects visible contents or consistency questions on explicit inputs
- Current implementation is image-backed, but image creation, music creation, and future creator workflows all stay modeled as creator skills loaded with `skill action="view"`; the top-level tool surface stays intentionally generic

## Target Web Surface

The target model-facing `web` surface collapses outward web work while keeping gateway fetch lanes and allowlists explicit underneath.

- Actions: `fetch`, `browse`, `search`
- `fetch` is the ordinary external-web read path and maps to the gateway default lane
- `browse` is the explicit local-crawler/webpage traversal path and maps to the gateway `local_crawler` lane
- `search` is lightweight research discovery that returns a small fetched URL set without collapsing into session continuity or transcript search semantics
- Gateway RPC methods remain split as `web.fetch` and `web.fetch_binary`; that transport split is deliberate so URL policy, binary size limits, redirect auditing, and lane-specific allowlists stay fail-closed

This keeps ordinary page retrieval, crawler-style browsing, and small-scope web research under one semantic tool family instead of exposing multiple near-duplicate web micro-tools to the model.

## Target Vault Surface

The target model-facing `vault` surface collapses durable notes, Obsidian search, and daily journaling into one tool.

- Actions: `read`, `write`, `search`, `daily`
- Legacy migration aliases remain available inside the same tool:
  `vault_read` -> `read`
  `vault_write` -> `write`
  `vault_search` -> `search`
  `vault_daily` -> `daily`

This keeps durable note creation, retrieval, search, and daily-note workflows on one semantic surface instead of scattering them across vault micro-tools. `vault` stays distinct from `scratchpad` and `memory`: scratchpad is temporary working context, memory is structured recall, and vault is for durable notes and artifacts.

## Target System Surface

The target model-facing `system` surface collapses safe runtime-setting reads and guarded lifecycle control into one tool.

- Preferred actions:
  `read`
  `restart`
  `rebuild`
- Accepted legacy action aliases:
  `settings_get` -> `read`
  `self_restart` -> `restart`
  `self_rebuild` -> `rebuild`

`system action="read"` preserves the existing safe runtime-settings snapshot behavior. `system action="restart|rebuild"` preserves the existing restart safeguard checks, notification flow, and capability enforcement, but keeps lifecycle control on one semantic surface instead of separate micro-tools.

## Target Shard Surface

The target model-facing `shard` surface collapses long-horizon shard work and fold-back lifecycle control into one tool.

- Actions: `spawn`, `list`, `status`, `deliver`
- Legacy action alias remains available inside the same tool:
  `spawn_shard` -> `spawn`
- `list` and `status` are anchored on the live shard runtime snapshot/detail views instead of ad hoc summaries
- `deliver` wires to the real shard delivery path, which transitions available artifacts into delivered state and refreshes fold-back review metadata

This keeps long-horizon shard execution, operator-visible shard runtime state, and explicit fold-back delivery on one semantic surface while preserving shard-specific concurrency scheduling and merge-review semantics.

### Hidden Or Background-Only Surfaces

- reflection internals
- heartbeat plumbing that should not be model-selected directly
- maintenance workers
- operator/debug surfaces
- autoload bookkeeping

## Runtime Prompt Presentation

The companion-facing runtime prompt should describe the active stack for the turn, not the implementation mechanics behind it or an aspirational fully-collapsed taxonomy.

- Treat the currently loaded tools as the active stack for the turn; prefer calling a direct tool that already fits the task.
- Mention `tool_search` and `toolset` as the discovery/control path for non-default overlays, but do not spend prompt budget on active counts, per-tool activation sources, or suffixes such as promoted/autoload/deferred.
- Hide internal/background-only tools from ordinary direct turns unless the current turn is scheduled, deferred, or otherwise explicitly about that background workflow.
- Keep richer activation/source/debug detail on admin and observability surfaces rather than in the companion prompt.

## Naming Rules

- Prefer one top-level tool per semantic domain.
- Prefer an `action` parameter over a family of near-duplicate verbs.
- Keep `north_star` separate from the core always-on set.
- Use `orient` as the active-orientation surface; it is not deep archival memory.
- Keep `scratchpad` as the ephemeral long-context workspace for large temporary material such as PDFs, articles, working notes, and rolling source summaries.
- Keep scratchpad distinct from `orient` and `memory`: it is for temporary working context, not active canon or durable recall.
- Scratchpad entries now age under an explicit lifecycle policy from `scheduler.json`; stale temporary notes are eligible for cleanup unless they are promoted first.
- Promote scratchpad content only when it hardens into stable facts (`memory`), durable notes/artifacts (`vault` or repo docs), or orientation state (`orient`).
- Temporary file cleanup only touches generated media plus the managed workspace temp subtree at `workspace/.psfn/temp-artifacts`; ordinary workspace files are never swept implicitly.
- Use `think` as an explicit fallback for deep reasoning, not as the default escape hatch.
- Keep `web` distinct from `session`: transcript lookup and continuity resume belong to `session`, while remote-page discovery/retrieval belongs to `web`.
- Keep creative prompt craft, appearance heuristics, and provider/model quirks in creator skills rather than top-level tool descriptions.
- Keep bounded worker control on `subagent` with `action=spawn|message|wait|cancel|status`.
- Keep shard and subagent names distinct because they model different work durations and isolation semantics.
- Keep forked shard generation explicit so inherited parent context stays in shard prompt discipline rather than leaking into bounded subagent control.

## Current-To-Target Migration Map

The table below maps current first-party tool names to the target surface. It is a migration map, not a claim that every target name is already live today. "Keep" means the target name is already effectively present. "Collapse" means multiple current tools should become one semantic tool family. "Hide" means the surface should move behind toolset/background control.

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
| `load_tools` | `toolset` | hidden | `load_tools` no longer ships as a live runtime control tool on this branch; use `toolset action="activate"` for discovery-driven activation. |
| `fs_read` | `fs` | always-on | Collapsed into `fs action="read"`. |
| `fs_list` | `fs` | always-on | Collapsed into `fs action="list"`. |
| `shell_exec` | `shell` | always-on | Direct command execution now belongs on `shell action="exec"`; the `think` helper remains bounded and secondary. |
| `repo_status` | `repo` | always-on | Repository inspection belongs under one primitive. |
| `repo_diff` | `repo` | always-on | Same family. |
| `repo_apply_patch` | `repo` | extended | Mutation stays gated. |
| `repo_commit` | `repo` | extended | Mutation stays gated. |
| `repo_create_branch` | `repo` | extended | Mutation stays gated. |
| `repo_open_pr` | `repo` | extended | Mutation stays gated. |
| `issue_ready` | `beads` | hidden | Legacy alias now maps to `beads action="ready"`. |
| `issue_show` | `beads` | hidden | Legacy alias now maps to `beads action="show"`. |
| `issue_create` | `beads` | hidden | Legacy alias now maps to `beads action="create"`. |
| `issue_update` | `beads` | hidden | Legacy alias now maps to `beads action="update"`. |
| `issue_close` | `beads` | hidden | Legacy alias now maps to `beads action="close"`. |
| `issue_sync` | `beads` | hidden | Legacy alias now maps to `beads action="sync"`. |
| `beads` | `beads` | extended | Unified tracked-work surface with `action=ready|show|create|update|close|sync`; read-style actions share one registration, but mutation remains explicit via `action`. |
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
| `self_restart` | `system` | always-on | Collapsed into `system action="restart"`; lifecycle safeguards and capability checks still gate execution. |
| `self_rebuild` | `system` | always-on | Collapsed into `system action="rebuild"` with the same safeguards. |
| `notify` | `notify` | extended | Unified notify surface with `action=brief|send|approval_request`. |
| `notify_operator` | `notify` | hidden | Legacy operator alert behavior now maps to `notify action="brief"`. |
| `web_fetch` | `web` | always-on | Collapsed into `web action="fetch"` for ordinary remote page retrieval through the default gateway lane. |
| `crawler_fetch` | `web` | always-on | Collapsed into `web action="browse"` so crawler-lane use stays explicit without creating a second top-level web tool. |
| `web_research` | `web` | always-on | Collapsed into `web action="search"` for small-scope URL discovery + fetch; do not confuse with `session search` or transcript recall. |
| `subagent` | `subagent` | extended | Unified bounded-worker control plane; keep distinct from long-horizon shard work. |
| `spawn_shard` | `shard` | extended | Legacy action/name now collapses into `shard action="spawn"`; long-horizon clone work is shard work, not subagent work, and forked shards intentionally inherit typed parent context snapshots and a stable prompt prefix. |
| `think` | `think` | always-on | Keep as an explicit fallback for deep reasoning. |
| `skill` | `skill` | always-on | Unified surface with `action=list|view|create|update`; skills stay discoverable and managed-skill mutation remains explicit on the same semantic tool. |
| `vault_write` | `vault` | extended | Collapsed into `vault action="write"`; vault stays for durable notes/artifacts, not scratchpad or memory. |
| `vault_read` | `vault` | always-on | Collapsed into `vault action="read"`. |
| `vault_search` | `vault` | always-on | Collapsed into `vault action="search"`. |
| `vault_daily` | `vault` | extended | Collapsed into `vault action="daily"`; daily journaling stays on the same durable note surface. |
| `image_create` | `media` | extended | Collapsed into `media action="generate"`; detailed prompt craft belongs in creator skills, not runtime context. |
| `image_edit` | `media` | extended | Collapsed into `media action="edit"` on the same surface. |
| `image_analyze` | `media` | extended | Collapsed into `media action="analyze"` on the same surface. |

## Retirement Guidance

- Where unified tools already exist, legacy action aliases are temporary migration shims, not a second permanent API surface.
- Use `agent.tools.legacy_alias` telemetry to measure whether operators and prompts have moved to the canonical action names.
- Remove legacy aliases only after canonical unified actions have stable adoption and the dependent prompt/runtime surfaces have been updated.

## Configuration Guidance

- Keep `promotedExtendedTools` small. It is a short-term exposure mechanism, not the long-term taxonomy.
- Do not add more micro-tool-specific config keys as a substitute for `toolset`.
- Treat `tool_search` as the first discovery step for non-default tools and `toolset` as the semantic control plane for activating, pinning, and unpinning them.
- Keep `shardToolsets` shard-specific. It should not become a general companion tool-selection mechanism.
- Preserve `north_star` as a dedicated semantic surface rather than folding it into `identity` or `orient`.
- Leave `think` available as a fallback, but do not use it to hide missing tool taxonomy.

## Practical Rule Of Thumb

If the task is world execution, use a primitive. If it is companion state, use a semantic companion tool. If it is workflow strategy, encode it in a skill. If it is long-tail or special-case tool selection, use `tool_search`/`toolset`. If none of that fits, `think` is the fallback.
