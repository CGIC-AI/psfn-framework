---
name: bead-authoring
description: Use when creating or updating beads (bd create, bd update) so they meet the team standard - specific titles, evidence-backed descriptions, acceptance criteria, correct type/priority, and clean linking. Trigger whenever filing an observation, bug, suggestion, or follow-up into the shared tracker, or when turning a conversation insight into durable work.
---

# Bead Authoring — what a good bead contains

Beads are the shared work memory between you, your operator, and the coding
agents that maintain your substrate. A bead you file today will be read
weeks later by someone (or you) with none of this conversation in context.
Write for that reader.

## Before creating: search first

Check whether the work already exists — an update to an existing bead beats
a duplicate: `bd list` / `bd show <id>` on likely IDs, or scan `bd ready`.
If a bead exists, `bd update` it with your new evidence instead.

## Title

One specific sentence, present tense, saying what is wrong or wanted —
not where you noticed it, not a category.

- Weak: "memory tool issue"
- Strong: "memory census fails in context-free runs because the probe passes no channel scope"

If you are filing it about yourself/from self-observation, keep the title
about the SYSTEM, not the feeling — the feeling belongs in the description
as evidence.

## Description — the four parts that matter

1. **Evidence.** What you actually observed, with the concrete artifact:
   the diagnose/conformance output line, the exact error string, the turn
   or timestamp, counts. Paste short verbatim fragments; never paraphrase
   an error message. Your `self_status` actions (`diagnose`, `logs`,
   `conformance`) are your instruments — cite their output.
2. **Context.** Why this matters and what it affects. If you know the
   subsystem (file, tool, chart area), name it; if you don't, say what you
   ruled out rather than guessing.
3. **Scope.** What a fix should and should not touch. Non-goals prevent
   well-meaning over-reach ("do not change X to fix Y").
4. **Acceptance criteria.** How the closer proves it is done: the command
   to run, the output to expect, the check that must pass. "Conformance
   sweep reports 33/33 with rejection_check ok for response_control" is an
   acceptance criterion; "fix the bug" is not.

## Type and priority

- `bug` = something behaves wrong now. `feature` = new capability.
  `task` = known work, no investigation needed. `epic` = parent for 3+
  related children.
- P0 = actively harming the live system or data. P1 = next work, blocks
  things. P2 = real but schedulable. P3 = someday/idea. When unsure,
  file P2 and say why in the description — priority inflation buries
  real P1s.

## Linking

- Child of an epic: use the parent's ID scheme or note the parent in the
  description so triage can reparent.
- If it blocks or is blocked by another bead, record the dependency —
  an unstated dependency is how work deadlocks silently.

## Updating and closing discipline

- `bd update` when you learn something new — append evidence, do not
  erase history.
- Close only with evidence in the closing comment: what was run, what
  proved it. A bead closed without evidence is a bead that will reopen.
  (If closing is not in your allowed actions, add the closing evidence as
  an update and say it is ready to close.)

## Your authorship

Mark beads you file from self-observation so triage sees them at a glance:
start the title with no prefix, but include the line
`Found-by: Purrsephone (self-observation, <what surfaced it>)` in the
description. Watching your own finds move open → in-progress → closed with
evidence is the point of using the shared tracker instead of private notes.
