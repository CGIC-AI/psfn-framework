#!/usr/bin/env bash
# bus-session-start.sh: a Claude Code SessionStart hook that surfaces the project's
# recent agent bus runs at the start of a session.
#
# If the project has a runs directory containing run files, the hook writes a JSON
# object on stdout whose additionalContext lists up to the five most recently
# modified runs, each with its last message timestamp, its distinct agent count and
# its message count. If there is no runs directory, or it holds no readable run
# files, the hook writes nothing and exits 0.
#
# The runs directory is $AGENTBUS_DIR when set, otherwise <project>/bus/runs, where
# <project> is the cwd reported by Claude Code on stdin, falling back to the working
# directory of the hook process.
#
# The hook only reads. It never writes to a run file and never fails a session: any
# unexpected condition results in silence and exit 0.
#
# Contract references (verified against the official documentation, 2026-08-02):
#   stdin fields session_id, transcript_path, cwd, hook_event_name, source, and the
#   hookSpecificOutput / hookEventName / additionalContext output shape:
#     https://code.claude.com/docs/en/hooks.md
#   exit 0 with empty stdout adds nothing to context:
#     https://code.claude.com/docs/en/hooks-guide.md

set -u

hook_input="$(cat 2>/dev/null || true)"

command -v python3 >/dev/null 2>&1 || exit 0

BUS_HOOK_INPUT="$hook_input" python3 <<'PY' 2>/dev/null || exit 0
import json
import os
import sys
from pathlib import Path

MAX_RUNS = 5

raw = os.environ.get("BUS_HOOK_INPUT", "")
cwd = ""
try:
    payload = json.loads(raw)
    if isinstance(payload, dict) and isinstance(payload.get("cwd"), str):
        cwd = payload["cwd"]
except ValueError:
    pass

project = Path(cwd) if cwd else Path.cwd()
env_dir = os.environ.get("AGENTBUS_DIR", "").strip()
runs = Path(env_dir) if env_dir else project / "bus" / "runs"

if not runs.is_dir():
    sys.exit(0)

candidates = [p for p in runs.glob("*.jsonl") if not p.name.endswith(".vec.jsonl")]
try:
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
except OSError:
    sys.exit(0)

rows = []
for path in candidates[:MAX_RUNS]:
    agents, messages, last_ts = set(), 0, None
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(msg, dict):
                    continue
                messages += 1
                agent = msg.get("agent")
                if isinstance(agent, str) and agent.strip():
                    agents.add(agent)
                ts = msg.get("ts")
                if isinstance(ts, str) and ts.strip():
                    last_ts = ts
    except OSError:
        continue
    rows.append((path.name, last_ts, len(agents), messages))

if not rows:
    sys.exit(0)

report = [f"Agent bus runs in {runs} (most recently modified first):"]
for name, last_ts, n_agents, messages in rows:
    report.append(f"  {name}"
                  f"  last message: {last_ts or 'unknown'}"
                  f"  agents: {n_agents}"
                  f"  messages: {messages}")
report.append("Read a run file before appending to it, and append as you work. "
              "The `bus` skill holds the practice.")

print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "\n".join(report),
}}))
PY
