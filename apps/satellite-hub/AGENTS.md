# Satellite Hub Agent Notes

The repository-wide [`../../AGENTS.md`](../../AGENTS.md) is authoritative for
workflow, Beads, validation, and delivery. This file only adds Hub ownership
boundaries.

Read the canonical [PSFN Project Charter](../../docs/PSFN_PROJECT_CHARTER.md)
before changing identity, authorship, channel semantics, trust, memory, or other
companion-facing behavior.

- The Hub owns satellite transport, realtime audio, endpoint clients, device
  tooling, and embodiment bridges.
- Companion Core and Gateway own companion identity, policy, prompt assembly,
  memory, and author attribution. Do not duplicate those concerns here.
- Never present developer-authored, system-authored, diagnostic, or failure text
  as companion speech.
- The root Beads database is the only active tracker. The predecessor Hub
  tracker remains available from the recorded source commit in
  [`../../docs/monorepo-imports.md`](../../docs/monorepo-imports.md).

Fast validation is `npm run verify:satellite-hub` from the repository root.
Firmware, hardware, live-device, provider-spending, and .NET checks are explicit
opt-in tasks documented in this application's README.
