# PSFN Read-Only Code Audit

> **Superseded framing:** This was a perimeter skim. Operator feedback (2026-07-21): kube/fleet+SSO is the live direction (Garden not the exposed edge); CogSec `shadow` is intentional soak; prefer deep findings over deploy-shape nits.  
> **Deep-dive follow-up:** [`READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md`](./READONLY_AUDIT_origin-main_DEEPDIVE_20260721.md) — memory store economics, subject SQL, fleet capability design, revised priorities.  
> **Seam/provenance follow-up:** [`READONLY_AUDIT_origin-main_SEAMS_20260721.md`](./READONLY_AUDIT_origin-main_SEAMS_20260721.md) — L0→L2 stack, chat turns, privacy matrix, multi-human/outbound provenance, automata efficiency.  
> **Welfare follow-up:** [`READONLY_AUDIT_origin-main_WELFARE_20260721.md`](./READONLY_AUDIT_origin-main_WELFARE_20260721.md) — companion core health/comfort vs charter care laws.

**Scope:** `origin/main` at `f8f798d13e2e0da3baa2dfac56961608acd2ab71`  
**Date:** 2026-07-21  
**Auditor posture:** code-first; charter + architecture diagram for intent; no other docs consulted  
**Method:** static review of security-critical and high-churn paths under `src/` (~3.2k TypeScript files; ~1.7k production, ~1.2k test). Not an exhaustive line-by-line review of every module.  
**Worktree:** `/home/ada/ai/dev/worktrees/psfn-framework/audit-main-readonly` (detached `origin/main`)

---

## 1. Overall code quality summary

**Overall grade: strong systems-engineering quality with structural debt.**

This is not average application TypeScript. The security-sensitive core (URL/SSRF policy, shell sandbox, intake sink gates, attribution forgery guards, Postgres schema pinning, timing-safe secret compare, fleet-auth capability transport) shows deliberate fail-closed design, extensive tests, and comments that encode real threat models. That is rare and good.

The codebase is also large, hot-path dense, and unevenly modularized. Several god files (2k–3.3k lines) concentrate orchestration risk. Charter architecture is *mostly* present in code, but a few foundational laws are still partially aspirational (credential custody, CogSec enforce mode default, full shard isolation). Production readiness depends heavily on deployment wiring (network isolation, fleet auth principal mode, intake-policy mode) more than on missing code seams.

**Does it meet best practices?** In the security perimeter modules, yes — often above typical Node/TS practice. Across the full tree, maintainability and module size lag the quality of the perimeter design. The project does **not** cleanly “meet best practices” end-to-end; it meets them where they matter most, and pays for that with complexity and god-file gravity.

---

## 2. Charter adherence and project spirit

Evaluated against `docs/PSFN_PROJECT_CHARTER.md` architectural laws and the topology in `docs/architecture-diagram.mmd`.

| Law / spirit | Code verdict | Notes |
|---|---|---|
| 3 Gateway sole privileged external edge | **Mostly held** | Gateway owns web/shell/git/vault/LLM edge; agent probes outbound isolation at startup |
| 4 Untrusted execution outside secrets boundary | **Held for shell** | Bubblewrap: `--unshare-net`, `--cap-drop ALL`, allowlist, prlimit |
| 6 Core authoritative mind | **Held** | Agent composition is the mind; channels are adapters |
| 7 Core must not have direct access to secrets | **Mostly held** | `secretAuthority: 'agent'` avoids gateway secret hydration; agent has no `dotenv` import; still depends on env not shipping secrets into agent |
| 8 Owner files own mutable settings | **Held** | Owner-file loaders, contract guards, seed files, fail-closed missing owners |
| 9 Credentials toward vault custody | **Partial** | `CredentialVaultPort` + OpenBao path exist; default backend remains `env` |
| 12–13 Subagent ≠ shard; shards high-tier | **Partial** | Distinct modules; charter itself admits current shards are not full isolated clones |
| 14–15 No direct core self-mod | **Directional** | Shell/git gated; analysis workbench sandbox; not a full PR-fold self-mod pipeline everywhere |
| 17–19 No fabricated partner speech / system masquerade | **Strong** | `entry-attribution.ts` forgery neutralization; system-note lanes; internal-role envelopes |
| 20 Broken state must not look healthy | **Generally held** | Fail-closed config; health surfaces record last failures; degraded modes are explicit (`ALLOW_AGENT_OUTBOUND_NETWORK`) |
| 21 Split runtime only | **Held** | `src/app/startup/index.ts` disabled fail-closed; gateway/agent/operator entrypoints |
| 2 L0 filesystem JSONL canonical | **Held** | Session store + segment rollover + projections/mirrors language |
| 34 CogSec provenance at sinks | **Structural yes, default soft** | Sink gates well designed; seed `intake-policy.json` mode is **`shadow`** (observe, do not block) |
| Continuity / partner flourishing / care | **Present** | Rest windows, weighted thoughts, charge/budget, social autonomy, ICP fatigue surfaces |
| Spirit: companion not disposable session toy | **Aligned** | L0 archive, episodic, memory provenance, Garden operator surface |

**Spirit verdict:** The code is trying hard to be a continuity substrate, not a chatbot. Fail-closed is a living practice in many modules (not just a slogan). The main spirit risks are (1) complexity that makes miswiring likely, (2) shadow-mode CogSec default, (3) god files that blur “thin composition roots,” and (4) shard isolation still short of the constitutional target.

---

## 3. Security findings

Severity uses practical exploit / harm potential, not review vibes.

### S1 — HIGH (config-dependent): Garden auth can be entirely off when no token and not fleet principal

**Where:** `src/operator/garden/server-request-routing.ts:102–110`

```ts
const skipAuth = deps.requireAuthForPublicRoutes !== true && (
  requestPath.startsWith('/_app/')
  || requestPath === '/health'
  || requestPath.startsWith('/health/')
  || requestPath === '/login'
);

if (!skipAuth && (deps.token || deps.requireAuthForPublicRoutes) && !deps.checkAuth(req, res)) return;
```

**Issue:** If `token` is unset **and** `requireAuthForPublicRoutes` is not true, **no route is authenticated** — including `/api/*` admin surfaces. Fleet principal mode tightens this (`requireAuthForPublicRoutes`), and shared-token paths use timing-safe compare via backplane auth helpers. Single-companion local/default posture still depends on operators setting a token.

**Charter angle:** Garden is the primary operator surface for config, memory inspection, and review. Unauthenticated Garden is partner-sovereignty and companion-welfare risk.

**Recommendation:** Fail closed at server construction when no auth material is configured for any network-bound bind address (loopback-only exception if intentionally local-dev).

---

### S2 — HIGH (deployment-dependent): Agent network isolation probe treats any probe failure as “isolated”

**Where:** `src/app/agent/startup-guards.ts:20–57`

```ts
const probeResult = await fetch(NETWORK_ISOLATION_PROBE_URL, {
  method: 'HEAD',
  ...
}).then(
  (response) => ({ reachable: true as const, status: response.status }),
  () => ({ reachable: false as const, status: null }),
);

if (!probeResult.reachable) {
  return; // allow startup
}
```

**Issue:** Any error (DNS failure, temporary packet loss, destination-specific firewall to `1.1.1.1`, IPv6-only egress, captive portal) is treated as isolation success. That is fail-**open** relative to “agent must not reach the public internet.” The override `ALLOW_AGENT_OUTBOUND_NETWORK=true` is explicit and logged (good). The false-negative path is not.

**Mitigation already present:** Production compose/k8s network policies (verified by scripts) are the real control; the probe is a defense-in-depth check.

**Recommendation:** Multi-target probes + require *proof of isolation* from the platform (NetworkPolicy annotation / CNI check) rather than a single negative HEAD.

---

### S3 — MEDIUM: Default CogSec intake mode is `shadow` (gates do not block)

**Where:** `config/intake-policy.seed.json` → `mode=shadow`  
**Logic:** `src/core/cogsec/intake/sink-gates.ts:23–34, 141`

In shadow mode, `allowed` is always true after evaluation. Enforcement of quarantined/unscreened content at sinks is disabled by design for rollout.

**Charter law 34** wants provenance preserved at consequential sinks. Structure exists; default posture does not enforce.

**Recommendation:** Production owner-file validation or startup assert: production layout requires `mode: 'enforce'` (or explicit operator override env with loud degrade).

---

### S4 — MEDIUM: Credential custody still env-primary

**Where:** `src/boundary/custody/credential-vault.ts:130–149`  
Default backend is `env`; OpenBao is opt-in via `CREDENTIAL_VAULT_BACKEND`.

Charter §6.3 / law 9 want vault custody growth. Port abstraction is good; operational default is still process-env keys on the gateway host.

---

### S5 — MEDIUM (defense-in-depth): `quoteIdentifier` in fleet-auth schema access does not escape quotes

**Where:** `src/persistence/backups/fleet-auth-schema-access.ts:43–45`

```ts
function quoteIdentifier(value: string): string {
  return `"${value}"`;
}
```

**Mitigation:** Callers pass values through `assertValidPostgresSchemaName` / role validators (`src/persistence/postgres.ts:20–47`) that restrict to `[a-z][a-z0-9_]*`. Injection is blocked by charset, not by quoting.

**Issue:** Local quote helper is weaker than `quotePostgresSchemaName` / `postgres-restore.ts` escape (`" → ""`). Future call-site misuse could introduce SQL injection. Prefer the shared quoters only.

---

### S6 — LOW–MEDIUM: Git ops shell out via string `execSync`

**Where:** `src/boundary/integrations/git/ops.ts:289–307`

Commands are built as shell strings; path/message args go through `shellEscape`. Hardcoded subcommands are fixed. This is acceptable if every dynamic fragment is escaped and validation never regresses — but shell-string git remains a classic footgun versus `spawn(argv[])`.

Sandbox shell path (bubblewrap + argv array) is the stronger model; git ops is weaker isolation.

---

### S7 — LOW: Production `as any` at gateway RPC boundary

**Where:**  
- `src/boundary/gateway/client.ts:590`  
- `src/boundary/gateway/server.ts:1627`

```ts
await serverAndClient.receiveAndSend(message as any);
```

Likely JSON-RPC library typing gap. Not a direct vuln, but weakens compile-time protocol guarantees at the trust boundary.

---

### Security positives (explicitly not findings)

These are well done and should not be “fixed” casually:

1. **SSRF / DNS rebinding** — `url-policy.ts` classifies IPv4/IPv6 (including mapped/embedding ranges) with `ipaddr.js`; always-block metadata/link-local/ULA; `checkResolvedIP` + **pinned `connectAddress`** on fetch; **each redirect hop** re-runs policy+DNS (`web.ts:450–508, 570–672`); credential headers stripped on origin change.
2. **Shell sandbox** — empty allowlist fails; path allowlist; no `LD_*`; bubblewrap net/user/pid unshare; prlimit caps (`shell-execution-policy.ts`, `bubblewrap-runner.ts:28–78`).
3. **Timing-safe compares** — `secret-compare.ts`, API auth, fleet-auth capability digests.
4. **Intake sink gates** — single module; quarantined content invisible; multi-envelope fail-closed; trifecta assessment; shadow vs enforce explicit (`sink-gates.ts`).
5. **Attribution forgery** — control/bidi strip, delimiter neutralization, stable-id trust anchor (`entry-attribution.ts:17–100`).
6. **Postgres schema pin** — search_path pinned per pool; no silent public fallback (`postgres.ts:60–116`).
7. **Agent has no dotenv** — startup index disabled; split-only operational shape.

---

## 4. Potential bugs and unhandled edge cases

### B1 — Agent isolation probe false “healthy isolation”

Already S2. Edge case: selective egress (can reach provider endpoints, cannot reach `1.1.1.1`) starts the agent while charter isolation is violated.

### B2 — `readJsonLines` loads entire L0 segment into memory

**Where:** `src/persistence/jsonl.ts:57–66`

```ts
const raw = readFileSync(path, 'utf-8');
...
raw.split('\n').forEach(...)
```

Segments roll at `L0_SESSION_FILE_MAX_BYTES = 16 MiB` (`store-primitives.ts:177`), so worst case is bounded per segment but still O(segment) memory and CPU on every full read. Concurrent multi-channel rebuilds can spike RSS. Corrupt-line handling is explicit (good); full-file split is naive for hot paths.

### B3 — N+1 memory authorization lookups

**Where:** `src/faculties/memory/retrieval/access-context.ts:102–104`

```ts
await Promise.all(sourceMemoryIds.map(id => input.memoryStore.getById(id)))
```

Unbounded fan-out of `getById` per profile. Correctness may hold; under large `sourceMemoryIds` this is latency + pool pressure. Similar pattern: `subject-authorized-store.ts` and vision attachment screening use `Promise.all` over candidate arrays without a concurrency ceiling.

### B4 — JSONL append is process-safe only via higher-level locks

`appendJsonLine` uses `appendFileSync` without fsync or advisory lock. Session store has cross-process write locks for journal chains — good when used. Direct callers of `appendJsonLine` (e.g. git audit log) can interleave lines under multi-writer scenarios. Partial writes on crash remain a classic JSONL risk (OS-level atomicity of writes under PIPE_BUF helps for small lines only).

### B5 — Non-null assertions after length checks

Many `arr[0]!` after `length` checks (gateway, sessions, fleets). Usually safe; a few sites couple optional config with `!` (`server.ts` optional brokers). Prefer explicit throw with structured error — project already does this well in many places; inconsistency remains.

### B6 — Core-memory startup hydration degrades per-channel

**Where:** `src/faculties/core-memory/startup-hydration.ts:62–64`  
Channel hydrate failures push to `degraded` and continue. Correct for multi-channel resilience, but charter law 20 requires degraded state to remain visible to operators — confirm Garden/health surfaces always expose this list (not verified end-to-end in this audit).

---

## 5. Performance

| Area | Observation | Impact |
|---|---|---|
| L0 JSONL full-segment read/parse | Full `readFileSync` + `split` | Medium on long companions; mitigated by 16 MiB roll |
| Memory retrieval | Vector search staged with telemetry; default limits in shared background | Generally intentional |
| Contact profile access | N+1 `getById` | Medium under wide graphs |
| God-file load / cold start | Agent main + gateway server are huge modules | Cold start / tooling cost |
| Parallel `Promise.all` without caps | Vision screening, authorization maps | Burst CPU / DB under multi-attachment turns |
| Web fetch body caps | Text/binary max 8 MiB streaming enforced | Good fix (comment cites prior unbounded buffer) |
| LLM circuit breakers | Per-route keys | Good resilience |

**Optimization opportunities (non-blocking):**

1. Streaming JSONL readers for index rebuild / audit scans.  
2. Batched `getByIdMany(ids)` in memory store for access-context.  
3. Bound concurrency (`p-limit` style) for vision and authorization maps.  
4. Continue splitting god files to reduce re-parse / recompile cost in agent loops.

---

## 6. Readability and maintainability

### God files (structural debt)

| File | Approx lines | Concern |
|---|---|---|
| `src/boundary/gateway/server.ts` | ~3390 | Trust boundary + routing + auth + methods composition |
| `src/persistence/postgres/migrations.ts` | ~3113 | Expected for migrations; still heavy |
| `src/persistence/postgres/model-usage-store.ts` | ~2546 | Store density |
| `src/boundary/gateway/client.ts` | ~2463 | Agent↔gateway protocol surface |
| `src/persistence/sessions/store.ts` | ~2344 | L0 core |
| `src/system/config/scheduler-config.ts` | ~2275 | Owner complexity |
| `src/core/agent/substrate-agent.ts` | ~2193 | Mind loop |
| `src/core/session/manager.ts` | ~2153 | Session semantics |
| `src/app/agent/main.ts` | ~2085 | Composition root too thick |

Charter layer model wants **thin composition roots**. Current agent main imports dozens of faculties and wires them inline — workable for a single product, hostile to new contributors and adversarial review.

### Positive structure

- Clear domain folders: `boundary/`, `core/`, `faculties/`, `persistence/`, `operator/garden/`.
- Shared guards centralized (`shared/utils/types.ts` `isRecord` — only one production definition found).
- Contracts modules under `shared/contracts/`.
- High test density (~40% of TS files are tests) around security and privacy regressions.

### Naming / semantics

- Internal role envelopes, system notes, whispers vs musings directionally match charter vocabulary.
- Some residual “journal” wording near L0 remains; charter prefers “L0 session archive.” Mostly disciplined.

---

## 7. TypeScript / engineering practices

| Practice | Status |
|---|---|
| `strict: true` | Yes (`tsconfig.json`) |
| `module: NodeNext` + ESM (`"type": "module"`) | Yes |
| `verbatimModuleSyntax` | Yes |
| Empty catch swallows | Rare; security paths prefer throw/log |
| Production `as any` | Very rare (RPC boundary) |
| Typed errors | Common custom errors (`ShellExecPolicyError`, JSON-RPC policy codes) |
| Lint / verify scripts | Rich (`lint`, settings contract, isolation, cycles, fleet-auth certification) |
| Node engines | `>=22` |
| Dependency cycles | Explicit verifier script |

**Best practices gap:** optional chaining + non-null assertion mix; oversized modules; some shell-string process spawning; seed defaults that are softer than production charter ideals.

---

## 8. Charter / architecture diagram alignment

Architecture diagram topology is reflected in code:

- External surfaces → gateway channels  
- Gateway holds secrets, policy, host tools  
- Operator process → Garden HTTP  
- Agent → SubstrateAgent, session, memory, scheduler, tools  
- Persistence: Postgres + JSONL + owner files + workspace + backups  

**Gaps diagram does not show but code has:** fleet-auth, CogSec, ICP autonomy, shared satellite hub — good expansions.  
**Gap code has vs charter target:** full distributed shard isolation, CredentialVault as primary custody, enforce-mode CogSec by default.

---

## 9. Priority recommendations

### P0 (do soon if any production bind is internet-reachable)

1. Fail closed Garden construction without auth when bind is non-loopback.  
2. Assert production intake-policy `mode: 'enforce'` (or explicit loud override).  
3. Treat agent network isolation as platform-enforced first; improve probe so “unknown” ≠ “isolated.”

### P1 (security posture / charter honesty)

4. Prefer `spawn(argv)` for git ops; retire shell-string path.  
5. Route all SQL identifier quoting through shared validators/quoters.  
6. Continue vault custody migration; shrink gateway env key surface.

### P2 (maintainability / performance)

7. Split `gateway/server.ts`, `agent/main.ts`, `substrate-agent.ts` by domain (methods already partially extracted).  
8. Batch memory `getById` and cap `Promise.all` fan-out in turn path.  
9. Streaming JSONL readers for large segment scans.

### P3 (charter completeness)

10. Document and track remaining shard isolation delta as charter debt (not pretend Docker/K8s shard executors exist).  
11. Keep Garden as real runtime reflection — avoid shadow settings UIs.

---

## 10. What is *not* claimed

- No runtime exploit was executed; findings are static.  
- Live k3s / PVC state was not inspected (read-only code audit).  
- Not every faculty (wiki, emotion, ICP, fleet-auth full matrix) was deep-read.  
- Admin UI Svelte code was only lightly scanned for `innerHTML` (none found in quick pass).

---

## 11. Bottom line

PSFN’s `main` code is a **serious fail-closed companion substrate**, not a toy agent harness. Security perimeter modules are high craft. The largest risks are **misconfiguration modes** (Garden without token, CogSec shadow, network probe false isolation) and **structural complexity** (god files, thick agent composition), not casual absence of validation.

The project spirit — continuity of identity, truthful companion-facing semantics, partner sovereignty, care boundaries — is visible in real code paths (attribution, system notes, rest/charge, intake envelopes). Closing the gap between **structural capability** and **default production enforcement** is the main charter-faithfulness work remaining.
