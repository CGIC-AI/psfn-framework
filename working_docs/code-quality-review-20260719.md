# Code Quality Review — 2026-07-19

> **WAVE COMPLETE (2026-07-19).** All 18 items (aylm.1–.17 + upx0.9) implemented, blind-reviewed,
> and integrated on `feat/aylm-code-quality` @ `ea3be9d8c` (base origin/main@00e60a25b2, reconciled).
> Epic seam review (dual blind) found 2 verified blockers, both remediated in one round:
> the stale subsystem-health event union (pre-existing backend bug surfaced into svelte-check by
> canonicalization) and the hardcoded-settings baseline drift from constant relocations.
> Final assembly gates: tsc 219 (was 220 pre-existing — wave net-fixed one), madge ZERO cycles,
> verbatimModuleSyntax on, eslint clean, svelte-check 2561 files/0 errors, hardcoded-settings green.
> Deployment prerequisites (operator, before live rollout): aylm.14 one-entry companions.json;
> aylm.15 `migrate:prompt-layer-identifiers -- --apply` per companion; aylm.16
> `migrate:session-filenames -- --apply` per companion. Full handoff in the epic close on
> bead `psfn-framework-aylm`.

Eight parallel read-only review agents (Opus) swept `src/` and `admin-ui/src/`, one per dimension:
duplication/DRY, type consolidation, unused code (knip/ts-prune), circular deps (madge), weak types,
error hiding, legacy/fallback paths, and AI-slop/comments. All findings were produced with file:line
evidence and reference-verification; nothing has been changed in the tree. Severity labels are the
reviewers' grades — per standing policy, verify any blocker-grade item against the Blocking Risk
Standard before remediation.

## Executive summary

The codebase is in **good shape overall**: the AI-slop sweep found essentially nothing (one P3
comment), error handling in the config/gateway/intake layers is exemplary fail-closed work, all 36
madge cycles are type-only (no runtime hazards), and the "unused code" surface is small and mostly
superseded-duplicate files. The real, concentrated debt is:

1. **Type drift across the src ↔ admin-ui boundary** — 113 type names hand-mirrored, several with
   live drift (admin still models a retired enum value; `Contact` weakened and missing fields).
   Highest-value fix in the whole review, and mechanically cheap (admin-ui already imports from `src`).
2. **One weak-type cluster** — the agent tool-call loop passes `any` where pi-ai/pi-agent-core export
   exact types; one union alias + two imports retires most of the repo's 47 `: any` hits.
3. **One layering violation** — `src/shared/contracts/runtime.ts` type-imports upward into `core/`,
   which alone manufactures ~24 of the 36 madge cycles.
4. **A handful of P2 error-swallows** in the Garden/admin and diagnostics layer (audit-write and
   quarantine-sidecar failures logged nowhere or debug-only).
5. **~15 mechanical DRY consolidations** with one clear P1 (channel long-running-status subsystem
   duplicated wholesale between Discord and Telegram).
6. **A few live legacy dual paths** that need a migration step before removal (fleet-SSO scalar
   fallback, prompt-layer `'main'` coercion, startup-time filename migration).

No P0 runtime-correctness defects were found by any lane. The drifted-type items are the closest
thing to live bugs (frontend can emit values the backend retired).

---

## 1. Duplication / DRY (agent 1)

jscpd: 307 production-to-production clones (1195 incl. tests). 15 ranked consolidations, all passing
the "same reason to change" test. Full jscpd JSON was written to the session scratchpad.

### Ranked findings

| # | Finding | Copies | Sev | Effort |
|---|---------|--------|-----|--------|
| F1 | **Long-running tool-status subsystem duplicated whole** (~90 lines each: constants, interface, 5 functions, byte-identical) | `src/channels/discord/adapter.ts:76,122,1161-1251` ⇄ `src/channels/telegram/adapter.ts:50,205,967-1035` | P1 | M |
| F2 | Fleet-auth session-row → snapshot mapping (20-field construction, no compiler linkage between copies) | `src/persistence/postgres/fleet-auth/authorization-context-store.ts:325-360` ⇄ `portal-authorization-store.ts:424-460` | P2 | M |
| F3 | `normalizeGatewayModelHint` (12-field LLMModelHint) + coercers duplicated in gateway — a param dropped in one path is a live-behavior bug | `src/boundary/gateway/client.ts:2180-2259` ⇄ `src/boundary/gateway/methods/llm.ts:680-759` | P2 | M |
| F4 | Local-time daily-window math (`getLocalMinuteOfDay`, wrap-around window logic) — timezone math deserves one tested home | `src/core/intention/proactive-time-gate.ts:80-108` ⇄ `src/core/scheduler/rest-window.ts:35-63` | P2 | S/M |
| F5 | Maintenance-CLI scaffold (parseArgs/bootstrap/`main().catch`) duplicated across ~15 entrypoints | `src/app/maintenance/*` (session-attribution-repair, session-integrity-repair, migrate-*, backfill-*, audit-*, …) | P2 | M |
| F6 | Image file-naming helpers byte-identical | `src/primitives/images/generated-media.ts:226-263` ⇄ `service.ts:82-119` | P2 | S |
| F7 | TTS connector abort/error helpers (`abortError`, `toError`, `responseError`, `combineAbortSignal`) | `src/primitives/voice/connectors/tts/echo-stream.ts:40-82` ⇄ `elevenlabs-stream.ts:17-49` | P2 | S |
| F8 | cogsec `uniqueStrings` + `mergeArtifactImpact` | `src/core/cogsec/regeneration.ts:154-172` ⇄ `revocation.ts:107-125` | P2 | S |
| F9 | Startup hydration `collectHydrationChannelIds` (memory vs wiki faculties) | `src/faculties/memory/startup-hydration.ts:47-67` ⇄ `src/faculties/wiki/startup-hydration.ts:53-73` | P2 | S/M |
| F10 | `clampListLimit` copy-pasted 4× in core/intention (parameterized twin already exists at `postgres-adapters/shared.ts:300`) | `care-reminders.ts:193`, `pending-follow-ups.ts:347`, `concerns.ts:573`, `patterns.ts:195` | P2 | S |
| F11 | `toError` reimplemented ~10×, `abortError` 5× | llm/voice/gateway sites; `src/shared/utils/errors.ts` is the natural home | P3 | S |
| F12 | `uniqueStrings` reimplemented 8× | cogsec, agent tool-catalog, shards, sessions-store | P3 | S |
| F13 | fleet-auth `positiveInteger` row coercer 6× | six fleet-auth store files | P3 | S |
| F14 | Garden proxy request wiring (`proxyApiRequest` vs `proxyBufferedApiRequest`, identical stream handlers) | `src/operator/garden/transport-client.ts:335-377` vs `:403-445`; related route-table dup in `server.ts`/`transport-server.ts` worth a follow-up | P2 | S/M |
| F15 | Signal-shutdown wiring copy-pasted across entrypoints (helpers exist but don't register listeners) | `src/app/agent/main.ts:1470-1494`, `src/app/operator/main.ts:79-100`, `src/app/gateway/main.ts:~689` | P3 | S |

Suggested homes: `src/shared/utils/errors.ts` (toError/abortError), `src/shared/time/daily-window.ts`,
`src/channels/shared/long-running-tool-status.ts`, `src/primitives/images/file-naming.ts`,
`src/persistence/postgres/fleet-auth/row-utils.ts`, module-local shared files for F5/F8/F9/F10/F14.

### Intentional duplication — reviewed and rejected
- Discord vs Telegram adapters wholesale: platform differences are genuine; only F1 is truly shared.
- TTS `resolveEncoding`/format resolvers: provider-specific, keep per-connector.
- Generic `clamp` sites: `src/shared/utils/numeric.ts` already exists; remaining inline bounds are per-domain and fine.
- Test-fixture duplication (bulk of jscpd hits): deliberately explicit, out of scope.

### Borderline (look, don't rush)
- `src/core/turns/observability.ts:205-342` vs `:344-464` (`sanitizeTurnSnapshot`/`cloneTurnSnapshotRecord`):
  extract only the identical sub-cloners; the two entrypoints have different reasons to change (P3/M).
- `turn-execution-adapter.ts:62-146` ⇄ `turn-execution-runtime.ts:298-383`: ~85-line collaborators
  interface mirrored across an intentional port seam — consolidate into one exported interface (P3, drift hazard).

---

## 2. Type consolidation (agent 2)

5,674 exported types across both trees; **113 names defined on both sides of the src ↔ admin-ui
boundary**. Key fact: admin-ui already imports directly from `src` (proven pattern:
`admin-ui/src/lib/types/tools.ts` re-exports canonical Garden types), so consolidation is mostly
"delete the hand-copy, import the canonical". Only ~27 of 146 types in
`admin-ui/src/lib/types/index.ts` derive from canonical today; the other ~119 are hand-defined.

### P0 — drifted copies (latent bugs)
1. **`Contact`** — `src/core/contacts/types.ts:266` vs `admin-ui/src/lib/types/index.ts:675`.
   Admin copy weakens `trustLevel`/`relationshipType` to `string`, drops `timezone?` and
   `isMachineIntelligence?`, inlines `conversationChannels`. Effort S.
2. **`ChannelPrivacyLevel`** — admin (`index.ts:673`) still carries `'broadcast'`, which the backend
   retired (`src/system/trust/policy.ts:111`). Frontend can render/emit a value the backend rejects.
   Canonical: `src/system/trust/context-envelope.ts:33`. Effort S.
3. **Observer-eval sidecar cluster** — ~15 name collisions; backend composes named sub-types
   (`src/core/eval/observer-sidecar/{persistence,privacy,metrics}.ts`), admin inlines full nested
   shapes literally (`admin-ui/src/lib/api/endpoints/observer-eval-sidecar.ts`, e.g. 13 named fields
   → ~80 inlined lines). Highest-volume drift surface. Effort L.

### P1 — true duplicates
4. `BehavioralPatternRow`/`BehavioralPatternSummaryRow` — byte-identical twice in backend
   (`src/core/intention/patterns.ts:99,113` ⇄ `postgres-adapters/shared.ts:67,81`). Effort S.
5. `PendingFollowUpRow` — same DB row, two nullability contracts (`pending-follow-ups.ts:168` vs
   `postgres-adapters/shared.ts:45`; three fields differ `| undefined`). Effort S.
6. `WikiRetrievalRequest` — field-identical (`src/faculties/wiki/retrieval.ts:242` ⇄
   `src/core/agent/contracts.ts:103`). Effort S.
7. `SubsystemLane*`/`SubsystemHealthSnapshot` cluster — identical minus JSDoc
   (`src/operator/garden/services/subsystem-health-service.ts` ⇄ admin `index.ts`). Effort S.
8. **`ModelRegistry*` cluster — bidirectional drift**: admin (`admin-ui/src/lib/models/registry.ts`)
   adds a `routing?` field absent from backend and weakens capability/tuning/cost metadata to
   `Record<string, unknown>`. Canonical: `src/shared/contracts/runtime.ts:1276-1407`. Effort M.

### P2 — mirrored copies with type-weakening (consolidate via import)
- `ContactChannelIdentity`/`ContactChannelLink`, `RoomSummary`/`RoomRosterMember` (enum → `string`
  weakening), `CharacterCardV2` (`spec` literal → `string`, inlined data shape),
  hand-copied enums currently in sync but at risk (`TrustLevel`, `RelationshipType`,
  `SocialRelationshipKind`, `SocialGraphEntitySource`), plus ~20 more one-liner mirrors enumerated in
  the agent report (SessionEntry, ContactMutationAuditEntry, PromptRegistryEntry, DiscoveredModel,
  IntakeQuarantineDecisionAction, ImageReferencePhoto, Channel* trust enums, etc.).

### P3 — backend-internal name pairs (verify same-domain before merging)
~20 pairs listed by the agent (TurnSnapshot, WebSocketVoiceSession, ShardCreationMode,
SubagentExecutionRequest, ScratchpadEntry, FleetAuthRole, ManagedSkillRecord, MetacognitiveFlagName,
`Awaitable<T>` → `src/shared/utils/`, …).

### Confirmed false duplicates — leave alone
- `PolicyDecision`/`PolicyContext` (gateway RPC vs trust-policy — different domains).
- `AdminTool*` in admin-ui — already re-exports of canonical, not copies.

### Strategy
1. Fix the four drifted-and-live items first (#1, #2, #3, #8).
2. Convert hand-mirrored admin types to the `tools.ts` re-export pattern (~90 of 113 collisions,
   near-zero risk).
3. Collapse backend-internal true dupes (#4–#7).
4. Move to `src/shared/contracts/` only what is genuinely cross-layer; otherwise import the owning module.

---

## 3. Unused code (agent 3)

knip and ts-prune both ran; **their raw output is dominated by false positives** (no Svelte plugin,
registry/string-path wiring). Every finding below was hand-verified by grepping symbol + basename +
import specifier repo-wide.

### Confirmed dead — safe to delete
1. **`src/operator/garden/api-routes-contacts.ts`** (213 lines) — superseded duplicate; the live
   `buildAdminContactRoutes` is `src/operator/garden/routes/contact-routes.ts` (imported at
   `api-routes.ts:12,795`).
2. `src/operator/garden/services/artifact-lifecycle-service.ts` — never imported/instantiated; sole
   implementer of an interface consumed only by itself. (Delete `services/types/artifacts.ts` with it.)
3. `src/operator/garden/services/research-library-service.ts` — same pattern. (Delete
   `services/types/research-library.ts` with it.)
4. `src/faculties/memory/research-library/runtime-wiring.ts` — zero references; means the
   research-library *tool* is never wired into production (flag to owner: dead wiring or missing wiring?).
5–6. `src/primitives/voice/pipeline/processor.ts` + `pipeline/contracts.ts` (only importer is #5).
7–9. `src/primitives/voice/transports/discord-input.ts`, `discord-output.ts`, `transports/types.ts`
   (only importers are 7/8) — live Discord voice is `src/channels/discord/voice.ts`, which doesn't use this layer.
10–17. **Dead barrel files** (zero importers; underlying modules imported directly):
   `src/core/emotion/index.ts`, `src/faculties/skills/index.ts`, `src/operator/garden/chat/index.ts`,
   `src/shared/cache/index.ts`, `src/system/capabilities/index.ts`, `src/primitives/voice/index.ts`,
   `src/primitives/voice/observers/index.ts`, `src/primitives/voice/transports/websocket/index.ts`.

### Needs owner judgment
- `src/app/startup/support/test-fixtures/external-plugin.ts` — zero references found (incl. dynamic
  patterns); looks like an orphaned fixture. Verify no external harness loads it.
- `src/app/maintenance/force-episodic-synthesis.ts` — runnable maintenance CLI, referenced only as a
  string in `parity-matrix.ts:560`; not in package.json scripts. Likely intentional operator tooling — confirm, don't delete.

### Not dead — do NOT remove
- `@snazzah/davey` dep — optional DAVE-protocol peer for `@discordjs/voice` E2EE, already in
  `.fallowrc.json` ignoreDependencies. `sherpa-onnx-node` — optional require with graceful fallback
  (`src/core/emotion/audio-classifier.ts:316`).
- e2e `agent-process.ts` files — spawned by string path from sibling `process-harness.ts`.
- All admin-ui/companion-ui knip hits (no Svelte/HTML entry parsing) and manual scripts/harnesses.

### Tooling follow-up
Add a knip config: Svelte plugin (or exclude admin-ui), companion-ui entry points, scripts/shakedown
entries, `.svelte-kit` ignore. That turns knip from noise into a usable CI gate.

---

## 4. Circular dependencies (agent 4)

madge: 36 cycles in src (admin-ui's 31 are the same cycles re-imported — zero of its own). **Every
cycle closes through a type-only edge** — no runtime/initialization hazards; damage is layering and
tooling. They collapse to 7 root cycles:

| Cycle | Root cause | Fix | Sev/Effort |
|-------|-----------|-----|------------|
| **A** — `shared/contracts/runtime.ts` ↔ core mega-SCC (~24 of 36 madge entries) | `runtime.ts:2,3,7,814,816` type-imports **upward** into `core/` (ContextManifest, presence metadata, TurnID, InternalState, MetacognitiveFlag) while core value-imports `CHANNEL_TYPES` downward | Relocate those type definitions down into `src/shared/contracts/` (new `self-model-contracts.ts`, `presence-contracts.ts`; fold `TurnID`); core re-exports for compat. Pure type move — not a composition-root problem | P1 / M |
| **B** — `turn-execution-runtime.ts` ↔ its 5 `turn-execution/*` children (hot turn path) | children each inline-type-import the parent's `TurnExecutionRuntime` | Move the interface into existing `turn-execution/contracts.ts` | P2 / S |
| **C** — `boundary/sandbox/capabilities/contracts.ts:11` ↔ `core/tools/analysis-workbench/types.ts:14` | bidirectional port types across the boundary↔core seam | Extract both port types to `src/shared/contracts/sandbox-analysis-contracts.ts` | P2 / S |
| **D** — `core/agent/presence-metadata.ts` ↔ `active-emanation-state.ts` | resolver fn adjacent to the type family | Split types out (overlaps cycle A's presence contract) | P3 / S |
| **E** — `core/intention/pending-follow-ups.ts` ↔ its store port | port needs domain types; main file barrels the port factory | Sibling `pending-follow-up-types.ts`; drop the barrel re-export | P3 / S |
| **F** — `faculties/shards/manager.ts` ↔ `port.ts` | `ActiveShard`/`SatelliteDelegationRequest` live in manager | Move both into existing `faculties/shards/types.ts` | P3 / S |
| **G** — `core/contacts/postgres-adapter/store.ts` ↔ `contact-authority-snapshot.ts` | snapshot helper types the concrete store | Minimal interface of the methods actually called | P3 / S |

Additional layering note: `runtime.ts` also type-imports `boundary/custody` and `system/trust` —
same smell as cycle A; fix together. Primitives layer is clean.

**Hardening:** tsconfig has neither `verbatimModuleSyntax` nor `isolatedModules` — nothing prevents a
type-only edge silently becoming a value edge (a *real* runtime cycle) later. Add
`verbatimModuleSyntax: true` after the cycle fixes.

---

## 5. Weak types (agent 5)

Sweep: 47 `: any` (src), 8 `as any`, 152 `as unknown as`, 1141 `Record<string, unknown>` (almost all
legitimate JSON/intake envelopes), zero `@ts-ignore`/`@ts-expect-error`. The fleet-auth branded-type
casts are all validation-gated (textbook `unknown`+validation, leave alone). The real debt is one cluster:

### P1 — agent tool-call loop cluster (fix together)
pi-ai exports `AssistantMessage`, `ToolCall` (discriminant `type: 'toolCall'`), content-block unions;
pi-agent-core exports `AgentEvent`. None are used at these sites:

- **F1** `src/core/agent/tool-call-scheduler.ts` — 14 `: any` hits (`:51,61,103,113,133,138,142,358,486-626`).
  Fix: import `ToolCall`/`AssistantMessage`; `content.filter((c): c is ToolCall => c.type === 'toolCall')`
  gives narrowing for free. `:358` → `AgentToolResult<unknown>`.
- **F2** `src/boundary/pi-agent/agent-loop-patch.ts:213,237,285` — `partial: any` → `AssistantMessage | null`;
  event cast retires once the stream is typed.
- **F3** `src/core/agent/scheduled-agent-loop.ts:106,107,167,169` — define once:
  `type ScheduledAgentEvent = AgentEvent | AgentLoopErrorEvent | { type: 'user_facing_boundary' }`
  and thread through F1/F2/F3 streams. This single alias retires the majority of the `: any` hits.
- **F4** `src/core/agent/substrate-agent/agent-state-runtime.ts:66-80` — five `(block: any)` →
  content-block union (P2/S).

### P2 — security / persistence casts
- **F5** `src/faculties/memory/postgres-store/rows.ts:284` — `scope_ref_kind as any` is pure noise;
  the field is `string | null`, truthy-narrowed, and the downstream normalizer validates fail-closed.
  **Delete the cast** — it typechecks without it. Effort S.
- **F6** `src/system/capabilities/gate.ts:160` and `src/faculties/shards/tool-sync.ts:57` —
  `params as any` at security gates → `Parameters<typeof tool.execute>[1]` (root cause is the
  documented bivariance hatch in `src/boundary/pi-agent/substrate-agent-tool.ts:33`; changing that is
  P3/L, not a quick win). Tighten returns to `AgentToolResult<unknown>`. Effort M.
- **F7** `src/core/agent/stream-adapter.ts:207` — async-generator IIFE cast to `any`; annotate the
  generator to match `StreamFn`'s declared `AssistantMessageEventStream`. Also `:161` double-widening. Effort M.
- **F8** `src/persistence/sessions/turn-record-*.ts` + fleet-auth audit files — ~20 round-trip
  `as unknown as Record<string, unknown>` casts for a generic redaction walk; make the gating helper
  generic `<T>(value: T): T` so the round-trips collapse. Effort L.

### Acceptable — leave alone
Fleet-auth branded casts (post-validation), `substrate-agent-tool.ts:33` bivariance hatch
(documented), guarded `this.lifecycle!` non-null uses, pg `rows[0]!` indexing, the
`Record<string, unknown>` envelope population, and pi-ai's own `ToolCall.arguments: Record<string, any>`
(third-party). P3 polish list in agent report (discord error guard, `SandboxHostHelper` generic,
admin-ui widening casts, e2e harness).

---

## 6. Error handling / defensive programming (agent 6)

Headline: **unusually strong fail-closed discipline.** `src/system/config/` is the reference standard
(ENOENT-only nulls, loud throws on malformed content); gateway methods, intake L3 screener
(allSettled → `failed_closed` + warn), event bus, and canary/contact-block audit guards are all
correct. No truly-empty catch blocks in non-test code. No P0s. Findings concentrate in Garden/admin
and diagnostics:

| # | Finding | Location | Class | Sev |
|---|---------|----------|-------|-----|
| 1 | **Privacy break-glass audit write swallowed with zero logging** — fail-closed boolean is right, but when break-glass starts 503ing the operator has no record of why the audit store failed (inconsistent with `canary-egress-guard.ts:104` pattern) | `src/operator/garden/routes/privacy-break-glass-routes.ts:55-57` | sloppy boundary | P2/S |
| 2 | **CogSec quarantine sidecar write failure silent unless LOG_LEVEL=debug** — quarantine state silently drifts from the journal it protects | `src/persistence/journals/journal/file-io.ts:317-325` | error hiding | P2/S |
| 3 | Malformed module registry (parseable non-array JSON) silently treated as empty — fail-open on a self-modification surface; mirror `settings-overlay.ts:135` and throw | `src/boundary/sandbox/capabilities/modules.ts:80-82` | silent fallback | P2/S |
| 4 | Subsystem-health service renders a throwing scheduler as "no lanes" — the health surface conceals the failure it exists to report | `src/operator/garden/services/subsystem-health-service.ts:508-512` | error hiding | P2/S |
| 5 | Prompts-service context builder: bare `catch { return null }`, no log | `src/operator/garden/services/prompts-service-context.ts:390-391` | error hiding | P3/S |
| 6 | Admin sub-config viewer returns null on corrupt owner-file — the one human who could repair it sees an empty editor; surface the error in the HTTP response | `src/operator/garden/services/settings-service.ts:1129-1132` | sloppy | P3/S-M |
| 7 | Scratchpad context injection dropped to `''` at debug on provider error — invisible cognition-quality regression | `src/core/agent/substrate-agent/runtime-context.ts:592-596` | error hiding | P2/S |
| 8 | Startup model resolution failure deferred at debug — a test-only concern weakens the production boot gate; misconfigured model surfaces as a first-turn failure instead of at startup | `src/core/agent/substrate-agent.ts:694-699` | fallback-adjacent | P2/S |
| 9 | Corrupt journal read → null at debug (indistinguishable from "no channel id") | `src/persistence/sessions/store/channel-filenames.ts:91-98` | sloppy | P3/S |

Verified-legitimate list (rollback/teardown `.catch(() => undefined)`, error-body `.text().catch`,
retrieval cache-key degrade, policy-rejection info logs, etc.) is in the agent report — skip re-flagging.

---

## 7. Deprecated / legacy / fallback paths (agent 7)

### Removable now
- **`src/core/tools/legacy-alias-telemetry.ts`** (whole file, git-dated 2026-04-10) — zero production
  callers; the alias table it instruments exists only in a test. Delete emitter + test + event
  declaration (`src/shared/event-bus.ts:255`) + two dead consumer branches
  (`src/operator/garden/telemetry-correlation.ts:24`, `server-telemetry-transport.ts:219`). P3/S.

### Needs migration first
- **Fleet-SSO dual read path** (`src/boundary/fleet-auth/fleet-sso-transport.ts:73-78`): falls back
  from `companionFleet` to synthesizing a one-entry fleet from loose `companionId`+`gardenPort`
  (both halves confirmed live via `api-surface.ts:510-514`). Single clean path: require a fleet
  manifest even for single-companion deployments. P2/M. Couples with **companion-id dual shape**
  (`src/shared/routing/companion-id.ts:14`) — retire together. P2/M.
- **Prompt-manager legacy `'main'` coercion** (`src/core/identity/prompt-manager.ts:95,119-126`):
  identifier-less `base` layers silently coerced to `'main'`. Needs a data check/backfill, then
  fail-closed on missing identifier. P2/M.
- **Session-store filename migration runs on every construction**
  (`src/persistence/sessions/store.ts:355` → `store/legacy-import.ts`): move to a one-shot
  `src/app/maintenance/` command, then delete once fleets are migrated. P2/M.
- **`backfillLegacyTurnId` doing double duty** (`src/core/turns/id.ts:25` + 10 call sites): it's both
  a legacy read-shim (load-bearing for old journals — keep) and a live deterministic id builder
  (`turn-execution-runtime.ts:718`, `icp-target-channel-recovery.ts:33`). Split into
  `deriveDeterministicTurnId` + a clearly-scoped backfill. P3/M.
- Legacy journal vocabulary reader (`src/persistence/journals/journal/legacy-source.ts`, pre-E3.1) —
  removable once journals are rewritten. P3/M. Channel-envelope one-shot migration tool — removable
  once fleets certified migrated. P3/S.

### Known-legacy — leave (standing rules)
SQLite cutover machinery (`src/persistence/cutover.ts` et al. — "no NEW SQLite" rule, these are the
existing surfaces), persistence-layout/scheduler-owner maintenance migrations (gated by the
fail-closed readiness assertion at `bootstrap-helpers.ts:252`), and
`fleet-auth-legacy-surface-guard.ts` (that's the enforcement of the policy, not a violation).

### Verified non-finding
**`gardenPort` is not a straggler.** The global/env retirement is complete; the surviving
`gardenPort` is the intended per-companion field on `CompanionFleetEntry` in `companions.json`
(validated in `companions-config.ts`, dated 2026-07-13..16). The only questionable surface is the
fleet-SSO scalar fallback above.

---

## 8. AI slop / comments (agent 8)

Near-zero findings — strong commenting discipline. Verified clean: no stubs/larp in live paths, no
commented-out code, no abandoned scratch files, no debug leftovers; all four TODOs are load-bearing
and tracked (`htm9.2-followup`, CaMeL taint-propagation debt); the "not implemented" hits are honest,
fail-closed seams (kube-auto-rollback, `role_gated` trust mode, satellites UI badge, bench `--live`).

**One finding (P3):** `src/core/intention/concern-softening.ts:2-3` — change-history narration.
Replace with: `// Concern-text rewrites are personality-sensitive (purity rule), so they live as
operator-tunable data (config/concern-softening.json), not code.` Keep line 7 (byte-for-byte default
constraint — load-bearing).

---

## Recommended execution plan

Ordered by value; each block is a candidate bead/wave. Nothing here is blocking; all P0/P1 grades
above are reviewer grades on *drift/debt*, not confirmed runtime failures — verify per policy before
scheduling as fixes.

1. **Type-drift repair (highest value):** admin-ui `Contact`, `ChannelPrivacyLevel` (retired
   `'broadcast'`), `ModelRegistryEntry`, observer-eval cluster → then the mechanical re-export
   conversion of the remaining ~90 mirrors. (Section 2)
2. **Weak-type cluster:** define `ScheduledAgentEvent`, import pi-ai types through
   tool-call-scheduler / agent-loop-patch / scheduled-agent-loop; delete the `rows.ts:284` cast. (Section 5)
3. **Cycle A type relocation** (`runtime.ts` upward imports) + cycle B; add `verbatimModuleSyntax`
   after. (Section 4)
4. **Error-visibility P2s:** findings 1–4, 7, 8 — all S-effort log/throw fixes. (Section 6)
5. **Dead-code deletion:** the 17 confirmed-dead files + legacy-alias telemetry; knip config so it
   can run in CI. (Sections 3, 7)
6. **DRY wave:** F1 (channel status tracker), F3 (model-hint normalizer), F2/F13 (fleet-auth row
   utils), then the S-effort batch (F6–F12, F15). (Section 1)
7. **Legacy migrations (operator-gated):** fleet-SSO manifest requirement, prompt-layer identifier
   backfill, session-filename migration → maintenance command. These need deployment coordination,
   not just code changes. (Section 7)

## Open questions for the operator
- Research-library tool: dead wiring or missing wiring? (`runtime-wiring.ts` unreferenced — was it
  meant to be registered?)
- `force-episodic-synthesis.ts`: confirm it's intentional operator tooling before any cleanup.
- Single-companion deployments: OK to require a one-entry `companions.json` fleet manifest (retires
  the fleet-SSO scalar fallback)?

---

## Operator decisions — 2026-07-19

All sections approved for execution as planned, with these specifics:

- **Types (sections 2, 5):** approved. Where the fix is "import the existing canonical/library type
  instead of a hand copy", proceed. The channel-adapter shape (solid shared core + thin per-platform
  edges) is the intended architecture — keep Discord/Telegram separation, extract only what's truly
  shared (F1).
- **Weak-type tool-calling cluster (section 5 F1–F4) + security/persistence casts (F5–F8):**
  operator wants **Fable subagents** on this implementation specifically (override of the usual
  Codex-implements default for this cluster).
- **Research library + artifact lifecycle:** confirmed dead — operator has an external application
  covering this; the wiki faculty replaced the lighter use. Existing bead **`psfn-framework-upx0.9`**
  (deferred) already scopes exactly this cluster (research-library/*, research-library-service.ts,
  artifact-lifecycle-service.ts, zero production callers). Un-defer and execute it; also remove
  `runtime-wiring.ts` (dead wiring, not missing wiring).
- **Dead barrel files:** delete, provided git history confirms they're directory-convention leftovers
  rather than staging for planned work (validation pending — Q3 below).
- **`force-episodic-synthesis.ts`:** confirmed intentional operator tooling. Keep. (Consider a
  comment/README note so future audits don't re-flag it.)
- **Legacy-alias telemetry:** remove.
- **Fleet manifest:** confirmed — deployments are always fleet-shaped; single companion = one-entry
  `companions.json`. Retire the fleet-SSO scalar fallback and the companion-id dual shape (section 7)
  rather than keeping the flag/dual path.
- **Legacy journal import:** keep IF it's the lorebook/external-chat-log → memories importer; remove
  if it's only the pre-E3.1 own-format shim (validation pending — Q1).
- **SQLite cutover machinery:** operator expects no further SQLite imports of that shape; the removal
  wave (`z7qe.1.1–1.3`, closed) should have been the end of it. Validate whether `cutover.ts` + the
  startup readiness assertion are now fully removable (validation pending — Q2).
- **Concern-softening comment (section 8):** don't edit the comment — the real fix is existing open
  bead **`psfn-framework-189d`** (retire the softening shim entirely; gentle language at the source).
  The closed qwhh/q3jy beads were the Docker config-file gap, a different issue.
- **`external-plugin.ts` fixture:** possibly tied to the external-eval/plugin lane; note
  `PSFN-qyrl.5` (EligibilityGate for plugin capabilities) is closed (validation pending — Q4).

### Validation results (Q1–Q4) — completed 2026-07-19

**Q1 — legacy chat import: KEEP (it's the external importer).**
`parseLegacyChatSource` (`src/persistence/journals/journal/legacy-source.ts:158`) auto-detects three
foreign formats (JSON array / `{messages:[...]}` / JSONL) with loose field aliasing
(`content|text|message|body|value`, `ai|bot|model|agent → assistant`, seconds-or-millis timestamps) —
the signature of ingesting other systems' exports. `runLegacyChatImport`
(`store/legacy-import.ts:110`) adds resumable import manifests. It imports chat logs into session
journals (not lorebooks → memories), but it is the import *feature*, not a pre-E3.1 shim — the only
rename content is one incidental 6-line normalization. Caveat: no live caller outside tests
(`manager.importLegacyChatFromFile` at `src/core/session/manager.ts:1857` is unreached by any
route/CLI) — API-complete but dormant. Section 7's finding #5 (`migrateLegacyFilenames()` running on
every store construction, `store.ts:355`) is a **separate mechanism** and still stands.

**Q2 — cutover.ts: KEEP (review finding retracted).**
`src/persistence/cutover.ts` is NOT SQLite machinery — the reviewer conflated names. It is the
filesystem persistence-**layout** migration (single shared root → split system/companion roots) with
sha256 verification and manifests; DB files are relocated as opaque blobs. It backs the
`npm run migrate:persistence-layout` CLI and the fail-closed startup gate
`assertPersistenceCutoverReady` (`bootstrap-helpers.ts:252`), which no-ops only for single-root
deployments — not vestigial under Postgres. Actively bug-fixed 2026-07-16 (`2b8d375414`, owner-file
scope routing). Also: the claimed SQLite references in `bootstrap-input.ts`/`runtime-harness.ts` no
longer exist, and package.json has zero sqlite deps — the z7qe removal wave is genuinely complete.
Section 7's "Known-legacy SQLite cutover machinery" line is superseded by this finding.

**Q3 — dead barrels: all eight safe to delete.**
Each traces to directory-creation convention (feature commits 2026-02/03) or wholesale relocation by
the *completed* charter layout migration (`73f9fe737d`, 2026-03-28). No abandoned-refactor signature,
no staged future work behind any of them.

### Wave beads — filed 2026-07-19 under epic `psfn-framework-aylm`

| Bead | Scope | Prio |
|------|-------|------|
| aylm.1 | Drifted admin types: Contact / ChannelPrivacyLevel ('broadcast') / ModelRegistry | P1 |
| aylm.2 | Observer-eval sidecar type cluster | P2 |
| aylm.3 | Remaining ~90 admin mirrors → re-exports + backend dupes (blocked by .1) | P2 |
| aylm.4 | Tool-call loop `any` cluster (**Fable subagents** per operator) | P2 |
| aylm.5 | Security-gate/persistence casts (**Fable subagents** per operator) | P2 |
| aylm.6 | Cycle A: runtime.ts upward type-imports + verbatimModuleSyntax (blocked by .7) | P2 |
| aylm.7 | Cycles B–G type relocations | P2 |
| aylm.8 | Garden/diagnostics error-swallow visibility fixes | P2 |
| aylm.9 | Dead-file deletion (contacts routes, voice orphans, barrels, fixture, alias telemetry) + knip config | P2 |
| aylm.10 | Shared long-running tool-status tracker (Discord/Telegram) | P2 |
| aylm.11 | Gateway model-hint normalizer + fleet-auth row utils | P2 |
| aylm.12 | Small-helper DRY batch | P3 |
| aylm.13 | Maintenance-CLI scaffold | P3 |
| aylm.14 | Fleet-SSO scalar fallback → one-entry fleet manifest (deploy coordination) | P2 |
| aylm.15 | Prompt-layer 'main' coercion → backfill + fail closed (deploy coordination) | P2 |
| aylm.16 | Startup filename migration → one-shot maintenance command | P2 |
| aylm.17 | backfillLegacyTurnId split | P3 |

Also: `psfn-framework-upx0.9` un-deferred (research-library + artifact-lifecycle removal, scope
extended with runtime-wiring.ts); `psfn-framework-189d` noted as the fix for the §8 comment finding.

**Q4 — external-plugin.ts: orphaned, safe to delete.**
Added 2026-03-05 (`d7ccb10ff1`) together with its only consumer `src/runtime.test.ts` (single-process
runtime regression). That test was deleted with the single-process runtime (`ffd62d1db6`,
`f6fde76b45`); the fixture survived only because the layout migration had moved it. Zero references
repo-wide, no plugin loader exists in startup composition. Conceptual overlap with EligibilityGate
only; `PSFN-qyrl.5` is closed. Delete.
