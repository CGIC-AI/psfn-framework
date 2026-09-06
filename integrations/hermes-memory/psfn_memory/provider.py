"""Automatic recall and completed root chat delivery through Hermes's MCP registry."""

import contextvars
import json
import logging
import threading

from agent.memory_provider import MemoryProvider

from .config import Config
from .outbox import Outbox

logger = logging.getLogger(__name__)


def _dispatch(name: str, args: dict):
    from tools.registry import registry
    return registry.dispatch(name, args)


def _decode_result(raw) -> dict:
    envelope = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(envelope, dict) or "error" in envelope:
        raise RuntimeError("PSFN MCP call failed; check the Hermes MCP connection")
    result = envelope.get("result")
    result = json.loads(result) if isinstance(result, str) else result
    if not isinstance(result, dict) or "error" in result:
        raise RuntimeError("PSFN MCP returned an invalid result")
    return result


class PSFNMemoryProvider(MemoryProvider):
    def __init__(self):
        self._state_lock = threading.RLock()
        self._wake = threading.Event()
        self._worker = None
        self._closing = False
        self._active = False
        self._session_id = ""
        self._status_callback = None

    @property
    def name(self) -> str:
        return "psfn"

    def is_available(self) -> bool:
        from hermes_constants import get_hermes_home
        try:
            Config.load(get_hermes_home())
        except (OSError, ValueError, TypeError):
            return False
        return True

    def unavailable_reason(self) -> str:
        return "Configure psfn-memory.json in the active Hermes profile; see the PSFN provider README."

    def initialize(self, session_id: str, **kwargs) -> None:
        config = Config.load(kwargs["hermes_home"])
        with self._state_lock:
            if self._worker is not None:
                raise RuntimeError("PSFN provider already initialized")
            self._config = config
            self._session_id = session_id
            self._status_callback = kwargs.get("warning_callback")
            if kwargs.get("platform", "cli") not in config.platforms:
                logger.info("PSFN memory delivery disabled for nonselected platform")
                return
            self._outbox = Outbox(kwargs["hermes_home"], body_id=config.body_id, companion_id=config.companion_id)
            context = contextvars.copy_context()
            self._worker = threading.Thread(target=context.run, args=(self._run_worker,), name="psfn-memory-delivery", daemon=True)
            self._worker.start()
            self._active = True
            self._wake.set()

    def get_tool_schemas(self) -> list[dict]:
        # The configured MCP server already exposes memory tools.
        return []

    def get_config_schema(self) -> list[dict]:
        return [
            {"key": "body_id", "description": "Expected PSFN external body ID (receipt assertion)", "required": True},
            {"key": "companion_id", "description": "Expected PSFN companion UUID (receipt assertion)", "required": True},
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        Config.parse(values).save(hermes_home)

    def _call(self, operation: str, args: dict) -> dict:
        return _decode_result(_dispatch(f"mcp__{self._config.mcp_server}__psfn_memory_{operation}", args))

    def _warn(self, message: str) -> None:
        logger.warning(message)
        if callable(self._status_callback):
            try:
                self._status_callback(message)
            except Exception:
                logger.exception("PSFN memory warning callback failed")

    def _session(self, session_id: str) -> str:
        with self._state_lock:
            current = session_id or self._session_id
        if not isinstance(current, str) or not current.strip():
            raise ValueError("PSFN memory requires a nonempty Hermes session ID")
        return current

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._active:
            return ""
        self._wake.set()
        try:
            result = self._call("context", {"sessionId": self._session(session_id), "query": query})
            if set(result) != {"context"} or not isinstance(result["context"], str):
                raise ValueError("Invalid PSFN memory context response")
            return result["context"]
        except Exception:
            self._warn("PSFN memory recall unavailable; this turn has no fresh PSFN memory context.")
            raise

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "", messages=None) -> None:
        if not self._active:
            return
        if not all(isinstance(text, str) and text.strip() for text in (user_content, assistant_content)):
            self._warn("PSFN memory skipped an empty user/assistant exchange.")
            return
        session = self._session(session_id)
        # A persisted root user row identifies repeated callbacks without collapsing
        # distinct turns that happen to contain identical text. Never ingest this list.
        source_key = None
        for message in reversed(messages or []):
            if isinstance(message, dict) and message.get("role") == "user":
                row_id = message.get("_row_id")
                if type(row_id) is int and row_id > 0 and not message.get("_compressed_summary"):
                    source_key = json.dumps([session, row_id])
                break
        with self._state_lock:
            if self._closing:
                raise RuntimeError("PSFN provider is shutting down; turn was not queued")
            self._outbox.enqueue(session, user_content, assistant_content, source_key=source_key)
            self._wake.set()

    def on_session_switch(self, new_session_id: str, **kwargs) -> None:
        if not isinstance(new_session_id, str) or not new_session_id.strip():
            raise ValueError("Invalid Hermes session ID")
        with self._state_lock:
            self._session_id = new_session_id
        # Queued turns retain the session supplied when captured, including on rewind.
        self._wake.set()

    def _validate_receipt(self, result: dict, event: dict) -> dict:
        receipt = result.get("receipt")
        expected = {
            "bodyId": self._config.body_id, "companionId": self._config.companion_id,
            "sessionId": event["sessionId"], "eventId": event["eventId"], "status": "accepted",
        }
        if (
            set(result) != {"receipt"}
            or not isinstance(receipt, dict)
            or set(receipt) != set(expected) | {"receiptId"}
            or any(receipt.get(key) != value for key, value in expected.items())
            or not isinstance(receipt.get("receiptId"), str)
            or not receipt["receiptId"].strip()
        ):
            raise ValueError("PSFN ingestion receipt did not match the queued event and configured identity")
        return receipt

    def _run_worker(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            try:
                events = self._outbox.pending(self._config.retry_batch_size)
                for event in events:
                    receipt = self._validate_receipt(self._call("ingest", event), event)
                    self._outbox.acknowledge(event["eventId"], receipt)
                if self._outbox.pending_count():
                    self._wake.set()
                elif self._closing:
                    return
            except Exception:
                self._warn("PSFN memory delivery pending; completed chat remains in the local retry queue.")
                if self._closing:
                    return

    def shutdown(self) -> None:
        with self._state_lock:
            self._closing = True
            worker = self._worker
            self._wake.set()
        if worker is not None:
            worker.join(timeout=self._config.shutdown_timeout_seconds)
            if worker.is_alive() or self._outbox.pending_count():
                self._warn("PSFN memory shutdown left pending delivery; restart this profile to retry.")
