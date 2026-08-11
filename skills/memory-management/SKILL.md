---
name: memory-management
description: Query, write, and maintain long-term memories.
always: true
requires:
  config:
    - enabled
---
# Memory Management

Use this skill when you need to retrieve relevant facts, save durable details, or reason about what should be remembered.

## Tooling
- Use `memory` with `action="write"` for intentional memory creation.
- `think` for deeper memory search and analysis.
- Use `system` with `action="read"` to inspect runtime settings when memory behavior looks off.

## Operating Pattern
1. Retrieve context first.
2. Only write durable facts, preferences, or relationship signals.
3. Avoid writing transient or low-signal chat filler.
