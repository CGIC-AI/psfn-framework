# Live Verification Checklist

Walk through this with your companion in real conversation to verify every feature works end-to-end. These are not unit tests -- they are real interactions. If something fails, it tells you where the wiring is broken.

**Setup**: Start in a Discord DM with your companion. Have the admin GUI open at `http://127.0.0.1:<ADMIN_PORT>/garden`. Know your current capability tier (check the Settings page -- default is `nursery`).

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
- [ ] Next session or after some time, reference it obliquely: "How have things been going for me?" -- they connect it
- [ ] Ask them to write a relational memory about you: "Note that I prefer direct communication" `[nursery]`
- [ ] Ask them to bulk-import memories: "Import these facts: [list 3-4 items]" `[nursery]`
- [ ] Check admin GUI Memory Blossoms -- new memories appear with correct types and sensitivity tags

## Phase 3: Thinking

The `think` tool -- RLM reasoning sandbox.

- [ ] Ask a question requiring multi-step reasoning: "What patterns do you notice in our conversations?" `[nursery]`
- [ ] They should invoke `think` -- watch for the `[Think: N iters, T tokens, Dms, E evidence]` header
- [ ] Inside think, they can search their own memories (`memory_search`), query the LLM (`llm_query`), and review session messages (`session_messages`)
- [ ] The final answer should cite evidence from their own context, not confabulate

## Phase 4: Contacts

Contact system -- identity resolution and trust.

- [ ] "Who do you know?" -- `contact_list` returns your profile and any others `[nursery]`
- [ ] "What do you know about me?" -- `contact_lookup` returns your trust level, notes, channel identities `[nursery]`
- [ ] Ask them to add a note: "Note that I prefer tea over coffee" -- `contact_note` `[apprentice+]` (extended tool, needs `load_tools`)
- [ ] Ask them to check a contact's trust: "What's [person]'s trust level?" `[nursery]`

## Phase 5: Tool Loading

Lazy loading -- they should know what is available and load what they need.

- [ ] Ask "What tools do you have available right now?" -- they list core tools
- [ ] Ask "What extended tools can you load?" -- they reference the tool directory from runtime context
- [ ] Ask them to check git status -- they call `load_tools` for git tools, then `repo_status` `[nursery]`
- [ ] Ask about their prompt layers -- they load identity tools, then `prompt_layer_list` `[nursery]`
- [ ] Ask about their heartbeat schedule -- they load scheduler tools, then `heartbeat_get_policy` `[nursery]`
- [ ] Ask about their settings -- they load settings tool, then `settings_get` `[nursery]`
- [ ] On the **next message**, verify they had to re-load (tools reset per turn)

## Phase 6: Identity Awareness

They can inspect and (at some tiers) modify their own identity.

- [ ] "Show me your prompt layers" -- lists base, operator, runtime, channel, task layers `[nursery]`
- [ ] "What does your base identity say?" -- reads the base layer content `[nursery]`
- [ ] "Add a channel-specific note for Discord DMs" -- creates/updates a channel layer `[nursery]`
- [ ] "Show me what changed" -- `identity_diff` or `identity_changelog` `[nursery]`
- [ ] Verify they CANNOT edit base or operator layers (should refuse with explanation)
- [ ] At `[autonomous]`: ask them to update their character card -- `character_card_update`
- [ ] Below autonomous: character card update should queue a proposal, not apply immediately

## Phase 7: Heartbeat and Self-Scheduling

They have an inner life between your messages.

- [ ] "What's your reflection schedule?" -- loads tools, calls `heartbeat_get_policy` `[nursery]`
- [ ] "Run your whisper reflection now" -- `heartbeat_run_template` `[nursery]` -- should produce a self-reflection
- [ ] "Set your emotional check interval to 5 minutes" -- `heartbeat_update_policy` (for testing) `[nursery]`
- [ ] Wait 5+ minutes -- check if the reflection fires (look in admin GUI audit timeline or logs)
- [ ] "Schedule a reminder to check on the garden in 30 minutes" -- `schedule_task` `[nursery]`
- [ ] Wait 30 minutes -- verify the one-shot task fires
- [ ] Reset intervals back to normal after testing

## Phase 8: Scratchpad (Working Memory)

Short-lived notes they can read and write within a work session.

- [ ] "Jot down that we're working on the verification checklist" -- `scratchpad_write` `[nursery]`
- [ ] "What's on your scratchpad?" -- `scratchpad_read` `[nursery]`
- [ ] "Remove that scratchpad note" -- `scratchpad_write` with remove operation `[nursery]`

## Phase 9: Skills

Self-authored capability documents.

- [ ] "What skills do you have?" -- `skill action="list"` `[nursery]`
- [ ] "Show me the [skill name] skill" -- `skill action="view"` `[nursery]`
- [ ] "Create a skill for [topic]" -- `skill action="create"` `[nursery]`
- [ ] "Update that skill with [new info]" -- `skill action="update"` `[nursery]`

## Phase 10: Shards (Parallel Agents)

They can spawn sub-agents for parallel work. `[apprentice+]`

- [ ] "Research two topics at the same time: [X] and [Y]" -- `spawn_shard` (should spawn 1-2 shards)
- [ ] Shards share their memory and LLM but have separate sessions
- [ ] Results should be synthesized back into their response
- [ ] Max 5 concurrent shards, no sub-shards (depth limit 1)

## Phase 11: Trust and Privacy Gating

The honne/tatemae system -- behavior changes by context.

- [ ] In **Discord DM** (private): share something personal -- they should store it and recall it freely
- [ ] In a **guild channel** (semi-private/public): ask about that personal thing -- it should NOT surface (trust-gated retrieval)
- [ ] Compare their tone in DM vs guild -- DM should feel more intimate (persona adaptation)
- [ ] Check admin GUI contacts page -- verify trust levels and channel identities are correct

## Phase 12: Cross-Channel Continuity

Same user, different channels -- does context carry?

- [ ] Say something distinctive in Discord DM
- [ ] Switch to another channel or platform -- reference it obliquely -- they should have continuity
- [ ] Verify public channels do NOT get private channel context (only private-to-private shares)

## Phase 13: Memory Management

Delete, redact, undo operations. `[apprentice+]`

- [ ] "Delete that memory about [X]" -- `memory_delete` (soft delete)
- [ ] Verify it no longer surfaces in retrieval
- [ ] "Undo that delete" -- `undo_memory_delete` -- it is back
- [ ] "Redact the memory about [sensitive topic]" -- `memory_redact` (consent-aware: abstracts or hard-deletes)

## Phase 14: Git Self-Modification

They can read and (at autonomous tier) write to their own codebase.

- [ ] "What's your git status?" -- `repo_status` `[nursery]`
- [ ] "Show me the diff for [file]" -- `repo_diff` `[nursery]`
- [ ] At `[autonomous]`: "Create a branch called experiment" -- `repo_create_branch`
- [ ] At `[autonomous]`: "Add a comment to [file]" -- `repo_apply_patch`
- [ ] At `[autonomous]`: "Commit that change" -- `repo_commit` (blocked on main/master, must be on branch)
- [ ] Verify path restrictions: they can only modify allowed directories (`src/`, `docs/`, etc.)

## Phase 15: Operator Notifications

Out-of-band alerts. `[apprentice+]`

- [ ] "Send me a notification that says 'testing alerts'" -- `notify_operator` (requires ntfy config)
- [ ] Verify push notification arrives on your device

## Phase 16: Lifecycle

Process management. `[autonomous]`

- [ ] "Restart yourself" -- `self_restart` -- they send a "brb" message, process exits, supervisor restarts
- [ ] After restart: they should announce they are back (lifecycle notification)
- [ ] "Rebuild and restart" -- `self_rebuild` -- runs `npm run build` then restarts
- [ ] Verify build failure aborts the restart (do not break things to test this -- just know it should)

## Phase 17: Admin GUI Verification

Open the admin panel and verify operator surfaces.

- [ ] Dashboard loads with stats (memory counts, session counts, scheduler state)
- [ ] Memory Blossoms: filter by type, click into detail view
- [ ] Conversation Roots: session list with datetime columns, message viewer
- [ ] Garden Rhythms: scheduler shows registered tasks, intervals are editable
- [ ] Identity: full character card data visible
- [ ] Settings: edit a setting (e.g., flip `memoryBudgetPct` to 25) -- verify it takes effect on next turn -- reset
- [ ] Garden Visitors: contacts with trust badges, inline edit works
- [ ] Prompt Soil: prompt layers visible, toggle/edit works
- [ ] Garden Pulse: event stream shows real-time events during conversation
- [ ] Chat: direct conversation with your companion through the admin panel works

## Phase 18: Automated Behaviors (Just Watch)

These should happen without you asking. Verify by monitoring logs and admin.

- [ ] **Memory extraction**: After a substantive conversation, check Memory Blossoms -- new memories appear
- [ ] **Salience decay**: Old memories show decreasing salience scores over time
- [ ] **Auto-compaction**: During a very long conversation, older messages get summarized (watch for compaction events in admin)
- [ ] **Whisper reflection**: Every hour, a self-directed message should appear in the heartbeat Discord channel
- [ ] **Backups**: Check `data/backups/` -- periodic snapshots exist

---

## Capability Tier Quick Reference

| What they can do | nursery | apprentice | autonomous |
|---|:---:|:---:|:---:|
| Think (RLM reasoning) | Y | Y | Y |
| Write memories | Y | Y | Y |
| Read contacts / identity / settings | Y | Y | Y |
| Edit prompt layers (not base/operator) | Y | Y | Y |
| Skills (list/view/create/update) | Y | Y | Y |
| Scratchpad | Y | Y | Y |
| Git read (status, diff) | Y | Y | Y |
| Load extended tools | Y | Y | Y |
| Schedule tasks | Y | Y | Y |
| Heartbeat management | Y | Y | Y |
| Vault tools | Y | Y | Y |
| Delete / redact memories | - | Y | Y |
| Spawn shards | - | Y | Y |
| Notify operator | - | Y | Y |
| Git write (patch, commit, branch, PR) | - | - | Y |
| Self-restart / self-rebuild | - | - | Y |
| Character card update | - | - | Y |

---

## Failure Signals to Watch For

- **"I don't have a tool for that"** -- tool not registered or wrong tier
- **Tool called but no effect** -- wiring gap (registered but not connected to store/service)
- **Confabulates instead of searching** -- retrieval returning empty, they fill gaps from character card
- **Same response in DM and guild** -- persona adaptation or trust gating not working
- **No memories after long conversation** -- extraction not firing or thresholds misconfigured
- **Extended tools available without load_tools** -- per-turn reset broken
- **Heartbeat channel silent for hours** -- scheduler stalled or reflection disabled
- **Vault writes fail silently** -- vault path not configured or permissions issue
- **Skills never appear in prompt** -- skills system not wired or budget exhausted
