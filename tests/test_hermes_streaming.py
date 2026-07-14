from __future__ import annotations

import ast

from hub.adapters.agent.hermes_streaming import _HERMES_STREAM_WORKER


def test_hermes_voice_completion_has_no_channel_specific_output_cap() -> None:
    tree = ast.parse(_HERMES_STREAM_WORKER)
    completion_calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "create"
        and {keyword.arg for keyword in node.keywords} >= {"model", "messages", "stream"}
    ]

    assert len(completion_calls) == 1
    keyword_names = {keyword.arg for keyword in completion_calls[0].keywords}
    assert "max_tokens" not in keyword_names
    assert "max_completion_tokens" not in keyword_names
