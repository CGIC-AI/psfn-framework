from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable

from hub.util import utc_now


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
        now_provider: Callable[[], datetime] = utc_now,
    ) -> None:
        self._ttl = ttl
        self._now = now_provider
        self._sessions: dict[str, ConversationSession] = {}

    def purge_expired(self) -> None:
        now = self._now()
        expired = [
            conversation_id
            for conversation_id, session in self._sessions.items()
            if now - session.updated_at > self._ttl
        ]
        for conversation_id in expired:
            del self._sessions[conversation_id]

    def get(self, conversation_id: str) -> ConversationSession | None:
        self.purge_expired()
        return self._sessions.get(conversation_id)

    def get_or_create(self, conversation_id: str) -> ConversationSession:
        self.purge_expired()
        session = self._sessions.get(conversation_id)
        if session is None:
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
        session.history.extend(messages)
        session.updated_at = self._now()
        return session

    def set_history(self, conversation_id: str, messages: list[dict[str, str]]) -> ConversationSession:
        session = self.get_or_create(conversation_id)
        session.history = list(messages)
        session.updated_at = self._now()
        return session

    def touch(self, conversation_id: str) -> ConversationSession:
        session = self.get_or_create(conversation_id)
        session.updated_at = self._now()
        return session
