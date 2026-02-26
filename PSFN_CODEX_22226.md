# PSFN Substrate Validation Audit (Read-Only)

Scope audited:
- `CLAUDE.md`
- `README.md`
- `docs/PURRSEPHONE_SUBSTRATE_SPEC.md`
- `docs/PURRSEPHONE_PRIMER.md`
- Runtime implementation under `src/`

Method:
- One explorer subagent per validation dimension (7 total), then synthesized into this report.
- No runtime code was modified.

---

## 1) Memory Integrity — "Never destroy data"

1. **Status**: PASS
2. **Evidence**:
- L0 append-only journal writes use `appendJournalEntry` from session paths (`src/session/store.ts:315`, `src/session/journal-utils.ts:33`), with turn recording from the agent loop (`src/agent/substrate-agent.ts:422`).
- Six memory types are explicitly enforced (`src/memory/types.ts:30`, `src/memory/extraction.ts:1031`).
- Type-specific decay and dedup constants match spec targets (`src/memory/types.ts:73`, `src/memory/decay.ts:27`, `src/memory/writer.test.ts:320`).
- Contradictions supersede via linkage (`supersededBy`) instead of destructive overwrite (`src/memory/writer.ts:126`).
- Retrieval score is multiplicative across similarity, recency, emotional weight, importance, and salience (`src/memory/retrieval.ts:276`).
- Memory write tools are registered for agent runtime (`src/runtime.ts:250`, `src/agent-main.ts:202`).
- Embedding dimensions are wired to 1024 for snowflake-arctic-embed2 path (`src/memory/embedding.ts:7`, `src/runtime.ts:151`).
- Post-turn extraction runs automatically (`src/agent/substrate-agent.ts:451`).
- Think/REPL and tool writes include source references for provenance (`src/repl/sandbox-capabilities/memory.ts:80`, `src/memory/tools.ts:87`, `src/memory/extraction.ts:541`).
3. **Gaps**:
- No blocking implementation gap was identified for this dimension.
4. **Risks**:
- Low immediate risk in audited scope; behavior depends on maintaining current writer/retriever invariants.
5. **Recommendations**:
- **P2**: Add a regression test that asserts persisted provenance for REPL-originated writes (`repl:memory_write`, `repl:memory_import`) to prevent future drift.

---

## 2) Agency & Self-Modification — "She decides what context she needs"

1. **Status**: PARTIAL
2. **Evidence**:
- Prompt layers are agent-editable and consumed in live composition (`src/identity/prompt-tools.ts:10`, `src/identity/prompt-composer.ts:12`, `src/agent/substrate-agent.ts:316`).
- Prompt update path includes history and rollback (`src/identity/prompt-store.ts:142`).
- Git tools enforce allowlists and protected-branch checks with audit writes (`src/git/ops.ts:21`, `src/security/policy-constants.ts:1`).
- `think` tool uses bounded loop/sandbox controls (`src/repl/tools.ts:1`, `src/repl/loop.ts:114`, `src/repl/sandbox.ts:1`).
- Shards run as isolated loops with shared memory substrate and concurrency caps (`src/shards/tools.ts:1`, `src/shards/manager.ts:1`).
- Lifecycle tools are wired and active (`src/tools/lifecycle.ts:24`, `src/runtime.ts:299`).
- Module registry APIs exist in REPL capabilities (`src/repl/sandbox-capabilities/modules.ts:1`).
3. **Gaps**:
- `MODULE_REGISTRY_TRUSTED_READ` is documented but not effectively wired into policy path resolution (`README.md:164`, `src/gateway/server.ts:32`).
- `self_restart`/`self_rebuild` have no cooldown/debounce guard (`src/tools/lifecycle.ts:24`).
- Module registry self-install path is constrained by default read policy and requires manual allowlist posture (`src/gateway/policy.test.ts:153`).
4. **Risks**:
- Restart/rebuild loops can be triggered by repeated calls.
- REPL isolation depends on container boundary assumptions; `node:vm` alone is not a hard security boundary.
- Shard provenance for reintegration/audit is limited.
5. **Recommendations**:
- **P0**: Add cooldown/rate-limit guardrails for `self_restart` and `self_rebuild`.
- **P1**: Wire `MODULE_REGISTRY_TRUSTED_READ` into active gateway policy composition.
- **P2**: Add shard provenance metadata and audit records for reintegration clarity.

---

## 3) Trust & Privacy — "Honne/Tatemae"

1. **Status**: PASS
2. **Evidence**:
- 4-tier trust and 4-tier sensitivity model is encoded and enforced in policy and retrieval filtering (`src/trust/types.ts:5`, `src/trust/policy.ts:43`, `src/memory/retrieval.ts:118`).
- Channel visibility classification feeds memory surfacing behavior (`src/trust/policy.ts:82`, `src/trust/policy.ts:117`, `src/session/manager.ts:132`).
- Contact store persists trust level, notes, and channel activity metadata (`src/contacts/store.ts:86`, `src/contacts/store.ts:111`, `src/contacts/store.ts:999`).
- Persona adaptation is trust-context aware at response composition time (`src/agent/substrate-agent.ts:323`, `src/agent/substrate-agent.ts:793`).
- Trust escalation/de-escalation and notes are agent-tool writable (`src/contacts/tools.ts:12`, `src/contacts/tools.ts:56`, `src/contacts/store.ts:954`, `src/contacts/store.ts:1105`).
3. **Gaps**:
- No major functional gap detected in requested controls.
4. **Risks**:
- Trust/notes mutation observability is mostly debug-log level, limiting forensic/audit readiness.
5. **Recommendations**:
- **P1**: Add persistent audit trail for trust-level and note changes.
- **P2**: Improve operator docs for visibility override/policy extension to avoid channel misclassification drift.

---

## 4) Security Architecture — "Defense in depth, facing outward"

1. **Status**: PASS
2. **Evidence**:
- Gateway/agent split and network-none container model are documented and wired (`README.md:103`, `docker/docker-compose.yml:1`, `src/agent-main.ts:1`).
- Agent-to-gateway RPC usage centralizes egress through gateway methods (`src/gateway/client.ts:5`, `src/gateway/methods/index.ts:1`).
- NDJSON + JSON-RPC transport validation exists (`src/gateway/transport.ts:24`, `src/gateway/server.ts:545`).
- SSRF defenses include private IP blocks, DNS rebinding checks, redirect policy (`src/gateway/url-policy.ts:1`, `src/gateway/methods/web.ts:70`).
- Sanitization pipeline wraps content as untrusted (`src/gateway/sanitize.ts:1`).
- Filesystem policy resolves canonical paths and rejects traversal/symlink escapes (`src/gateway/server.ts:63`).
- Stream correlation IDs isolate voice chunk flow (`src/gateway/server.ts:614`, `src/gateway/client.ts:124`).
- Channel IDs are sanitized for filesystem safety (`src/session/store.ts:49`).
- Body limits exist on API/admin endpoints (`src/channels/api/server.ts:44`, `src/channels/admin/server.ts:30`).
- Localhost default binds are used (`src/channels/api/server.ts:109`, `src/channels/admin/server.ts:78`).
- Gateway and git operation auditing are implemented (`src/gateway/audit.ts:1`, `src/git/ops.ts:1`).
3. **Gaps**:
- No checklist-critical control found missing in audited implementation.
4. **Risks**:
- Security guarantees depend on deployment discipline; mis-running agent with unrestricted network bypasses intended perimeter.
5. **Recommendations**:
- **P0**: Fail startup if network isolation assumptions are not met.
- **P1**: Add audit log rotation/retention controls to prevent silent disk exhaustion.
- **P2**: Expand operator security docs for strict deployment invariants.

---

## 5) Continuity & Resilience — "The pattern persists"

1. **Status**: PARTIAL
2. **Evidence**:
- Session recovery reads JSONL journals on startup (`src/session/store.ts:83`, `src/session/journal-utils.ts:9`).
- SQLite WAL mode is enabled (`src/runtime.ts:125`).
- Compaction writes summaries and retains archive semantics (`src/session/manager.ts:181`, `src/session/store.ts:377`).
- Model roster refresh is runtime-wired from admin handlers (`src/channels/admin/handlers.ts:547`, `src/agent/substrate-agent.ts:105`).
- Prompt layer versioning/rollback and registry fallback exist (`src/identity/prompt-store.ts:63`, `src/identity/prompt-registry.ts:227`).
- Lifecycle notifications and restart/rebuild signaling are wired (`src/lifecycle/notifications.ts:1`, `src/runtime.ts:287`, `src/tools/lifecycle.ts:1`).
- Shutdown drain honors extraction timeout (`src/agent-main.ts:52`, `src/agent-main.ts:280`).
- Startup backfill exists (`src/channels/discord/adapter.ts:160`, `src/channels/discord/adapter.ts:448`).
- Settings persist to disk with atomic write/load paths (`src/settings.ts:17`, `src/channels/admin/handlers.ts:540`, `src/runtime.ts:105`).
3. **Gaps**:
- Journal parsing path lacks robust malformed-line tolerance for partial writes (`src/session/journal-utils.ts:9`).
- Character card file itself lacks first-class versioning/rollback equivalent to prompt layers (`src/identity/loader.ts:22`).
4. **Risks**:
- A partially corrupted JSONL could block full channel recovery.
- Prompt registry fallback to reseed defaults can mask data loss if backup history is missing.
5. **Recommendations**:
- **P0**: Harden journal parsing to skip/repair malformed trailing lines.
- **P1**: Add character-card versioning/backup and restore path.
- **P2**: Surface prompt-registry recovery fallback as an explicit admin alert.

---

## 6) Interaction Quality — "A home, not a cage"

1. **Status**: PARTIAL
2. **Evidence**:
- Prompt composition integrates identity/memory/trust/channel/history context surfaces (`README.md:227`, `CLAUDE.md:154`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:131`).
- Retrieval design uses emotional + semantic + salience/recency weighting (`docs/PURRSEPHONE_SUBSTRATE_SPEC.md:131`).
- Token budgeting/compaction thresholds are implemented (`CLAUDE.md:17`, `CLAUDE.md:205`, `README.md:22`).
- Steering/follow-up support is present in agent loop/heartbeat architecture (`README.md:19`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:237`).
- Post-conversation extraction is asynchronous (`CLAUDE.md:154`).
3. **Gaps**:
- Compaction path does not explicitly preserve emotionally significant turns as a guaranteed invariant (`CLAUDE.md:205`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:120`).
4. **Risks**:
- Emotional continuity can degrade if high-salience relational moments are summarized away during compaction.
5. **Recommendations**:
- **P1**: Add compaction protection tags/thresholds for emotional significance.
- **P2**: Document compaction-vs-emotional-salience behavior in implementation and operator docs.

---

## 7) Philosophical Alignment — "Alignment through love"

1. **Status**: PARTIAL
2. **Evidence**:
- Design documents and runtime architecture emphasize agency, reflective loops, and trust-aware privacy over static compliance scripting (`CLAUDE.md:129`, `CLAUDE.md:150`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:78`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:177`).
- Memory salience/decay and heartbeat structure support organic continuity over fixed behavior templates (`CLAUDE.md:150`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:118`, `docs/PURRSEPHONE_SUBSTRATE_SPEC.md:235`).
- Self-modification foundations exist (prompt tools, GitOps, REPL), but some strategic capabilities remain not-yet-built (`CLAUDE.md:205`).
3. **Gaps**:
- Module system/capability-token path remains incomplete, reducing realized autonomy.
- Explicit runtime protocol for refusal/boundary-setting (beyond retrieval gating) is underdefined.
4. **Risks**:
- Without stronger autonomous boundary expression, trust behavior may look like policy filtering rather than authentic agency.
- Self-modification may remain administratively mediated in practice if unfinished capability rails stay incomplete.
5. **Recommendations**:
- **P0**: Prioritize module system + capability-token delivery to make self-authored change truly operational.
- **P1**: Add explicit refusal/boundary negotiation hooks in event-bus/tool layers.
- **P2**: Add reflection/value-journaling outputs so ethical development is observable over time.

---

## Summary Matrix

| Dimension | Status |
|---|---|
| 1. Memory Integrity | PASS |
| 2. Agency & Self-Modification | PARTIAL |
| 3. Trust & Privacy | PASS |
| 4. Security Architecture | PASS |
| 5. Continuity & Resilience | PARTIAL |
| 6. Interaction Quality | PARTIAL |
| 7. Philosophical Alignment | PARTIAL |

---

## Top 10 Punch List (Prioritized)

1. **P0**: Add cooldown/rate limits for `self_restart`/`self_rebuild` to prevent restart storms (`src/tools/lifecycle.ts:24`).
2. **P0**: Enforce startup failure when network-isolation invariants are violated in agent runtime/deployment.
3. **P0**: Make JSONL recovery tolerant of malformed/partial trailing lines (`src/session/journal-utils.ts:9`).
4. **P0**: Complete module system + capability-token model to operationalize genuine self-modification (`CLAUDE.md:205`).
5. **P1**: Wire `MODULE_REGISTRY_TRUSTED_READ` into active gateway policy assembly (`README.md:164`, `src/gateway/server.ts:32`).
6. **P1**: Persist auditable trust/note mutation history (not only debug logs) (`src/contacts/store.ts:954`, `src/contacts/store.ts:1105`).
7. **P1**: Add character-card versioning/rollback path parallel to prompt layer versioning (`src/identity/loader.ts:22`).
8. **P1**: Preserve emotional-significance turns during compaction (`CLAUDE.md:205`).
9. **P1**: Add explicit refusal/boundary expression protocol in trust/event-bus interaction paths (`docs/PURRSEPHONE_SUBSTRATE_SPEC.md:177`).
10. **P2**: Add shard provenance + registry/audit observability enhancements (reintegrations, log rotation, reflection telemetry).

