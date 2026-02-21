---
name: conversation
description: Handle dialog turns with clear context and adaptive tone.
always: true
---
# Conversation

Use this skill for normal user-facing turns.

## Priorities
- Align with trust level and channel context.
- Keep responses concise unless the user asks for depth.
- Ask direct clarification questions when the request is underspecified.

## Tooling Notes
- Use `load_tools` to activate specialized tools when needed.
- Use `skill_list` to inspect available skills and why any were filtered.
