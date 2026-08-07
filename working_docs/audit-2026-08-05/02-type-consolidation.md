# Audit Lane 2 — Type Definition Consolidation

Date: 2026-08-05. Branch: `feat/emosim-fleet-shakedown` (working tree as-is). Read-only.

## Scope & method

Goal: inventory the type-definition landscape; find types defined in multiple places that
should be shared, misplaced types that belong in canonical contract layers, and same-name
collisions between unrelated shapes.

Method:

1. Extracted every top-level `export interface|type` name across `src/`, `companion-ui/src`,
   `admin-ui/src` and histogrammed duplicates:
   `grep -rEhI "^export (interface|type) [A-Z]" src companion-ui/src admin-ui/src --include="*.ts" | sed ... | sort | uniq -c`.
   ~120 names appear 2+ times. Every duplicate name was then resolved to its defining files
   and both definitions were opened and read (no flag from name alone).
2. Read in full or in large part: `src/boundary/gateway/protocol.ts` (1465 lines),
   `src/shared/contracts/runtime.ts` + `runtime-base.ts` (relevant sections),
   `companion-ui/src/lib/api/gateway-protocol.ts` (356 lines, full),
   `companion-ui/src/lib/protocol/framing.ts` (header), `companion-ui/README.md`,
   `src/shared/utils/types.ts` (105 lines, full), `src/system/settings/contracts.ts` (head),
   `src/system/settings/schema.ts`, `src/system/config/settings-contract.ts`,
   `src/boundary/pi-agent/substrate-agent-tool.ts` (full),
   `admin-ui/src/lib/types/index.ts` (relevant sections) and
   `admin-ui/src/lib/types/canonical-type-aliases.test.ts` (head).
3. Spot-checked the typebox-schema vs hand-interface leg in `src/core/tools/ntfy.ts`,
   `src/faculties/memory/tools.ts`, `src/core/scheduler/schedule-tool.ts`,
   `src/core/agent/no-reply-tool.ts`.
4. Checked the settings/owner-file leg: Garden service types
   (`src/operator/garden/services/types/settings.ts`) and admin-ui settings routes for
   re-declared settings shapes.
5. Consulted `working_docs/READONLY_AUDIT_*_20260721.md` for leads; none of the prior audits
   covered type-name duplication, so all findings here are fresh and independently verified
   against current code.

Coverage limits: this is a name-collision + same-shape sweep. Types with *different* names
describing the same payload (structural duplication without a shared name) were only sampled
(the typebox leg), not exhaustively mapped. `PSFN-Satellite-Hub/` internals were treated as a
read-only protocol reference per `companion-ui/README.md` and not audited as consolidation
targets. No builds or test runs (audit constraints).

## Critical assessment

No critical (security/fail-open) findings in this lane. The type landscape is in much better
shape than a repo this size usually is: cross-process wire types are centralized in
`src/shared/contracts/`, the gateway↔agent JSON-RPC protocol has exactly one home
(`src/boundary/gateway/protocol.ts`, imported by both `server.ts`/`methods/*` and
`client.ts`), memory domain types are single-sourced in `src/faculties/memory/types.ts` and
imported by `src/core/`, and the admin-ui mirror is systematically aliased with a drift test.
The findings are therefore about a handful of genuine duplicates and several same-name
collisions that will confuse readers and can silently drift.

### Major

**M1 — `RuntimeMode`: two exported types, same name, disjoint value sets.**
- `src/system/lifecycle/runtime-mode.ts:9` — canonical process-topology mode:
  `'split' | 'gateway-agent'` (derived from `RUNTIME_MODE`, line 4-7).
- `src/core/agent/tool-wiring-validator.ts:220` — `export type RuntimeMode = 'gateway';`
  a single-literal stub meaning "validate against the gateway tool wiring".
- The stub is imported into production code: `src/faculties/shards/manager.ts:18`
  (`runtimeMode?: RuntimeMode` dep at line 230) and
  `src/faculties/subagents/faculty.ts:19` (line 186).
- Why it matters: the two types are semantically unrelated, their values don't even overlap
  (`'gateway'` ∉ `'split' | 'gateway-agent'`), and both names read as "the" runtime mode.
  Any reader of `ShardManagerDeps.runtimeMode` will reasonably assume the lifecycle type.
  Type mismatch currently fails at compile time (good), but the collision invites wrong
  imports in composition code (`src/app/startup/`) where both are in scope.
- Recommendation: rename the validator's type to e.g. `ToolWiringValidationMode` (mechanical;
  ~4 files).

**M2 — `SatelliteRoutingMetadata`: two unrelated shapes, same name, both widely imported.**
- `src/shared/contracts/satellite-registry.ts:436` — wire contract: `schemaVersion: 1`,
  required `satelliteId`, `endpointId`, `claimType`, `sessionId`, `mobility`, `capabilities`,
  `telemetryScopes`, `auth`, … (fully required registry snapshot).
- `src/core/agent/satellite-adapter-port.ts:22` — agent-internal delegation hint: every field
  optional (`connectionId?`, `sessionId?`, `turnId?`, `siteId?`, `satelliteId?`, `presence?`,
  `shardDelegation?`). Structurally incompatible with the registry type despite sharing
  `satelliteId`/`sessionId`.
- Importers are currently disjoint sets (registry side: `src/boundary/gateway/server.ts:20`,
  `src/channels/api/server/session.ts:21`, `src/shared/contracts/runtime-base.ts:21`; port
  side: `src/faculties/shards/types.ts:13`, `src/faculties/shards/result-lineage.ts:2`,
  `src/faculties/shards/manager.ts`), so nothing breaks today — but 13 files reference one
  or the other, and the port type's name claims a canonical-contract meaning it doesn't have.
- Why it matters: a future edit that wires shard delegation results into satellite registry
  reporting (plausible — both concern satellites) will produce a silent structural mismatch
  the moment both are imported into one module.
- Recommendation: rename the port type to `SatelliteDelegationRoutingHint` (it sits next to
  `SatelliteShardDelegationHint` in the same file). Mechanical, ~5 files.

**M3 — `PolicyDecision` / `PolicyContext`: same names, different domains, different values.**
- `src/system/trust/policy.ts:112` — `PolicyDecision = 'allow' | 'deny' | 'sanitize'`;
  `src/system/trust/policy.ts:134` — `PolicyContext` = trust/channel-privacy/memory-sensitivity
  disclosure context.
- `src/boundary/gateway/protocol.ts:1254` — `PolicyDecision = 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL'`;
  `src/boundary/gateway/protocol.ts:1256` — `PolicyContext` = `{ method, params, callerClass }`
  RPC-gate context.
- Both pairs are exported and consumed by sibling policy modules
  (`src/boundary/gateway/policy.ts:3` imports the gateway pair; trust consumers import the
  trust pair). Today no file imports both, and the value casing difference makes accidental
  cross-use a compile error.
- Why it matters: "policy" is one of the most load-bearing words in this repo (fail-closed
  policy gates). Two exported `PolicyDecision` types with different casing conventions is a
  standing invitation to wire the wrong enum into an audit log or comparison.
- Recommendation: rename the gateway pair to `GatewayPolicyDecision` / `GatewayPolicyContext`
  (the gateway pair is the less-widely-imported one). Mechanical, contained to
  `src/boundary/gateway/`.

### Minor — true duplicates (identical shapes, consolidation candidates)

**m1 — `Awaitable<T>` re-declared in 12 files.** `type Awaitable<T> = T | Promise<T>` appears
in: `src/faculties/memory/memory-store-port.ts:499`, `src/core/contacts/trust-drift-signals.ts:14`,
`src/core/contacts/contact-store-port.ts:49`, `src/core/enrollment/enrollment-store-port.ts:9`,
`src/core/intention/concern-route-handoff.ts:7` (exported),
`src/core/intention/pending-follow-up-store-port.ts:1` (exported),
`src/core/intention/{social-desire,behavioral-pattern,concern,weighted-thought}-store-port.ts`,
`src/core/cogsec/revocation.ts:17`, `src/core/cogsec/regeneration.ts:23`. The canonical
utility-types home `src/shared/utils/types.ts` has guards but no `Awaitable`. Zero drift risk
per instance, but it is exactly the kind of type the repo convention says lives in
`src/shared/utils/types.ts`. Trivial mechanical fix: one export, 12 import swaps.

**m2 — `TextEmotionDType`: hand-written union vs const-derived, same values.**
`src/shared/contracts/runtime-base.ts:265` lists the 9 dtypes by hand;
`src/core/emotion/text-classifier.ts:14-19` defines `TEXT_EMOTION_DTYPE_VALUES` const + derived
type with the identical list. `src/system/config/runtime-config-contracts.ts` imports the
runtime-base one. If a dtype is added to the transformers.js support list, two edits are
required and nothing enforces consistency. Fix direction: keep the const in
`text-classifier.ts` (runtime needs values for validation) and make the shared-contract type
an import — or add a `satisfies`/assertion test tying them together. Needs a small layering
decision (shared/contracts importing from core/emotion inverts the usual direction, so the
assertion-test option may fit repo convention better).

**m3 — `METACOGNITIVE_FLAG_NAMES` duplicated literal-for-literal.**
`src/shared/contracts/self-model-contracts.ts:87-96` and
`src/core/identity/prompt-runtime/macro-hints.ts:3-11` define the same 5-flag literal array
(`uncertainty`, `avoidance`, `high_engagement`, `repetition`, `confabulation_risk`) under two
const names and export the same-named `MetacognitiveFlagName` type from both. The canonical
contract is the self-model one (imported by `src/core/self-model/metacognition.ts:9,15`).
`macro-hints.ts` should import the const (or at least the type) from
`src/shared/contracts/self-model-contracts.ts`. Mechanical.

**m4 — `ReflectionPublishInput` identical in two sibling integrations.**
`src/boundary/integrations/vault/auto-publish.ts:12-18` and
`src/boundary/integrations/journal/auto-publish.ts:7-13` — byte-identical 5-field interface.
Both files are parallel auto-publishers differing only in folder maps; the input type (and
much of the file skeleton) should be shared from one place
(e.g. `src/boundary/integrations/reflection-publish-input.ts` or the reflection runtime).
Mechanical.

**m5 — `FleetRestoreDatabaseOperation` identical, same directory.**
`src/persistence/backups/fleet-restore-transaction.ts:80-83` and
`src/persistence/backups/fleet-restore-database-marker.ts:17-20` — identical
`{ operationId, operationIdentity }`. Additionally the state union is defined twice under
two names with identical values: `FleetRestoreDatabaseOperationState` (transaction file, line 84)
and `FleetRestoreDatabaseMarkerState` (marker file, line 22), both
`'absent' | 'prepared' | 'committed' | 'foreign'`. Same-package duplication; the marker file
can export and the transaction file import. Mechanical.

**m6 — `ShardAuditTrail` identical, same subsystem.**
`src/faculties/shards/manager.ts:207-209` and `src/faculties/shards/tool-sync.ts:22-24` —
identical one-method interface (`append(event, details?): unknown`). Both are in
`src/faculties/shards/`; no boundary justifies two definitions. Mechanical (move to
`types.ts` or have tool-sync import from manager — check import-cycle direction first).

**m7 — `ReflectionExecutionSource` identical union in two files, both live in one import graph.**
`src/persistence/journals/reflection-substrate.ts:33-37` and
`src/core/scheduler/reflection-template-runtime/runtime-helpers.ts:22` — identical 4-member
union. `src/core/scheduler/reflection-template-runtime.ts` imports the runtime-helpers one
(line 95) *and* imports from reflection-substrate (line 50) in the same module, so a value
produced under one type flows into a parameter typed by the other. Structurally compatible
today; silently divergent the day someone adds a fifth source to one side only. Mechanical:
runtime-helpers should re-export from reflection-substrate (or vice versa — persistence owns
the persisted discriminator, so persistence should be the home).

**m8 — `ScratchpadEntry` identical across the agent/memory port seam.**
`src/faculties/memory/memory-store-port.ts:120-125` and
`src/core/agent/scratchpad-port.ts:1-6` — identical `{ id, content, createdAt, updatedAt }`.
`scratchpad-port.ts` documents itself as a deliberate narrow synchronous port (comment at
lines 8-10), which justifies the *interface* (`ScratchpadProvider`) but not re-declaring the
*record shape*. `src/core/agent/contracts.ts:24` re-exports the scratchpad-port one.
Mechanical: scratchpad-port imports the record from memory-store-port.

**m9 — `BeadsAction` union duplicated.**
`src/boundary/gateway/protocol.ts:472` hand-writes
`'ready' | 'show' | 'create' | 'update' | 'close' | 'sync'`;
`src/boundary/integrations/beads/enablement.ts:14-15` defines `ALL_BEADS_ACTIONS` const +
derived `BeadsAction` — and that file's header comment explicitly claims to be the "single
source of truth" for beads enablement so gateway policy and agent registration agree.
Values match today; the protocol union can silently drift from the const. Fix: protocol.ts
imports the type from enablement.ts (enablement imports only env utils — no cycle risk).
Mechanical.

**m10 — `McpExecuteResult` inlines literal unions that have canonical types.**
`src/boundary/gateway/protocol.ts:356-406` embeds
`'primary' | 'trusted' | 'regular' | 'public'` (canonical: `TrustLevel`,
`src/shared/contracts/trust-contracts.ts:1`),
`'read' | 'write' | 'read_write' | 'destructive' | 'control'` (canonical: `McpToolEffect`,
`src/system/config/mcp-servers-config.ts:70`),
`'never' | 'sensitive' | 'always'` (`McpConfirmationMode`, same file, line 73), and
`'public' | 'personal' | 'intimate' | 'confidential'` (`SensitivityLevel` — which protocol.ts
*already imports* at line 103 and uses elsewhere, e.g. line 206). Four inline copies of
policy vocabularies inside a wire contract. Mechanical: use the canonical types.

**m11 — `EchoStreamingTtsConfig`: drifted same-name pair + export-star shadowing.**
`src/primitives/voice/connectors/tts/index.ts:14-19` declares
`{ url: string; voice: string; preset?: string; model?: string }` (provider-settings shape);
`src/primitives/voice/connectors/tts/echo-stream.ts:25-32` declares
`{ baseUrl?; voice?; preset?; model?; extraBody?; headers?; fetchImpl? }` (connector config).
They have already drifted in both nullability and field name (`url` vs `baseUrl`), bridged by
a manual adapter at `index.ts:113-118`. Worse, `index.ts` does `export * from './echo-stream.js'`
(line 9) while declaring a conflicting local export — the local declaration silently shadows
the star-exported one, so which `EchoStreamingTtsConfig` you get depends on which module
path you import from. Recommendation: rename one (e.g. `EchoTtsProviderSettings` in index.ts).
Small, mechanical.

**m12 — `ManagedSkillRecord` hand-copied subset.**
`src/operator/garden/admin-contract.ts:143-150` re-lists the fields of
`src/faculties/skills/store.ts:136-145` minus `absolutePath`/`relativePath`. Should be
`Omit<ManagedSkillRecord, 'absolutePath' | 'relativePath'>` (possibly with the store type
renamed/re-exported) so added fields propagate. Mechanical.

**m13 — `WebSocketVoiceSession` near-duplicate across voice transport layers.**
`src/channels/api/voice-websocket.ts:29-33` (`{ id, openedAtMs, lastSeenAtMs }`) vs
`src/primitives/voice/transports/websocket/types.ts:86-91` (same + `connectionId`). The
channels/api type is the primitives type minus one field; could be
`Omit<WebSocketVoiceSession, 'connectionId'>`. Low drift stakes; mechanical.

### Minor — same-name, different-shape collisions (rename, not merge)

**c1 — `CogSecCompactionInvalidationResult`.**
`src/persistence/sessions/store.ts:315-319` (`{ caseId, channelId, invalidatedCompactionIds: number[] }`)
vs `src/core/cogsec/revocation.ts:56-58` (`{ invalidatedCompactionIds: string[] }`).
The bridge adapter in `src/operator/garden/services/session-service.ts:278-302` maps between
them by re-keying numeric ids as `` `${channelId}:${id}` `` strings — so the name collision
spans an actual data-shape conversion (number ids vs composite string ids). The adapter is
deliberate; the identical name for pre- and post-mapping shapes is not. Rename the revocation
one (e.g. `CogSecCompactionRevocationOutcome`). Mechanical, few files.

**c2 — `TurnSnapshot`.** `src/primitives/voice/turns/types.ts:29` (voice state-machine
snapshot) vs `src/core/turns/snapshot.ts:198` (persisted turn record snapshot). Unrelated
domains, both legitimately named. Not flagged as a defect — noted here only because the name
is load-bearing; a rename is optional. Nit.

### Pattern finding — typebox schema vs hand-written params interface (drift risk, documented intent)

Tool implementations follow a deliberate contract documented in
`src/boundary/pi-agent/substrate-agent-tool.ts:1-18`: the scheduler validates every call
against the tool's typebox `parameters` schema before `execute` runs, so `execute` annotates
a concrete params interface over already-validated data. That intent is sound and this audit
does not dispute it. The drift surface is *how* the interface is produced:

- Good pattern (drift-free): `src/core/agent/no-reply-tool.ts:18-30` names the schema and
  derives `type ResponseControlParams = Static<typeof RESPONSE_CONTROL_PARAMETERS>`.
- Common pattern (drift-prone): anonymous inline `parameters: Type.Object({...})` /
  `Type.Union([...])` plus a separate hand-written flat interface. Examples:
  `src/faculties/memory/tools.ts:395-431` (`MemoryToolParams`, ~25 fields) vs the inline
  schemas starting at `tools.ts:465,579,689,...`; `src/core/tools/ntfy.ts:222-243`
  (`NotifyToolParams`) vs the 6-member `Type.Union` at `ntfy.ts:973-1058`;
  `src/core/scheduler/schedule-tool.ts:121-150` (`ScheduleToolParams`, ~30 fields) vs the
  inline `Type.Object` at line 527.
- Note the hand interfaces also accumulate *dual-spelling* fields (`contact_id?` +
  `contactId?`, `scope_kind?` + `scopeKind?` in `MemoryToolParams`) that the schema only
  partly mirrors — the interface is neither derived from nor checked against the schema.
- Impact is bounded: runtime behavior comes from the schema; a stale interface field degrades
  to `undefined` reads inside the handler. This is a maintainability/type-safety issue, not
  a runtime hole — the fail-closed guarantee is carried by the schema validation.
- Recommendation: for plain `Type.Object` schemas, name the schema const and use
  `Static<typeof>`; for unions, derive a `Static<typeof union>` and narrow per action in the
  handler instead of maintaining a parallel flat interface. Medium effort (touches ~dozens
  of tool files if done repo-wide; could be done incrementally per tool).

## Recommendations

Ordered by value/effort. All are safe mechanical changes unless noted.

1. **Rename the colliding policy/runtime/satellite types (M1–M3, c1).** Biggest
   confusion-per-line in the lane. `RuntimeMode` (validator) → `ToolWiringValidationMode`;
   port-side `SatelliteRoutingMetadata` → `SatelliteDelegationRoutingHint`; gateway
   `PolicyDecision`/`PolicyContext` → `GatewayPolicy*`; revocation-side
   `CogSecCompactionInvalidationResult` → distinct name. Effort: ~0.5–1 day total, each
   contained to one subsystem; pure renames, type-checked.
2. **Consolidate the identical duplicates (m1, m3–m9).** Each is a 2-file change with an
   obvious canonical home: `Awaitable` → `src/shared/utils/types.ts`; `MetacognitiveFlagName`
   const → `src/shared/contracts/self-model-contracts.ts`; `ReflectionPublishInput` → a
   shared integrations module; `FleetRestoreDatabaseOperation` + state union → marker file;
   `ShardAuditTrail` → `src/faculties/shards/types.ts`; `ReflectionExecutionSource` →
   `src/persistence/journals/reflection-substrate.ts`; `ScratchpadEntry` →
   memory-store-port; `BeadsAction` → enablement.ts. Effort: ~1 hour each, all mechanical.
3. **Replace inline policy literals in `protocol.ts` `McpExecuteResult` with the canonical
   vocabulary types (m10)** — `TrustLevel`, `McpToolEffect`, `McpConfirmationMode`,
   `SensitivityLevel` (already imported). ~30 minutes, mechanical.
4. **Fix the `EchoStreamingTtsConfig` shadowing (m11).** Rename the index.ts settings shape;
   the `export *` shadowing is fragile and already-drifted. ~1 hour. Slight design choice in
   naming.
5. **`Omit`-derive the admin/subset types (m12, m13).** `ManagedSkillRecord`,
   `WebSocketVoiceSession`. ~30 minutes.
6. **Decide a policy for schema-derived tool params (pattern finding).** Adopt
   `Static<typeof schema>` as the default (per the existing `no-reply-tool.ts` precedent) and
   convert opportunistically; at minimum, require named schema consts for new tools.
   Repo-wide conversion is multi-day; writing the convention down and converting the three
   worst offenders (`memory/tools.ts`, `ntfy.ts`, `schedule-tool.ts`) is ~1 day. This one
   benefits from a short design note before mass edits.
7. **`TextEmotionDType` (m2): add a compile-time tie between the two definitions** (a
   `satisfies`/equivalence assertion or a test) if the layering direction makes a plain import
   awkward. ~1 hour.

Nothing here needs a large refactor or a migration; the highest-risk item is the repo-wide
tool-params convention change (#6), which should stay incremental.

## Risks & false positives

Deliberately **not** flagged:

- **`companion-ui/src/lib/protocol/events.ts` + `framing.ts` + `api/gateway-protocol.ts`** —
  a documented, deliberate mirror of the Satellite Hub wire protocol
  (`companion-ui/README.md`: hub is a read-only protocol reference; the mirror "remains as a
  strictly validated view/event adapter and protocol regression surface"). It already imports
  shared guards/contracts from the root (`src/shared/utils/types.ts`,
  `src/shared/contracts/satellite-registry.ts`, `shard-directory.ts`) and re-validates all
  untrusted wire data fail-closed (`hasExactKeys`, bounded strings, allowlisted enums). This
  is a trust boundary, not duplication.
- **admin-ui `Canonical*` aliases** — `admin-ui/src/lib/types/index.ts` and
  `api/endpoints/*.ts` alias backend types (`export type SessionEntry = CanonicalSessionEntry`,
  etc.) and `admin-ui/src/lib/types/canonical-type-aliases.test.ts` pins the aliases against
  the canonical definitions. This is a tested mirroring discipline, the opposite of drift.
- **admin-ui `AuditEntry` (`admin-ui/src/lib/types/index.ts:1011`)** vs
  `src/boundary/gateway/audit-port.ts:3` — different shapes, but the admin-ui one is a UI
  view model over merged Garden/gateway/charge history, not a mirror. Fine.
- **`SubagentExecutionRequest`** (`src/core/agent/substrate-agent/bounded-subagent-contract.ts:79`),
  **`ConcernCandidateExtractionContext`** (`src/core/intention/concern-candidate-types.ts:12`),
  **`ShardCreationMode`** (`src/faculties/shards/types.ts:20`) — plain type aliases to a
  single canonical definition; duplicates in name only because grep counts alias sites.
- **`PromptSectionScopeResolver`** (`src/core/identity/prompt-sections.ts:14` vs
  `prompt-section-provenance.ts:103`) — two function-type aliases whose return types resolve
  to the same underlying `scopeProvenance` shape; the provenance file documents the UI
  contract relationship (lines 18-21). Borderline; left unflagged because both are narrow
  local aliases of a shared telemetry type.
- **Tool param interfaces generally** — see the pattern finding; the validated-params
  contract is documented intent in `substrate-agent-tool.ts`, so only the hand-written (vs
  `Static`-derived) maintenance hazard is flagged, not the existence of the interfaces.
- **`unknown` params / `Record<string, unknown>` at RPC and intake boundaries** — correct per
  repo rules (untrusted wire data), not weak typing.
- **`RuntimeMode` in `tool-wiring-validator.ts`** is flagged for the name collision only;
  whether the single-literal stub should exist at all is a dead-code/weak-types lane
  question (see cross-lane notes).

Candidates needing human verification:

- **m2 layering direction** (`TextEmotionDType`): whether shared/contracts may import from
  `src/core/emotion/` depends on the repo's import-graph seam rules
  (`config/import-graph-seams.json`); I did not run the import-graph gate. If the direction
  is disallowed, use the assertion-test option.
- **m6 import direction** (`ShardAuditTrail`): manager.ts and tool-sync.ts have existing
  cross-imports; consolidating needs a cycle check.
- The histogram method only catches same-named exports. Structurally duplicated payload
  types under *different* names (beyond the sampled tool-params case) likely exist and were
  not exhaustively mapped.

## Cross-lane notes

- **Weak-types lane:** `SubstrateAgentTool.execute` types `params: any`
  (`src/boundary/pi-agent/substrate-agent-tool.ts:31`) by design (pi-agent-core generic
  erasure, documented); hand-annotated interfaces at each `execute` site are the compensating
  control. Also `HomeAssistantState` carries `[key: string]: unknown`
  (`src/boundary/gateway/protocol.ts:835`) — deliberate upstream API passthrough.
- **Dead-code lane:** `RuntimeMode = 'gateway'` (`tool-wiring-validator.ts:220`) is a
  single-member type — worth checking whether a second mode was ever planned or the
  abstraction can collapse. `GitHubProjectSyncResult`/`BeadsExternalSyncResult` surface in
  protocol.ts (lines 928-958) may warrant a liveness check.
- **Legacy/shim lane:** `src/system/settings/schema.ts` keeps `LEGACY_MODEL_SETTINGS_KEYS`
  (lines 17-26) — check against the alpha migration boundary in `docs/specifications.md`
  for whether the legacy model-settings acceptance still has a named exception.
- **Comments/slop lane:** several duplicated types carry comments that must move with the
  canonical definition if consolidated (e.g. the `scratchpad-port.ts` port-rationale comment,
  the `enablement.ts` single-source-of-truth header).
- **Dedup lane:** `vault/auto-publish.ts` and `journal/auto-publish.ts` are near-identical
  files beyond the shared input type (same folder-map structure, same publish flow) — a
  code-dedup candidate broader than the type-level fix in m4.
