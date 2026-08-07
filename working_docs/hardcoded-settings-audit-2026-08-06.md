# Settings Authority and Hardcoded Policy Audit — Pre-Bead Design

**Status:** Operator-reviewed design. Core domain decisions are recorded; the Satellite Hub boundary remains open for a cross-repository review.

**Evidence base:** `HEAD 70c2c81f7` on 2026-08-06, plus the current uncommitted working tree.

**Goal:** Put every legitimate operator choice in one canonical JSON domain, remove duplicate authority, and inventory every remaining hardcoded policy or guard.

**Non-goal:** Turn security floors, protocol constants, or derived runtime state into downgradeable settings.

---

## 1. Executive conclusions

The current problem has three parts:

1. Some operator choices are still hardcoded or env-only.
2. Some choices already exist in JSON but live in the wrong domain or in more than one place.
3. `settings.json` has become a catch-all, while related domains are split across many files.

The highest-value concrete finding is channel routing. One field, `channels.json.discord.heartbeatChannelId`, currently serves several unrelated roles:

- the primary private companion channel;
- proactive outreach and morning-wake delivery;
- lifecycle/restart status;
- reflection delivery;
- the notify tool's operator Discord destination.

Approval requests can use a different hidden env-only destination, `CONFIRMATION_OPERATOR_DISCORD_CHANNEL_ID`.

These roles have different privacy, urgency, and audience rules. They need explicit role bindings in `channels.json`.

Model authority is also fragmented. Provider definitions, model catalog entries, per-purpose selections, MoA choices, embeddings, emotion models, voice models, image models, and web-tool models do not share one owner.

The operator approved eight core configuration domains, plus topology/authority files and namespaced extension configs. `settings.json` becomes `core.json` before public release.

Configuration validity must be graded. Missing boot-critical paths fail startup. Missing optional feature blocks leave that feature unavailable with a visible diagnostic; they do not synthesize runtime defaults or block unrelated functions.

Most settings should apply live. Every field needs an explicit application mode, and models must hot-swap without a process restart.

Restart-only settings are limited to process topology, listeners, transport security, and components that cannot be safely rebuilt in place.

Garden should be generated from the canonical settings contract.

Domain tabs, global search, labels, descriptions, validation, scope, inheritance, reload state, and related-setting links should come from schema metadata rather than hardcoded pages.

Fleet globals and companion customization must be separate authorities.

Global domain files provide defaults; sparse per-companion files use the same domain shape and override only schema-approved paths. The primary companion is not the source of fleet defaults.

---

## 2. Verified current state

### 2.1 Hardcoded-settings gate

The current repository state is:

- `npm run verify:hardcoded-settings` passes;
- scanner findings: **2,069**;
- baseline entries: **2,069**;
- entries tagged `migration debt`: **455**;
- extended-form entries: **1,100**;
- extended-form entries missing a note: **0**;
- simple entries without a note: **822**;
- current source/baseline value mismatches: **0**.

The directory inventory includes `test-support:71`. The previous audit omitted those entries from its subtotal.

The gate keys entries by `file::name`. Baseline values are informational, so changing the value of an existing symbol does not fail the gate.

Evidence: `scripts/verify-hardcoded-settings.mjs:69-70`, `scripts/verify-hardcoded-settings.mjs:122-140`, and `scripts/verify-hardcoded-settings.mjs:155-164`.

The gate therefore proves that no scanned symbol was added or removed. It does not prove that a baselined value stayed unchanged.

### 2.2 Settings contract

The current settings contract passes and contains **153** runtime keys.

`config/settings.seed.json` alone has **111** top-level keys. It mixes memory, models, voice, channels, tools, lifecycle, CogSec, media, shards, UI, and integrations.

Several items identified as missing in the earlier audit are already JSON-owned and Garden-exposed:

- memory retrieval policy;
- group-memory policy;
- shard heartbeat stale/disconnect settings;
- document-ingest byte and character limits;
- embedding dimensions;
- most analysis-workbench ceilings;
- audience-scope and relationship-confidence trust thresholds.

Those are not migration candidates. Some still belong in a better domain, but a second setting must not be created.

### 2.3 Current owner-file spread

The inspected runtime configuration is spread across:

- `settings.json`;
- `models.json` and `providers.json`;
- `scheduler.json`;
- `channels.json`;
- `trust-policy.json` and `intake-policy.json`;
- `partner-affect-shadow.json`;
- `charge-policy.json`;
- `capability-tier.json`, `skills.json`, and `subagent-roles.json`;
- `backup.json`;
- `mcp-servers.json`;
- `companions.json` and `fleet-auth.json` for topology and authority.

The file count is not the only issue. Related decisions are split across those files while unrelated decisions accumulate in `settings.json`.

---

## 3. Ownership test

Every candidate value should pass this test before migration.

### 3.1 Operator-owned JSON setting

A value belongs in JSON when an operator may legitimately choose it per deployment or companion.

Examples include destinations, enabled features, model assignments, schedules, quiet hours, retention policy, budgets, thresholds, and retry behavior.

### 3.2 Immutable code-owned invariant

A value stays in code when changing it requires a coordinated code release or could weaken a security/protocol invariant.

Examples include protocol close codes, cryptographic formats, serialization versions, mandatory authentication behavior, and minimum secure transport requirements.

### 3.3 Code floor or ceiling plus operator setting

Some concerns need two layers:

- code owns a non-bypassable security floor or resource ceiling;
- JSON owns a validated operational value that may only be equally strict or stricter.

For example, an operator may lower an upload limit below the code maximum. They may not raise it beyond the audited hard ceiling.

### 3.4 Derived runtime state

Derived values should be visible in Garden but not writable as duplicate settings.

Examples include the effective chat model, resolved provider endpoint, active capability projection, and resolved channel route.

### 3.5 Secret or deployment wiring

Secrets remain in the credential vault or `.env`. JSON stores only credential references.

Ports, sockets, process roots, and bootstrap topology may remain env-owned when they are truly deployment wiring.

---

## 4. Proposed core configuration domains

This is a proposed physical owner model, not a Garden navigation model.

| Proposed owner | Responsibility | Current sources to consolidate |
|---|---|---|
| `core.json` | Sessions, lifecycle, tools, UI, imports, operational behavior, diagnostics, backup policy | Core parts of `settings.json`, `backup.json`, env-only operational knobs |
| `models.json` | Providers, model catalog, capabilities, purpose assignments, fallbacks, and every inference modality | `models.json`, `providers.json`, model/provider fields in `settings.json` |
| `channels.json` | Accounts, transports, channel roles, routing, notification sinks, privacy labels, voice destinations | `channels.json`, channel/voice fields in `settings.json`, channel destination env vars |
| `memory.json` | Memory, retrieval, extraction, salience, relationships, affect shadows, profiles, and episodic policy | Memory/profile/wiki settings, `partner-affect-shadow.json`, hardcoded memory policy |
| `scheduler.json` | Cadence, quiet hours, wakeups, background lanes, initiative triggers | Existing `scheduler.json`, unowned scheduler/reflection constants |
| `cogsec.json` | Intake, trust, disclosure, quarantine, persona conformance, screening and approval policy | `trust-policy.json`, `intake-policy.json`, CogSec parts of `settings.json` |
| `economy.json` | Charge, budgets, quotas, fatigue reserves, paid work, rate limits | `charge-policy.json`, budget fields from `settings.json`, related hardcoded budgets |
| `capabilities.json` | Capability tier, tool grants, shard/subagent policy, role definitions, skill enablement | `capability-tier.json`, `subagent-roles.json`, capability/tool fields, selected parts of `skills.json` |

This reduces the core schema set while giving each domain a strong boundary.

Rename `settings.json` to `core.json`. Its schema must reject fields owned by another domain.

### 4.1 Files outside the core setting domains

Some files are authority, topology, content, or extension data rather than general settings:

- `companions.json` and `fleet-auth.json` remain topology/authority owners;
- identity and character artifacts remain identity data;
- places and world files remain world data;
- MCP and plugin configs live under a namespaced extension area;
- `satellites.json` remains a topology, trust, and endpoint-authority registry while the Hub boundary is finalized;
- secrets remain in the vault or env and are referenced from domain config.

Suggested extension layout:

```text
extensions/
  mcp.json
  <plugin-id>.json
```

An extension may own unique settings. It must reference core domain services for models, channels, budgets, credentials, and capability decisions.

---

## 5. Domain access rules

Moving JSON files is not enough. Consumers need one shared access path per domain.

### 5.1 One owner per setting path

Every writable setting must have exactly one tuple:

```text
domain + JSON path + scope + requiredness + validator + apply mode + UI metadata
```

The settings contract should reject duplicate ownership.

### 5.2 Domain services, not copied projections

Runtime consumers and extensions should call typed domain services such as:

- `models.resolvePurpose(...)`;
- `channels.resolveRole(...)`;
- `memory.resolvePolicy(...)`;
- `cogsec.evaluate(...)`;
- `economy.resolveBudget(...)`.

`SubstrateConfig` may carry an immutable startup snapshot, but it must not become a second authority.

### 5.3 Garden is a view over owners

Garden may group controls by task or persona. A Voice page can edit channel, model, and reliability fields without inventing a `garden-voice.json` owner.

Each control must display:

- canonical owner file and path;
- global or per-companion scope;
- effective value;
- restart or live-reload behavior;
- immutable floor or ceiling, when applicable.

### 5.4 No runtime default twins

Required owner files already fail startup when missing. Runtime `?? literal` defaults should not duplicate values that are mandatory in an owner file.

Code literals remain only for immutable bounds, protocol behavior, and bootstrap structure. An optional block resolves to `unconfigured`; code must not populate hidden operational values inside it.

### 5.5 Presence, activation, and startup failure

No runtime literal should silently fill an absent operator-owned path. The schema must classify configuration into three activation tiers.

**Boot-critical:** Missing, malformed, unknown, or inconsistent values fail startup. Examples include schema versions, core security policy, a usable chat-model assignment, and credential references for enabled transports.

The fleet must have at least one enabled external conversation surface routed to a companion. Discord, Telegram, or the companion application may satisfy this requirement; the Garden admin chat does not replace it.

**Required when enabled:** An optional feature block may be absent. If present or marked enabled, every required child must validate or that component fails closed.

For example, an absent `voice` block means voice is unavailable. An enabled voice block with no model, credential reference, or destination is invalid.

**Optional policy:** Optional values may be omitted only when omission has an explicit non-operational meaning such as `unconfigured` or `unavailable`. Omission must not trigger a hidden tuning value.

A malformed owner file or unknown key always rejects. Garden must surface unavailable features and the exact missing paths instead of swallowing the condition.

Requiredness should also name its failure scope: `runtime`, `gateway`, `agent`, `companion`, or `feature`. One unconfigured optional companion feature should not take down unrelated fleet services.

### 5.6 Live application and restart contracts

Every field must declare one application mode:

- `live`: validate, persist, apply, and acknowledge without restart;
- `component_restart`: restart only the owning connection or component;
- `process_restart`: save as desired state and show effective-versus-desired divergence;
- `deployment_restart`: reserved for listener, root, certificate, or topology changes outside safe process reconfiguration;
- `immutable`: code-owned and read-only.

Models, model assignments, provider routing, ordinary policy thresholds, schedules, budgets, and most channel routing should target `live` application.

Bot credentials, listener addresses, TLS material, runtime roots, and some gateway transports may need component, process, or deployment restart.

Live mutations must be transactional at the domain boundary:

1. validate the full candidate domain and cross-domain constraints;
2. write atomically with a revision precondition;
3. apply to every registered consumer;
4. invalidate affected caches;
5. report success only after consumer acknowledgement;
6. roll back or retain an explicit divergence record if application fails.

The current implementation already hot-applies Garden model writes and watches direct `models.json` edits. Only `models.json` is watched; scheduler and several other owners report restart divergence.

Evidence: `src/operator/garden/services/settings-service.ts:211-265`, `src/operator/garden/local-admin-contract.ts:472-490`, and `src/operator/garden/services/owner-file-reload-watcher.ts:25-90`.

Replace the one-file watcher with a domain reload registry. Each domain registers its validator, applier, cache invalidations, rollback behavior, and application mode.

### 5.7 Schema-driven Garden settings

Standard JSON has no comments. Do not repeat labels and descriptions inside every global and per-companion values file.

Each domain file should carry `$schema` and `schemaVersion`. Its canonical JSON Schema or settings contract supplies the human and runtime metadata for every path.

Required field metadata:

- stable path and machine key;
- title and plain-language description;
- type, units, enum choices, format, and valid range;
- domain, tags, search aliases, and display order;
- global/per-companion scope and inheritance behavior;
- activation tier and failure scope;
- application mode and effective-versus-desired state;
- secret/reference classification;
- immutable floor or ceiling;
- related paths and cross-domain constraint identifiers.

The same contract must generate runtime validation, Garden controls, API validation, search documents, and operator documentation. A field cannot be runtime-valid but absent from the settings index.

Garden's all-settings surface should provide:

- one tab per domain;
- one search across names, descriptions, paths, tags, and related settings in every domain;
- effective, global, and companion-override values;
- inherited/overridden badges and reset-to-global actions;
- live/restart state and validation errors;
- bulk fleet editing where a field permits companion scope.

Ordinary scalars, arrays, enums, and maps should render generically. Complex model catalogs, channel route graphs, capability matrices, and secret references may use specialized editors backed by the same owner paths.

Existing Garden pages may embed a selected set of canonical paths. They must call the same patch API and must not create page-specific settings or owner files.

The current contract already exposes owner, type, scope, range, and enum metadata, but descriptions, application modes, activation tiers, relationships, and comprehensive domain rendering are missing.

Evidence: `src/system/config/settings-contract.ts:97-123`, `src/system/config/settings-contract.ts:457-485`, and `src/shared/contracts/settings-garden-contract.ts:35-172`.

### 5.8 Global defaults and per-companion overrides

The current implementation uses two mechanisms:

- a sparse `settings.overlay.json` deep-merged over global `settings.json` for a manual whitelist;
- whole per-companion owner files for scheduler, charge policy, capability tier, and skills.

Objects deep-merge, while arrays and scalars replace. Invalid overlay keys fail startup.

Evidence: `src/system/config/settings-overlay.ts:12-28`, `src/system/config/settings-overlay.ts:36-92`, `src/system/config/settings-overlay.ts:136-157`, and `src/system/config/settings-contract.ts:60-81`.

Replace both mechanisms with a uniform domain overlay contract:

```text
effective companion domain = complete global domain + sparse companion domain override
```

The system root owns complete global domain files. A companion root may contain sparse files with the same domain filenames and object shape.

Schema metadata marks each path as `global_only`, `companion_override`, or `companion_required`. Unknown or disallowed override paths fail closed.

New companions should inherit the current global value dynamically. Do not copy a snapshot of global files at creation time; copies drift and stop receiving later global changes.

An operator edit materializes only the changed companion path. Resetting a field deletes that override path and immediately restores global inheritance.

Global edits propagate to every companion that has not overridden the path. Companion edits never mutate fleet defaults, including edits for the primary companion.

Arrays replace by default. Maps and registries merge by stable identifier only when their schema explicitly declares that strategy.

Garden must always show value provenance: `global`, `companion override`, `companion required`, or `derived`.

### 5.9 Cross-setting relationships

Related settings should remain independent, but the contract must describe their operational relationship.

For example, a tool may allow five minutes while a channel expects a response within three. That may require progress events or a longer channel window; it does not mean the two values should become one setting.

Cross-domain constraints need stable identifiers, involved paths, severity, and remediation text. Invalid combinations block writes; risky but valid combinations produce searchable warnings.

Garden search results should show related settings and allow an operator to move between them without knowing which domain owns each path.

---

## 6. Real findings by domain

### 6.1 Channels and destinations — highest priority

#### CH-1: `heartbeatChannelId` is semantically overloaded

`channels.json.discord.heartbeatChannelId` currently selects several destinations with different meanings.

It is consumed by proactive outreach, temporal wake, weighted-thought outreach, social desire, lifecycle notifications, reflection, and the notify tool.

Evidence: `src/app/agent/main.ts:1312-1466`, `src/app/agent/main.ts:1535-1542`, `src/app/agent/control-plane.ts:294-300`, and `src/system/lifecycle/notifications.ts:368-377`.

This should become explicit role configuration plus a contact-aware conversation resolver.

Proposed shape:

```json
{
  "routes": {
    "primaryConversation": {
      "resolver": "contactGraph",
      "preferredTransports": ["discord", "telegram", "companion-app"]
    },
    "proactiveOutbound": {
      "resolver": "contactGraph",
      "preferOriginConversation": true,
      "privateToGroup": "deny",
      "groupToPrivate": "allow",
      "groupToGroup": "originOnly"
    },
    "lifecycleStatus": { "channel": "discord", "accountId": "primary", "channelId": "<id>" },
    "operatorAlerts": [
      { "channel": "telegram", "target": "<chat-id>" },
      { "channel": "ntfy", "target": "<topic>" }
    ],
    "approvalRequests": { "inherits": "operatorAlerts" }
  }
}
```

Lifecycle, maintenance, alert, and approval routes use exact operator bindings. Social and concern-driven proactive delivery resolves the target contact through the contact graph.

The routing contract is privacy-monotonic:

- a private/DM-origin message may route only to a verified private channel for the same contact;
- a group-origin message may return to that exact group or move to a verified private channel for the same contact;
- a group-origin message may not jump to a different group;
- alert, maintenance, testing, public, and unrelated invite-only channels are never conversational fallbacks;
- an equivalent private channel on another transport may be tried when the preferred private route is unavailable;
- no eligible route means fail closed, not “send to last active.”

Content disclosure policy still evaluates the proposed destination. Contact resolution does not bypass privacy, consent, quiet hours, trust, audience scope, or rate limits.

The necessary data already partly exists. Concerns can retain `contactId`; concern candidates retain `channelId` and `contactId`; contact identities and conversation channels carry privacy levels.

The current proactive dispatcher does not use those inputs. It accepts a preselected channel and only checks exact equality with the configured heartbeat channel.

Evidence: `src/shared/contracts/intention-contracts.ts:61-90`, `src/core/intention/concern-candidate-types.ts:35-58`, `src/core/intention/proactive-outbound.ts:10-110`, and `src/core/contacts/types.ts:32-72`.

#### CH-2: approval routing is hidden in env

These non-secret choices are currently env-owned:

- `CONFIRMATION_OPERATOR_DISCORD_CHANNEL_ID`;
- `CONFIRMATION_NTFY_TOPIC`;
- `CONFIRMATION_EXPIRY_MS`.

Move destinations to `channels.json`. Move approval expiry, escalation, and confirmation policy to `cogsec.json`.

Credential values such as `NTFY_TOKEN` remain secrets. Endpoint and topic configuration should use JSON plus a credential reference.

Evidence: `src/boundary/gateway/bootstrap-input.ts:392-402` and `src/boundary/gateway/bootstrap-input.ts:480-483`.

#### CH-3: implicit last-active fallback is operator-invisible

Lifecycle notifications fall back to the last active Discord session when no heartbeat channel is configured.

That is surprising routing behavior. Replace it with `disabled` or an exact lifecycle role binding. A last-active conversation must never become an implicit maintenance destination.

Evidence: `src/system/lifecycle/notifications.ts:368-377`.

#### CH-4: channel settings are duplicated in `settings.json`

Examples include Telegram enablement, Discord trigger settings, voice targets, and several channel-adjacent media fields.

Transport/account/routing fields belong in `channels.json`. Model identity and provider choice belong in `models.json`.

Evidence: `config/settings.seed.json:395-403` and `src/channels/backplane/config.ts:71-203`.

#### CH-5: companion channel ownership is embedded in one global array

Multi-companion Discord configuration currently maps companion IDs, accounts, token references, heartbeat destinations, and group-memory policy inside global `channels.json.discord.accounts[]`.

Evidence: `src/channels/backplane/config.ts:520-629` and `src/channels/backplane/config.ts:667-699`.

Move companion account selections, destinations, and routes into each companion's sparse `channels.json`. Keep shared listeners, transport-wide security, and fleet routing policy global-only.

Garden can then render a fleet matrix and apply bulk patches without making the global file a second companion registry.

#### CH-6: missing `channels.json` currently becomes an empty owner

The current loader returns an empty object when `channels.json` is absent, and downstream parsing supplies inert or default projections.

Evidence: `src/channels/backplane/config.ts:701-720` and `src/channels/backplane/config.ts:1080-1124`.

The target contract requires the domain file and at least one fleet external conversation surface. Optional transports remain absent or disabled within that valid owner.

### 6.2 Models and inference — highest priority

#### MOD-1: model selection has several authorities

Current model-related authority is split across:

- provider entries in `providers.json`;
- model catalog and purpose declarations in `models.json`;
- `modelPurposeSelection` in `settings.json` and companion overlays;
- separate MoA reference and aggregator settings;
- embeddings and text-emotion models in `settings.json`;
- STT, TTS, image, and web-tool model selections in other sections.

All inference consumers should resolve through `models.json`.

Evidence: `config/models.seed.json:1-198`, `config/providers.seed.json:1-34`, `src/system/config/model-selection-config.ts:13-65`, and `src/system/settings/contracts.ts:301-302`.

Recommended structure:

```json
{
  "providers": [],
  "models": [],
  "assignments": {}
}
```

Assignments should cover chat, reasoning, summary, extraction, memory, vision, embeddings, emotion classification, STT, TTS, image creation/editing, web tools, and MoA roles.

Schedulers, plugins, skills, and faculties should request a purpose. They should not store provider/model strings in their own config.

Provider definitions and the catalog are global-only. Assignment paths are companion-overridable through the companion's sparse `models.json`.

All inference modalities and assignments must apply live. A successful mutation updates new inference requests without interrupting requests already in flight.

#### MOD-2: provider endpoints are mixed with unrelated settings

Provider endpoint URLs, capability metadata, model discovery URLs, capacity, and credential references belong beside the provider registry in `models.json`.

Evidence: `src/system/config/providers-config.ts:28-48` and `src/system/config/providers-config.ts:122-179`.

Secrets remain outside JSON. JSON stores references such as `{ "kind": "env", "envName": "..." }`.

#### MOD-3: model-like telemetry labels are not settings

Strings such as `scheduler:weighted-thought-outreach` or `deterministic:no-claimed-values` are provenance labels, not selectable models.

The audit must not classify them as model configuration.

### 6.3 Core runtime and operations

#### CORE-1: lifecycle timeouts have multiple authorities

Shutdown, extraction drain, command execution, rollout, and rollback timeouts are split across hardcoded defaults, env parsing, and `lifecycleKubernetes` settings.

Evidence: `src/app/agent/main.ts:178-221`, `src/app/agent/control-plane.ts:59-206`, and `src/boundary/gateway/bootstrap-input.ts:70-503`.

Move legitimate operational choices into `core.json.operations.lifecycle`. Keep immutable emergency ceilings in code.

#### CORE-2: duplicate defaults remain in load, snapshot, and example layers

Examples include session-mirror windows and Discord trigger windows.

Evidence: `src/system/settings/runtime.ts:209-211`, `src/system/settings/runtime.ts:517-519`, and `src/system/settings/runtime.ts:1037-1039`.

Once a required owner path exists, loaders and snapshots should consume it without another literal fallback.

#### CORE-3: hidden operational behavior needs triage

Real candidates include:

- post-turn status-history retention;
- completion-notice expiry;
- ready-notification dedupe window;
- internal-state rehydration window;
- diagnostic aggregation windows;
- long-running tool status polling;
- session and journal retention policy.

Each needs an operator-use case, reload rule, range, and immutable ceiling before migration.

#### CORE-4: `chatApiBaseUrl` is missing from `SubstrateConfig`

The setting is applied through an index-signature/intersection escape rather than an explicit typed field.

Evidence: `src/system/settings/runtime.ts:427-429`, `src/system/settings/runtime.ts:888`, and `src/system/config/runtime-config-contracts.ts:160-440`.

Add the field or remove the projection when the domain split makes it unnecessary.

### 6.4 Memory

#### MEM-1: meaningful memory policy is still hardcoded

High-confidence candidates include:

- memory deduplication thresholds by type;
- contradiction offsets;
- durable auto-importance thresholds;
- emotional persistence multipliers;
- near-turn memory window;
- stale-memory review age;
- scratchpad expiry;
- episode synthesis windows and caps.

These belong in `memory.json` when operators can tune them without violating memory integrity.

Evidence: `src/faculties/memory/types.ts:374-384`, `src/faculties/memory/near-turn-memory-lane.ts:13`, `src/faculties/memory/maintenance-review.ts:103`, and `src/faculties/memory/postgres-store.ts:171`.

#### MEM-2: already-owned policies must not be recreated

Memory retrieval policy and group-memory policy are already settings-backed and Garden-exposed.

Relocate them to `memory.json`; do not introduce parallel knobs.

Evidence: `src/shared/contracts/settings-garden-contract.ts:98-103` and `src/system/config/settings-contract-guard.test.ts:455-469`.

#### MEM-3: code must retain integrity ceilings

Hard limits that prevent unbounded scans, oversized writes, or unsafe retention remain code ceilings.

Operator settings may choose smaller values where useful.

#### MEM-4: partner affect belongs with relationships

Merge `partner-affect-shadow.json` into `memory.json.relationships` rather than CogSec or core.

Partner-affect shadows, autobiographical profiles, and public/private relationship projections are memory-derived relationship state and policy.

CogSec owns the trust, audience, disclosure, and approval gates that control how those projections cross privacy boundaries.

### 6.5 Scheduler and autonomy

#### SCH-1: reflection policy is partly hardcoded

Candidates include daily review cadence, deliberation range limits, template burst windows, and reflection-specific budgets.

Cadence and enablement belong in `scheduler.json`. Token/spend budgets belong in `economy.json`. Model choice is a `models.json` purpose reference.

Evidence: `src/core/scheduler/reflection-policy.ts:76`, `src/core/scheduler/reflection-policy.ts:154-156`, and `src/core/scheduler/reflection-template-runtime.ts:116`.

#### SCH-2: motivation and outreach thresholds are hidden

Motivation confidence, arousal, mood-drift, concern-resolution windows, and outreach throttles affect when the companion initiates or suppresses work.

They should be operator-visible, with per-companion scope and safe validation.

Evidence: `src/core/intention/motivation.ts:31-48` and `src/core/intention/concerns.ts:175`.

#### SCH-3: internal lane logging policy is mixed with product policy

Some six-hour constants only throttle informational logs. Those are observability policy, not social-fatigue policy.

The migration must verify each consumer rather than infer meaning from a name or nearby narrative.

Evidence: `src/core/scheduler/social-desire-outreach-lane.ts:94-116` uses its six-hour value only to throttle an informational log.

### 6.6 Cognitive security and trust

#### COG-1: trust thresholds already exist

Audience-scope thresholds and participant-relationship confidence are already owned by `trust-policy.json`.

Move them into the consolidated `cogsec.json`; do not create new copies.

Evidence: `config/trust-policy.seed.json:13-17` and `src/system/config/trust-policy-config.ts:312-327`.

#### COG-2: trust, intake, and persona policy are fragmented

Trust/disclosure, intake screening, source lists, quarantine, drift detection, and persona conformance currently span several files and `settings.json`.

They should share one CogSec owner and validator surface.

#### COG-3: security policy may be stricter, never silently weaker

Unknown policy data rejects. Code-owned security floors remain non-bypassable.

Garden may expose stronger operator choices, effective status, and upgrade warnings without offering unsafe downgrades.

### 6.7 Charge, budgets, and resource stewardship

#### ECO-1: budgets are split by caller rather than economic meaning

Analysis-workbench tokens, MoA cost, external communication rate limits, provider capacity, fatigue reserves, and paid-media limits live in different places.

`economy.json` should own spend, quota, and attention budgets. Consumers request named budget surfaces.

Evidence: `config/charge-policy.seed.json:1-48` and `src/core/tools/analysis-workbench/types.ts:43-52`.

Provider technical capacity stays in `models.json`. Scheduler cadence stays in `scheduler.json`.

#### ECO-2: existing workbench settings are only partial

Max tokens, wall time, subqueries, execution timeout, and truncation are already settings-backed.

Remaining candidates include max iterations, tool calls, rate limits, tier budgets, and daily cost warnings. Extend one policy; do not add another workbench config.

Evidence: `config/settings.seed.json:320-325`, `src/app/startup/composition/parity.ts:157-172`, and `src/core/tools/analysis-workbench/types.ts:90-149`.

### 6.8 Capabilities, skills, shards, and subagents

#### CAP-1: capability authority is split across several files

Tier, custom tokens, skill enablement, subagent roles, shard toolsets, and concurrency controls should resolve through `capabilities.json`.

Evidence: `config/capability-tier.seed.json`, `config/skills.seed.json`, `config/subagent-roles.seed.json`, and `config/settings.seed.json:419-423`.

Extension-specific settings may remain namespaced, but enablement and grants belong to the capability domain.

#### CAP-2: configurable limits need immutable maxima

Shard/subagent concurrency, worker-lane queue limits, tool grants, and shell policy are legitimate operator settings.

Code retains hard ceilings and forbidden capabilities that an owner file cannot widen.

### 6.9 Voice and media

Voice spans several domains and should not create another top-level owner by default.

- voice destinations and transport enablement belong in `channels.json`;
- STT/TTS/image providers and models belong in `models.json`;
- retries, timeouts, buffering, and reliability policy belong in `core.json` or `economy.json` by meaning;
- immutable frame, transcript, and audio ceilings remain in code.

The current hardcoded voice reliability budgets are valid migration candidates after this ownership split is agreed.

Evidence: `src/primitives/voice/policy/reliability.ts:19-64`. Immutable audio/text ceilings are separate in `src/primitives/voice/policy/security.ts:8-13`.

### 6.10 Satellite Hub and companion application boundary

Satellite support is optional. An absent or disabled satellite registry must leave satellite functions unavailable without preventing ordinary virtual places, channels, or companions from starting.

The current core already owns `satellites.json`, a fail-closed registry for endpoint identity, claims, capabilities, privacy, companion routing, place binding, and restart policy.

Evidence: `src/shared/contracts/satellite-registry.ts:300-370`, `src/channels/backplane/satellite-registry.ts:656-697`, and `src/channels/backplane/satellite-registry.ts:763-778`.

Recommended boundary:

- core/gateway owns enablement, accepted identities, credential references, mTLS/trust requirements, allowed claims, privacy ceilings, capability grants, and endpoint-to-companion/place bindings;
- Satellite Hub owns hardware discovery, drivers, sensors, local device addresses, rendering, app/device runtime, and device-local restart behavior;
- virtual rooms, places, and world state remain usable without a Hub;
- the companion application may use the Hub transport without making Hub-specific hardware configuration part of the core domain files.

Keep `satellites.json` outside the eight general setting domains because it is primarily topology and authority.

Expose it through the same metadata/search framework and use core models, channels, budgets, and capability references where needed.

The exact app-versus-Hub ownership line needs a cross-repository review before implementation beading. Do not force a Hub dependency onto features that can operate directly.

---

## 7. Values that should remain code-owned

The earlier audit overreached by treating shared names and security constants as settings candidates.

Keep these code-owned unless a stricter bounded override has a real operator use case:

- TLS minimums and certificate-verification requirements;
- protocol close codes and wire method names;
- cryptographic formats and signature rules;
- schema min/max lengths that prevent malformed input;
- hard request/body/frame ceilings;
- database protocol defaults used only by test harnesses;
- calendar unit constants;
- deterministic telemetry and provenance labels;
- test fixtures.

Fleet-internal TLS 1.3 should remain a code-owned floor. Public TLS 1.2 is a security-hardening candidate to raise, not a user-editable downgrade knob.

Evidence: `src/boundary/gateway/fleet-sso-router.ts:588`, `src/boundary/gateway/transport.ts:898`, and `src/channels/api/server/http.ts:68`.

PQC or hybrid handshakes belong on the security roadmap. They require runtime, library, peer, and deployment compatibility evidence and must fail closed when required.

Garden should display effective transport security and compatibility status read-only.

---

## 8. Hardcoded inventory and gate changes

The scanner should become a complete policy inventory, not only a name-token tripwire.

### 8.1 Detect more policy-shaped names

Add or otherwise detect concepts such as:

- `TTL`, `EXPIRY`, `WINDOW`, `AGE`, `DURATION`;
- `WEIGHT`, `DECAY`, `SALIENCE`;
- `DIMS`, `CHARS`, `BYTES`, `SIZE`;
- `STALE`, `BURST`, `THROTTLE`;
- nested returned/assigned values and safe derived literal arithmetic.

Renaming `TTL` to `TTL_MS` does not help today because neither token is scanned.

Evidence: `scripts/lib/hardcoded-settings-scanner.mjs:5-33`.

### 8.2 Verify values, not only identities

The gate should fail when a baselined literal value changes without an intentional baseline update.

At minimum, CI should compare current `value` with the baseline value.

### 8.3 Use structured dispositions

Each production finding should carry fields such as:

```json
{
  "domain": "channels",
  "disposition": "migrate_to_json",
  "targetPath": "channels.json.routes.lifecycleStatus",
  "reason": "operator-selected delivery destination"
}
```

Code-owned findings should use dispositions such as:

- `security_floor`;
- `protocol_constant`;
- `resource_ceiling`;
- `derived_default`;
- `test_fixture`;
- `migration_debt`.

This extends the existing baseline. It does not create another runtime config file.

### 8.4 Separate production and fixture reporting

Test and certification fixtures may remain scanned, but their counts and reports should be separate from production policy debt.

### 8.5 Generate the full report

The gate should generate a domain-grouped Markdown or JSON artifact containing every finding, current value, disposition, owner path, and rationale.

That artifact becomes the complete answer to “what is hardcoded, where is it, and why?”

---

## 9. Consolidation rules

1. A setting has one canonical domain and path.
2. A domain file rejects keys owned elsewhere.
3. Garden controls write through domain services, never local UI config.
4. Examples/templates provision owners but are not runtime fallback authority.
5. Consumer-specific configs reference shared model, channel, budget, and capability identifiers.
6. Extensions may own unique config but cannot copy core domain settings.
7. Secrets use references; secret values do not enter owner files.
8. Security floors and hard ceilings remain code-owned and read-only.
9. Derived values are visible but not separately writable.
10. Migration deletes the old path after validation; silent compatibility twins are forbidden.
11. Owner files do not use runtime literal defaults for operator-owned policy.
12. Optional feature blocks are unavailable when absent and fail closed when enabled but incomplete.
13. Every field declares activation tier, failure scope, application mode, and UI metadata.
14. Global defaults are independent of the primary companion.
15. Sparse companion domain files override only schema-approved paths.
16. Live changes are validated and applied transactionally; restart-only changes show desired-versus-effective state.
17. Cross-domain relationships are described by constraints, not collapsed into duplicate or shared knobs.

---

## 10. Approved implementation order

### Phase 0 — settings-contract foundation

- define the eight schemas and domain/path registry;
- add title, description, scope, requiredness, apply mode, relations, and floor/ceiling metadata;
- implement uniform global-plus-companion resolution;
- implement the reload registry and desired-versus-effective state;
- classify code floors, settings, secrets, and derived values.

### Phase 1 — channel-role tracer bullet

- add typed channel roles;
- split conversation, proactive, lifecycle, alert, and approval destinations;
- resolve proactive targets through contact identity, origin scope, and privacy policy;
- migrate hidden env-only destination choices;
- update Garden and runtime consumers;
- remove `heartbeatChannelId` and last-active routing overloads.

### Phase 2 — model authority tracer bullet

- merge provider and model authority;
- define one purpose resolver;
- migrate all text, audio, image, video, embedding, classifier, MoA, and tool-model choices;
- make global and per-companion assignment changes live;
- remove copied model/provider settings.

### Phase 3 — split the catch-all

- rename `settings.json` to `core.json`;
- move memory, CogSec, economy, capability, and channel keys to their approved domains;
- move partner-affect policy under `memory.json.relationships`;
- merge small related owner files into their target domains;
- keep migration atomic per domain.

### Phase 4 — hardcoded policy wave

- migrate verified operator choices by domain;
- retain and classify security/protocol/resource invariants;
- remove duplicate runtime defaults.

### Phase 5 — gate and Garden completion

- enforce value-aware hardcoded inventory;
- enforce one owner per path;
- generate domain tabs and global search from the settings contract;
- display description, source, inheritance, effective value, related paths, and reload state;
- let subsystem and fleet pages embed or bulk-edit canonical paths;
- generate the complete code-owned policy report.

---

## 11. Operator decision record

1. **Core filename:** Rename `settings.json` to `core.json` before public release.

2. **Inference authority:** `models.json` owns providers, catalogs, capabilities, assignments, and every text, audio, speech, image, video, embedding, classifier, and compound inference role.

3. **Startup strictness:** Boot-critical paths fail closed. Optional absent features remain unavailable with visible diagnostics. Enabled but incomplete feature blocks fail their declared startup scope.

4. **Runtime defaults:** Do not synthesize missing operator policy with runtime literals.

5. **Live application:** Most settings apply live. Models must hot-swap. Restart-only behavior is explicit and limited to changes that cannot be safely rebuilt in place.

6. **Proactive routing:** Use contact-graph resolution constrained by exact channel-role and privacy policy. Private content never widens to a group; group content may stay in its origin group or narrow to a private route.

7. **Alerts:** Operator alerts use global fan-out with optional per-companion overrides. Alert and maintenance destinations are never implicit conversational routes.

8. **Relationship affect:** Move partner-affect shadows under `memory.json.relationships`; CogSec retains trust and disclosure gates.

9. **Capabilities and extensions:** Merge skill enablement and grants into `capabilities.json`. Unique plugin settings remain namespaced and reference shared core domains.

10. **Companion scope:** Use global domain defaults plus sparse per-companion files with the same domain shape. Primary-companion settings do not define globals.

11. **Garden generation:** Build domain tabs, field controls, global search, related-setting navigation, and bulk companion editing from the canonical schema/contract.

### 11.1 Remaining architecture boundary

Finalize which companion-application settings belong to core versus Satellite Hub.

The working boundary keeps trust, permissions, routing, privacy, and endpoint bindings in core while Hub hardware, drivers, sensors, and device-local behavior remain Hub-owned.

This boundary needs a cross-repository review, but it does not block the settings-contract, channel, model, or domain-split tracer bullets.

---

## 12. Verification performed for this audit

- `npm run verify:hardcoded-settings` — passed;
- `npm run verify:settings-contract` — passed;
- hardcoded-gate and settings-contract tests — 47 passed;
- source-reference validation — 79 cited paths and line ranges resolved;
- source-to-baseline literal comparison — 0 mismatches;
- `RUNTIME_SETTINGS_KEYS` count — 153;
- `config/settings.seed.json` top-level key count — 111;
- no product code, owner files, beads, commits, or live state changed.
