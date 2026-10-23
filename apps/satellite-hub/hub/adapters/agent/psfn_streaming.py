from __future__ import annotations

import asyncio
import json
import logging
import math
import os
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from typing import Callable
from typing import Any, Literal

import httpx

from hub.adapters.interfaces import AgentReply
from hub.adapters.bounds import bounded_request, bounded_lines, decode_json
from hub.security.device_assertion import HubDeviceAssertionIssuer
from hub.storage.history import bounded_history
from hub.storage.session_cache import SessionCache
from hub.util import utc_now
from hub.satellite_claims import (
    ClientCertificateConfig,
    SatelliteClaimConfig,
    build_satellite_claim_envelope,
    build_satellite_registry_headers,
    derive_channel_id,
    normalize_claim_config,
)


_LOGGER = logging.getLogger(__name__)

TouchKind = Literal["headpat", "petting", "hug", "kiss"]
TouchRegion = Literal["head", "cheek", "body"]
TouchResponseMode = Literal["respond", "observe"]


class PsfnStreamingProvider:
    def __init__(
        self,
        *,
        api_base_url: str,
        model_name: str,
        provider_name: str | None = None,
        api_key: str | None = None,
        author_id: str | None = None,
        author_name: str | None = None,
        claim_config: SatelliteClaimConfig | None = None,
        client_certificate: ClientCertificateConfig | None = None,
        device_assertion_issuer: HubDeviceAssertionIssuer | None = None,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 60.0,
        history_max_conversations: int | None = None,
        history_max_messages: int | None = None,
        history_max_bytes: int | None = None,
        history_ttl_seconds: float | None = None,
        now_provider: Callable[[], datetime] = utc_now,
        max_provider_response_bytes: int | None = None,
        max_provider_line_bytes: int | None = None,
    ) -> None:
        self._history_max_messages = history_max_messages if history_max_messages is not None else int(os.getenv("HUB_HISTORY_MAX_MESSAGES", "64"))
        self._history_max_bytes = history_max_bytes if history_max_bytes is not None else int(os.getenv("HUB_HISTORY_MAX_BYTES", "65536"))
        if not math.isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("Provider timeout must be positive and finite")
        self._provider_timeout_seconds = timeout_seconds
        self._provider_response_bytes = max_provider_response_bytes if max_provider_response_bytes is not None else self._history_max_bytes * 8 + 65536
        self._provider_line_bytes = max_provider_line_bytes if max_provider_line_bytes is not None else self._history_max_bytes * 6 + 8192
        if self._provider_response_bytes < 1 or self._provider_line_bytes < 1:
            raise ValueError("Provider response capacities must be positive")
        self._history_cache = SessionCache(
            max_sessions=history_max_conversations if history_max_conversations is not None else int(os.getenv("HUB_HISTORY_MAX_CONVERSATIONS", "128")),
            ttl=timedelta(seconds=history_ttl_seconds if history_ttl_seconds is not None else float(os.getenv("HUB_HISTORY_TTL_SECONDS", "300"))),
            max_history_messages=self._history_max_messages, max_history_bytes=self._history_max_bytes,
            now_provider=now_provider,
        )
        base_url = api_base_url.rstrip("/")
        if not base_url.endswith("/v1"):
            base_url = f"{base_url}/v1"
        headers: dict[str, str] = {}
        if api_key and api_key.strip():
            headers["Authorization"] = f"Bearer {api_key.strip()}"
        self._claim_config = claim_config or normalize_claim_config(tls=client_certificate)
        client_options: dict[str, Any] = {
            "base_url": base_url,
            "headers": headers,
            "timeout": httpx.Timeout(timeout_seconds, connect=10.0),
        }
        tls = self._claim_config.tls or client_certificate
        if tls and tls.configured:
            assert tls.cert_path is not None
            assert tls.key_path is not None
            client_options["cert"] = (str(tls.cert_path), str(tls.key_path))
        if tls and tls.ca_path is not None:
            client_options["verify"] = str(tls.ca_path)
        self._client = client or httpx.AsyncClient(**client_options)
        self._owns_client = client is None
        self._request_headers = headers
        self._model_name = model_name
        self._provider_name = (provider_name or "").strip().lower() or None
        self._author_id = author_id.strip() if author_id else None
        self._author_name = author_name.strip() if author_name else None
        self._device_assertion_issuer = device_assertion_issuer
        self._history_lock = asyncio.Lock()

    async def reply(
        self,
        *,
        text: str,
        conversation_id: str,
        history: list[dict[str, str]],
    ) -> AgentReply:
        normalized_history = self._bounded(history)
        messages = self._build_messages(history=normalized_history, text=text)
        response_text = await self._complete(messages=messages, conversation_id=conversation_id, stream=False)
        final_text = self._validate_reply(response_text)
        updated_history = self._bounded([*normalized_history, {"role": "user", "content": text}, {"role": "assistant", "content": final_text}])
        await self._set_history(conversation_id, updated_history)
        return AgentReply(text=final_text, history=updated_history)

    async def stream_reply(
        self,
        *,
        text: str,
        conversation_id: str,
    ) -> AsyncIterator[str]:
        prior_history = await self._get_history(conversation_id)
        messages = self._build_messages(history=prior_history, text=text)
        response_text = ""
        response_bytes = 0
        completed = False
        try:
            async for delta in self._stream_completion(messages=messages, conversation_id=conversation_id):
                response_bytes += len(delta.encode("utf-8"))
                if response_bytes > self._history_max_bytes:
                    raise ValueError("Conversation reply exceeds byte limit")
                response_text += delta
                yield delta
            completed = True
        finally:
            if completed:
                final_text = self._validate_reply(response_text)
                updated_history = self._bounded([*prior_history, {"role": "user", "content": text}, {"role": "assistant", "content": final_text}])
                await self._set_history(conversation_id, updated_history)

    async def submit_touch_stimulus(
        self,
        *,
        conversation_id: str,
        kind: TouchKind,
        region: TouchRegion,
        count: int,
        duration_ms: int,
        response_mode: TouchResponseMode,
    ) -> dict[str, str]:
        payload = {
            "satelliteId": self._claim_config.satellite_id,
            "endpointId": self._claim_config.endpoint_id,
            "claimType": self._claim_config.type,
            "sessionId": conversation_id,
            "deviceId": self._claim_config.endpoint_id,
            "kind": kind,
            "region": region,
            "count": count,
            "durationMs": duration_ms,
            "responseMode": response_mode,
        }
        body = await bounded_request(
            self._client, "POST",
            "/companion/stimuli",
            max_bytes=self._provider_response_bytes,
            timeout_seconds=self._provider_timeout_seconds,
            json=payload,
            headers=self._with_device_assertion(self._request_headers, conversation_id),
        )
        data = decode_json(body)
        if not isinstance(data, dict) or data.get("status") != "accepted" or not isinstance(data.get("messageId"), str):
            raise RuntimeError("PSFN companion stimulus returned an invalid response")
        result = {"status": "accepted", "messageId": data["messageId"]}
        if isinstance(data.get("response"), str):
            result["response"] = data["response"]
        return result

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _build_messages(self, *, history: list[dict[str, str]], text: str) -> list[dict[str, str]]:
        if len(text) > self._history_max_bytes or len(text.encode("utf-8")) > self._history_max_bytes:
            raise ValueError("Conversation message exceeds byte limit")
        messages = [dict(message) for message in history if message.get("role") in {"user", "assistant"} and message.get("content")]
        messages.append({"role": "user", "content": text})
        return self._bounded(messages)

    def _bounded(self, history: list[dict[str, str]]) -> list[dict[str, str]]:
        return bounded_history(history, max_messages=self._history_max_messages, max_bytes=self._history_max_bytes)

    def _validate_reply(self, text: str) -> str:
        if len(text) > self._history_max_bytes or len(text.encode("utf-8")) > self._history_max_bytes:
            raise ValueError("Conversation reply exceeds byte limit")
        if not text.strip():
            raise RuntimeError("PSFN completion returned no text")
        return text.strip()

    async def _get_history(self, conversation_id: str) -> list[dict[str, str]]:
        async with self._history_lock:
            session = self._history_cache.get(conversation_id)
            history = session.history if session is not None else []
            return [dict(message) for message in history]

    async def _set_history(self, conversation_id: str, history: list[dict[str, str]]) -> None:
        async with self._history_lock:
            self._history_cache.set_history(conversation_id, history)

    async def _complete(
        self,
        *,
        messages: list[dict[str, str]],
        conversation_id: str,
        stream: bool,
    ) -> str:
        satellite_claim = self._build_satellite_claim(conversation_id)
        payload = self._build_payload(
            messages=messages,
            conversation_id=conversation_id,
            stream=stream,
            satellite_claim=satellite_claim,
        )
        body = await bounded_request(
            self._client, "POST",
            "/chat/completions",
            max_bytes=self._provider_response_bytes,
            timeout_seconds=self._provider_timeout_seconds,
            json=payload,
            headers=self._build_request_headers(conversation_id, satellite_claim=satellite_claim),
        )
        data = decode_json(body)
        return _extract_completion_text(data)

    async def _stream_completion(
        self,
        *,
        messages: list[dict[str, str]],
        conversation_id: str,
    ) -> AsyncIterator[str]:
        satellite_claim = self._build_satellite_claim(conversation_id)
        payload = self._build_payload(
            messages=messages,
            conversation_id=conversation_id,
            stream=True,
            satellite_claim=satellite_claim,
        )
        async with asyncio.timeout(self._provider_timeout_seconds), self._client.stream(
            "POST",
            "/chat/completions",
            json=payload,
            headers={**self._build_request_headers(conversation_id, satellite_claim=satellite_claim), "Accept-Encoding": "identity"},
        ) as response:
            if response.status_code >= 400:
                raise RuntimeError(_format_http_error(response))
            async for line in bounded_lines(response, max_bytes=self._provider_response_bytes, max_line_bytes=self._provider_line_bytes):
                if not line:
                    continue
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                if data == "[DONE]":
                    return
                delta = _extract_delta_text(data)
                if delta:
                    yield delta

    def _build_payload(
        self,
        *,
        messages: list[dict[str, str]],
        conversation_id: str,
        stream: bool,
        satellite_claim: dict[str, object],
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "model": self._model_name,
            "messages": messages,
            "stream": stream,
            "system_prompt_mode": "default",
            "response_style": "concise",
            "satellite_claim": satellite_claim,
        }
        if self._device_assertion_issuer is None:
            payload["user"] = conversation_id
            if self._provider_name:
                payload["provider"] = self._provider_name
        return payload

    def _build_satellite_claim(self, conversation_id: str) -> dict[str, object]:
        channel_id = self._derive_channel_id(conversation_id)
        return build_satellite_claim_envelope(
            config=self._claim_config,
            conversation_id=conversation_id,
            session_id=conversation_id,
            channel_id=channel_id,
            api_key=self._request_headers.get("Authorization"),
        )

    def _build_request_headers(self, conversation_id: str, *, satellite_claim: dict[str, object]) -> dict[str, str]:
        headers = dict(self._request_headers)
        channel_id = self._derive_channel_id(conversation_id)
        if channel_id:
            headers["X-PSFN-Channel-Type"] = self._claim_config.channel_type
            headers["X-PSFN-Channel-ID"] = channel_id
            headers["X-PSFN-Satellite-ID"] = self._claim_config.satellite_id
            headers["X-PSFN-Satellite-Name"] = self._claim_config.display_name
            headers.update(
                build_satellite_registry_headers(
                    config=self._claim_config,
                    satellite_claim=satellite_claim,
                ),
            )
            headers["X-PSFN-Satellite-Claim"] = json.dumps(satellite_claim, separators=(",", ":"))
            headers["X-PSFN-Channel-Metadata"] = json.dumps(
                {
                    "sessionId": conversation_id,
                    "sourceSatelliteId": self._claim_config.satellite_id,
                    "sourceSatelliteName": self._claim_config.display_name,
                    "satelliteClaim": satellite_claim,
                },
                separators=(",", ":"),
            )
            if self._author_id and self._author_name:
                headers["X-PSFN-Author-ID"] = self._author_id
                headers["X-PSFN-Author-Name"] = self._author_name
        return self._with_device_assertion(headers, conversation_id)

    def _with_device_assertion(self, headers: dict[str, str], conversation_id: str) -> dict[str, str]:
        result = dict(headers)
        if self._device_assertion_issuer is not None:
            result["X-PSFN-Hub-Device-Assertion"] = self._device_assertion_issuer.issue(conversation_id)
        return result

    def _derive_channel_id(self, conversation_id: str) -> str | None:
        normalized = conversation_id.strip()
        if not normalized:
            return None
        return derive_channel_id(self._claim_config.channel_type, normalized)


def _extract_completion_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return ""
    message = first_choice.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
    delta = first_choice.get("delta")
    if isinstance(delta, dict):
        content = delta.get("content")
        if isinstance(content, str):
            return content
    text = first_choice.get("text")
    if isinstance(text, str):
        return text
    return ""


def _extract_delta_text(data: str) -> str:
    try:
        payload = json.loads(data)
    except json.JSONDecodeError:
        _LOGGER.debug("Ignoring non-JSON PSFN stream payload")
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first_choice = choices[0]
    if not isinstance(first_choice, dict):
        return ""
    delta = first_choice.get("delta")
    if isinstance(delta, dict):
        content = delta.get("content")
        if isinstance(content, str):
            return content
        role = delta.get("role")
        if isinstance(role, str):
            return ""
    message = first_choice.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content
    text = first_choice.get("text")
    if isinstance(text, str):
        return text
    return ""


def _format_http_error(response: httpx.Response, *, body: bytes | None = None) -> str:
    return f"PSFN chat completion failed ({response.status_code})"
