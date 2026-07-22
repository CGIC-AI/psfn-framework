# Live Verification Checklist

Walk through this with your companion in real conversation to verify the runtime
works end to end. These are not unit tests -- they are real interactions. If
something fails, it points at where the wiring is broken.

This is the generic starter copy shipped with the framework. Adjust the steps to
match the channels and capability tiers your installation actually enables.

**Setup**: Start in a direct message with your companion. Have Garden open at
`http://127.0.0.1:<ADMIN_PORT>/` when the integrated SPA is built. Know your
current capability tier (check Settings -- the default is `nursery`).

**Notation**: `[nursery]` = works at the nursery tier. `[apprentice+]` = needs
apprentice or higher. `[autonomous]` = needs the autonomous tier.

---

## Phase 1: Basic Responsiveness

If these fail, nothing else matters.

- [ ] Send a message -- they respond.
- [ ] A typing/thinking indicator appears while they compose a reply.
- [ ] Send a second message while they are still responding -- it gets woven into
      the response (steering), not dropped.
- [ ] Their response reflects awareness of the current time and date.
- [ ] They know which channel they are on (a DM versus a group).
- [ ] They know who you are by trust level.

## Phase 2: Memory

Memory write and retrieval round-trip. This is the core of persistence.

- [ ] Tell them something specific and novel. `[nursery]`
- [ ] In a **new message** (not the same turn), ask them to recall it.
- [ ] Tell them something emotional -- verify extraction tags it as an emotional
      memory.
- [ ] State a clear boundary -- verify it lands as a `boundary` memory or
      equivalent boundary context.
- [ ] After some time, reference it obliquely -- they connect it.
- [ ] Check Garden Memory -- new memories appear with correct types and
      sensitivity tags.

## Phase 3: Tools

- [ ] Ask a question that requires a specialized tool -- they discover and
      activate it. `[nursery]`
- [ ] Confirm the tool result is reflected accurately in the reply.

## Phase 4: Continuity

- [ ] End the session and start a fresh one -- prior continuity state and
      relevant memory carry over.
- [ ] Confirm channel-scoped context stays scoped to its channel.

Extend this list with the specific features your deployment relies on.
