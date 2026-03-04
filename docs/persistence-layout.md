# Persistence Layout

## Overview

Runtime persistence under `DATA_DIR` is split by artifact type:

- `sessions/`: L0 chat/session transcripts and session index/search metadata
- `notes/`: reflective journals and scratchpad-style working notes
- `contacts/`: contact snapshots and continuity artifacts

This split exists to keep operator-facing data discoverable without SQLite inspection.

## Directory Map

- `DATA_DIR/sessions/`
  - Per-channel L0 session journals (`*.jsonl`)
  - `_channel_index.json`
  - `session-search.sqlite`
  - `_import_manifest.jsonl`
- `DATA_DIR/notes/`
  - `values.jsonl` (values reflection journal)
  - `scratchpad.json` (scratchpad snapshot mirror)
  - `reflections/journal.jsonl` (heartbeat reflection notes)
  - `reflections/*.jsonl` (migrated legacy internal reflection journals)
- `DATA_DIR/contacts/`
  - `index.json` (contact summary index)
  - `contact-<id>.json` (per-contact snapshot)
  - `continuity/user_<id>.jsonl` (cross-channel continuity threads)

## Migration / Backward Compatibility

- `values.jsonl` legacy path:
  - Legacy location: `DATA_DIR/values.jsonl`
  - Current location: `DATA_DIR/notes/values.jsonl`
  - On first access, legacy file content is migrated forward if the new file is absent.
- Legacy reflection session files:
  - `internal:reflection:*` journals previously created in `DATA_DIR/sessions/` are moved to `DATA_DIR/notes/reflections/`.
  - Moved channels are removed from `_channel_index.json`.
- Legacy continuity files:
  - `DATA_DIR/sessions/user_*.jsonl` are moved to `DATA_DIR/contacts/continuity/` when missing there.

## Operational Notes

- Internal reflection channels (`internal:reflection:*`) are no longer persisted into `sessions/`.
- Scratchpad data remains source-of-truth in SQLite (`scratchpad_entries`) and is mirrored to `notes/scratchpad.json` for operator visibility.
- Contact records remain source-of-truth in SQLite and are mirrored into `contacts/` JSON snapshots.
