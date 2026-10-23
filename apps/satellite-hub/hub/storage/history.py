from __future__ import annotations


def bounded_history(messages: list[dict[str, str]], *, max_messages: int, max_bytes: int) -> list[dict[str, str]]:
    """Retain a recent suffix of whole messages; never start with an orphan reply."""
    retained: list[dict[str, str]] = []
    byte_count = 0
    for message in reversed(messages):
        role, content = message.get("role"), message.get("content")
        role = role.strip() if isinstance(role, str) else role
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        if len(content) > max_bytes:
            break
        content = content.strip()
        if not content:
            continue
        size = len(content.encode("utf-8"))
        if len(retained) >= max_messages or byte_count + size > max_bytes:
            break
        retained.append({"role": role, "content": content})
        byte_count += size
    retained.reverse()
    while retained and retained[0]["role"] != "user":
        retained.pop(0)
    return retained
