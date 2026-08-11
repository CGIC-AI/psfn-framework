from __future__ import annotations

import json

import httpx
import pytest

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider
from hub.satellite_claims import normalize_claim_config


@pytest.mark.anyio
async def test_psfn_streaming_provider_streams_deltas_and_persists_history() -> None:
    requests: list[dict[str, object]] = []
    request_headers: list[dict[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        requests.append(body)
        request_headers.append({
            "x-psfn-channel-type": request.headers.get("x-psfn-channel-type", ""),
            "x-psfn-channel-id": request.headers.get("x-psfn-channel-id", ""),
            "x-psfn-satellite-claim-type": request.headers.get("x-psfn-satellite-claim-type", ""),
            "x-psfn-satellite-id": request.headers.get("x-psfn-satellite-id", ""),
            "x-psfn-satellite-endpoint-id": request.headers.get("x-psfn-satellite-endpoint-id", ""),
            "x-psfn-satellite-session-id": request.headers.get("x-psfn-satellite-session-id", ""),
            "x-psfn-satellite-thread-id": request.headers.get("x-psfn-satellite-thread-id", ""),
            "x-psfn-satellite-capabilities": request.headers.get("x-psfn-satellite-capabilities", ""),
            "x-psfn-satellite-name": request.headers.get("x-psfn-satellite-name", ""),
            "x-psfn-satellite-claim": request.headers.get("x-psfn-satellite-claim", ""),
            "x-psfn-author-id": request.headers.get("x-psfn-author-id", ""),
            "x-psfn-author-name": request.headers.get("x-psfn-author-name", ""),
        })
        if len(requests) == 1:
            stream = (
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"psfn","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"psfn","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
                "data: [DONE]\n\n"
            )
            return httpx.Response(
                200,
                content=stream.encode("utf-8"),
                headers={"Content-Type": "text/event-stream"},
                request=request,
            )
        stream = (
            'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"psfn","choices":[{"index":0,"delta":{"content":"Again"},"finish_reason":null}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(
            200,
            content=stream.encode("utf-8"),
            headers={"Content-Type": "text/event-stream"},
            request=request,
        )

    client = httpx.AsyncClient(
        base_url="http://psfn.test/v1",
        transport=httpx.MockTransport(handler),
    )
    provider = PsfnStreamingProvider(
        api_base_url="http://psfn.test/v1",
        api_key=None,
        model_name="psfn",
        claim_config=normalize_claim_config(
            capability_profile="voice-only",
            satellite_id="pi-w",
            endpoint_id="pi-w-realtime",
            display_name="Pi West",
        ),
        client=client,
    )

    first_chunks = [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="realtime:pi-w")]
    second_chunks = [chunk async for chunk in provider.stream_reply(text="follow up", conversation_id="realtime:pi-w")]

    assert first_chunks == ["Hello"]
    assert second_chunks == ["Again"]
    assert requests[0]["model"] == "psfn"
    assert requests[0]["stream"] is True
    assert "max_tokens" not in requests[0]
    assert requests[0]["system_prompt_mode"] == "default"
    assert "system_prompt" not in requests[0]
    assert requests[0]["response_style"] == "concise"
    assert requests[0]["user"] == "realtime:pi-w"
    assert requests[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert requests[0]["satellite_claim"]["claim"] == {
        "namespace": "satellite.endpoint",
        "type": "voice-only",
        "satelliteId": "pi-w",
        "endpointId": "pi-w-realtime",
        "sessionId": "realtime:pi-w",
        "threadId": "realtime:pi-w",
        "channelId": "satellite.endpoint:realtime:pi-w",
        "deviceClass": "voice",
        "displayName": "Pi West",
        "locationMode": "static",
    }
    assert request_headers[0] == {
        "x-psfn-channel-type": "satellite.endpoint",
        "x-psfn-channel-id": "satellite.endpoint:realtime:pi-w",
        "x-psfn-satellite-claim-type": "voice-only",
        "x-psfn-satellite-id": "pi-w",
        "x-psfn-satellite-endpoint-id": "pi-w-realtime",
        "x-psfn-satellite-session-id": "realtime:pi-w",
        "x-psfn-satellite-thread-id": "realtime:pi-w",
        "x-psfn-satellite-capabilities": "text,audio_input,speech_to_text,audio_output,text_to_speech",
        "x-psfn-satellite-name": "Pi West",
        "x-psfn-satellite-claim": json.dumps(requests[0]["satellite_claim"], separators=(",", ":")),
        "x-psfn-author-id": "",
        "x-psfn-author-name": "",
    }
    assert requests[1]["messages"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "Hello"},
        {"role": "user", "content": "follow up"},
    ]

    await provider.aclose()
    await client.aclose()


@pytest.mark.anyio
async def test_provider_override_keeps_full_companion_prompt_pipeline() -> None:
    requests: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            content=(
                'data: {"choices":[{"delta":{"content":"Fast"},"finish_reason":null}]}\n\n'
                "data: [DONE]\n\n"
            ).encode("utf-8"),
            headers={"Content-Type": "text/event-stream"},
            request=request,
        )

    client = httpx.AsyncClient(
        base_url="http://psfn.test/v1",
        transport=httpx.MockTransport(handler),
    )
    provider = PsfnStreamingProvider(
        api_base_url="http://psfn.test/v1",
        api_key=None,
        provider_name="openrouter",
        model_name="z-ai-glm-5.2-nitro",
        claim_config=normalize_claim_config(
            capability_profile="voice-only",
            satellite_id="bedroom",
            endpoint_id="waveshare-bedroom",
            display_name="Companion Bedroom",
        ),
        client=client,
    )

    chunks = [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="bedroom")]

    assert chunks == ["Fast"]
    assert len(requests) == 1
    payload = requests[0]
    assert payload["provider"] == "openrouter"
    assert payload["model"] == "z-ai-glm-5.2-nitro"
    assert payload["stream"] is True
    assert "max_tokens" not in payload
    assert payload["system_prompt_mode"] == "default"
    assert payload["response_style"] == "concise"
    assert payload["user"] == "bedroom"
    assert payload["messages"] == [{"role": "user", "content": "hello"}]
    assert payload["satellite_claim"]["claim"]["channelId"] == "satellite.endpoint:bedroom"
    assert "system_prompt" not in payload

    await provider.aclose()
    await client.aclose()


@pytest.mark.anyio
async def test_provider_submits_typed_headpat_to_companion_stimuli_route() -> None:
    captured: list[tuple[str, str, dict[str, object]]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append((
            request.url.path,
            request.headers.get("authorization", ""),
            json.loads(request.content.decode("utf-8")),
        ))
        return httpx.Response(
            200,
            json={
                "status": "accepted",
                "messageId": "companion-stimulus-1",
                "response": "Mmm, bedtime headpats.",
            },
            request=request,
        )

    client = httpx.AsyncClient(
        base_url="http://psfn.test/v1",
        transport=httpx.MockTransport(handler),
    )
    provider = PsfnStreamingProvider(
        api_base_url="http://psfn.test/v1",
        api_key="satellite-secret",
        model_name="psfn",
        claim_config=normalize_claim_config(
            capability_profile="voice-only",
            satellite_id="bedroom",
            endpoint_id="waveshare-bedroom",
            display_name="Companion Bedroom",
        ),
        client=client,
    )

    result = await provider.submit_touch_stimulus(
        conversation_id="bedroom",
        kind="headpat",
        region="head",
        count=1,
        duration_ms=0,
        response_mode="respond",
    )

    assert result == {
        "status": "accepted",
        "messageId": "companion-stimulus-1",
        "response": "Mmm, bedtime headpats.",
    }
    assert captured == [(
        "/v1/companion/stimuli",
        "Bearer satellite-secret",
        {
            "satelliteId": "bedroom",
            "endpointId": "waveshare-bedroom",
            "claimType": "voice-only",
            "sessionId": "bedroom",
            "deviceId": "waveshare-bedroom",
            "kind": "headpat",
            "region": "head",
            "count": 1,
            "durationMs": 0,
            "responseMode": "respond",
        },
    )]

    await provider.aclose()
    await client.aclose()
