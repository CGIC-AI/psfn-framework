# PSFN memory for Hermes

Run a companion in Hermes while PSFN keeps its long-term memory. This provider
recalls PSFN context before a turn and submits each completed human/assistant
exchange to the gateway's memory MCP server. The gateway forwards directly to
the companion's core memory service; it does not run a PSFN conversation turn.
PSFN accepts the raw exchange durably and processes its normal memory lifecycle.

Compatibility is pinned to Hermes commit
`5bd439d3ed4ae5f099857813383389dcd0ab4369` (Python 3.11–3.13). The adapter uses
Hermes's existing MCP registry and adds no runtime dependencies. This is an
internal Hermes interface, so check the included tests before upgrading Hermes.

## Installation

Install this package into the Python environment of that exact Hermes checkout:

```sh
# From integrations/hermes-memory, with the Hermes environment active:
python -m pip install .
```

The package registers the `psfn` entry point in `hermes_agent.memory_providers`;
no files need to be copied into Hermes's source tree. The build backend is
exactly pinned in `pyproject.toml`. Select a dedicated Hermes profile for each
companion/body binding. Keep that companion's persona in its existing
`$HERMES_HOME/SOUL.md`; this adapter does not synchronize personas.

The operator must enable `api.externalMemory.bindings` in the gateway's external
`channels.json`, using a dedicated bearer token bound to one body, companion and
known contact. The server configuration and credential stay outside this public
repository. A body token is not a core-agent connection credential.

## Profile configuration

Set the following in the active profile's `config.yaml`. The address is invented;
substitute the actual gateway address and keep TLS verification enabled.

```yaml
memory:
  provider: psfn
  memory_enabled: false
  user_profile_enabled: false

mcp_servers:
  psfn:
    url: https://memory.example.com/v1/memory/mcp
    headers:
      Authorization: Bearer ${HERMES_MEMORY_TOKEN}
    timeout: 5
    tools:
      include:
        - psfn_memory_context
        - psfn_memory_search
        - psfn_memory_get
        - psfn_memory_remember
        - psfn_memory_ingest
      resources: false
      prompts: false
```

Hermes resolves `${HERMES_MEMORY_TOKEN}` from its environment. Supply the token
using the profile's normal secret setup; never commit it. Keep the `psfn` MCP
toolset selected if restricting Hermes toolsets. The provider exposes no duplicate
tool schemas. Disabling the built-in `memory` toolset does not disable its
lifecycle callbacks or the separately configured MCP tools.

Create `$HERMES_HOME/psfn-memory.json`, or use `hermes memory setup`:

```json
{
  "body_id": "example-hermes",
  "companion_id": "00000000-0000-4000-8000-000000000001"
}
```

These are expected receipt identities, not authority supplied to the server. They
must match the gateway credential binding. Optional fields are `mcp_server`
(default `psfn`), `platforms` (default `["cli"]`), `retry_batch_size` (20), and
`shutdown_timeout_seconds` (5). Add only the interactive platforms you intend to
use; `subagent`, `cron`, `tool`, and `flush` are rejected. The network timeout
belongs to the MCP connection; keep recall calls within Hermes's outer eight
second prefetch limit.

## Delivery and scope

The adapter persists completed exchanges under
`$HERMES_HOME/psfn-memory/outbox.sqlite3` before sending them. Each event receives
a stable UUID and capture timestamp; every retry sends the original payload.
Startup, new turns, recall, session switches and shutdown trigger retries. A
receipt must match the configured body/companion and the queued session/event
before the adapter clears the queued plaintext. Receipt status `accepted` means
durable acceptance, **not** completed extraction. Receipt metadata and content
digests remain locally for duplicate-callback detection.

The queue is bound to one body/companion. Reusing it with a different identity
fails; create a separate profile. Preserve this profile's queue during moves and
backups until all pending events are accepted. Its contents are private chat.

Only the completed root human input and final assistant reply are submitted.
Hermes supplies clean input before its nudges and strips skill scaffolding. Raw
message lists are used only for optional persisted user-row IDs, never as memory
payloads. Tool work, intermediate replies, reasoning, subagent output and
compression summaries are excluded. Standard delegated children skip external
memory entirely. Session switches do not rewrite pending events; each retains
its captured session. A parent session ID is never treated as a subagent test.

Distinct repeated sentences remain distinct turns. When Hermes provides a
persisted user-row ID, repeated callbacks for that same session/row deduplicate;
conflicting content rejects. Without a row ID, each callback is a new event.

Hermes invokes synchronization only after completed turns and queues that hook
in a daemon worker. Interrupted/human-only turns and a process crash before the
provider callback are outside this slice. The local outbox cannot recover events
it never received. It also does not retract accepted memories after Hermes undo
or infer duplicate historical rows across branches. No full transcript recovery
or checkpoint-v2 archival is claimed.

Recall failures produce a warning and raise to Hermes; its normal provider hooks
catch failures and can continue the turn. This provider does not globally require
memory before actions. Delivery failures retain queued chat and report pending
delivery. A shutdown timeout leaves the queue for the next profile startup.

The deliberate MCP tools are available alongside automatic hooks. `remember`
and `ingest` require caller-chosen stable `eventId` values; retry the same request
with the same ID after an uncertain response. The gateway rejects contradictory
reuse. Automatic chat ingestion already supplies and persists its event IDs.

## Tests

Use the pinned Hermes source and its Python environment. Tests do not contact
PSFN or a model provider, and use temporary Hermes homes and queues.

```sh
# HERMES_SOURCE is an immutable checkout of the commit above.
PYTHONPATH="$PWD:$HERMES_SOURCE" python -m unittest discover -s tests -v
```

Tests exercise the actual imported Hermes ABC, durable replay, matching receipts,
profile context propagation, concurrent sessions, source-ID deduplication, and
the exact registry JSON result format. A separate host-contract test uses the
actual Hermes registry and startup wiring with network operations mocked.
