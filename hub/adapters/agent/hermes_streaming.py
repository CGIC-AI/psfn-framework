from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import uuid


_LOGGER = logging.getLogger(__name__)


class HermesStreamingProvider:
    def __init__(
        self,
        *,
        gateway_home: Path,
        model_name: str,
    ) -> None:
        self._gateway_home = gateway_home
        self._model_name = model_name
        self._hermes_repo = Path.home() / ".hermes" / "hermes-agent"
        self._python = self._hermes_repo / "venv" / "bin" / "python"
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._queues: dict[str, asyncio.Queue[dict[str, object]]] = {}
        self._write_lock = asyncio.Lock()

    async def stream_reply(
        self,
        *,
        text: str,
        conversation_id: str,
    ):
        await self._ensure_started()
        assert self._process is not None and self._process.stdin is not None

        request_id = uuid.uuid4().hex
        queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self._queues[request_id] = queue
        payload = {
            "command": "reply",
            "request_id": request_id,
            "conversation_id": conversation_id,
            "chat_id": f"esphome-voice:{conversation_id.replace('/', '_')}",
            "chat_name": f"ESPHome Voice {conversation_id}",
            "model_name": self._model_name,
            "gateway_home": str(self._gateway_home),
            "text": text,
        }

        async with self._write_lock:
            self._process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            await self._process.stdin.drain()

        try:
            while True:
                message = await queue.get()
                message_type = str(message.get("type") or "")
                if message_type == "delta":
                    delta = str(message.get("text") or "")
                    if delta:
                        yield delta
                    continue
                if message_type == "done":
                    return
                if message_type == "error":
                    raise RuntimeError(str(message.get("error") or "Hermes worker failed"))
        finally:
            self._queues.pop(request_id, None)

    async def aclose(self) -> None:
        await self._fail_pending("Hermes streaming worker closed")
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            self._stderr_task = None
        if self._process is not None:
            if self._process.stdin is not None:
                self._process.stdin.close()
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=3)
            except TimeoutError:
                self._process.kill()
                await self._process.wait()
            self._process = None

    async def _ensure_started(self) -> None:
        if self._process is not None and self._process.returncode is None:
            return
        self._process = await asyncio.create_subprocess_exec(
            str(self._python),
            "-u",
            "-c",
            _HERMES_STREAM_WORKER,
            cwd=str(self._hermes_repo),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._reader_task = asyncio.create_task(self._stdout_reader())
        self._stderr_task = asyncio.create_task(self._stderr_reader())

    async def _stdout_reader(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        try:
            while True:
                line = await self._process.stdout.readline()
                if not line:
                    break
                try:
                    message = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    _LOGGER.debug("Ignoring non-JSON Hermes worker output: %r", line)
                    continue
                request_id = str(message.get("request_id") or "")
                queue = self._queues.get(request_id)
                if queue is not None:
                    await queue.put(message)
        except asyncio.CancelledError:
            return
        finally:
            await self._fail_pending("Hermes streaming worker exited")

    async def _stderr_reader(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        try:
            while True:
                line = await self._process.stderr.readline()
                if not line:
                    return
                _LOGGER.debug("Hermes worker stderr: %s", line.decode("utf-8", errors="replace").rstrip())
        except asyncio.CancelledError:
            return

    async def _fail_pending(self, error: str) -> None:
        for queue in list(self._queues.values()):
            await queue.put({"type": "error", "error": error})


_HERMES_STREAM_WORKER = r"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

payload = None
gateway_home = None
runner = None
client = None
runtime = None


def _emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def _load_runtime(gateway_home_value: str):
    global gateway_home, runner, client, runtime
    gateway_home = Path(gateway_home_value).expanduser()
    os.environ["HERMES_HOME"] = str(gateway_home)

    from dotenv import load_dotenv
    load_dotenv(gateway_home / ".env", override=True, encoding="utf-8")

    from openai import OpenAI
    from agent.prompt_builder import DEFAULT_AGENT_IDENTITY, PLATFORM_HINTS
    from gateway.config import Platform
    from gateway.run import GatewayRunner
    from gateway.session import SessionSource, build_session_context, build_session_context_prompt
    from hermes_cli.runtime_provider import resolve_runtime_provider

    runtime = resolve_runtime_provider(requested=os.getenv("HERMES_INFERENCE_PROVIDER"))
    if runtime.get("api_mode") != "chat_completions":
        raise RuntimeError(
            f"Voice streaming currently requires chat_completions provider, got {runtime.get('api_mode')}"
        )

    runner = GatewayRunner()
    client = OpenAI(api_key=runtime.get("api_key"), base_url=runtime.get("base_url"))

    def build_messages(*, chat_id: str, chat_name: str, text: str):
        source = SessionSource(
            platform=Platform.LOCAL,
            chat_id=chat_id,
            chat_name=chat_name,
            chat_type="channel",
            user_id="voice-hub",
            user_name="Voice Hub",
        )
        session_entry = runner.session_store.get_or_create_session(source)
        context = build_session_context(source, runner.config, session_entry)
        context_prompt = build_session_context_prompt(context)
        transcript = runner.session_store.load_transcript(session_entry.session_id)

        messages = [
            {
                "role": "system",
                "content": "\n\n".join(
                    part
                    for part in (
                        DEFAULT_AGENT_IDENTITY,
                        PLATFORM_HINTS.get("cli", ""),
                        runner._ephemeral_system_prompt,
                        context_prompt,
                        (
                            "Respond in one short, spoken-friendly sentence unless the user explicitly asks for more. "
                            "Do not call tools. Do not add preambles, summaries, or extra reassurance."
                        ),
                    )
                    if part
                ),
            }
        ]
        for message in transcript:
            role = message.get("role")
            content = message.get("content")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": text})
        return source, session_entry, messages

    return build_messages


build_messages = None

for raw_line in sys.stdin:
    if not raw_line.strip():
        continue
    payload = json.loads(raw_line)
    request_id = payload.get("request_id")
    try:
        if build_messages is None:
            build_messages = _load_runtime(payload["gateway_home"])

        source, session_entry, messages = build_messages(
            chat_id=payload["chat_id"],
            chat_name=payload["chat_name"],
            text=payload["text"],
        )

        stream = client.chat.completions.create(
            model=payload["model_name"],
            messages=messages,
            stream=True,
            # Voice turns need visible text quickly rather than reasoning-first latency.
            extra_body={"reasoning": {"enabled": False}},
        )

        full_text = ""
        for chunk in stream:
            for choice in getattr(chunk, "choices", []):
                delta = getattr(choice.delta, "content", None)
                if not delta:
                    continue
                if isinstance(delta, list):
                    parts = []
                    for item in delta:
                        text_part = getattr(item, "text", None)
                        if text_part:
                            parts.append(text_part)
                    delta_text = "".join(parts)
                else:
                    delta_text = str(delta)
                if not delta_text:
                    continue
                full_text += delta_text
                _emit({"request_id": request_id, "type": "delta", "text": delta_text})

        response_text = full_text.strip()
        timestamp = datetime.now().isoformat()
        runner.session_store.append_to_transcript(
            session_entry.session_id,
            {"role": "user", "content": payload["text"], "timestamp": timestamp},
        )
        runner.session_store.append_to_transcript(
            session_entry.session_id,
            {"role": "assistant", "content": response_text, "timestamp": timestamp},
        )
        runner.session_store.update_session(session_entry.session_key)
        _emit({"request_id": request_id, "type": "done", "text": response_text})
    except Exception as exc:
        _emit({"request_id": request_id, "type": "error", "error": str(exc)})
"""
