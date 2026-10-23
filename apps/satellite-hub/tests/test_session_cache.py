from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

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


def test_reset_flood_evicts_least_recent_session_and_preserves_active_history() -> None:
    cache = SessionCache(max_sessions=3)
    cache.set_history("active", [{"role": "user", "content": "recent context"}])
    for index in range(100):
        cache.get_or_create(f"reset-{index}")
        assert cache.get("active").history == [{"role": "user", "content": "recent context"}]
    assert cache.get("reset-97") is None
    assert cache.get("reset-98") is not None
    assert cache.get("reset-99") is not None


def test_session_cache_expires_at_exact_idle_deadline_and_recreates_cleanly() -> None:
    current = datetime(2026, 3, 20, tzinfo=timezone.utc)
    cache = SessionCache(max_sessions=1, ttl=timedelta(seconds=10), now_provider=lambda: current)
    cache.set_history("old", [{"role": "assistant", "content": "old context"}])
    current += timedelta(seconds=10)
    assert cache.get("old") is None
    assert cache.get_or_create("new").history == []


def test_session_cache_rejects_invalid_capacity() -> None:
    with pytest.raises(ValueError, match="positive"):
        SessionCache(max_sessions=0)
