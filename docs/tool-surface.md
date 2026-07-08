# Tool Surface Contract

This document defines the canonical model-facing tool stack for PSFN and maps retired first-party names to their canonical replacements.

The goal is not to expose more tools. The goal is to reduce tool-choice entropy while preserving semantic companion-state surfaces that must stay explicit. Charter Law 33 governs this surface: one semantic model-facing tool per domain; domain operations live as actions; legacy or split helper names must not remain callable, searchable, promotable, autoloaded, or documented as model-facing API once the canonical action exists. The stack below is the current model-facing contract; retired names are documented only so maintainers know what not to reintroduce.

## Canonical Stack

### Always-On Primitives

- `fs`
- `repo`
- `shell`
- `web`
- `analysis_workbench`
- `tool_search`
- `toolset`
- `response_control`

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
- `wiki`
- `journal`
- `vault`
- `beads`
- `skill`
- `self_status`
- `system`
- `notify`
- `generate_image`
- `selfie_create`

## Current Stabilized Branch

The current runtime exposes canonical first-party tool names for the domains covered by this contract. Split helper names are not an acceptable compatibility lane: they must not be registered, returned from discovery, pinned, autoloaded, or documented as callable tools.

Always-on adaptive control:

- `tool_search`
- `toolset`
- `response_control`

Unified top-level direct tools in the current runtime:

- `fs`
- `repo`
- `shell`
- `web`
- `skill`
- `wiki`
- `journal`
- `orient`
- `memory`
- `scratchpad`
- `contact`
- `session`
- `identity`
- `north_star`
- `schedule`
- `self_status`
- `system`
- `subagent`
- `vault`
- `beads`
- `notify`
- `generate_image`
- `selfie_create`

Important current-state notes:

- `load_tools` and `promoted_tools_*` are no longer live runtime control tools. Discovery, activation, pinning, and catalog inspection run through `tool_search` and `toolset`.
- `fs_list`, `fs_read`, `repo_status`, `repo_diff`, `repo_apply_patch`, `repo_commit`, `repo_create_branch`, `repo_open_pr`, `vault_*`, `issue_*`, `settings_get`, `self_restart`, `self_rebuild`, and `notify_operator` are historical or action-alias names, not model-facing control paths.
- Transcript lookup stays on `session`; memory and scratchpad mutation stay on `memory` and `scratchpad`; contact mutation stays on `contact`; values and concerns stay on `orient`.
- Safe companion-facing runtime introspection stays on `self_status`; guarded runtime settings and lifecycle actions stay on `system`.
- `response_control action="no_reply"` is the explicit no-response disposition surface. It is for intentional non-replies, not hidden failure.
- Generic image generation, editing, and analysis stay on `generate_image` (registered core, presented before admin/dev tooling); `selfie_create` stays separate as the first-class core self-expression image tool. The old `media` name is retired: activation attempts fail with an error naming `generate_image`.
- `journal` is a core durable markdown note surface for companion-authored notes and longer-lived context that is not typed memory, active orientation, or scratch work.
- `shard` is currently a reserved extended registry entry for future long-horizon shard lifecycle control. Shard execution internals, fold-review lineage, and satellite delegation exist, but bounded model-facing worker control is currently `subagent`.
- Garden's Tools page must reflect the runtime catalog for canonical names only. It may show actions, required parameters, capability requirements, reversibility, interruptibility/concurrency, and bundle membership, but must not present retired aliases as callable tools.

## Canonical Discovery Surface

`tool_search` and `toolset` are always-on adaptive-control tools.

- `tool_search` searches non-default canonical tools by purpose and description.
- `toolset action="list"` reports active, loaded, available, and pinned canonical tools.
- `toolset action="suggest"` proposes canonical tools for the current task without loading them.
- `toolset action="describe"` returns canonical action schemas, required parameters, capability requirements, reversibility, interruptibility/concurrency metadata, and bundle membership.
- `toolset action="activate"` loads canonical extended tools for the current turn.
- `toolset action="pin"` and `toolset action="unpin"` mutate the small pinned overlay.

These tools follow the Hermes-inspired rule: discovery can describe capabilities and bundles in detail, but it must not multiply callable names for actions that already belong to a canonical surface.

## Canonical Identity Surface

The canonical model-facing `identity` surface collapses prompt-layer and persona work into one tool.

- Read actions: `list_layers`, `get_layer`, `diff_layer`, `history`
- Prompt mutation actions: `update_layer`, `rollback_layer`, `toggle_layer`, `commit_stage`, `cancel_stage`
- Persona mutation action: `update_persona`

The surface is always on so the model does not have to discover or choose among prompt-stack micro-tools. Write actions remain capability-gated, and the existing confirmation/cooling-off safeguards still apply.

## Canonical Schedule Surface

The canonical model-facing `schedule` surface collapses time-based continuity and scheduling work into one tool. The registry tracks the broad target verbs (`list`, `create`, `update`, `delete`, `run`); the live schedule implementation still exposes concrete scheduler actions for continuity and templates:

- Continuity actions: `list`, `create_follow_up`, `activate_follow_up`, `create_reminder`, `trigger_reminder`
- Scheduler/template actions: `list_templates`, `update_template`, `run_template`, `schedule_prompt`

This keeps durable reminders, proactive follow-ups, birthdays, anniversaries, self-reminders, and timed work under one semantic faculty instead of scattering them across ad hoc timer micro-tools.

## Canonical Filesystem Surface

The canonical model-facing `fs` surface collapses common workspace inspection and safe file mutation into one tool.

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

## Canonical Repo Surface

The canonical model-facing `repo` surface collapses git-backed repository inspection and mutation into one tool.

- Actions: `inspect`, `patch`, `branch`, `commit`, `publish`
- `inspect` keeps repository state and diff lookup on one primitive instead of splitting them across read-only micro-tools
- `patch`, `branch`, and `commit` keep destructive mutation explicit and capability-gated
- `publish` remains distinct from shell and still routes through the guarded GitHub publication path instead of raw command execution

This keeps repository work on one primitive while preserving the existing protected-branch checks, allowlisted patch paths, and gateway approval policy for write and publish flows.

## Canonical Shell Surface

The current runtime already exposes a unified model-facing `shell` tool for direct command execution outside `analysis_workbench`, and that remains the canonical shape.

- Action: `exec`

The surface stays intentionally narrow:

- commands run without a shell parser; callers must pass explicit `command` and `args`
- gateway policy remains authoritative for enablement, executable allowlists, cwd bounds, timeouts, and output caps
- confirmation, auditing, and fail-closed denial stay on the underlying `shell.exec` gateway path
- `shell` remains distinct from `fs` and `repo`; use those primitives for structured workspace and git operations instead of shelling out by default
- `shell_exec` inside `analysis_workbench` remains a bounded helper, not the primary model-facing surface

## Canonical Session Surface

The canonical model-facing `session` surface collapses continuity, transcript lookup, resumption, and focus workflow into one tool.

- Primary actions: `list`, `new`, `resume`, `search`, `grep`, `list_continuity`, `checkpoint`, `wake_return`, `start_focus`, `complete_focus`
- Retired aliases that must not be model-facing:
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

## Canonical Contact Surface

The canonical model-facing `contact` surface collapses relationship operations and canonical contact continuity into one tool.

- Actions: `list`, `lookup`, `note`, `set_trust`, `propose_trust`, `link_identity`, `set_channel_privacy`, `set_machine_intelligence`
- Retired aliases that must not be model-facing:
  `contact_list` -> `list`
  `contact_lookup` -> `lookup`
  `contact_note` -> `note`
  `contact_set_trust` -> `set_trust`
  `contact_link_identity` -> `link_identity`
  `contact_set_channel_privacy` -> `set_channel_privacy`

This keeps contact lookup, typed notes, trust drift handling, cross-channel identity linking, and per-channel privacy on one semantic relationship surface instead of scattering them across micro-tools. Trust/disclosure invariants and typed contact semantics remain enforced by the underlying contact store.

`set_trust` can only apply low-tier trust changes autonomously; high-tier promotion stays blocked (policy/store guards). To promote a contact to `trusted`, the agent uses `propose_trust` (requires `contactId` and `rationale`), which enqueues a proposal onto the shared confirmation queue for operator approval in the Garden Confirmations page. The write happens only on approval, under a manual-authorized `operator:` actor, and is audited like any other trust mutation. `primary` can never be proposed — it remains owner-only.

## Canonical Notify Surface

The canonical model-facing `notify` surface collapses operator briefs, lightweight outbound delivery, and approval escalation into one tool.

- Actions: `brief`, `send`, `approval_request`
- `brief` is the direct replacement for legacy `notify_operator`
- `send` requires an explicit delivery channel and explicit external target; it does not infer the current channel
- `approval_request` keeps operator-review details explicit instead of hiding them behind implicit side effects

The surface keeps lightweight visible tool output separate from the heavier internal delivery work. Briefs remain fail-closed for scheduled/internal contexts, outbound sends require explicit delivery targets, and approval escalation stays explicit about what is awaiting review.

## Canonical Skill Surface

The current runtime already exposes a unified model-facing `skill` tool for skill discovery, inspection, usage telemetry, and managed-skill mutation, and that remains the canonical shape.

- Actions: `list`, `view`, `create`, `update`
- Usage telemetry action: `stats`
- Retired action aliases must not be model-facing; the model-facing tool name is `skill`
- `list` preserves discovery metadata, eligibility outcomes, and filtered-skill reasons
- `view` loads one skill's full YAML + Markdown body on demand
- Global deployment skills live in the repository root `skills/` directory and are provided to the companion through `skills.json`
- `create` and `update` write personal managed skills under `WORKSPACE_PATH/skills/<category>/<name>/SKILL.md` and refresh the runtime snapshot; personal skills remain separate from repo-global skills
- Creator workflows such as image creation, music creation, and future media variants belong here as creator-category skills loaded with `skill action="view"`

## Canonical Image Surface

The canonical model-facing `generate_image` surface (formerly `media`) collapses generic image generation, transformation, and inspection into one tool. `selfie_create` remains a separate first-class self-expression image tool because it owns appearance context, saved-reference anchoring, and self-representation safeguards. Both are core tools in the default stack, and their descriptions cross-reference each other in both directions: images of the companion herself belong to `selfie_create`; everything else belongs to `generate_image`.

- Actions: `generate`, `edit`, `analyze`
- `generate` creates a new image from a prompt
- `edit` transforms one or more existing input URLs (the retired `image_edit` capability lives here)
- `analyze` inspects visible contents or consistency questions on explicit inputs (consumption-side behavior; a future `analyze_media` split may move it off this tool)
- Detailed prompt craft for image creation, music creation, and future creator workflows stays modeled as creator skills loaded with `skill action="view"`

## Canonical Web Surface

The canonical model-facing `web` surface collapses outward web work while keeping gateway fetch lanes and allowlists explicit underneath.

- Actions: `fetch`, `browse`, `search`
- `fetch` is the ordinary external-web read path and maps to the gateway default lane
- `browse` is the explicit local-crawler/webpage traversal path and maps to the gateway `local_crawler` lane
- `search` is lightweight research discovery that returns a small fetched URL set without collapsing into session continuity or transcript search semantics
- Gateway RPC methods remain split as `web.fetch` and `web.fetch_binary`; that transport split is deliberate so URL policy, binary size limits, redirect auditing, and lane-specific allowlists stay fail-closed

This keeps ordinary page retrieval, crawler-style browsing, and small-scope web research under one semantic tool family instead of exposing multiple near-duplicate web micro-tools to the model.

## Canonical Wiki Surface

The canonical model-facing `wiki` surface is the canonical PSFN-owned knowledge-base for durable reference documents and personal knowledge notes.

- Actions: `list`, `read`, `search`, `write`, `import`
- Authored documents live under `WORKSPACE_PATH/knowledge/wiki/`
- Imported/source-derived documents require source class and provenance references
- Wiki results must be labeled as authored/imported/reference knowledge, not transcript memory or lived relationship memory
- Wiki storage stays distinct from L0 session history, L0.1 episodic landmarks, L2 typed memory, scratchpad, journal files, and active orientation

This keeps durable reference creation, retrieval, search, and import on one semantic surface. Stable facts or relational knowledge still belong in `memory`; temporary working context stays in `scratchpad`; active operational state stays in `orient`.

## Canonical Journal Surface

The canonical model-facing `journal` surface is for durable companion-authored markdown notes, reflections, and longer-lived context that should remain narrative but should not become active orientation, typed memory, or same-turn scratch work.

- Actions: `list`, `read`, `write`, `append`, `search`
- Journal notes are durable markdown files managed by the runtime journal operations.
- Use separate notes for separate topics; append only when continuing an existing note.
- Use `scratchpad` for temporary excerpts or working hypotheses, `orient` for active concerns/open threads, `wiki` for curated reference knowledge, and `memory` for typed recall facts.

## Legacy External Vault Surface

The legacy model-facing `vault` surface is an optional external Obsidian bridge for bounded source read/search/write compatibility. It is not the canonical durable companion note store.

- Actions: `read`, `write`, `search`, `daily`
- Retired aliases that must not be model-facing:
  `vault_read` -> `read`
  `vault_write` -> `write`
  `vault_search` -> `search`
  `vault_daily` -> `daily`

External vault notes that become PSFN-owned reference knowledge should be imported into `wiki` with source class `imported_partner_vault_note` and provenance references. Direct vault access must not silently copy Obsidian content into L0/L0.1/L2 memory.

## Canonical System Surface

The canonical model-facing `system` surface collapses safe runtime-setting reads and guarded lifecycle control into one tool.

- Preferred actions:
  `read`
  `restart`
  `rebuild`
- Retired aliases that must not be model-facing:
  `settings_get` -> `read`
  `self_restart` -> `restart`
  `self_rebuild` -> `rebuild`

`system action="read"` preserves the existing safe runtime-settings snapshot behavior. `system action="restart|rebuild"` preserves the existing restart safeguard checks, notification flow, and capability enforcement, but keeps lifecycle control on one semantic surface instead of separate micro-tools.

## Reserved Shard Surface

The `shard` registry entry is reserved for long-horizon shard work and fold-back lifecycle control. It is not yet the ordinary direct model-facing control surface.

- Current registry action: `spawn`
- Bounded short-horizon worker control belongs to `subagent action="spawn"`; `spawn_subagent` and the old `spawn_shard` name must not be used in active prompts or checklists.
- Shard internals already include `ShardManager`, fold-review records, lineage tagging, artifact review policy, active/degraded/offline lifecycle state, charge accounting, and satellite delegation hooks.
- Future direct shard control should converge on this one surface rather than reintroducing `spawn_shard` or shard-specific micro-tools.

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
- Promote scratchpad content only when it hardens into stable facts (`memory`), durable notes/artifacts (`wiki` or repo docs), or orientation state (`orient`).
- Temporary file cleanup only touches generated media plus the managed workspace temp subtree at `workspace/.psfn/temp-artifacts`; ordinary workspace files are never swept implicitly.
- Use `analysis_workbench` only for bounded multi-stage analysis of large files, codebases, logs, transcripts, datasets, or evidence sets that would overload normal context.
- Keep `web` distinct from `session`: transcript lookup and continuity resume belong to `session`, while remote-page discovery/retrieval belongs to `web`.
- Keep creative prompt craft, appearance heuristics, and provider/model quirks in creator skills rather than top-level tool descriptions.
- Keep bounded worker control on `subagent` with `action=spawn|message|wait|cancel|status`.
- Keep shard and subagent names distinct because they model different work durations and isolation semantics.
- Keep forked shard generation explicit so inherited parent context stays in shard prompt discipline rather than leaking into bounded subagent control.

## Retired Name Map

The table below maps current or retired first-party tool names to the canonical surface. It is a retirement map, not a compatibility promise. "Hidden" and "retired" names must not be model-facing once the canonical action exists.

| Retired or current name | Canonical surface | Exposure | Notes |
| --- | --- | --- | --- |
| `memory` | `memory` | always-on | Unified long-term memory surface with `action=write|search|shared_background|census|exists|timeline|import|patch|redact|delete|restore`; capability gating still distinguishes read/write/delete-sensitive paths. `action=shared_background` (contact_a/contact_b) returns the memories that link two contacts (edge-evidence, co-mention, shared-room) under the asking context's gates — it is an ACTION only, never a separate model-facing tool (Charter Law 33). |
| `scratchpad` | `scratchpad` | always-on | Unified ephemeral workspace with `action=list|add|replace|append|remove`; short-lived working notes stay explicit and non-canonical. |
| `wiki` | `wiki` | always-on | Internal PSFN-owned durable reference knowledge with `action=list|read|search|write|import`; separate from memory, scratchpad, journals, orientation, and Obsidian/Vault. |
| `core_memory_append` | `orient` | always-on | Now maps to `orient action="append"` for incremental orientation updates. |
| `core_memory_replace` | `orient` | always-on | Now maps to `orient action="replace"` for single-block rewrites. |
| `memory_rethink` | `orient` | background-only | Now maps to `orient action="reorient"` for holistic orientation refresh. |
| `values_list` | `orient` | always-on | Values are part of active self-orientation, not a separate tool family. |
| `values_add` | `orient` | retired | Append-only value journaling belongs on `orient action="values_add"`. |
| `values_update` | `orient` | retired | Revisions belong on `orient action="values_update"`. |
| `create_concern` | `orient` | background-only | Active concerns are orientation data, not a task board. |
| `list_concerns` | `orient` | background-only | Concern visibility belongs to the same active-state lane. |
| `resolve_concern` | `orient` | background-only | Concern resolution closes the loop on active-state tracking. |
| `transition_concern` | `orient` | background-only | Concern lifecycle transitions stay on the same active-state lane. |
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
| `session_new` | `session` | retired | Use `session action="new"`; continuity and conversation workflow belong together. |
| `session_list` | `session` | hidden | Historical top-level name; use `session action="list"`. |
| `session_resume` | `session` | retired | Use `session action="resume"`; resume is a workflow action. |
| `session_search` | `session` | hidden | Historical top-level name; use `session action="search"`. |
| `session_grep` | `session` | hidden | Historical top-level name; use `session action="grep"`. |
| `continuity_list` | `session` | hidden | Historical top-level name; use `session action="list_continuity"`. |
| `wake_return_summary` | `session` | hidden | Historical top-level name; use `session action="wake_return"`. |
| `start_focus` | `session` | retired | Use `session action="start_focus"`. |
| `complete_focus` | `session` | retired | Use `session action="complete_focus"`. |
| `self_restart` | `system` | hidden | Historical top-level name; use `system action="restart"` with the same safeguards. |
| `self_rebuild` | `system` | hidden | Historical top-level name; use `system action="rebuild"` with the same safeguards. |
| `notify` | `notify` | extended | Unified notify surface with `action=brief|send|approval_request`. |
| `notify_operator` | `notify` | hidden | Legacy operator alert behavior now maps to `notify action="brief"`. |
| `web_fetch` | `web` | always-on | Collapsed into `web action="fetch"` for ordinary remote page retrieval through the default gateway lane. |
| `crawler_fetch` | `web` | always-on | Collapsed into `web action="browse"` so crawler-lane use stays explicit without creating a second top-level web tool. |
| `web_research` | `web` | always-on | Collapsed into `web action="search"` for small-scope URL discovery + fetch; do not confuse with `session search` or transcript recall. |
| `subagent` | `subagent` | always-on | Unified bounded-worker control plane; keep distinct from long-horizon shard work. |
| `spawn_subagent` | `subagent` | retired | Use `subagent action="spawn"` for bounded short-horizon work. |
| `spawn_shard` | `shard` | hidden | Historical name from the pre-consolidation surface. Do not use it in active prompts or checklists; future long-horizon shard work should converge on `shard action="spawn"`. |
| `analysis_workbench` | `analysis_workbench` | always-on | Bounded RLM+REPL analysis for large files, codebases, logs, transcripts, datasets, or evidence sets. Not for routine reasoning, tool discovery, schema confusion, simple lookup, or state changes. |
| `skill` | `skill` | always-on | Unified surface with `action=list|view|stats|create|update`; skills stay discoverable and managed-skill mutation remains explicit on the same semantic tool. |
| `vault` | `vault` | extended | Legacy external Obsidian bridge for bounded source read/search/write compatibility; canonical durable reference knowledge belongs in `wiki`. |
| `journal` | `journal` | always-on | Durable markdown journal with `action=list|read|write|append|search`; separate from memory, scratchpad, wiki, and active orientation. |
| `vault_write` | `vault` | hidden | Historical top-level name; use `vault action="write"` only for the external Obsidian bridge. |
| `vault_read` | `vault` | hidden | Historical top-level name; use `vault action="read"` only for the external Obsidian bridge. |
| `vault_search` | `vault` | hidden | Historical top-level name; use `vault action="search"` only for the external Obsidian bridge. |
| `vault_daily` | `vault` | hidden | Historical top-level name; use `vault action="daily"` only for the external Obsidian bridge. |
| `media` | `generate_image` | retired | Renamed: the `media` name was too vague to route against `selfie_create`. Activation of the old name fails with an error naming `generate_image`. |
| `image_create` | `generate_image` | retired | Use `generate_image action="generate"`; detailed prompt craft belongs in creator skills, not runtime context. |
| `image_edit` | `generate_image` | retired | Use `generate_image action="edit"` on the same surface. |
| `image_analyze` | `generate_image` | retired | Use `generate_image action="analyze"` on the same surface. |
| `selfie_create` | `selfie_create` | core | First-class self-expression image tool with appearance context, saved-reference anchoring, and generated-output review. |

## Retirement Guidance

- Where unified tools already exist, legacy action aliases and split helper names are retirement debt, not a second API surface.
- Do not add new model-facing aliases for actions that already belong to a canonical tool.
- If an exception is unavoidable, first add it to the charter with owner, reason, validation, and removal criteria.

## Configuration Guidance

- Keep `promotedExtendedTools` small. It is a short-term exposure mechanism, not the long-term taxonomy.
- Do not add more micro-tool-specific config keys as a substitute for `toolset`.
- Treat `tool_search` as the first discovery step for non-default tools and `toolset` as the semantic control plane for activating, pinning, and unpinning them.
- Keep `shardToolsets` shard-specific. It should not become a general companion tool-selection mechanism.
- Preserve `north_star` as a dedicated semantic surface rather than folding it into `identity` or `orient`.
- Leave `analysis_workbench` available for large-context analysis, but do not use it to hide missing tool taxonomy or routine direct-tool gaps.

## Practical Rule Of Thumb

If the task is world execution, use a primitive. If it is companion state, use a semantic companion tool. If it is workflow strategy, encode it in a skill. If it is long-tail or special-case tool selection, use `tool_search`/`toolset`. Use `analysis_workbench` only when the material is too large or multi-stage for normal context without crowding out the conversation.
