from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json

import httpx
import pytest

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider


@pytest.mark.anyio
async def test_provider_retains_only_recent_whole_turns_with_message_and_utf8_budgets() -> None:
    requests = []

    def handler(request):
        requests.append(json.loads(request.content)["messages"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    async with httpx.AsyncClient(base_url="http://psfn.test/v1", transport=httpx.MockTransport(handler)) as client:
        provider = PsfnStreamingProvider(
            api_base_url="http://psfn.test/v1", model_name="psfn", client=client,
            history_max_messages=4, history_max_bytes=12,
        )
        reply = await provider.reply(text="éé", conversation_id="one", history=[])
        reply = await provider.reply(text="éé", conversation_id="one", history=reply.history)
        reply = await provider.reply(text="éé", conversation_id="one", history=reply.history)
        assert reply.history == [
            {"role": "user", "content": "éé"}, {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "éé"}, {"role": "assistant", "content": "ok"},
        ]
        assert requests[-1] == [
            {"role": "user", "content": "éé"}, {"role": "assistant", "content": "ok"},
            {"role": "user", "content": "éé"},
        ]
        before = len(requests)
        with pytest.raises(ValueError, match="byte limit"):
            await provider.reply(text="é" * 7, conversation_id="one", history=[])
        assert len(requests) == before


@pytest.mark.anyio
async def test_streaming_provider_conversation_lru_ttl_and_output_budget_use_real_store() -> None:
    requests = []
    current = datetime(2026, 10, 23, tzinfo=timezone.utc)

    def handler(request):
        requests.append(json.loads(request.content)["messages"])
        text = "too-long-output" if requests[-1][-1]["content"] == "large" else "ok"
        return httpx.Response(200, content=(f'data: {json.dumps({"choices": [{"delta": {"content": text}}]})}\n\n'
                                           'data: [DONE]\n\n'), headers={"Content-Type": "text/event-stream"})

    async with httpx.AsyncClient(base_url="http://psfn.test/v1", transport=httpx.MockTransport(handler)) as client:
        provider = PsfnStreamingProvider(
            api_base_url="http://psfn.test/v1", model_name="psfn", client=client,
            history_max_conversations=2, history_max_bytes=12, history_ttl_seconds=10,
            now_provider=lambda: current,
        )

        async def turn(conversation, text="hi"):
            return [chunk async for chunk in provider.stream_reply(text=text, conversation_id=conversation)]

        await turn("active")
        for index in range(100):
            await turn(f"reset-{index}")
            await turn("active")
            assert requests[-1][0] == {"role": "user", "content": "hi"}
            assert len(requests[-1]) > 1
        await turn("reset-0")
        assert requests[-1] == [{"role": "user", "content": "hi"}]
        current += timedelta(seconds=10)
        await turn("active")
        assert requests[-1] == [{"role": "user", "content": "hi"}]
        with pytest.raises(ValueError, match="byte limit"):
            await turn("large-output", "large")
        await turn("large-output")
        assert requests[-1] == [{"role": "user", "content": "hi"}]
