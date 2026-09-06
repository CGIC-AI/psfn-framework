"""No-network tests using the actual Hermes MemoryProvider ABC on PYTHONPATH."""

import contextvars
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from agent.memory_provider import MemoryProvider
from psfn_memory import PSFNMemoryProvider, register
from psfn_memory.config import Config
from psfn_memory.outbox import Outbox
from psfn_memory.provider import _decode_result

COMPANION_ID = "00000000-0000-4000-8000-000000000001"
BODY_ID = "example-hermes"


def receipt(args):
    return {
        "receiptId": "example-receipt-" + args["eventId"],
        "bodyId": BODY_ID, "companionId": COMPANION_ID,
        "sessionId": args["sessionId"], "eventId": args["eventId"], "status": "accepted",
    }


def envelope(result):
    # The actual MCP registry handler wraps text content in a JSON result string.
    return json.dumps({"result": json.dumps(result)})


def wait_for(predicate):
    deadline = time.monotonic() + 3
    tick = threading.Event()
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Background memory delivery did not reach expected state")
        tick.wait(0.01)


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def open(self):
        return Outbox(self.temp.name, body_id=BODY_ID, companion_id=COMPANION_ID)

    def test_restart_replays_identical_event_and_deduplicates_persisted_source(self):
        box = self.open()
        event_id = box.enqueue("s1", "human", "assistant", source_key="s1:42")
        event = box.pending(1)[0]
        restarted = self.open()
        self.assertEqual(restarted.pending(1), [event])
        self.assertEqual(restarted.enqueue("s1", "human", "assistant", source_key="s1:42"), event_id)
        with self.assertRaises(ValueError):
            restarted.enqueue("s1", "changed", "assistant", source_key="s1:42")
        restarted.acknowledge(event_id, receipt(event))
        self.assertEqual(restarted.pending_count(), 0)
        with restarted._connect() as db:
            row = db.execute("SELECT payload,receipt FROM events").fetchone()
            self.assertIsNone(row[0])
            self.assertEqual(json.loads(row[1])["eventId"], event_id)
        self.assertEqual(restarted.enqueue("s1", "human", "assistant", source_key="s1:42"), event_id)
        self.assertEqual(restarted.pending_count(), 0)

    def test_identical_words_in_distinct_turns_are_preserved(self):
        box = self.open()
        first = box.enqueue("s1", "yes", "okay")
        second = box.enqueue("s1", "yes", "okay")
        self.assertNotEqual(first, second)
        self.assertEqual(box.pending_count(), 2)

    def test_concurrent_duplicate_capture_and_profile_binding(self):
        box = self.open()
        with ThreadPoolExecutor(max_workers=8) as pool:
            ids = list(pool.map(lambda _: box.enqueue("s1", "u", "a", source_key="s1:9"), range(20)))
        self.assertEqual(len(set(ids)), 1)
        with self.assertRaises(ValueError):
            Outbox(self.temp.name, body_id="other-body", companion_id=COMPANION_ID)
        self.assertEqual(box.path.stat().st_mode & 0o777, 0o600)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        Config(BODY_ID, COMPANION_ID).save(self.temp.name)
        self.calls = []
        self.offline = False
        self.bad_receipt = None
        self.attempted = threading.Event()
        self.warnings = []
        self.patch = patch("psfn_memory.provider._dispatch", side_effect=self.dispatch)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.providers = []
        self.addCleanup(lambda: [p.shutdown() for p in self.providers])

    def dispatch(self, name, args):
        self.calls.append((name, dict(args)))
        self.attempted.set()
        if self.offline:
            return json.dumps({"error": "offline"})
        if name.endswith("_context"):
            return envelope({"context": "Prior preference: short progress updates."})
        result = receipt(args)
        if self.bad_receipt:
            result.update(self.bad_receipt)
        return envelope({"receipt": result})

    def start(self, *, platform="cli", session="old-session"):
        provider = PSFNMemoryProvider()
        provider.initialize(session, hermes_home=self.temp.name, platform=platform,
                            warning_callback=self.warnings.append)
        self.providers.append(provider)
        return provider

    def test_real_abc_entrypoint_and_recall(self):
        class Context:
            def register_memory_provider(inner, provider):
                self.assertIsInstance(provider, MemoryProvider)
                self.assertEqual(provider.name, "psfn")
        register(Context())
        provider = self.start()
        self.assertEqual(provider.get_tool_schemas(), [])
        self.assertIn("short progress", provider.prefetch("progress", session_id="thread-2"))
        self.assertEqual(self.calls[-1], ("mcp__psfn__psfn_memory_context", {"sessionId": "thread-2", "query": "progress"}))

    def test_only_supplied_completed_pair_is_sent_and_callback_deduplicates(self):
        provider = self.start()
        messages = [
            {"role": "system", "content": "not chat"},
            {"role": "user", "content": "injected prompt", "_row_id": 5},
            {"role": "assistant", "content": "intermediate", "tool_calls": [{"name": "delegate"}]},
            {"role": "tool", "content": "subagent private output"},
            {"role": "assistant", "content": "final", "_row_id": 8},
        ]
        provider.sync_turn("clean human", "clean final", session_id="root", messages=messages)
        wait_for(lambda: provider._outbox.pending_count() == 0 and self.calls)
        provider.sync_turn("clean human", "clean final", session_id="root", messages=messages)
        provider.shutdown()
        self.assertEqual(len(self.calls), 1)
        name, args = self.calls[0]
        self.assertEqual(name, "mcp__psfn__psfn_memory_ingest")
        self.assertEqual(set(args), {"sessionId", "eventId", "user", "assistant", "occurredAt"})
        self.assertEqual((args["user"], args["assistant"]), ("clean human", "clean final"))
        self.assertIs(type(args["occurredAt"]), int)

    def test_failure_survives_restart_with_same_event(self):
        self.offline = True
        provider = self.start()
        provider.sync_turn("user", "assistant", session_id="s1")
        self.assertTrue(self.attempted.wait(3))
        provider.shutdown()
        original = provider._outbox.pending(1)[0]
        self.offline = False
        restarted = self.start(session="different-session")
        wait_for(lambda: restarted._outbox.pending_count() == 0)
        self.assertEqual(self.calls[-1][1], original)
        self.assertTrue(self.warnings)

    def test_idle_timer_recovers_first_failed_delivery_without_another_signal(self):
        interval = 0.05
        Config(BODY_ID, COMPANION_ID, retry_interval_seconds=interval).save(self.temp.name)
        box = Outbox(self.temp.name, body_id=BODY_ID, companion_id=COMPANION_ID)
        box.enqueue("finished-session", "last human turn", "last assistant reply")
        original = box.pending(1)[0]
        attempts = []

        def fail_once_then_accept(name, args):
            attempts.append((time.monotonic(), dict(args)))
            if len(attempts) == 1:
                return json.dumps({"error": "Connection offline"})
            return envelope({"receipt": receipt(args)})

        with patch("psfn_memory.provider._dispatch", side_effect=fail_once_then_accept):
            provider = self.start()
            # No sync_turn, prefetch, session change, or explicit wake follows.
            wait_for(lambda: box.pending_count() == 0)
            provider.shutdown()
        self.assertEqual([args for _, args in attempts], [original, original])
        self.assertGreaterEqual(attempts[1][0] - attempts[0][0], interval)

    def test_failure_warnings_classify_remote_errors_without_echoing_secrets(self):
        provider = self.start()
        cases = [
            ("401 Unauthorized Authorization: Bearer secret-sentinel", "authentication"),
            ("403 forbidden private-chat-sentinel", "access denied"),
            ("invalid external memory arguments private-chat-sentinel", "validation"),
        ]
        for remote_error, diagnostic in cases:
            with patch("psfn_memory.provider._dispatch", return_value=json.dumps({"error": remote_error})):
                with self.assertRaises(RuntimeError):
                    provider.prefetch("query")
            warning = self.warnings[-1]
            self.assertIn("MCPCallError", warning)
            self.assertIn(diagnostic, warning)
            self.assertNotIn("secret-sentinel", warning)
            self.assertNotIn("private-chat-sentinel", warning)

    def test_wrong_receipt_never_clears_payload(self):
        provider = self.start()
        for change in [
            {"bodyId": "wrong"}, {"companionId": "wrong"}, {"sessionId": "wrong"},
            {"eventId": "wrong"}, {"status": "completed"}, {"receiptId": ""},
        ]:
            event = {"sessionId": "s1", "eventId": "event"}
            with self.assertRaises(ValueError):
                provider._validate_receipt({"receipt": {**receipt(event), **change}}, event)
        self.bad_receipt = {"bodyId": "wrong"}
        provider.sync_turn("u", "a", session_id="s1")
        self.assertTrue(self.attempted.wait(3))
        provider.shutdown()
        self.assertEqual(provider._outbox.pending_count(), 1)

    def test_switch_and_concurrent_sessions_preserve_capture_attribution(self):
        self.offline = True
        provider = self.start()
        provider.sync_turn("old", "answer")
        provider.on_session_switch("new", parent_session_id="old-session", reset=True)
        provider.sync_turn("new", "answer")
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda n: provider.sync_turn(str(n), "a", session_id=f"parallel-{n}"), range(12)))
        provider.shutdown()
        events = provider._outbox.pending(20)
        self.assertEqual(events[0]["sessionId"], "old-session")
        self.assertEqual(events[1]["sessionId"], "new")
        self.assertEqual({e["sessionId"] for e in events[2:]}, {f"parallel-{n}" for n in range(12)})

    def test_interactive_platform_policy_and_empty_turns(self):
        child = self.start(platform="subagent")
        child.sync_turn("task", "result")
        self.assertEqual(child.prefetch("task"), "")
        provider = self.start()
        provider.sync_turn("", "answer")
        provider.sync_turn("question", " ")
        provider.shutdown()
        self.assertEqual(provider._outbox.pending_count(), 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.warnings), 2)

    def test_recall_failure_is_visible_and_pending_delivery_retries(self):
        self.offline = True
        provider = self.start()
        provider.sync_turn("u", "a")
        self.assertTrue(self.attempted.wait(3))
        with self.assertRaises(RuntimeError):
            provider.prefetch("recall")
        self.assertTrue(any("recall unavailable" in w for w in self.warnings))
        self.offline = False
        provider.prefetch("retry")
        wait_for(lambda: provider._outbox.pending_count() == 0)

    def test_worker_carries_profile_context(self):
        profile = contextvars.ContextVar("test_profile", default="wrong")
        seen = []
        token = profile.set("active-profile")
        self.addCleanup(lambda: profile.reset(token))
        with patch("psfn_memory.provider._dispatch", side_effect=lambda name, args: (
            seen.append(profile.get()) or envelope({"receipt": receipt(args)})
        )):
            provider = self.start()
            provider.sync_turn("u", "a")
            wait_for(lambda: provider._outbox.pending_count() == 0 and seen)
            provider.shutdown()
        self.assertEqual(seen, ["active-profile"])

    def test_bad_warning_callback_does_not_kill_delivery_worker(self):
        provider = self.start()
        provider._status_callback = lambda _: (_ for _ in ()).throw(RuntimeError("broken UI"))
        with self.assertLogs("psfn_memory.provider", level="WARNING") as captured:
            provider._warn("pending")
        self.assertTrue(any("warning callback failed" in message for message in captured.output))
        provider.sync_turn("u", "a")
        wait_for(lambda: provider._outbox.pending_count() == 0 and self.calls)


class ResultTests(unittest.TestCase):
    def test_actual_mcp_result_shapes_and_errors(self):
        self.assertEqual(_decode_result({"result": {"context": "hi"}}), {"context": "hi"})
        self.assertEqual(_decode_result(envelope({"context": "hi"})), {"context": "hi"})
        for result in [{"error": "failed"}, {"result": "not json"}, {"result": {"error": "failed"}}, [], {"context": "raw"}]:
            with self.assertRaises((RuntimeError, ValueError)):
                _decode_result(result)

    def test_config_rejects_unknown_authority_and_bad_values(self):
        for values in [
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "token": "no"},
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "platforms": ["subagent"]},
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "retry_batch_size": True},
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "shutdown_timeout_seconds": float("nan")},
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "retry_interval_seconds": 0},
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "retry_interval_seconds": True},
            {"body_id": BODY_ID, "companion_id": COMPANION_ID, "retry_interval_seconds": float("inf")},
        ]:
            with self.assertRaises(ValueError):
                Config.parse(values)


if __name__ == "__main__":
    unittest.main()
