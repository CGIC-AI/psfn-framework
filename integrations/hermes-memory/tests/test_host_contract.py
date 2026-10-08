"""Startup and dispatch against the pinned Hermes source; no model/MCP network."""

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from psfn_memory.config import Config
from test_provider import BODY_ID, COMPANION_ID, receipt, wait_for


class HermesHostContractTests(unittest.TestCase):
    def test_native_profile_plugin_discovery_without_virtualenv_entrypoint(self):
        from utils import fast_safe_load
        from plugins.memory import find_provider_dir, load_memory_provider
        source = Path(__file__).resolve().parents[1] / "psfn_memory"
        manifest = fast_safe_load((source / "plugin.yaml").read_text())
        self.assertEqual(manifest["name"], "psfn")
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HERMES_HOME": directory}):
            target = Path(directory) / "plugins" / manifest["name"]
            shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__"))
            with patch("plugins.memory._iter_entry_points", return_value=[]):
                self.assertEqual(find_provider_dir("psfn"), target)
                provider = load_memory_provider("psfn")
                self.assertIsNotNone(provider)
                self.assertEqual(provider.name, "psfn")

    def test_real_startup_with_builtin_stores_disabled_and_registry_dispatch(self):
        self._exercise_startup("cli")

    def test_desktop_startup_loads_native_provider_and_delivers_completed_turn(self):
        self._exercise_startup("desktop")

    def test_telegram_gateway_identity_reaches_recall_and_completed_turn(self):
        self._exercise_startup("telegram")

    def _exercise_startup(self, platform):
        from tools.registry import registry
        from tools.mcp_tool_handlers import _render_call_tool_result

        calls = []
        names = ["mcp__psfn__psfn_memory_context", "mcp__psfn__psfn_memory_ingest"]

        def handler(args):
            calls.append(dict(args))
            value = {"context": "Relevant PSFN memory"} if "query" in args else {"receipt": receipt(args)}
            # Use Hermes's real MCP result renderer and registry, with a local
            # transport result so this test never opens a server connection.
            return _render_call_tool_result(SimpleNamespace(
                content=[SimpleNamespace(type="text", text=json.dumps(value))],
                isError=False, structuredContent=value,
            ), "psfn")

        for name in names:
            registry.register(name, "mcp_psfn", {"name": name, "description": "test", "parameters": {"type": "object"}}, handler)
            self.addCleanup(registry.deregister, name)
        cfg = {"memory": {"provider": "psfn", "memory_enabled": False, "user_profile_enabled": False}, "agent": {}}
        # Newer Hermes redirects tempfile.tempdir into its home during startup.
        # Restore it before the temporary profile is removed.
        with tempfile.TemporaryDirectory() as directory, patch.object(tempfile, "tempdir", tempfile.gettempdir()):
            Config(BODY_ID, COMPANION_ID, platforms=("cli", "desktop", "telegram")).save(directory)
            shutil.copytree(Path(__file__).resolve().parents[1] / "psfn_memory",
                            Path(directory) / "plugins" / "psfn",
                            ignore=shutil.ignore_patterns("__pycache__"))
            with (
                patch.dict(os.environ, {"HERMES_HOME": directory}),
                patch("socket.socket.connect", side_effect=AssertionError("Network is forbidden in provider contract tests")),
                patch("hermes_cli.config.load_config", return_value=cfg),
                patch("hermes_cli.config.load_config_readonly", return_value=cfg),
                patch("plugins.memory._iter_entry_points", return_value=[]),
                patch("agent.model_metadata.get_model_context_length", return_value=204_800),
                patch("model_tools.get_tool_definitions", return_value=[{
                    "type": "function", "function": {"name": name, "description": "test", "parameters": {"type": "object"}},
                } for name in names]),
                patch("model_tools.check_toolset_requirements", return_value={}),
                patch("agent.process_bootstrap.OpenAI"),
                patch("agent.agent_init._setup_logging"),
            ):
                from run_agent import AIAgent
                agent = AIAgent(
                    api_key="test-key-not-a-credential", base_url="https://llm.example.com/v1",
                    quiet_mode=True, skip_context_files=True, skip_memory=False,
                    disabled_toolsets=["memory"], session_id="root-session", platform=platform,
                    **({"user_id": "12345", "chat_id": "12345", "chat_type": "dm"}
                       if platform == "telegram" else {}),
                )
                try:
                    self.assertIsNone(agent._memory_store)
                    provider = agent._memory_manager.get_provider("psfn")
                    self.assertIsNotNone(provider)
                    self.assertEqual(agent.valid_tool_names, set(names))
                    self.assertEqual(agent._memory_manager.prefetch_all("remember", session_id="root-session"), "Relevant PSFN memory")
                    agent._sync_external_memory_for_turn(
                        original_user_message="human chat", final_response="final answer", interrupted=False,
                    )
                    self.assertTrue(agent._memory_manager.flush_pending(timeout=3))
                    wait_for(lambda: len(calls) == 2 and provider._outbox.pending_count() == 0)
                    self.assertEqual(calls[1]["sessionId"], "root-session")
                    self.assertEqual(calls[1]["user"], "human chat")
                    if platform == "telegram":
                        source = {"platform": "telegram", "userId": "12345", "chatId": "12345", "chatType": "dm"}
                        self.assertEqual(calls[0]["source"], source)
                        self.assertEqual(calls[1]["source"], source)
                    agent._sync_external_memory_for_turn(
                        original_user_message="interrupted", final_response="partial", interrupted=True,
                    )
                    self.assertEqual(len(calls), 2)
                finally:
                    agent.close()


if __name__ == "__main__":
    unittest.main()
