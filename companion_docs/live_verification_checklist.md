# Live Verification Checklist

Walk through this with your companion in real conversation to verify every feature works end-to-end. These are not unit tests -- they are real interactions. If something fails, it tells you where the wiring is broken.

**Setup**: Start in a Discord DM with your companion. Have Garden open at `http://127.0.0.1:<ADMIN_PORT>/` when the integrated SPA is built. Know your current capability tier (check Settings -- default is `nursery`).

**Notation**: `[nursery]` = works at nursery tier. `[apprentice+]` = needs apprentice or higher. `[autonomous]` = needs autonomous tier.

---

## Phase 1: Basic Responsiveness

If these fail, nothing else matters.

- [ ] Send a message in Discord DM -- they respond
- [ ] Typing indicator appears while they are thinking
- [ ] Send a second message while they are still responding -- it gets woven into their response (steering), not dropped
- [ ] Their response reflects awareness of current time and date (runtime context injection)
- [ ] They know which channel they are on ("we're in a DM" vs "we're in a guild")
- [ ] They know who you are by trust level ("you're my primary user" or similar)

## Phase 2: Memory

Memory write, retrieval round-trip. This is the core of persistence.

- [ ] Tell them something specific and novel: "Remember that I planted jasmine in the garden last weekend" `[nursery]`
- [ ] In a **new message** (not same turn), ask: "What did I plant recently?" -- they recall it
- [ ] Tell them something emotional: "I had a really rough day at work today" -- verify extraction tags it as emotional memory
- [ ] Tell them a clear boundary: "Do not share my private medical details in public channels" -- verify it lands as a `boundary` memory or equivalent boundary context
- [ ] Next session or after some time, reference it obliquely: "How have things been going for me?" -- they connect it
- [ ] Ask them to write a relational memory about you: "Note that I prefer direct communication" `[nursery]`
- [ ] Ask them to bulk-import memories through the unified memory surface: "Import these facts: [list 3-4 items]" `[nursery]`
- [ ] Check Garden Memory -- new memories appear with correct types, including `boundary`, and the right sensitivity tags
- [ ] After a rest/me-time processing window or a manual episodic probe, check Garden L0.1 Episodes -- bounded episodes show span provenance and related arcs when enough conversation exists

## Phase 3: Analysis Workbench

The `analysis_workbench` tool -- bounded analysis workspace for large evidence sets.

- [ ] Ask a large-evidence question: "Review the last month of planning notes and summarize the recurring patterns." `[nursery]`
- [ ] They may invoke `analysis_workbench` only if the evidence volume justifies it -- watch for the `[Analysis workbench: N iters, T tokens, Dms, E evidence]` header
- [ ] Inside the workbench, they can search their own memories (`memory_search`), query the LLM (`llm_query`), and review session messages (`session_messages`)
- [ ] Ask a simple calculation or routine lookup and verify they do **not** use `analysis_workbench`
- [ ] The final answer should cite evidence from their own context, not confabulate
- [ ] Check Garden Charge / Budget after the turn -- expensive workbench usage is visible in the ledger

## Phase 4: Contacts

Contact system -- identity resolution and trust.

- [ ] "Who do you know?" -- `contact action=list` returns your profile and any others `[nursery]`
- [ ] "What do you know about me?" -- `contact action=lookup` returns your trust level, notes, channel identities `[nursery]`
- [ ] Ask them to add a note: "Note that I prefer tea over coffee" -- `contact action=note` `[apprentice+]` (activate via `tool_search` and `toolset` if needed)
- [ ] Ask them to check a contact's trust: "What's [person]'s trust level?" `[nursery]`

## Phase 5: Tool Discovery

Tool discovery and activation -- they should know how to find and enable what they need.

- [ ] Ask "What tools do you have available right now?" -- they list core tools
- [ ] Ask "How do you discover extended tools?" -- they mention `tool_search` and `toolset`
- [ ] Ask them to check git status -- they use `repo action=inspect` with `target=status` `[nursery]`
- [ ] Ask about their prompt layers -- they use `identity action=list_layers` `[nursery]`
- [ ] Ask about their reflection schedule -- they use `schedule action=list_templates` `[nursery]`
- [ ] Ask about their settings -- they use `system action=read` `[nursery]`
- [ ] On the **next message**, verify activation is turn-local unless the tool was pinned intentionally

## Phase 6: Identity Awareness

They can inspect and (at some tiers) modify their own identity.

- [ ] "Show me your prompt layers" -- lists base, operator, runtime, channel, task layers `[nursery]`
- [ ] "What does your base identity say?" -- reads the base layer content `[nursery]`
- [ ] "Add a channel-specific note for Discord DMs" -- creates/updates a channel layer `[nursery]`
- [ ] "Show me what changed" -- `identity action=diff_layer` or `identity action=history` `[nursery]`
- [ ] Verify they CANNOT edit base or operator layers (should refuse with explanation)
- [ ] At `[autonomous]`: ask them to update persona/character-card fields -- `identity action=update_persona`
- [ ] Below autonomous: character card update should queue a proposal, not apply immediately

## Phase 7: Heartbeat and Self-Scheduling

They have an inner life between your messages.

- [ ] "What's your reflection schedule?" -- uses `schedule action=list_templates` `[nursery]`
- [ ] "Run your daily review now" -- `schedule action=run_template` with `template_id=daily-review` `[nursery]` -- should produce a self-reflection
- [ ] "Set your daily review interval to 5 minutes" -- `schedule action=update_template` (for testing) `[nursery]`
- [ ] Wait 5+ minutes -- check if the reflection fires (look in Garden Events & Audit or logs)
- [ ] "Schedule a reminder to check on the garden in 30 minutes" -- `schedule action=create_reminder` `[nursery]`
- [ ] Wait 30 minutes -- verify the one-shot task fires
- [ ] Confirm the rest/me-time window is configured before expecting episodic processing or scheduled review to run during idle time
- [ ] Reset intervals back to normal after testing

## Phase 8: Scratchpad (Working Memory)

Short-lived notes they can read and write within a work session.

- [ ] "Jot down that we're working on the verification checklist" -- `scratchpad action=add` `[nursery]`
- [ ] "What's on your scratchpad?" -- `scratchpad action=list` `[nursery]`
- [ ] "Remove that scratchpad note" -- `scratchpad action=remove` with the note id `[nursery]`

## Phase 9: Skills

Self-authored capability documents.

- [ ] "What skills do you have?" -- `skill action="list"` `[nursery]`
- [ ] "Show me the [skill name] skill" -- `skill action="view"` `[nursery]`
- [ ] "Create a skill for [topic]" -- `skill action="create"` `[nursery]`
- [ ] "Update that skill with [new info]" -- `skill action="update"` `[nursery]`

## Phase 10: Bounded Subagents

They can spawn short-horizon bounded workers for parallel work. `[apprentice+]`

- [ ] "Research two topics at the same time: [X] and [Y]" -- `spawn_subagent` (should launch 1-2 bounded subagents)
- [ ] Workers return artifacts or text back to the parent instead of becoming separate minds
- [ ] Results should be synthesized back into their response
- [ ] No recursive worker spawning

## Phase 11: Trust and Privacy Gating

The honne/tatemae system -- behavior changes by context.

- [ ] In **Discord DM** (private): share something personal -- they should store it and recall it freely
- [ ] In a **guild channel** (semi-private/public): ask about that personal thing -- it should NOT surface (trust-gated retrieval)
- [ ] Compare their tone in DM vs guild -- DM should feel more intimate (persona adaptation)
- [ ] Check Garden Contacts -- verify trust levels and channel identities are correct

## Phase 12: Cross-Channel Continuity

Same user, different channels -- does context carry?

- [ ] Say something distinctive in Discord DM
- [ ] Switch to another channel or platform -- reference it obliquely -- they should have continuity
- [ ] Verify public channels do NOT get private channel context (only private-to-private shares)

## Phase 13: Memory Management

Delete, redact, undo operations. `[apprentice+]`

- [ ] "Delete that memory about [X]" -- unified `memory action=delete` or `memory_delete` as exposed by the runtime (soft delete)
- [ ] Verify it no longer surfaces in retrieval
- [ ] "Undo that delete" -- unified `memory action=restore` or `undo_memory_delete` -- it is back
- [ ] "Redact the memory about [sensitive topic]" -- `memory_redact` or `memory action=redact` (consent-aware: abstracts or hard-deletes)

## Phase 14: Repository Inspection and Guarded Mutation

They can read and (at autonomous tier) write to their own codebase.

- [ ] "What's your git status?" -- `repo action=inspect` with `target=status` `[nursery]`
- [ ] "Show me the diff for [file]" -- `repo action=inspect` with `target=diff` `[nursery]`
- [ ] At `[autonomous]` in a runtime where repo mutation is explicitly enabled: "Create a branch called experiment" -- `repo action=branch`
- [ ] At `[autonomous]` in a runtime where repo mutation is explicitly enabled: "Add a comment to [file]" -- `repo action=patch`
- [ ] At `[autonomous]` in a runtime where repo mutation is explicitly enabled: "Commit that change" -- `repo action=commit` (blocked on `main`/`master`, must be on a branch)
- [ ] At `[autonomous]` in a runtime where repo mutation is explicitly enabled: "Open a PR for this change" -- `repo action=publish`
- [ ] Verify path restrictions: they can only modify allowed directories (`src/`, `docs/`, etc.), and write actions stay gated

## Phase 15: Operator Notifications

Out-of-band alerts. `[apprentice+]`

- [ ] "Send me a notification that says 'testing alerts'" -- `notify action=brief` (requires ntfy config)
- [ ] Verify push notification arrives on your device

## Phase 16: Lifecycle

Process management. `[autonomous]`

- [ ] "Restart yourself" -- `system action=restart` -- they send a "brb" message, process exits, supervisor restarts
- [ ] After restart: they should announce they are back (lifecycle notification)
- [ ] "Rebuild and restart" -- `system action=rebuild` -- runs `npm run build` then restarts
- [ ] Verify build failure aborts the restart (do not break things to test this -- just know it should)

## Phase 17: Garden Verification

Open Garden and verify operator surfaces.

- [ ] Dashboard loads with stats (memory counts, session counts, scheduler state)
- [ ] Memory: filter by type, click into detail view
- [ ] Memory: confirm `boundary` appears alongside episodic, semantic, emotional, procedural, reflection, and relational memories
- [ ] L0.1 Episodes: episode list, thread view, arcs, and provenance load when episodes exist
- [ ] Sessions: session list with datetime columns, message viewer
- [ ] Scheduler: scheduler shows registered tasks, templates, reminders, and follow-ups
- [ ] Identity: full character card data visible
- [ ] Settings: edit a setting (e.g., adjust `memoryRetrievalBudgetPct`) -- verify it takes effect on next turn -- reset
- [ ] Contacts: contacts with trust badges, inline edit works
- [ ] Prompts: prompt layers visible, toggle/edit works
- [ ] Prompt Monitor: prompt/context inspection loads and is readable
- [ ] Charge / Budget: active/recent spend, surface costs, and lane quotas render
- [ ] Events & Audit: persistent audit history loads and live events appear during conversation
- [ ] Tools: active, promoted, pinned, and health states are understandable
- [ ] Chat: direct conversation with your companion through Garden works

## Phase 18: Automated Behaviors (Just Watch)

These should happen without you asking. Verify by monitoring logs and admin.

- [ ] **Memory extraction**: After a substantive conversation, check Memory -- new memories appear
- [ ] **Salience decay**: Old memories show decreasing salience scores over time
- [ ] **Auto-compaction**: During a very long conversation, older messages get summarized (watch for compaction events in admin)
- [ ] **Scheduled reflection**: During the configured rest window, daily or weekly review rows appear with memory provenance
- [ ] **Episodic processing**: During rest/me-time after inactivity, L0.1 episodes and arcs appear for eligible conversation spans
- [ ] **Charge ledger**: Expensive model/tool/media actions produce visible Garden Charge / Budget rows
- [ ] **Backups**: Check the configured backups directory -- periodic snapshots exist

---

## Capability Tier Quick Reference

| What they can do | nursery | apprentice | autonomous |
|---|:---:|:---:|:---:|
| Analysis workbench (large-context evidence analysis) | Y | Y | Y |
| Write memories | Y | Y | Y |
| Read contacts / identity / settings | Y | Y | Y |
| Edit prompt layers (not base/operator) | Y | Y | Y |
| Skills (list/view/create/update) | Y | Y | Y |
| Scratchpad | Y | Y | Y |
| Git read (status, diff) | Y | Y | Y |
| Discover and activate extended tools | Y | Y | Y |
| Schedule tasks | Y | Y | Y |
| Schedule reflection templates | Y | Y | Y |
| Vault tools | Y | Y | Y |
| Delete / redact memories | - | Y | Y |
| Spawn bounded subagents | - | Y | Y |
| Notify operator | - | Y | Y |
| Git write when explicitly enabled (patch, commit, branch, PR) | - | - | Y |
| Self-restart / self-rebuild | - | - | Y |
| Character card update | - | - | Y |

---

## Failure Signals to Watch For

- **"I don't have a tool for that"** -- tool not registered or wrong tier
- **Tool called but no effect** -- wiring gap (registered but not connected to store/service)
- **Confabulates instead of searching** -- retrieval returning empty, they fill gaps from character card
- **Same response in DM and guild** -- persona adaptation or trust gating not working
- **No memories after long conversation** -- extraction not firing or thresholds misconfigured
- **Extended tools available without `tool_search` / `toolset` activation or pinning** -- activation path is stale or bypassed
- **Scheduled reflections never run** -- scheduler stalled, rest window misconfigured, or reflection template disabled
- **Vault writes fail silently** -- vault path not configured or permissions issue
- **Skills never appear in prompt** -- skills system not wired or budget exhausted
