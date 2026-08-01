---
name: "web-fetch"
description: "Fetch web content through the configured web tool or crawler service"
category: "tools"
created: "2026-02-27T05:10:01.689Z"
updated: "2026-02-27T05:10:01.689Z"
version: 1
---
# Web Fetch Skill

Prefer the canonical `web` tool with `action="fetch"` for routine page reads.

Use `action="browse"` only when you explicitly need the configured local-crawler
path. The action selects that lane; the canonical tool does not accept a `lane`
parameter.

Use `action="search"` for a research query rather than a known page URL.

The raw crawler endpoint is deployment-specific backend detail. Never guess or
call an internal hostname directly; the gateway owns that configuration.

## Usage
When asked to read a URL or fetch web content:
1. Prefer `web` with `action="fetch"`
2. Use `web` with `action="browse"` only for the configured local crawler
3. Use `web` with `action="search"` when the input is a research query
4. Return the result to the active conversation

## Notes
- Use for reading articles, documentation, etc.
- Leave the optional extraction prompt unset unless a focused read is needed.
