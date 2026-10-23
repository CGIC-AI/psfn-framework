from __future__ import annotations

from dataclasses import dataclass, field
from collections import OrderedDict
from datetime import datetime, timedelta
from typing import Callable

from hub.util import utc_now
from hub.storage.history import bounded_history


@dataclass(slots=True)
class ConversationSession:
    conversation_id: str
    created_at: datetime
    updated_at: datetime
    history: list[dict[str, str]] = field(default_factory=list)


class SessionCache:
    def __init__(
        self,
        *,
        ttl: timedelta = timedelta(seconds=300),
        max_sessions: int = 128,
        max_history_messages: int = 64,
        max_history_bytes: int = 65536,
        now_provider: Callable[[], datetime] = utc_now,
    ) -> None:
        if max_sessions < 1 or ttl <= timedelta(0) or max_history_messages < 2 or max_history_bytes < 1:
            raise ValueError("Session capacity and TTL must be positive")
        self._ttl = ttl
        self._max_sessions = max_sessions
        self._max_history_messages = max_history_messages
        self._max_history_bytes = max_history_bytes
        self._now = now_provider
        self._sessions: OrderedDict[str, ConversationSession] = OrderedDict()

    def purge_expired(self) -> None:
        now = self._now()
        expired = [
            conversation_id
            for conversation_id, session in self._sessions.items()
            if now - session.updated_at >= self._ttl
        ]
        for conversation_id in expired:
            del self._sessions[conversation_id]

    def get(self, conversation_id: str) -> ConversationSession | None:
        self.purge_expired()
        session = self._sessions.get(conversation_id)
        if session is not None:
            self._sessions.move_to_end(conversation_id)
            session.updated_at = self._now()
        return session

    def get_or_create(self, conversation_id: str) -> ConversationSession:
        session = self.get(conversation_id)
        if session is None:
            if len(self._sessions) >= self._max_sessions:
                self._sessions.popitem(last=False)
            now = self._now()
            session = ConversationSession(
                conversation_id=conversation_id,
                created_at=now,
                updated_at=now,
            )
            self._sessions[conversation_id] = session
        return session

    def extend_history(self, conversation_id: str, messages: list[dict[str, str]]) -> ConversationSession:
        session = self.get_or_create(conversation_id)
        session.history = self._bounded([*session.history, *messages])
        session.updated_at = self._now()
        return session

    def set_history(self, conversation_id: str, messages: list[dict[str, str]]) -> ConversationSession:
        session = self.get_or_create(conversation_id)
        session.history = self._bounded(messages)
        session.updated_at = self._now()
        return session

    def touch(self, conversation_id: str) -> ConversationSession:
        session = self.get_or_create(conversation_id)
        session.updated_at = self._now()
        return session

    def _bounded(self, messages: list[dict[str, str]]) -> list[dict[str, str]]:
        return bounded_history(messages, max_messages=self._max_history_messages, max_bytes=self._max_history_bytes)
