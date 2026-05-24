# Tool Surface Contract

This document defines the target model-facing tool stack for PSFN and maps the current first-party names to that target.

The goal is not to expose more tools. The goal is to reduce tool-choice entropy while preserving semantic companion-state surfaces that must stay explicit. Unless a section explicitly says "current stabilized branch", treat the unified names below as target taxonomy, not a claim that every target tool is already registered in the live runtime.

## Target Stack

### Always-On Primitives

- `fs`
- `repo`
- `shell`
- `web`
- `analysis_workbench`
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

The current Sprint 8 runtime ships a mixed direct tool surface. The target stack above is architectural direction; several high-entropy legacy aliases have already been collapsed.

Always-on adaptive control:

- `tool_search`
- `toolset`

Unified top-level direct tools in the current runtime:

- `fs`
- `repo`
- `shell`
- `web`
- `skill`
- `orient`
- `memory`
- `scratchpad`
- `contact`
- `session`
- `identity`
- `north_star`
- `schedule`
- `system`
- `subagent`
- `vault`
- `beads`
- `notify`
- `media`

Still-split or compatibility direct tools in the current runtime:

- memory mutation helpers: `memory_import_batch`, `memory_patch`, `memory_redact`, `memory_delete`, `undo_memory_delete`, `scratchpad_write`
- contact mutation helpers: `contact_note`, `contact_set_trust`, `contact_link_identity`, `contact_set_channel_privacy`
- session continuity helpers: `session_new`, `session_resume`, `start_focus`, `complete_focus`
- values: `values_add`, `values_update`
- promoted-tool compatibility helpers: `promoted_tools_*`
- media compatibility helpers: `image_create`, `image_edit`, `image_analyze`, plus dedicated `selfie_create`
- bounded worker launch helper: `spawn_subagent`

Important current-state notes:

- `load_tools` is no longer a live runtime control tool. Tool discovery and activation now run through `tool_search` and `toolset`.
- `fs_list`, `fs_read`, `repo_status`, `repo_diff`, `repo_apply_patch`, `repo_commit`, `repo_create_branch`, `repo_open_pr`, `vault_*`, `issue_*`, `settings_get`, `self_restart`, `self_rebuild`, and `notify_operator` are historical or action-alias names, not the preferred model-facing control path.
- Transcript lookup now stays on the direct `session` tool; the split `session_search`, `session_grep`, and `session_list` registrations are no longer live.
- Unified `memory`, `scratchpad`, `contact`, `session`, and `orient` are live direct tools on this branch, while only selected write/mutation helpers stay split during migration.
- Unified `identity`, `north_star`, `schedule`, `system`, `vault`, `beads`, `notify`, and `media` are live direct tools on this branch. Legacy prompt-layer, lifecycle, operator-notification, vault, beads, and heartbeat/scheduling aliases are not the model-facing control path.

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

This keeps durable reminders, proactive follow-ups, birthdays, anniversaries, self-reminders, and timed work under one semantic faculty instead of scattering them across ad hoc timer micro-tools.

## Target Filesystem Surface

The target model-facing `fs` surface collapses common workspace inspection and safe file mutation into one tool.

- Inspection actions: `list`, `read`, `search`
- Mutation actions: `write`, `edit`

The surface is designed to keep routine codebase inspection out of `analysis_workbench`:

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

The current runtime already exposes a unified model-facing `shell` tool for direct command execution outside `analysis_workbench`, and that remains the target shape.

- Action: `exec`

The surface stays intentionally narrow:

- commands run without a shell parser; callers must pass explicit `command` and `args`
- gateway policy remains authoritative for enablement, executable allowlists, cwd bounds, timeouts, and output caps
- confirmation, auditing, and fail-closed denial stay on the underlying `shell.exec` gateway path
- `shell` remains distinct from `fs` and `repo`; use those primitives for structured workspace and git operations instead of shelling out by default
- `shell_exec` inside `analysis_workbench` remains a bounded helper, not the primary model-facing surface

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
- `create` and `update` write personal managed skills under `WORKSPACE_PATH/skills/<category>/<name>/SKILL.md` and refresh the runtime snapshot; deployment/system skills remain separate
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
- Current Sprint 8 bounded parallel work uses `spawn_subagent`; the old `spawn_shard` name is historical and should not be used in active prompts or checklists.
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
- Use `analysis_workbench` only for bounded multi-stage analysis of large files, codebases, logs, transcripts, datasets, or evidence sets that would overload normal context.
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
| `persona_update` | `identity` | always-on | Collapsed into `identity action=update_persona` with the existing review guards preserved. |
| `character_card_update` | `identity` | hidden | Historical prompt/persona mutation name; use `identity action="update_persona"`. |
| `north_star` | `north_star` | extended | Unified long-horizon guiding-intent surface with `action=list|create|update|delete|reorder`; keep it semantic and non-core. |
| `settings_get` | `system` | hidden | Historical top-level name; runtime-setting reads use `system action="read"`. |
| `tool_search` | `tool_search` | always-on | Primary discovery surface for non-default tools; pair it with `toolset` for activation or pinning. |
| `promoted_tools_list` | `toolset` | hidden | Legacy promoted-tool helper now collapses into `toolset action="list"`. |
| `promoted_tools_add` | `toolset` | hidden | Legacy promoted-tool helper now collapses into `toolset action="pin"`. |
| `promoted_tools_remove` | `toolset` | hidden | Legacy promoted-tool helper now collapses into `toolset action="unpin"`. |
| `promoted_tools_swap` | `toolset` | hidden | Legacy slot-reorder helper is no longer model-facing. |
| `load_tools` | `toolset` | hidden | `load_tools` no longer ships as a live runtime control tool on this branch; use `toolset action="activate"` for discovery-driven activation. |
| `fs_read` | `fs` | hidden | Historical top-level name; use `fs action="read"`. |
| `fs_list` | `fs` | hidden | Historical top-level name; use `fs action="list"`. |
| `shell_exec` | `shell` | always-on | Direct command execution now belongs on `shell action="exec"`; the `analysis_workbench` helper remains bounded and secondary. |
| `repo_status` | `repo` | hidden | Historical top-level name; use `repo action="inspect" target="status"`. |
| `repo_diff` | `repo` | hidden | Historical top-level name; use `repo action="inspect" target="diff"`. |
| `repo_apply_patch` | `repo` | hidden | Historical top-level name; use gated `repo action="patch"` when mutation is explicitly enabled. |
| `repo_commit` | `repo` | hidden | Historical top-level name; use gated `repo action="commit"` when mutation is explicitly enabled. |
| `repo_create_branch` | `repo` | hidden | Historical top-level name; use gated `repo action="branch"` when mutation is explicitly enabled. |
| `repo_open_pr` | `repo` | hidden | Historical top-level name; use `repo action="publish"`. |
| `issue_ready` | `beads` | hidden | Legacy alias now maps to `beads action="ready"`. |
| `issue_show` | `beads` | hidden | Legacy alias now maps to `beads action="show"`. |
| `issue_create` | `beads` | hidden | Legacy alias now maps to `beads action="create"`. |
| `issue_update` | `beads` | hidden | Legacy alias now maps to `beads action="update"`. |
| `issue_close` | `beads` | hidden | Legacy alias now maps to `beads action="close"`. |
| `issue_sync` | `beads` | hidden | Legacy alias now maps to `beads action="sync"`. |
| `beads` | `beads` | extended | Unified tracked-work surface with `action=ready|show|create|update|close|sync`; read-style actions share one registration, but mutation remains explicit via `action`. |
| `session_new` | `session` | always-on | Continuity and conversation workflow belong together. |
| `session_list` | `session` | hidden | Historical top-level name; use `session action="list"`. |
| `session_resume` | `session` | extended | Resume is a workflow action, not a read-only query. |
| `session_search` | `session` | hidden | Historical top-level name; use `session action="search"`. |
| `session_grep` | `session` | hidden | Historical top-level name; use `session action="grep"`. |
| `continuity_list` | `session` | hidden | Historical top-level name; use `session action="list_continuity"`. |
| `wake_return_summary` | `session` | hidden | Historical top-level name; use `session action="wake_return"`. |
| `start_focus` | `session` | extended | Focus sessions are workflow state. |
| `complete_focus` | `session` | extended | Same family. |
| `self_restart` | `system` | hidden | Historical top-level name; use `system action="restart"` with the same safeguards. |
| `self_rebuild` | `system` | hidden | Historical top-level name; use `system action="rebuild"` with the same safeguards. |
| `notify` | `notify` | extended | Unified notify surface with `action=brief|send|approval_request`. |
| `notify_operator` | `notify` | hidden | Legacy operator alert behavior now maps to `notify action="brief"`. |
| `web_fetch` | `web` | always-on | Collapsed into `web action="fetch"` for ordinary remote page retrieval through the default gateway lane. |
| `crawler_fetch` | `web` | always-on | Collapsed into `web action="browse"` so crawler-lane use stays explicit without creating a second top-level web tool. |
| `web_research` | `web` | always-on | Collapsed into `web action="search"` for small-scope URL discovery + fetch; do not confuse with `session search` or transcript recall. |
| `subagent` | `subagent` | extended | Unified bounded-worker control plane; keep distinct from long-horizon shard work. |
| `spawn_subagent` | `subagent` | extended | Current bounded parallel launch helper for short-horizon work. It is not the long-horizon shard surface. |
| `spawn_shard` | `shard` | hidden | Historical name from the pre-consolidation surface. Do not use it in active prompts or checklists; future long-horizon shard work should converge on `shard action="spawn"`. |
| `analysis_workbench` | `analysis_workbench` | always-on | Bounded RLM+REPL analysis for large files, codebases, logs, transcripts, datasets, or evidence sets. Not for routine reasoning, tool discovery, schema confusion, simple lookup, or state changes. |
| `skill` | `skill` | always-on | Unified surface with `action=list|view|create|update`; skills stay discoverable and managed-skill mutation remains explicit on the same semantic tool. |
| `vault_write` | `vault` | hidden | Historical top-level name; use `vault action="write"`. |
| `vault_read` | `vault` | hidden | Historical top-level name; use `vault action="read"`. |
| `vault_search` | `vault` | hidden | Historical top-level name; use `vault action="search"`. |
| `vault_daily` | `vault` | hidden | Historical top-level name; use `vault action="daily"`. |
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
- Leave `analysis_workbench` available for large-context analysis, but do not use it to hide missing tool taxonomy or routine direct-tool gaps.

## Practical Rule Of Thumb

If the task is world execution, use a primitive. If it is companion state, use a semantic companion tool. If it is workflow strategy, encode it in a skill. If it is long-tail or special-case tool selection, use `tool_search`/`toolset`. Use `analysis_workbench` only when the material is too large or multi-stage for normal context without crowding out the conversation.
