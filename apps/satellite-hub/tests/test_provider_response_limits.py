from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from websockets.asyncio.server import serve

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider
from hub.adapters.tts.deepgram import DeepgramTTSProvider
from hub.adapters.tts.elevenlabs import ElevenLabsTTSProvider
from hub.adapters.bounds import ProviderLimits
from hub.adapters.stt.deepgram_live import DeepgramLiveSTTProvider
from hub.adapters.tts.elevenlabs_streaming import ElevenLabsStreamingTTS


class Chunks(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


@pytest.mark.anyio
async def test_model_http_and_sse_transport_caps_precede_history_and_recover() -> None:
    requests = []
    bodies = [
        b'{"choices":[{"message":{"content":"ok"}}]}' + b" " * 60,
        b"x" * 1000,
        b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        b"data: " + b"x" * 1000,
        b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    ]

    def handler(request):
        requests.append(json.loads(request.content))
        body = bodies[len(requests) - 1]
        return httpx.Response(200, stream=Chunks([body]))

    async with httpx.AsyncClient(base_url="http://provider.test/v1", transport=httpx.MockTransport(handler)) as client:
        provider = PsfnStreamingProvider(
            api_base_url="http://provider.test/v1", model_name="psfn", client=client,
            max_provider_response_bytes=len(bodies[0]), max_provider_line_bytes=64,
        )
        assert (await provider.reply(text="hello", conversation_id="one", history=[])).text == "ok"
        with pytest.raises(RuntimeError, match="Provider response limit"):
            await provider.reply(text="hello", conversation_id="overflow", history=[])
        assert [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="new")] == ["ok"]
        with pytest.raises(RuntimeError, match="Provider response limit"):
            _ = [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="overflow")]
        assert [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="overflow")] == ["ok"]
        assert requests[-1]["messages"] == [{"role": "user", "content": "hello"}]


@pytest.mark.anyio
@pytest.mark.parametrize("provider_type", [DeepgramTTSProvider, ElevenLabsTTSProvider])
async def test_tts_http_audio_exact_limit_overflow_has_no_artifact_and_recovers(tmp_path, provider_type) -> None:
    bodies = iter([b"12345678", b"123456789", b"healthy"])
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, stream=Chunks([next(bodies)])))) as client:
        options = {"voice_id": "fixture"} if provider_type is ElevenLabsTTSProvider else {}
        provider = provider_type(api_key="invented", output_root=tmp_path, client=client,
                                 limits=ProviderLimits(max_http_bytes=8), **options)
        first = await provider.synthesize("invented input")
        assert first.audio_path.read_bytes() == b"12345678"
        before = len(list(tmp_path.rglob("*.mp3")))
        with pytest.raises(RuntimeError, match="Provider response limit"):
            await provider.synthesize("invented input")
        assert len(list(tmp_path.rglob("*.mp3"))) == before
        assert (await provider.synthesize("invented input")).audio_path.read_bytes() == b"healthy"
        await provider.aclose()


@pytest.mark.anyio
async def test_voice_list_json_is_bounded_before_parse_and_recovery_works(tmp_path) -> None:
    voice_json = b'{"voices":[{"voice_id":"fixture","category":"premade"}]}'
    calls = 0

    def handler(request):
        nonlocal calls
        if request.url.path.endswith("/voices"):
            calls += 1
            return httpx.Response(200, stream=Chunks([voice_json + (b" " if calls == 1 else b"")]))
        return httpx.Response(200, content=b"audio")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = ElevenLabsTTSProvider(api_key="invented", output_root=tmp_path, client=client,
                                        limits=ProviderLimits(max_json_bytes=len(voice_json)))
        with pytest.raises(RuntimeError, match="Provider response limit"):
            await provider.synthesize("hello")
        assert not list(tmp_path.rglob("*.mp3"))
        assert (await provider.synthesize("hello")).audio_path.read_bytes() == b"audio"
        await provider.aclose()


@pytest.mark.anyio
@pytest.mark.parametrize("attack", ["segments", "text", "frame"])
async def test_deepgram_real_socket_turn_limits_fail_closed_and_next_turn_recovers(attack) -> None:
    connections = 0

    async def handler(ws):
        nonlocal connections
        connections += 1
        first = connections == 1
        try:
            async for message in ws:
                if isinstance(message, bytes):
                    texts = ["a", "b"] if attack == "segments" and first else ["x" * 2000 if attack == "frame" and first else "ééx" if first else "ok"]
                    for text in texts:
                        await ws.send(json.dumps({"type": "Results", "is_final": True, "channel": {"alternatives": [{"transcript": text}]}}, ensure_ascii=False))
                elif json.loads(message).get("type") == "Finalize":
                    await ws.send('{"type":"UtteranceEnd"}')
        except Exception:
            pass

    async with serve(handler, "127.0.0.1", 0) as upstream:
        provider = DeepgramLiveSTTProvider(
            api_key="invented", websocket_url=f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}",
            limits=ProviderLimits(max_segments=1, max_text_bytes=4, max_ws_message_bytes=1024),
        )
        try:
            await provider.start_turn("one")
            await provider.send_audio(b"12")
            await asyncio.sleep(0.03)
            with pytest.raises(RuntimeError, match="Provider"):
                await provider.finish_turn()
            await provider.start_turn("two")
            await provider.send_audio(b"12")
            assert (await provider.finish_turn()).text == "ok"
        finally:
            await provider.aclose()


@pytest.mark.anyio
async def test_deepgram_exact_utf8_budget_succeeds_and_input_audio_overflow_recovers() -> None:
    frame = json.dumps({"type": "Results", "is_final": True, "channel": {"alternatives": [{"transcript": "éé"}]}}, ensure_ascii=False)

    async def handler(ws):
        try:
            async for message in ws:
                await ws.send(frame if isinstance(message, bytes) else '{"type":"UtteranceEnd"}')
        except Exception:
            pass

    async with serve(handler, "127.0.0.1", 0) as upstream:
        provider = DeepgramLiveSTTProvider(api_key="invented", websocket_url=f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}",
            limits=ProviderLimits(max_audio_bytes=8, max_text_bytes=4, max_segments=1, max_ws_message_bytes=len(frame.encode("utf-8"))))
        try:
            await provider.start_turn("one")
            await provider.send_audio(b"12345678")
            assert (await provider.finish_turn()).text == "éé"
            await provider.start_turn("overflow")
            with pytest.raises(RuntimeError, match="Provider"):
                await provider.send_audio(b"123456789")
            await provider.start_turn("healthy")
            await provider.send_audio(b"12")
            assert (await provider.finish_turn()).text == "éé"
        finally:
            await provider.aclose()


@pytest.mark.anyio
async def test_elevenlabs_real_socket_slow_consumer_context_and_audio_limits_recover() -> None:
    flood = asyncio.Event()

    async def send_audio(ws, context, data, *, final=False):
        await ws.send(json.dumps({"contextId": context, "audio": base64.b64encode(data).decode("ascii"), "isFinal": final}))

    async def handler(ws):
        try:
            async for message in ws:
                payload = json.loads(message)
                if payload.get("text") != " ":
                    continue
                context = payload["context_id"]
                if context == "overflow":
                    await send_audio(ws, context, b"1234")
                    await flood.wait()
                    await send_audio(ws, context, b"5678")
                    await send_audio(ws, context, b"9012")
                elif context == "exact":
                    await send_audio(ws, context, b"1234")
                    await asyncio.sleep(0.03)
                    await send_audio(ws, context, b"5678", final=True)
                else:
                    await send_audio(ws, context, b"good", final=True)
        except Exception:
            pass

    async with serve(handler, "127.0.0.1", 0) as upstream:
        provider = ElevenLabsStreamingTTS(api_key="invented", voice_id="fixture",
            websocket_url=f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}",
            limits=ProviderLimits(max_contexts=1, max_queued_chunks=1, max_queued_bytes=4, max_audio_bytes=8))

        def text():
            queue = asyncio.Queue()
            queue.put_nowait("hello")
            queue.put_nowait(None)
            return queue

        try:
            stalled = provider.stream_text(text_chunks=text(), context_id="overflow")
            assert await anext(stalled) == b"1234"
            with pytest.raises(RuntimeError, match="context capacity"):
                _ = [chunk async for chunk in provider.stream_text(text_chunks=text(), context_id="other")]
            flood.set()
            await asyncio.sleep(0.03)
            with pytest.raises(RuntimeError, match="Provider"):
                await anext(stalled)
            assert [chunk async for chunk in provider.stream_text(text_chunks=text(), context_id="exact")] == [b"1234", b"5678"]
            assert [chunk async for chunk in provider.stream_text(text_chunks=text(), context_id="healthy")] == [b"good"]
        finally:
            await provider.aclose()


@pytest.mark.anyio
async def test_sse_line_limit_is_incremental_and_independent_of_total_wire_budget() -> None:
    line = b'data: {"choices":[{"delta":{"content":"ok"}}]}'
    bodies = iter([line + b"\n\ndata: [DONE]\n\n", b"x" * (len(line) + 1) + b"\n", line + b"\n\ndata: [DONE]\n\n"])
    def handler(request):
        body = next(bodies)
        return httpx.Response(200, stream=Chunks([body[index:index + 7] for index in range(0, len(body), 7)]))
    async with httpx.AsyncClient(base_url="http://provider.test/v1", transport=httpx.MockTransport(handler)) as client:
        provider = PsfnStreamingProvider(api_base_url="http://provider.test/v1", model_name="psfn", client=client,
                                         max_provider_response_bytes=256, max_provider_line_bytes=len(line))
        assert [part async for part in provider.stream_reply(text="hello", conversation_id="exact")] == ["ok"]
        with pytest.raises(RuntimeError, match="Provider response limit"):
            _ = [part async for part in provider.stream_reply(text="hello", conversation_id="overflow")]
        assert [part async for part in provider.stream_reply(text="hello", conversation_id="overflow")] == ["ok"]


@pytest.mark.anyio
async def test_streaming_voice_list_frame_and_utf8_input_limits_recover() -> None:
    voice_json = b'{"voices":[{"voice_id":"fixture","category":"premade"}]}'
    calls = 0
    def http_handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, stream=Chunks([voice_json + (b" " if calls == 1 else b"")]))
    healthy_frame = json.dumps({"contextId": "b", "audio": "MTIzNA==", "isFinal": True})
    async def handler(ws):
        try:
            async for raw in ws:
                payload = json.loads(raw)
                text = payload.get("text")
                if not isinstance(text, str) or text == " ":
                    continue
                context = payload["context_id"]
                if context == "a":
                    await ws.send("x" * 1000)
                else:
                    await ws.send(json.dumps({"contextId": context, "audio": "MTIzNA==", "isFinal": True}))
        except Exception:
            pass
    def text(value):
        queue = asyncio.Queue()
        queue.put_nowait(value)
        queue.put_nowait(None)
        return queue
    async with httpx.AsyncClient(transport=httpx.MockTransport(http_handler)) as client:
        async with serve(handler, "127.0.0.1", 0) as upstream:
            provider = ElevenLabsStreamingTTS(api_key="invented", voice_id=None, http_client=client,
                websocket_url=f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}",
                limits=ProviderLimits(max_json_bytes=len(voice_json), max_ws_message_bytes=len(healthy_frame.encode()), max_text_bytes=4))
            try:
                with pytest.raises(RuntimeError, match="Provider response limit"):
                    _ = [part async for part in provider.stream_text(text_chunks=text("hi"), context_id="v")]
                with pytest.raises(RuntimeError, match="Provider"):
                    _ = [part async for part in provider.stream_text(text_chunks=text("hi"), context_id="a")]
                with pytest.raises(RuntimeError, match="Provider"):
                    _ = [part async for part in provider.stream_text(text_chunks=text("ééx"), context_id="c")]
                assert [part async for part in provider.stream_text(text_chunks=text("éé"), context_id="b")] == [b"1234"]
            finally:
                await provider.aclose()


@pytest.mark.anyio
async def test_abandoned_tts_consumer_expires_without_keeping_context_registry_full() -> None:
    async def handler(ws):
        try:
            async for raw in ws:
                payload = json.loads(raw)
                if payload.get("text") == " ":
                    context = payload["context_id"]
                    await ws.send(json.dumps({"contextId": context, "audio": "MTIzNA==", "isFinal": context == "new"}))
        except Exception:
            pass
    def text():
        queue = asyncio.Queue()
        queue.put_nowait("hi")
        queue.put_nowait(None)
        return queue
    async with serve(handler, "127.0.0.1", 0) as upstream:
        provider = ElevenLabsStreamingTTS(api_key="invented", voice_id="fixture",
            websocket_url=f"ws://127.0.0.1:{upstream.sockets[0].getsockname()[1]}",
            limits=ProviderLimits(max_contexts=1, idle_seconds=0.05))
        try:
            abandoned = provider.stream_text(text_chunks=text(), context_id="old")
            assert await anext(abandoned) == b"1234"
            await asyncio.sleep(0.12)
            assert [part async for part in provider.stream_text(text_chunks=text(), context_id="new")] == [b"1234"]
            with pytest.raises(RuntimeError, match="expired"):
                await anext(abandoned)
        finally:
            await provider.aclose()
