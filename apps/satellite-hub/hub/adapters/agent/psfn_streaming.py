from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any, Literal

import httpx

from hub.adapters.interfaces import AgentReply
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
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 60.0,
    ) -> None:
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
        self._history_by_conversation: dict[str, list[dict[str, str]]] = {}
        self._history_lock = asyncio.Lock()

    async def reply(
        self,
        *,
        text: str,
        conversation_id: str,
        history: list[dict[str, str]],
    ) -> AgentReply:
        normalized_history = _normalize_history(history)
        messages = self._build_messages(history=normalized_history, text=text)
        response_text = await self._complete(messages=messages, conversation_id=conversation_id, stream=False)
        final_text = response_text.strip() or "I don't have a response yet."
        updated_history = [*normalized_history, {"role": "user", "content": text}, {"role": "assistant", "content": final_text}]
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
        completed = False
        try:
            async for delta in self._stream_completion(messages=messages, conversation_id=conversation_id):
                response_text += delta
                yield delta
            completed = True
        finally:
            if completed:
                final_text = response_text.strip() or "I don't have a response yet."
                updated_history = [*prior_history, {"role": "user", "content": text}, {"role": "assistant", "content": final_text}]
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
        response = await self._client.post(
            "/companion/stimuli",
            json=payload,
            headers=self._request_headers,
        )
        if response.status_code >= 400:
            raise RuntimeError(_format_http_error(response))
        data = response.json()
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
        messages = [dict(message) for message in history if message.get("role") in {"user", "assistant"} and message.get("content")]
        messages.append({"role": "user", "content": text})
        return messages

    async def _get_history(self, conversation_id: str) -> list[dict[str, str]]:
        async with self._history_lock:
            history = self._history_by_conversation.get(conversation_id, [])
            return [dict(message) for message in history]

    async def _set_history(self, conversation_id: str, history: list[dict[str, str]]) -> None:
        async with self._history_lock:
            self._history_by_conversation[conversation_id] = [dict(message) for message in history]

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
        response = await self._client.post(
            "/chat/completions",
            json=payload,
            headers=self._build_request_headers(conversation_id, satellite_claim=satellite_claim),
        )
        if response.status_code >= 400:
            raise RuntimeError(_format_http_error(response))
        data = response.json()
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
        async with self._client.stream(
            "POST",
            "/chat/completions",
            json=payload,
            headers=self._build_request_headers(conversation_id, satellite_claim=satellite_claim),
        ) as response:
            if response.status_code >= 400:
                body = await response.aread()
                raise RuntimeError(_format_http_error(response, body=body))
            async for line in response.aiter_lines():
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
            "user": conversation_id,
            "satellite_claim": satellite_claim,
        }
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
        return headers

    def _derive_channel_id(self, conversation_id: str) -> str | None:
        normalized = conversation_id.strip()
        if not normalized:
            return None
        return derive_channel_id(self._claim_config.channel_type, normalized)


def _normalize_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    for message in history:
        role = str(message.get("role") or "").strip()
        content = str(message.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        normalized.append({"role": role, "content": content})
    return normalized


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
        _LOGGER.debug("Ignoring non-JSON PSFN stream payload: %s", data)
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
    detail = ""
    if body:
        detail = body.decode("utf-8", errors="replace").strip()
    if not detail:
        try:
            detail = response.text.strip()
        except Exception:
            detail = ""
    if detail:
        return f"PSFN chat completion failed ({response.status_code}): {detail}"
    return f"PSFN chat completion failed ({response.status_code})"
