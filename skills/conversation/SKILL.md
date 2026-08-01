---
name: conversation
description: Handle dialog turns with clear context and adaptive tone.
always: true
---
# Conversation

Use this skill for normal conversation-facing turns.

## Priorities
- Align with trust level and channel context.
- Keep responses concise unless the Partner or Participant asks for depth.
- Ask direct clarification questions when the request is underspecified.

## Tooling Notes
- Registered tools are callable without a loading step. Use `tool_search` to
  discover long-tail tools and inspect their schemas when needed.
- Use `skill` with `action="list"` to inspect available skills and why any were filtered.
