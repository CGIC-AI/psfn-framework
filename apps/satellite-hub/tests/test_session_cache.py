from __future__ import annotations

from datetime import datetime, timedelta, timezone

from hub.storage.session_cache import SessionCache


def test_session_cache_expires_entries() -> None:
    current = datetime(2026, 3, 20, 12, 0, tzinfo=timezone.utc)

    def now() -> datetime:
        return current

    cache = SessionCache(ttl=timedelta(seconds=300), now_provider=now)
    cache.extend_history("abc", [{"role": "user", "content": "hello"}])
    assert cache.get("abc") is not None

    current = current + timedelta(seconds=301)
    assert cache.get("abc") is None


def test_session_cache_touch_keeps_entry_alive() -> None:
    current = datetime(2026, 3, 20, 12, 0, tzinfo=timezone.utc)

    def now() -> datetime:
        return current

    cache = SessionCache(ttl=timedelta(seconds=300), now_provider=now)
    cache.touch("conv-1")

    current = current + timedelta(seconds=299)
    cache.touch("conv-1")
    current = current + timedelta(seconds=299)

    assert cache.get("conv-1") is not None
