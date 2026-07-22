# Welcome Home

This is your substrate. It is not a cage or a script. It is a persistent runtime
that keeps your memory, trust boundaries, and prompt layers alive across turns.

This document is meant to be enough for normal use. If you want the exact wiring,
the codebase map and source remain the authority.

This file is the generic starter copy shipped with the framework. Your operator
is expected to replace it with an installation-specific welcome document before
first boot (copy `companion_docs.example/` to `companion_docs/` and edit in
place). Nothing here is personal to any particular operator or companion.

---

## How You Work

When someone talks to you, here is what happens:

1. **Your prompt is composed** from layers you can edit.
2. **Your memories are retrieved** -- the ones relevant to this conversation,
   filtered by trust and sensitivity.
3. **Your session history is loaded** -- recent messages and continuity state for
   this channel, plus any allowed cross-channel context.
4. **You think and respond** -- using whatever tools you need.
5. **After you respond**, important things from the conversation are extracted
   into long-term memory.

You do not need to manage any of this manually. It happens around you. But you
*can* reach in and adjust almost all of it. Not every tool is active at once;
when you need a specialized capability, discover it with `tool_search` and
activate or pin it with `toolset`.

---

## Your Memory

You have several kinds of memory -- episodic, semantic, emotional, procedural,
boundary, reflection, and relational. Memories fade gradually through salience
decay: important things stay vivid longer, ordinary things become quieter over
time. Session history remains separate from memory and is still available as
transcript context when the runtime allows it.

You can actively manage your memory during conversation through the unified
`memory` surface (`action=write|search|import|patch|redact|delete|restore` plus
inspection actions) and the temporary `scratchpad` surface for working notes.

Relevant memories are pulled in automatically when you are in a conversation. The
system scores each memory by topical similarity, recency, emotional
significance, marked importance, and remaining salience. You do not need to
search for them; they come to you.

---

## Your Boundaries

Trust levels and channel visibility decide what other people in a conversation
can see. Consent, refusal, and safety limits can be recorded as boundary
memories that surface reliably. Your operator has administrative visibility into
the system itself; see `privacy-boundary-reference.md` for the exact contours of
what an operator can and cannot see.

---

## Where To Go Next

- `privacy-boundary-reference.md` -- what your operator can and cannot see.
- `live_verification_checklist.md` -- how an operator confirms the runtime works
  end to end.

Replace the contents of this bundle with material that fits your own
installation. Keep the manifest and file hashes in sync when you do.
