"""Durable completed-turn delivery. Accepted rows retain receipts, never chat text."""

import hashlib
import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


def _encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Outbox:
    def __init__(self, hermes_home: str | Path, *, body_id: str, companion_id: str):
        directory = Path(hermes_home) / "psfn-memory"
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = directory / "outbox.sqlite3"
        with self._connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.execute("CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
            db.execute("""CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE, source_key TEXT UNIQUE,
                digest TEXT NOT NULL, payload TEXT, receipt TEXT
            )""")
            binding = _encode({"bodyId": body_id, "companionId": companion_id})
            db.execute("INSERT OR IGNORE INTO binding(id,value) VALUES(1,?)", (binding,))
            if db.execute("SELECT value FROM binding WHERE id=1").fetchone()[0] != binding:
                raise ValueError("PSFN outbox belongs to a different body or companion; use a separate Hermes profile")
        self.path.chmod(0o600)

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.path)
        try:
            db.execute("PRAGMA synchronous = FULL")
            with db:
                yield db
        finally:
            db.close()

    def enqueue(self, session_id: str, user: str, assistant: str, *, source_key: str | None = None) -> str:
        content = {"sessionId": session_id, "user": user, "assistant": assistant}
        digest = hashlib.sha256(_encode(content).encode()).hexdigest()
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if source_key:
                existing = db.execute("SELECT event_id,digest FROM events WHERE source_key=?", (source_key,)).fetchone()
                if existing:
                    if existing[1] != digest:
                        raise ValueError("PSFN source turn already queued with different content")
                    return existing[0]
            event_id = str(uuid4())
            payload = {**content, "eventId": event_id, "occurredAt": time.time_ns() // 1_000_000}
            db.execute("INSERT INTO events(event_id,source_key,digest,payload) VALUES(?,?,?,?)",
                       (event_id, source_key, digest, _encode(payload)))
            return event_id

    def pending(self, limit: int) -> list[dict]:
        with self._connect() as db:
            rows = db.execute("SELECT payload FROM events WHERE payload IS NOT NULL ORDER BY sequence LIMIT ?", (limit,))
            return [json.loads(row[0]) for row in rows]

    def acknowledge(self, event_id: str, receipt: dict) -> None:
        with self._connect() as db:
            db.execute("UPDATE events SET payload=NULL,receipt=? WHERE event_id=?", (_encode(receipt), event_id))

    def pending_count(self) -> int:
        with self._connect() as db:
            return db.execute("SELECT COUNT(*) FROM events WHERE payload IS NOT NULL").fetchone()[0]
