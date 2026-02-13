# CODEX PSFN Review (Read-Only Audit)

Date: 2026-02-13
Scope: Security, configuration, and alignment against `docs/PURRSEPHONE_SUBSTRATE_SPEC.md` and `.beads/issues.jsonl`.
Method: Static code review only (no source edits), plus test run (`npm test`: 138/138 passing).

## Findings (Ordered by Severity)

### Critical

1. Unrestricted `web.fetch` allows SSRF and internal network probing through the gateway.
Evidence:
- `src/gateway/server.ts:49` returns `ALLOW` for all `web.fetch`.
- `src/gateway/server.ts:252` fetches arbitrary `params.url` directly.
Impact:
- Prompt-influenced agent behavior can hit localhost/private services/metadata endpoints from the host-side gateway.
Recommendation:
- Enforce URL policy: allowlist domains, require `https`, deny localhost/link-local/private CIDR targets, and require explicit approval for non-allowlisted destinations.

2. Filesystem policy can be bypassed via symlink traversal.
Evidence:
- Policy is prefix-based on normalized path string, not canonical target path: `src/gateway/server.ts:56`, `src/gateway/server.ts:60`.
- Actual file operations use raw path (`readFile`/`writeFile`): `src/gateway/server.ts:277`, `src/gateway/server.ts:286`.
Impact:
- A path inside workspace that points via symlink outside workspace can be treated as `ALLOW`.
Recommendation:
- Resolve both requested path and target with `realpath`, reject symlink escapes, and enforce policy on canonical path.

3. Streaming chunk routing is not request-safe and can cross-talk under concurrency.
Evidence:
- Gateway emits `llm.chunk` with constant `requestId: 0`: `src/gateway/server.ts:193`.
- Client keeps a single global handler: `src/gateway/client.ts:27`, `src/gateway/client.ts:61`, `src/gateway/client.ts:187`.
- Shards are explicitly concurrent-capable: `src/shards/manager.ts:14`, `src/shards/manager.ts:38`.
Impact:
- Concurrent LLM streams can leak/mix token chunks between tasks, creating integrity and possible data exposure issues.
Recommendation:
- Introduce per-request IDs end-to-end and map chunk handlers by request ID.

### High

4. Gateway mode currently risks sending an empty Discord reply for every incoming message.
Evidence:
- Gateway handler returns placeholder empty content: `src/gateway-main.ts:71`.
- Discord adapter always attempts to send handler response: `src/channels/discord/adapter.ts:113`, `src/channels/discord/adapter.ts:115`.
Impact:
- In gateway/agent split mode this can trigger failed sends or user-facing error replies before agent response path completes.
Recommendation:
- Add explicit “no direct reply” mode for gateway-side adapter path, or skip send when response is empty in gateway forwarding mode.

5. No authentication beyond socket permissions for agent-to-gateway RPC.
Evidence:
- Socket permission set to group-writeable `0770`: `src/gateway/transport.ts:78`.
- No per-connection auth/identity handshake in server accept path: `src/gateway/server.ts:296`.
Impact:
- Any local process with socket access can call privileged gateway methods (`discord.send`, `llm.*`, `fs.*`).
Recommendation:
- Add peer authentication (token/challenge), tighter socket ownership/perms, and method-level capability scoping.

6. Single-process mode weakens the stated REPL security boundary.
Evidence:
- Sandbox comment explicitly says Docker is the real boundary: `src/repl/sandbox.ts:3`.
- Single-process runtime registers `think` tool with direct providers: `src/runtime.ts:56`, `src/runtime.ts:107`.
Impact:
- In `npm run dev`, a sandbox escape would run in same trust domain as secrets/network clients.
Recommendation:
- Treat single-process as non-hardened dev mode only; gate `think` tool behind explicit flag, or isolate REPL path even in dev.

### Medium

7. Config knobs exist but are not honored by runtime logic.
Evidence:
- Config loads `memoryRetrievalLimit` and `extractionInterval`: `src/types.ts:99`, `src/types.ts:100`, `src/types.ts:115`, `src/types.ts:116`.
- Retrieval and extraction use hardcoded constants instead: `src/memory/retrieval.ts:42`, `src/memory/extraction.ts:73`, `src/memory/types.ts:52`, `src/memory/types.ts:53`.
Impact:
- Operators cannot tune extraction/retrieval behavior through env as documented by config shape.
Recommendation:
- Thread config values into `MemoryRetriever`/`MemoryExtractor` and remove duplicate hardcoded knobs.

8. Gateway defaults and container paths are misaligned for future file-broker use.
Evidence:
- Gateway default workspace is `./workspace`: `src/gateway-main.ts:23`.
- Agent container workspace mount is `/app/workspace`: `docker/docker-compose.yml:15`.
Impact:
- Agent-originated `fs.*` requests may fall outside gateway ALLOW path unless manually configured.
Recommendation:
- Define and document explicit host/container path mapping or a normalized virtual path contract.

9. Startup fragility: gateway does not ensure socket directory exists.
Evidence:
- Default socket path under `/run/psfn`: `src/gateway-main.ts:18`.
- No `mkdir` for socket directory before listen.
Impact:
- Gateway can fail on clean hosts where `/run/psfn` is absent.
Recommendation:
- Create parent directory before `createSocketServer`.

10. Partial channel ID sanitization in session filenames.
Evidence:
- Only `/` and `:` are replaced: `src/session/store.ts:12`.
Impact:
- Non-Discord channel IDs with other path-metacharacters can produce unsafe or ambiguous filenames.
Recommendation:
- Restrict to strict allowlist (`[a-zA-Z0-9._-]`) and hash/encode anything else.

## Configuration/Documentation Drift

1. Contradictory status in `CLAUDE.md` about REPL.
Evidence:
- Claims “Sprints 1-4 complete ... RLM+REPL sandbox”: `CLAUDE.md:150`.
- Also says REPL is “Not yet built”: `CLAUDE.md:157`.

2. Model default mismatch between code and example env.
Evidence:
- Code default primary model: `z-ai/glm-5` in `src/types.ts:105`.
- Example env sets `z-ai/glm-4.7`: `.env.example:13`.

3. Embedding endpoint examples differ across docs/defaults.
Evidence:
- README uses localhost example: `README.md:35`.
- `.env.example` and default config point to `purrsephone.local...`: `.env.example:19`, `src/memory/embedding.ts:8`.

## Alignment With Overall Plan (Spec + Beads)

1. Module system is still missing.
Spec references:
- `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:141` through `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:176`.
- File plan at `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:497`.
Current implementation signals:
- No module registry/loader in `src/`.
- No `jiti` dependency in `package.json`.
- Open tracking issue: `PSFN-zfr` in `.beads/issues.jsonl`.

2. Scheduler/heartbeat layer is not implemented yet.
Spec references:
- `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:235` through `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:243`.
- MVP includes scheduler: `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:304`.
Current implementation signals:
- Event map has no `schedule.*` events: `src/event-bus.ts:5`.
- No scheduler module in `src/`.

3. REPL persistence does not match spec intent.
Spec reference:
- “REPL is sandboxed but persistent within a session”: `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:88`.
Implementation:
- `runRLMLoop` creates a new sandbox each call: `src/repl/loop.ts:14`.
- Code comment describes it as “ephemeral think cycle”: `src/repl/loop.ts:2`.

4. Session compaction/branching capability is partial.
Spec references:
- Session manager + compaction in MVP: `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:278`.
- Tree/branch architecture references: `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:483`.
Implementation:
- JSONL append works, and compaction summaries can be stored: `src/session/store.ts:74`, `src/session/store.ts:111`.
- No automatic compaction routine, no branch semantics in runtime paths.

5. Security roadmap item “capability tokens” remains unimplemented.
Evidence:
- Mentioned as planned in `.beads/issues.jsonl` (`PSFN-2bf` notes and design).
- Protocol includes `approval.request`: `src/gateway/protocol.ts:130`.
- Gateway server does not implement `approval.request` method in `registerMethods`.

## Suggested Next Features (Priority Order)

1. Harden gateway policy and brokering.
Build:
- Canonical-path (`realpath`) FS enforcement.
- SSRF defenses and URL allowlisting for `web.fetch`.
- Per-request streaming IDs and chunk routing.
- Capability tokens (method/path/domain scoped, TTL-bound) for approved operations.

2. Implement minimal Scheduler (MVP subset).
Build:
- `heartbeat` timer, cron/every/one-shot task registry, memory maintenance hooks.
- Emit `schedule.tick`, `schedule.task.run`, `schedule.heartbeat` events as in spec.

3. Implement Module System (safe first pass).
Build:
- Registry + loader + lifecycle interfaces (`init/start/stop/health`).
- Restrict module IO/network through gateway policy from day one.
- Start with signed/trusted local modules before self-authored install flow.

4. Complete session compaction and branch support.
Build:
- Auto-compaction policy when session exceeds threshold.
- Branch IDs/tree metadata in session storage.
- Include compaction auditability and replay tests.

5. Observability and operator controls.
Build:
- Structured logging with log levels (`PSFN-7qz`).
- Runtime health endpoint/CLI summary for gateway policy decisions and pending approvals.

## Open Questions

1. Should `web.fetch` exist as a general primitive, or be replaced by narrow, allowlisted tools only?
2. Is single-process mode intended only for local dev, or must it meet production security posture?
3. Should shard execution be concurrency-limited by token budget in addition to count-based caps?
