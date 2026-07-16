# Tool-Gap Survey — Cribbing Missing TOOLS from Surveyed Harnesses (b0yl.7)

**Bead:** `psfn-framework-b0yl.7` (P2) · **Epic:** `psfn-framework-b0yl` (Tool-calling reliability) · **Date:** 2026-07-15 · **Assignee:** opus-lane-e

**Scope note:** this bead is about TOOLS, not skills. Skills (the `skill` surface, self-learning à la Hermes) are covered separately (`i72.2`). This survey inventories PSFN's live direct-tool catalog, inventories what each surveyed harness ships, and asks one question per candidate gap: *does this tool have proven cross-harness value that PSFN lacks, and does it fit a long-lived companion runtime (not a coding CLI)?* The bead's headline question — a plan/todo attention-anchor tool — gets a dedicated section.

Source material: `working_docs/prompt-audit-findings-20260714.md` §6 (harness research lane, primary-source verified) + live registry read (`src/core/agent/tool-surface/registry.ts`, 2026-07-15) + web confirmation of current harness tool sets.

---

## 1. PSFN current direct-tool inventory (live registry, 2026-07-15)

**29 canonical first-party surfaces: 21 `core` (always-eligible) + 8 `extended` (activated / pinned / autoloaded).** Every surface is action-multiplexed (one tool name, many actions) except the five static ones. This is the model-facing *direct* catalog — REPL-only helpers inside `analysis_workbench` sandbox execution are NOT catalog entries and are out of scope here.

Grouped by domain (presentation-rank order — social/expressive first, boundary/system last):

| Domain | Surface | Exp | Key actions | Companion role |
|---|---|---|---|---|
| self_expression | `selfie_create` | core | (static) | Self-portrait with appearance/reference anchoring |
| media | `generate_image` | core | generate, edit, analyze | Generic image gen/transform/vision |
| notification | `notify` | ext | brief, send, consider, approval_request | Governed outreach / operator notify / approval |
| contacts | `contact` | core | list, search, lookup, note, set_trust, propose_trust, set_relationship, link_identity, set_channel_privacy, block | Relationship + trust model |
| memory | `memory` | core | write, search, shared_background, census, exists, timeline, import, patch, redact, delete, restore | Durable episodic/semantic/emotional memory |
| memory | `scratchpad` | core | list, add, replace, append, remove | **Ephemeral freeform working notes** (mechanically the closest thing to a mutable todo list) |
| memory | `journal` | core | list, read, write, append, search | Durable companion-authored journal |
| sessions | `session` | core | list, new, resume, search, grep, wake_return, start_focus, complete_focus | Session lifecycle + transcript lookup + **focus work** (jhqb will split) |
| orientation | `orient` | core | append, replace, reorient, values_*, **create_concern, list_concerns, resolve_concern, transition_concern**, introspection_consent_* | Core-memory blocks + values + **active concerns** |
| orientation | `north_star` | ext | list, create, update, delete, reorder | **Durable long-horizon intent** (approval-gated plan layer; 7ym.1) |
| identity | `identity` | core | list_layers, get_layer, diff_layer, history, update_layer, rollback_layer, toggle_layer, update_persona, commit_stage, cancel_stage | Persona / character-card self-modification |
| knowledge | `skill` | core | list, view, stats, **create, update** | **Skill authoring** (verified end-to-end, see §5) |
| knowledge | `wiki` | core | list, read, search, semantic_search, write, import | Personal knowledge base |
| knowledge | `library` | ext | list, read, import_text, import_file, promote_scratchpad | Research library |
| knowledge | `vault` | ext | write, read, search, daily | External Obsidian bridge |
| scheduler | `schedule` | core | list, create_follow_up, activate_follow_up, create_reminder, trigger_reminder, list_templates, update_template, run_template, schedule_prompt | Reminders / follow-ups / scheduled prompts / heartbeat policy |
| analysis | `analysis_workbench` | core | (static — universal sandboxed executor) | **Universal code-exec seam** (holds the long tail à la OpenHands bash+IPython) |
| subagents | `subagent` | core | spawn, message, wait, cancel, status | Bounded short-horizon worker delegation |
| tracked_work | `beads` | ext | ready, show, create, update, close, sync | Issue tracker |
| adaptive_tooling | `tool_search` | core | (static) | Discovery-surface ranking |
| adaptive_tooling | `toolset` | core | list, suggest, describe, pin, unpin | Catalog/extension management (goose-style) |
| boundary | `fs` | core | read, list, search, write, edit | Filesystem (view/grep/glob/edit equivalent) |
| boundary | `repo` | ext | inspect, patch, commit, branch, publish | Git repo mutation |
| boundary | `shell` | ext | exec | Shell |
| boundary | `web` | core | fetch, browse, search | Web fetch / crawl / search |
| boundary | `world` | ext | perceive, list, control, move | Satellite/embodiment world control |
| system | `response_control` | core | no_reply | Suppress a reply |
| system | `self_status` | core | snapshot, diagnose, logs, conformance, availability_* | Self-diagnostics + peer availability |
| system | `system` | core | read, restart, rebuild | Settings read + self-restart/rebuild |

**Category coverage summary vs. a generic agent harness:**
- File/edit/search/exec: `fs`, `repo`, `shell`, `analysis_workbench` — **complete**.
- Web/browse/search: `web` — **complete**.
- Universal executor for the long tail: `analysis_workbench` — **complete** (the P2 "route long-tail through a universal executor" pattern already exists).
- Extension/catalog management: `toolset` — **complete** (goose-parity).
- Subagent delegation: `subagent` — **complete**.
- Skill authoring / self-learning: `skill` create/update — **complete and verified** (§5).
- Memory/notes: `memory`, `scratchpad`, `journal`, `wiki`, `vault`, `library` — **richer than any coding harness**.
- **Plan / todo / task-tracker: NO direct equivalent** — this is the one genuine gap (§4).

---

## 2. Per-harness tool inventory (surveyed harnesses)

Confirmed against primary sources / current docs (2026-07). Only *tools* listed (not skills, not slash-commands).

| Harness | Core tool set | Notable / distinctive | Plan/todo tool? |
|---|---|---|---|
| **Codex CLI** (OpenAI) | `shell`, `apply_patch`, `update_plan` | API-native tool deferral (one-hop); apply_patch diff format | **`update_plan`** — 1-sentence steps, status ∈ {pending, in_progress, completed}, *exactly one* in_progress; OpenAI docs call it "most performant" for plan/TODO |
| **opencode** | bash, read, write, edit, patch, list, glob, grep, lsp, webfetch, `task`, **`todowrite`/`todoread`**, `skill`, `question` | `question` clarify tool; task = subagent | **`todowrite`/`todoread`** (Claude-Code-derived todo list; off for subagents by default) |
| **Crush** (charmbracelet) | view, edit, multiedit, write, bash, grep, glob, ls, fetch, agentic_fetch, download, **`todos`** | `download` (fetch→disk); network tools permission-gated | **`todos`** |
| **OpenHands** (CodeAct/SDK) | `TerminalTool` (bash), `FileEditorTool` (str_replace), `BrowserTool`, `TaskTrackerTool`, Glob/Grep, `PlanningFileEditorTool` (PLAN.md) | Holds ~3 core tools; long tail via bash+IPython | **`TaskTrackerTool`** + `PlanningFileEditorTool` (edits a PLAN.md) |
| **goose** (Block) | Built-in `developer` extension (~11 tools: shell, editor, file ops); 70+ MCP extensions | Extension-mgmt UX; cache_control on last tool | No first-party todo tool (MCP Jira/Linear via extension) |
| **Aider** | No function-calling tools; edit via markdown diff formats; auto repo-map | Measured: markdown edits > JSON across models (§6 P12) | No (architect/editor split, not a tool) |
| **Hermes** (Nous) | XML tool-call format; huge community tool corpus; clarify tool | XML (not JSON) function calling; agent-created skills + security scanner | No first-party todo tool |
| **OpenClaw** (closest architectural analog) | Multi-channel gateway, persona files, heartbeats; tool set incl. experimental search→activate deferral | Its search→activate is off-by-default with a documented data-loss bug matching PSFN's "tool_search never used" symptom (§6 P3) | No first-party todo tool |
| **Claude Code** (Anthropic) | Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, **`TodoWrite`** | Reference implementation for the todo pattern opencode/Crush copied | **`TodoWrite`** |

**The pattern:** every *coding-first* harness that ships a plan/todo tool (Codex, opencode, Crush, OpenHands, Claude Code) does so as a **per-session working-state anchor** the model rewrites as it progresses. Companion-shaped / gateway harnesses (OpenClaw, goose, Hermes) do **not** ship one. That split is the crux of §4.

---

## 3. Gap analysis — tools PSFN lacks that have proven value

For each candidate: what it does · who ships it · fit for a long-lived companion (judged against companion life / memory / self-modification / channel presence, NOT coding-CLI ergonomics) · PSFN integration seam · verdict.

### 3.1 Plan / todo / task-tracker — **the one real gap** → see §4 for the full evaluation
Deferred to its own section per the bead title. Summary verdict: **RECOMMEND (scoped, gated)** — a lightweight in-prompt plan surface for focus-work / project / autonomous-background sessions only, NOT forced on casual companion turns.

### 3.2 Clarify / `question` tool (opencode `question`, Hermes clarify)
- **What:** a structured tool that pauses and asks the user a disambiguating question with optional choices, instead of guessing.
- **Ships:** opencode, Hermes (clarify).
- **Companion fit — POOR.** A companion's entire native surface *is* conversation; asking a clarifying question is just… replying. A dedicated tool adds a channel-mediation problem (which channel? voice can't render choice chips) and competes with natural turn-taking. `notify approval_request` already covers the one case where structured confirmation matters (consequential/governed actions).
- **Seam:** would live in `system` or `response_control`; none needed.
- **Verdict: SKIP.** Native conversation + `notify approval_request` cover it. Not a coding-CLI where the model can't just talk back.

### 3.3 `download` (fetch remote content → write to disk) (Crush)
- **What:** one-shot HTTP fetch that streams the body straight to a file (bypasses context for large payloads).
- **Ships:** Crush; opencode webfetch has a size-spill variant.
- **Companion fit — MARGINAL.** Composable today: `web fetch` + `fs write`, or `library import_file` / `vault`. The only unique value is not routing a large payload through context, which `web browse` already mitigates and which is a coding-workflow concern more than a companion one.
- **Seam:** a `web fetch` option (`toFile`) rather than a new tool.
- **Verdict: SKIP** (compose from `web` + `fs`; revisit only if large-artifact ingestion becomes common, then as a `web` action flag, not a new surface).

### 3.4 Dedicated `PLAN.md` / planning-file editor (OpenHands `PlanningFileEditorTool`)
- **What:** a file-editor variant specialized to maintain a durable `PLAN.md` for long code-navigation tasks.
- **Ships:** OpenHands.
- **Companion fit — POOR as a separate tool.** This is OpenHands' *file-backed* flavor of the plan tool; PSFN already has `fs edit`, `wiki`, `journal`, `north_star`, and `scratchpad` for durable text. If a plan surface is added (§4) it should be a first-class structured tool, not a Markdown-file convention.
- **Verdict: SKIP as a distinct tool** — folds into §4's decision.

### 3.5 LSP / diagnostics, repo-map, apply_patch diff format (opencode `lsp`, Aider repo-map, Codex `apply_patch`)
- **Companion fit — N/A.** These are coding-IDE affordances. PSFN self-edits code (`repo`, `fs`, `analysis_workbench`) but is not an IDE and does not need language-server diagnostics or a PageRank repo-map to live its life. `fs edit` + `repo patch` are sufficient for its self-modification surface.
- **Verdict: SKIP** (out of domain).

### 3.6 First-party issue-tracker / project-mgmt (goose→Jira/Linear via MCP, OpenHands delegation)
- **Companion fit — ALREADY HAVE.** `beads` (extended) is PSFN's tracked-work surface; `subagent` covers delegation.
- **Verdict: SKIP** (covered).

**Net:** across the entire surveyed set, PSFN's direct catalog already matches or exceeds every proven-value tool category **except the plan/todo anchor.** Everything else is either present, composable, or coding-CLI-specific and out of domain for a companion.

---

## 4. Dedicated evaluation — the plan / todo attention-anchor tool

### 4.1 The two distinct value propositions (keep them separate)
The bead frames this as a single question but it bundles two claims that must be judged apart:

1. **Task-tracking value (well-established):** for a multi-step task, a visible, model-owned, per-turn-updatable checklist keeps a long-horizon effort on-track, resists mid-task drift, and surfaces progress to the user. Codex/opencode/OpenHands/Claude-Code all ship this and OpenAI explicitly measures `update_plan` as their "most performant" plan mechanism. This value is **real but scoped to genuinely multi-step work.**

2. **Attention-anchor / tool-channel-warmth value (operator hypothesis, b0yl-relevant):** a tool the model touches every few turns keeps the tool-calling channel "warm" — models that recently emitted a tool call are likelier to keep emitting them. If true, a per-turn plan-update habit would raise overall tool-call reliability, which is exactly `b0yl`'s target. **This is plausible and directionally supported by the recency behavior harnesses exploit, but it is a hypothesis, not a measured PSFN result.** It must NOT become the primary justification, because the obvious failure mode is forcing plan churn onto casual companion turns.

### 4.2 The companion-fit constraint (why this isn't a straight adopt)
PSFN is not a coding CLI. Most of its turns are *presence* — chatting, being with the user, ambient/free-time reflection. A companion who opens a numbered TODO list to have coffee-chat is broken, not reliable. Every harness that ships a todo tool is task-first by construction; PSFN is relationship-first. So a blanket, always-on, "update your plan every turn" instruction is **wrong for the default companion loop** and would read as robotic. The tool only earns its place where the work is actually multi-step: **focus-work / project sessions (`jhqb` `focus_work`), autonomous background/free-time work, and long tool-using investigations.**

### 4.3 Can existing surfaces play the role? (the bead's explicit sub-question)

| Candidate surface | As a plan/todo anchor | Verdict |
|---|---|---|
| **`orient` concerns** (create/list/resolve/transition_concern) | Semantically the closest — a live list of "what I'm attending to." BUT concerns are framed **affectively** (worries / attentional pulls) and are surfaced in-prompt as emotional/self-model state; they feed appraisal. Churning them per-turn as task-steps would pollute the affect + self-model systems with mechanical task noise and inflate the concern list. Description-only nudging fights the framing. | **SKIP as the anchor** — wrong altitude; keep concerns affective. |
| **`north_star`** (durable intent, approval-gated, extended) | Wrong altitude in the other direction — durable life-goals with proposal/approval/progress tracking (7ym.1). Per-turn churn would corrupt the durable-intent semantics and it's approval-gated + extended (not always present). | **SKIP.** |
| **`scratchpad`** (list/add/replace/append/remove, core, ephemeral) | **Mechanically the closest** — an ephemeral, model-owned, freely-mutable list already in the core catalog. Missing: step/status semantics (pending/in_progress/completed), the "exactly one in_progress" discipline, and a guarantee it renders in-prompt each turn as an anchor. Could be *extended* into the plan surface cheaply. | **VIABLE as the host** — see 4.4 Option A. |
| **`focus_work`** (jhqb, heavyweight) | Project-span lifecycle (evidence + helper-model completion + transcript compaction). Too heavy and lifecycle-gated to be a per-turn anchor, but it is the **natural session context** in which a plan surface should be active. | **Pairs with, doesn't replace** the anchor. |
| **`beads`** (extended, external tracker) | Durable cross-session issue tracking; wrong altitude, heavyweight, off-by-default. | **SKIP.** |

**Conclusion:** no existing surface cleanly plays the *lightweight, per-turn, status-structured, in-prompt-rendered* plan role. `orient` concerns and `north_star` are the wrong altitude/framing; `scratchpad` is mechanically adjacent but lacks status semantics and guaranteed rendering.

### 4.4 Recommendation
**RECOMMEND adding a lightweight plan surface — scoped and gated — but only after `b0yl.1` (rich descriptions) and `b0yl.2` (always-loaded catalog) land, and staged behind a cheap zero-code experiment first.** The epic's own decisive finding is that the reliability problem is *descriptions and callability*, not a missing tool; a plan tool is a focus-session feature plus a *secondary* reliability lever, not the primary fix. Two implementation shapes, in staged order:

- **Stage 0 (cheap, zero new tool) — description-only experiment.** Rewrite `scratchpad` (and/or add a focus-session system-note) to instruct proactive, structured per-turn use *during focus_work / background sessions only*, with a `[ ] / [~] / [x]` status convention. Measure whether tool-call reliability rises (via the frequency telemetry `b0yl.5` is already building). This tests the 4.1-#2 hypothesis for ~free before committing to a new surface. If it moves the needle, it may be sufficient.

- **Stage 1 (if Stage 0 is promising or focus_work wants first-class plans) — a dedicated `plan` tool.** Steps with status ∈ {pending, in_progress, completed}, the "exactly one in_progress" discipline (Codex's proven shape), rendered as an in-prompt block **only when a plan is active**. Gate activation to focus-work / project / autonomous-background sessions (links `jhqb` `focus_work` and the free-time/background continuation lanes) — dormant and unrendered in ordinary companion presence. Register `core` so it is always *callable* when a session opts in, per the epic's "advertise, don't defer callability" ruling, but keep the in-prompt render conditional so it never intrudes on casual turns.

**Do NOT:** force per-turn plan updates on the default chat loop, or justify the tool primarily on channel-warmth. The task-tracking value (4.1-#1) is the durable justification; warmth is a bonus to measure, not to assume.

---

## 5. Acceptance criterion — skill-authoring path verified end-to-end

The bead requires verifying the companion can *author a new skill end-to-end, not just invoke one.* **VERIFIED.**

- `skill` surface exposes `create` and `update` actions (`registry.ts:366-375`).
- `action=create` validates name/category/content, then calls `runtime.getStore().create({ name, category, description, content })`, which writes a versioned **personal-ownership** skill to the store with a real `relativePath`, and calls `runtime.invalidate()` so the new skill is immediately discoverable (`src/faculties/skills/tools.ts:365-397`). `update` mirrors this for revisions (`:398-425`). Tests cover both (`tools.test.ts:50,189,196`).
- So the companion writes a new skill file, versioned and cache-invalidated, in one tool call — genuine authoring, not just `view`/`list`.
- **Known caveat (already tracked, no new bead):** agent-created skills lack the Hermes-style security scanner — that gap is `psfn-framework-i72.2` (Port agent-created skills + security scanner from Hermes, P2). This survey confirms the authoring path works; hardening it is i72.2's job.

---

## 6. Proposed follow-up beads (recommended tools ONLY)

Filed here as proposals for the wave's fixes epic — **not created by this bead.** Only the plan/todo anchor cleared the recommend bar; everything else was skip/already-have.

1. **Stage 0 — Focus-scoped plan-anchor description experiment (no new tool)** · **P3**
   Rewrite `scratchpad`'s description (and add a focus_work/background session system-note) to instruct proactive, structured, per-turn checklist use with a `[ ]/[~]/[x]` status convention, active *only* in focus-work / project / autonomous-background sessions. Wire it to the `b0yl.5` frequency telemetry so we can measure whether it lifts overall tool-call reliability (the channel-warmth hypothesis) before building a dedicated surface. Zero code beyond description + one conditional note. Gates the decision on Stage 1. Depends on `b0yl.1`/`b0yl.2`; links `b0yl.5`, `jhqb`.

2. **Stage 1 — Add a lightweight `plan` tool for focus-work / project / background sessions** · **P2**
   Introduce a dedicated `core` plan surface: ordered steps with status ∈ {pending, in_progress, completed}, the Codex "exactly one in_progress" invariant, and an in-prompt plan block rendered **only when a plan is active**. Activation gated to `focus_work` (jhqb), project sessions, and free-time/background continuation lanes; dormant and unrendered in ordinary companion presence. Callable-always-when-opted-in per the epic's advertise-don't-defer ruling. Build only if Stage 0 shows lift or `focus_work` wants first-class plans. Depends on Stage 0 result + `jhqb` (`focus_work` split); links `b0yl`, `7ym`.

(No beads proposed for clarify/question, download, PLAN.md editor, LSP/repo-map, or issue-tracker — all skipped in §3 as out-of-domain or already covered.)

---

## 7. Bottom line

PSFN's 29-surface direct catalog already matches or exceeds every proven-value tool category in the surveyed harnesses — universal executor, extension mgmt, subagents, skill authoring (verified), web, file/edit/exec, and a memory/notes suite richer than any coding harness. **The single genuine gap is the plan/todo attention-anchor**, and even that is a scoped, focus-session feature — not a default-loop necessity — best staged behind a zero-code description experiment before committing a new surface. The bead's reliability epic is right that the lever is descriptions and callability (`b0yl.1`/`.2`), not a missing tool; the plan anchor is a secondary, measurable bonus, correctly gated so a relationship-first companion never opens a TODO list to have coffee.
