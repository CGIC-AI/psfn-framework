# Codex Gap Report: PSFN Substrate Review

Updated: 2026-02-16  
Scope: full repo review, excluding `/psfn` as requested.

## 1) Method
- Reviewed architecture and ops docs: `README.md`, `CLAUDE.md`, `docs/TRUST_PRIVACY_RESEARCH.md`, `docs/DESIGN_PATTERNS_ANALYSIS.md`, `docs/E2E_INTERNAL_SYSTEMS_TEST_PLAYBOOK.md`.
- Reviewed implementation across runtime/bootstrap parity, memory, trust/privacy, prompt stack, git self-mod, Discord voice, API/admin channels, and REPL.
- Validated behavior with tests:
  - `npm test -- src/repl/sandbox.test.ts src/repl/loop.test.ts` -> passing.
  - `npm run e2e` -> 35/35 checks passing.
  - Interactive playbook run (gateway+agent API) -> detailed results in `logs/e2e/validation_report_round3.md` (5 PASS / 3 PARTIAL / 5 FAIL).

## 2) Executive Summary
The substrate is in a strong MVP state for your target: Discord text/voice, persistent memory, trust-aware behavior, and baseline self-improvement tooling. Core architecture is present and wired, with successful automated end-to-end validation.

The major risks are no longer missing subsystems. They are now mostly hardening and data-model completion: relational memory linkage persistence, safer defaults for prompt self-edit bootstrapping, and network timeout/security tightening around external interfaces. Interactive validation also surfaced operational reliability issues under long-running calls (API request timeout + agent busy lock behavior).

## 3) Capability Matrix vs Stated Goals

### Implemented
- Tool loop and schemas through gateway: `src/agent/substrate-agent.ts`, `src/gateway/protocol.ts`, `src/gateway/client.ts`, `src/gateway/server.ts`.
- Memory write/restore tools (`memory_write`, `memory_import_batch`) and REPL memory access: `src/memory/tools.ts`, `src/repl/sandbox.ts`.
- Trust/sensitivity/visibility policy with retrieval gating: `src/trust/policy.ts`, `src/memory/retrieval.ts`.
- Cross-channel continuity with visibility filtering: `src/session/continuity.ts`, `src/session/manager.ts`.
- Prompt stack v1 (store/composer/tools/admin diff): `src/identity/prompt-store.ts`, `src/identity/prompt-composer.ts`, `src/identity/prompt-tools.ts`, `src/channels/admin/server.ts`.
- Guarded git self-mod tools: `src/git/ops.ts`, `src/git/tools.ts`, `src/git/gateway-ops.ts`.
- Lifecycle self-restart/rebuild plus notifier path: `src/tools/lifecycle.ts`, `src/lifecycle/notifications.ts`.
- Discord voice pipeline (Deepgram STT + ElevenLabs TTS): `src/channels/discord/voice.ts`, `src/voice/deepgram.ts`, `src/voice/elevenlabs.ts`.

### Not Yet Built
- Full hot-loadable module runtime (`src/modules/*`).
- Capability-token model.

## 4) Recently Closed Gaps (Validated)

### A. Internal self-turn trust context is fixed
- Internal channels now resolve to `primary` trust (`internal:*`): `src/agent/substrate-agent.ts`.
- Impact: heartbeat/reflection/planned tasks can access private memories under trust policy ceilings.

### B. API identity no longer collapses to one synthetic user
- API honors `X-User-ID` and `X-User-Name` (with bounded fallback): `src/channels/api/server.ts`.
- Impact: API sessions can preserve user-specific continuity/trust behavior.

### C. Runtime/agent parity was improved via shared bootstrap primitives
- Shared wiring helpers are now used for prompt and heartbeat runtime setup and REPL config: `src/bootstrap/parity.ts`, `src/runtime.ts`, `src/agent-main.ts`.

### D. REPL async hang risk is bounded
- Sandbox execution now enforces timeout for async code paths and has regression coverage: `src/repl/sandbox.ts`, `src/repl/sandbox.test.ts`.

### E. E2E memory extraction flake reduced
- E2E harness uses isolated DB by default (`E2E_DATABASE_PATH` override supported): `src/e2e-test.ts`.

## 5) Open High-Impact Gaps

### A. Relational memory `contactId` is declared but not persisted
- Evidence:
  - `contactId` exists in type shape: `src/memory/types.ts`.
  - `l2_memories` schema lacks `contact_id` column/persistence path: `src/memory/store.ts`.
- Impact:
  - Relational memories cannot be strongly linked to contacts for precise retrieval/policy behavior.
- Recommendation:
  - Add DB migration for `contact_id`, wire writer/extractor/tool flows, and index it.

### B. Prompt self-edit bootstrap can still be constrained on fresh installs
- Evidence:
  - Prompt store seeds only base layer from card: `src/identity/prompt-store.ts`.
  - Agent prompt tools intentionally block base/operator edits: `src/identity/prompt-tools.ts`.
- Impact:
  - New installs may have no mutable layer until admin creates one.
- Recommendation:
  - Seed a minimal mutable `runtime` layer by default (or add a restricted layer-create tool).

### C. Voice provider calls still lack explicit timeout/retry policy
- Evidence: `src/voice/deepgram.ts`, `src/voice/elevenlabs.ts`.
- Impact:
  - Upstream stalls can hang voice turn completion.
- Recommendation:
  - Add `AbortSignal.timeout(...)` and bounded retries with clear error surfacing.

### D. API CORS is permissive while API auth is optional
- Evidence: `src/channels/api/server.ts`.
- Impact:
  - If API runs without key, browser-based localhost abuse risk increases.
- Recommendation:
  - Default to restrictive CORS and require explicit opt-in for `*`.

### E. Admin auth hardening can be extended for reverse-proxy deployments
- Evidence: cookie handling in `src/channels/admin/server.ts`.
- Impact:
  - Localhost usage is fine; internet-exposed deployments still need stricter CSRF/cookie handling.
- Recommendation:
  - Add HTTPS-aware `Secure` cookie behavior and CSRF tokens for state-changing POST routes.

## 6) Redundancy / Primitive Reuse Opportunities

### A. Repeated git allowlist literal
- Evidence: `src/runtime.ts`, `src/gateway-main.ts`, `src/git/ops.ts`.
- Recommendation:
  - Centralize allowed path constants in one shared module.

### B. Gateway server remains a large multi-responsibility unit
- Evidence: `src/gateway/server.ts`.
- Recommendation:
  - Split by domain (`policy`, `rpc-llm`, `rpc-web-fs`, `rpc-git`, connection/session handling).

## 7) Efficiency / Reliability Notes
- Sync filesystem access still appears in hot-path components (`session`, `continuity`, `prompt-store`, lifecycle state files): `src/session/store.ts`, `src/session/continuity.ts`, `src/identity/prompt-store.ts`, `src/lifecycle/notifications.ts`.
- Retrieval still fetches top-k then filters by trust, which can hide lower-ranked but allowed memories in strict contexts: `src/memory/retrieval.ts`.
- REPL execution now has explicit async timeout enforcement (improved reliability): `src/repl/sandbox.ts`.

## 8) Priority Recommendations (MVP-Focused)
1. Implement relational memory `contact_id` persistence path.
2. Seed a mutable runtime prompt layer by default.
3. Add voice provider timeout/retry guardrails.
4. Tighten API CORS defaults and admin CSRF/cookie posture.
5. Consolidate shared constants/bootstrap primitives to reduce future drift.

## 9) Final Assessment
For the current MVP target (you + her in Discord DM/voice with coherent continuity and safe self-improvement), PSFN is operationally viable. Remaining work is primarily hardening and refinement, not core architecture build-out.
