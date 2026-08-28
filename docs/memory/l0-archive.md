---
type: concept
title: Memory L0
description: L0 is the append-only autobiographical archive — per-channel signed JSONL session history on the filesystem, plus the memories.jsonl mutation ledger as an audit mirror. Filesystem truth; never rewritten; projections rebuild from it.
tags: [memory, l0, jsonl, session-archive, filesystem-truth, mutation-ledger, fail-closed]
generated: { by: "openwiki/0.4.3", at: "2026-08-28T13:30:04.287Z" }
---

# Memory L0

L0 is canonical lived history. It is not a cache, not a search index, and not
a restore primitive for L0.1 or L2.

See [Memory](overview.md) for the three-layer map, [Memory L0.1](l01-episodes.md)
for episodic landmarks, and [Memory L2](l2-typed.md) for typed long-term rows.

## What L0 is

| Piece | Path / owner | Role |
| --- | --- | --- |
| Session archive | per-channel signed JSONL under the session store | Authoritative autobiographical history (`filesystem_truth`) |
| Memory mutation ledger | `state/notes/memories.jsonl` | Append-only audit/export mirror of L2 mutations — **not** the L2 restore primitive |

Charter §6.27: do not call these a **journal**. Journal means companion-authored
personal Markdown writing ([Journal](../faculties/journal.md)). L0 is the
**L0 session archive** and the **memory mutation ledger**.

## Invariants

- Append-only. Repair rebuilds derived state **from** L0. It never rewrites L0.
- `session_messages_projection` is rebuildable search state, never L0 authority
  ([Memory projection](projection.md)).
- No SQLite runtime. Persistence rejects any other backend at startup
  (`src/persistence/postgres/parity-matrix.ts`).
- HMAC verification is on when a session keyring is configured
  (`src/persistence/sessions/store/journal-runtime.ts`).

## Session archive

Owned by `src/persistence/sessions/store.ts` and
`src/persistence/sessions/store/journal-runtime.ts`. Opened through
`SessionJournalRuntime` / `createFilesystemSessionArchivePort`.

Sealed JSONL segments follow `<stem>.NNNNN.jsonl` discovered from the directory
listing — higher numbers are newer, there is **no manifest**, and scanners claim
file identity (`dev:ino`) so a rotated file fails closed
(`src/persistence/jsonl-segments.ts`).

## Memory mutation ledger

Every L2 mutation also appends to `state/notes/memories.jsonl` through
`MemoryJournal` (`src/faculties/memory/journal.ts`): `insert`, `soft_delete`,
and `restore` events. The file header states it is an audit/export aid, not the
authoritative L2 restore primitive: embeddings, evolution links, and Postgres
tables restore from encrypted `pg_dump` backups.

Path: `resolveMemoryJournalPath` →
`resolveCompanionStateDir(companionDataDir)/notes/memories.jsonl`
(`src/persistence/layout.ts`). Backup verification uses its line count. Repair
scripts may rebuild empty `provenance_json` from it. Nothing replays it as a
restore.

## Who writes L0

Turn execution records user and assistant entries through `SessionManager`
(`src/core/session/`). Attribution guards keep scheduler/internal origin from
being recorded as Partner speech ([Attribution](../security/attribution.md),
[Session](../runtime/session.md)).

## Related

- [Memory](overview.md)
- [Memory L0.1](l01-episodes.md)
- [Memory L2](l2-typed.md)
- [Memory projection](projection.md)
- [Memory persistence authority](persistence-authority.md)
