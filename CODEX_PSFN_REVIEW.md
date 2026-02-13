# CODEX PSFN Review (Updated)

Date: 2026-02-13  
Scope: Security, configuration, and roadmap alignment review of current `main`.  
Method: Read-only audit + tests (`npm test`): 282/282 passing.

## What Changed Since Last Review

### Fixed

1. SSRF hardening for `web.fetch` is now implemented.
- `src/gateway/server.ts:319`
- `src/gateway/url-policy.ts:41`
- `src/gateway/url-policy.ts:94`

2. Symlink traversal bypass in FS policy is fixed.
- `src/gateway/server.ts:121`
- `src/gateway/server.ts:124`

3. Streaming chunk cross-talk is fixed with per-request IDs.
- `src/gateway/server.ts:245`
- `src/gateway/client.ts:29`
- `src/gateway/client.ts:196`

4. Session filename sanitization is now strict allowlist + encoding.
- `src/session/store.ts:13`

5. Scheduler layer is now implemented and wired.
- `src/scheduler/scheduler.ts:12`
- `src/runtime.ts:111`
- `src/agent-main.ts:97`

6. Config threading for retrieval/extraction intervals is implemented.
- `src/runtime.ts:93`
- `src/runtime.ts:104`
- `src/agent-main.ts:81`
- `src/agent-main.ts:90`

## Current Findings (Ordered by Severity)

### High

1. API and Admin servers are optional-auth and bind on all interfaces.
Evidence:
- API key is optional: `src/channels/api/server.ts:21`
- API auth only enforced when key exists: `src/channels/api/server.ts:78`
- API listen without host restriction: `src/channels/api/server.ts:48`
- Admin token is optional: `src/channels/admin/server.ts:18`
- Admin auth only enforced when token exists: `src/channels/admin/server.ts:77`
- Admin listen without host restriction: `src/channels/admin/server.ts:57`
Impact:
- If `API_PORT`/`ADMIN_PORT` is enabled without key/token, remote unauthenticated access is possible on networked hosts.
Recommendation:
- Default-bind to `127.0.0.1` unless explicit host is configured; fail startup when auth is unset unless `ALLOW_INSECURE_LOCAL=true`.

2. Gateway Discord forwarder still returns an empty placeholder response through adapter path.
Evidence:
- Placeholder empty response: `src/gateway-main.ts:73`
- Adapter always sends handler response content: `src/channels/discord/adapter.ts:118`
Impact:
- Can still produce empty-send/error behavior before agent response path completes.
Recommendation:
- Add explicit “forward-only/no-send” mode to adapter invocation in gateway wiring.

3. Gateway socket trust is based only on filesystem permissions.
Evidence:
- Socket permission is `0770`: `src/gateway/transport.ts:81`
- No per-connection auth handshake in server accept path: `src/gateway/server.ts:424`
Impact:
- Any local process with socket access can call gateway RPC methods.
Recommendation:
- Add lightweight auth (shared token/challenge) and stricter socket ownership/isolation.

### Medium

4. `web.fetch` URL denials are enforced in handler, but policy decision logging still marks method as `ALLOW`.
Evidence:
- Policy returns `ALLOW` for `web.fetch`: `src/gateway/server.ts:95`
- URL policy blocks inside handler with policy errors: `src/gateway/server.ts:322`
- Audit decision is captured before handler based on `evaluatePolicy`: `src/gateway/server.ts:208`
Impact:
- Audit trail can underreport policy-blocked fetches as `ALLOW` + error instead of `DENY`.
Recommendation:
- Move URL policy decision into `evaluatePolicy` path or include post-check decision override in audit.

5. API request body has no size guard.
Evidence:
- Entire request body accumulates unbounded: `src/channels/api/server.ts:116`
Impact:
- Large POST payloads can cause memory pressure/DoS.
Recommendation:
- Enforce max body size and reject with `413`.

6. Gateway does not ensure socket directory exists for default `/run/psfn/gateway.sock`.
Evidence:
- Default socket path: `src/gateway-main.ts:20`
- No `mkdir` for `dirname(socketPath)` before listen.
Impact:
- Startup failure on hosts where `/run/psfn` is missing.
Recommendation:
- `mkdirSync(dirname(socketPath), { recursive: true })` before `gateway.start()`.

7. Host/container workspace path mapping is still ambiguous for future FS broker use.
Evidence:
- Gateway default workspace: `src/gateway-main.ts:25`
- Agent container workspace mount: `docker/docker-compose.yml:15`
Impact:
- Future `fs.*` operations may classify incorrectly without explicit path mapping policy.
Recommendation:
- Add explicit host/container path map config and apply in policy checks.

### Low / Design Tradeoff

8. REPL in single-process mode is still not a strong security boundary (documented behavior).
Evidence:
- Sandbox comment: `src/repl/sandbox.ts:3`
- Single-process runtime includes `think` tool: `src/runtime.ts:141`
Note:
- This appears intentional for dev/simplicity; risk remains if single-process is used outside trusted environments.

## Alignment With Plan

1. Scheduler: now aligned (implemented).
- Spec target: `docs/PSFN_SUBSTRATE_SPEC.md:354`
- Implementation: `src/scheduler/scheduler.ts:12`

2. OpenAI-compatible API: implemented (ahead of original phase sequencing).
- Related issue closed: `PSFN-z5e` in `.beads/issues.jsonl`.

3. Admin GUI: implemented (out-of-band feature, useful operationally).
- Related issue closed: `PSFN-hxk` in `.beads/issues.jsonl`.

4. Module system: still not implemented.
- Spec module layer: `docs/PSFN_SUBSTRATE_SPEC.md:141`
- Open issue: `PSFN-zfr` in `.beads/issues.jsonl`.

5. Session compaction/branching remains partial.
- Store supports compaction entries: `src/session/store.ts:174`
- No automatic compaction flow in runtime/session manager paths: `src/session/manager.ts:39`.

6. Capability tokens still not implemented.
- Protocol type exists: `src/gateway/protocol.ts:132`
- No corresponding method registration in gateway server.

## Configuration/Docs Drift

1. README still describes scheduler as “planned”.
- `README.md:140`
- Current implementation includes scheduler (`src/scheduler/scheduler.ts`).

2. Model defaults mismatch remains.
- Code default: `z-ai/glm-5` (`src/types.ts:105`)
- `.env.example`: `z-ai/glm-4.7` (`.env.example:13`)

3. `CLAUDE.md` test count appears stale vs current test run.
- `CLAUDE.md:153` says 203 tests
- Current run: 282 tests

## Suggested Next Features

1. Secure network surfaces by default.
- Require auth for API/Admin when ports are enabled.
- Add explicit bind host config (`127.0.0.1` default).

2. Finish gateway hardening.
- Add socket auth handshake.
- Add policy/audit consistency for `web.fetch` denials.

3. Implement module system MVP (`PSFN-zfr`).
- Registry + loader + lifecycle hooks, with gateway-mediated IO/network constraints.

4. Implement automatic session compaction policy.
- Trigger based on message thresholds and preserve auditability.

5. Add request size/time guards to API and admin endpoints.
- Body caps, timeouts, and simple rate-limiting for exposed endpoints.
