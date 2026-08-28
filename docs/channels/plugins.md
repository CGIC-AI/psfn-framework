---
type: concept
title: Channel Plugins
description: The channel plugin contract — how channel adapters are declared, validated, credential-resolved, eligibility-gated, and attached to the gateway backplane via the ChannelPluginHost, the manifest-driven adapter loader, and the channels.json plugin sections.
tags: [channel-plugins, channel-adapters, backplane, plugin-host, plugin-registry, eligibility, channels-json, credential-vault, multica, fail-closed]
verified:
  - by: openwiki/0.4.3
    at: 2026-08-28T13:30:04.287Z
sources:
  - id: openwiki-source-8f888319d1e5e3310de9c4e0
    resource: repo://src/app/gateway/main.ts
  - id: openwiki-source-20942e1f2d4f109052b08aa6
    resource: repo://src/boundary/gateway/channel-surfaces.test.ts
  - id: openwiki-source-3a7902f9dd5f9bbb75a05c02
    resource: repo://src/boundary/gateway/channel-surfaces.ts
  - id: openwiki-source-fe6a30217f0aad29cd67ad05
    resource: repo://src/channels/backplane/channel-lifecycle.ts
  - id: openwiki-source-6d0fda34652d6bf6ea8b5b20
    resource: repo://src/channels/backplane/config.ts
  - id: openwiki-source-24da4bccf95fe9aaf0c87d6a
    resource: repo://src/channels/backplane/plugin-eligibility.ts
  - id: openwiki-source-3e76d5ef1b725a9724003210
    resource: repo://src/channels/backplane/registry-port.ts
  - id: openwiki-source-37a1709217ee148534fa7cd2
    resource: repo://src/channels/backplane/types.ts
  - id: openwiki-source-65a3763570bdb7aaa77f367c
    resource: repo://src/channels/multica/adapter.ts
  - id: openwiki-source-35893e4dd91a17311329af46
    resource: repo://src/channels/multica/origin.ts
  - id: openwiki-source-e8fe16e192c6f79f6927a072
    resource: repo://src/channels/multica/plugin.ts
  - id: openwiki-source-1f32e7474fe1c6a42875d023
    resource: repo://src/channels/plugins/builtin.ts
  - id: openwiki-source-ec8bd9f3110235aeef8a0aaa
    resource: repo://src/channels/plugins/channel-plugin-host.test.ts
  - id: openwiki-source-944c4545a0100cb2f8cc5470
    resource: repo://src/channels/plugins/host.ts
  - id: openwiki-source-769b769ad616821b11a5daec
    resource: repo://src/channels/plugins/load-sections.ts
  - id: openwiki-source-8b2aa9781399aefd484dac9d
    resource: repo://src/channels/plugins/registry.ts
  - id: openwiki-source-92be7e7eea968e3964607865
    resource: repo://src/channels/plugins/types.ts
generated: { by: "openwiki/0.4.3", at: "2026-08-28T13:30:04.287Z" }
---

# Channel Plugins

Channel plugins are the extension boundary through which new channel surfaces
attach to the gateway backplane. The contract has two distinct attach paths that
share the same adapter shape (`ChannelAdapterPort`) but different declaration,
validation, and lifecycle owners:

- **Manifest-declared adapters** — first-class channels (Discord — one entry per
  configured account in multi-account mode — and Telegram) declared as
  `ChannelAdapterFactoryPort` entries, normalized by
  `buildChannelAdapterFactoryManifest`, loaded by the backplane's
  `loadChannelAdaptersFromManifest`, and registered into a
  `ChannelAdapterRegistry`.
- **Plugin-declared adapters** — extension channels declared as unknown
  `channels.json` sections, parsed by a registered `ChannelPlugin`, resolved
  against the credential vault, and instantiated by `ChannelPluginHost`.

Both paths produce the same `ChannelAdapterPort` shape. Manifest adapters are
validated and registered into a `ChannelAdapterRegistry`; plugin adapters are
owned by the `ChannelPluginHost`, which additionally owns operator alert wiring
and per-plugin credential resolution. The OpenAI-compatible API surface is a
first-class `channels.json` key (`api`) owned by the core parser in
`src/channels/backplane/config.ts` and is served by its own HTTP server; it is
neither a manifest adapter entry nor a plugin in the gateway composition.

The authority for this page is `src/channels/plugins/*` and
`src/channels/backplane/*` together with the gateway composition in
`src/boundary/gateway/channel-surfaces.ts` and the startup order in
`src/app/gateway/main.ts`. See [multica.md](multica.md) for the one built-in
plugin end to end, [overview.md](overview.md) for the channels subsystem, and
<!-- openwiki: broken internal link [../chat-turn-lifecycle.md] file "../chat-turn-lifecycle.md" does not exist. Fix the href or restore the target, then delete this comment. -->
[chat-turn-lifecycle.md](../chat-turn-lifecycle.md) for what happens to an
inbound message after an adapter delivers it.

## The plugin contract

`src/channels/plugins/types.ts` pins the whole contract. A `ChannelPlugin` is
three things:

- **`manifest`** — `{ id, label }`. The id is the registry key and the
  `channels.json` section key; the adapter the plugin constructs must return
  the same id (enforced by the host, see below).
- **`parseConfig(raw)`** — a fail-closed parser that turns one untrusted
  `channels.json` section into a `ChannelPluginParseResult`:
  `{ config, enabled, companionId?, credentials }`. `credentials` is a
  `ChannelPluginCredentialNeed[]` — each need names an `id` (the key under
  which the secret is later presented to `create`), a `CredentialReference`
  (currently `env`-kind only), and a human `description` used in vault error
  messages.
- **`create(input)`** — receives `{ config, secrets, context }` and returns a
  `ChannelPluginInstance`: a constructed `ChannelAdapterPort` plus an optional
  `onOperatorAlert` registration hook the adapter uses to raise operator
  alerts. `create` may be synchronous or async.

`ChannelPluginHostContext` supplies the adapter's ambient dependencies: the
`RuntimeChannelLifecycleLogger`, a `shutdownTimeoutMs`, the cognition
`IntakeScreeningService` (or null), and optionally the gateway's
`postgresDatabaseUrl` when a plugin needs its own persistence.

## Registry

`createChannelPluginRegistry` (`src/channels/plugins/registry.ts`) builds the
id → plugin map with fail-closed validation: the manifest id is trimmed and
must be non-empty, and a duplicate registration throws
`Duplicate channel plugin registration "<id>"`. The registry exposes `get`,
`has`, and `list` (registration order). Plugins are never looked up by label —
the manifest id is the only key used by section parsing, host loading, and the
gateway.

## Load sections: how channels.json declares plugins

`parseChannelPluginSections` (`src/channels/plugins/load-sections.ts`) walks the
scoped `channels.json` root (or the root itself when there is no `channels`
object) and classifies every key:

- First-class keys — `discord`, `telegram`, `api`, `psfnAmica`, `companionUi`,
  `contextEnvelope` — are skipped; the core parser in
  `src/channels/backplane/config.ts` owns them.
- Every other key must resolve through the plugin registry; an unknown key
  throws `Unknown channel plugin "<key>"`. The value must be a JSON object
  (else `channels.json.<key> must be an object`), and the plugin's
  `parseConfig` result is recorded as a `ChannelPluginLoadedSection` keyed by
  the section name with the plugin id stamped on it.

`loadRuntimeChannelsConfig` invokes this with the builtin registry (or an
injected registry seam) and carries the result as
`RuntimeChannelsConfig.plugins`. The same validation runs again on
`saveChannelsOwnerFile`, so an owner-file write that would fail runtime load is
rejected fail-closed instead of persisted.

## Host lifecycle

`ChannelPluginHost` (`src/channels/plugins/host.ts`) is the lifecycle owner for
plugin-declared adapters. It is constructed via `ChannelPluginHost.load` and
then driven by the gateway through explicit phases. The gateway's actual call
order is **load → wireMessages → initialize → start → stop**: `wireMessages`
runs before `initialize`/`start` because adapters such as Multica refuse to
start without the inbound message handler and operator-alert handler that
wiring installs.

1. **`load`** — iterates the registry in registration order, skips sections
   whose `enabled` flag is false, and instantiates each enabled plugin. Any
   failure stops the instances already created (reverse order) and rethrows, so
   a half-loaded host never survives.
2. **`wireMessages`** — installs the inbound handler and operator alert wiring
   (see below). Requires every adapter to expose the `onMessage` bootstrap
   hook.
3. **`initialize`** — calls `adapter.init()` sequentially in registration
   order. A failure stops the instances up to and including the failing adapter
   and rethrows `Channel plugin "<id>" failed to initialize`.
4. **`start`** — calls `adapter.start()` sequentially. A failure stops every
   wired instance (via `stop()`) and rethrows
   `Channel plugin "<id>" failed to start`.
5. **`stop`** — tears down every wired instance in reverse registration order;
   `stopInstances` aggregates multiple stop errors into an `AggregateError`
   (`Channel plugin host failed to stop one or more plugins`).

```mermaid
sequenceDiagram
    participant GW as Gateway startup
    participant HOST as ChannelPluginHost
    participant VAULT as CredentialVaultPort
    participant PLUGIN as ChannelPlugin
    participant ADAPTER as ChannelAdapterPort

    GW->>HOST: load(registry, sections, vault, contextFor)
    loop each enabled plugin in registration order
        HOST->>VAULT: resolveRequired(need.reference, need.description)
        HOST->>PLUGIN: create(config, secrets, context)
        PLUGIN-->>HOST: instance with adapter
        HOST->>HOST: assert adapter id equals manifest id
    end
    HOST-->>GW: host with wired instances
    GW->>HOST: wireMessages(requestAgentVoiceStream, notifyOperator)
    HOST->>ADAPTER: onMessage(handler)
    HOST->>ADAPTER: onOperatorAlert(handler)
    GW->>HOST: initialize
    loop adapters in registration order
        HOST->>ADAPTER: init
    end
    GW->>HOST: start
    loop adapters in registration order
        HOST->>ADAPTER: start
    end
    GW->>HOST: stop
    loop adapters in reverse registration order
        HOST->>ADAPTER: stop
    end
```

Caption: ChannelPluginHost lifecycle phases as driven by the gateway — load, wireMessages, initialize, start, stop.

### Credential resolution

Secrets never live in `channels.json`. A plugin's `parseConfig` returns only
credential *references*; at instantiation `instantiatePlugin` resolves each
declared need with `vault.resolveRequired(need.reference, need.description)` and
presents the plugin with a flat `secrets` record keyed by need id. A missing
secret throws before `plugin.create` runs, so a plugin is never constructed
half-configured. Secrets are resolved per plugin and never shared across
plugins (each plugin's section declares exactly the needs it consumes).

`create` output is validated fail-closed: if `instance.adapter.id` differs from
`plugin.manifest.id` the host throws `Channel plugin "<id>" constructed adapter
id "<adapterId>"` — a plugin can never register an adapter under another
plugin's identity.

### Message and operator-alert wiring

`wireMessages` requires every adapter to expose the `onMessage` bootstrap hook
(an adapter missing it throws `Channel plugin "<id>" is missing onMessage
bootstrap hook`). Unlike the manifest-declared surfaces, plugin inbound does
not fan out through the gateway's `notifyChannelMessage` RPC: the host wires
`onMessage` directly to `requestAgentVoiceStream`, honoring an optional
`AbortSignal` from `MessageHandlerOptions`, and synthesizes the `AgentResponse`
metadata (`model`, `durationMs`, zero token counts) from the result. Operator
alerts raised through `instance.onOperatorAlert` are forwarded to the gateway's
`notifyOperator` with `sender.provenance = "system.channels.<pluginId>_failure"`
and `priority: 5`, using the plugin's idempotency key.

## Manifest-declared adapters and the backplane

The manifest path shares the adapter shape but is owned by
`src/channels/backplane/channel-lifecycle.ts`:

- `ChannelAdapterFactoryPort` declares `{ manifest, create }` where the manifest
  is `{ id, enabled, required?, label?, eligibility? }`.
  `buildChannelAdapterFactoryManifest` normalizes the entries fail-closed:
  ids are trimmed, must be non-empty, and duplicates throw.
- `loadChannelAdaptersFromManifest` loads enabled entries into a
  `MutableChannelAdapterRegistryPort`. Disabled entries are skipped with a
  warning, unless `required` is set — a required-but-disabled adapter throws.
  Before `create` runs, `requirePluginActivationEligibility` gates activation;
  a denied *required* adapter throws, a denied *optional* adapter is skipped
  with a decision log. After construction the adapter id must equal the
  manifest id (`Manifest id "<id>" does not match adapter id "<adapterId>"`),
  and each successful load registers the adapter and invokes the
  `syncChannelRegistry` callback. Optional create failures log and continue;
  required create failures throw. If the registry ends up empty, startup throws
  `No channel adapters loaded from manifest`.
- `ChannelAdapterRegistry` (`src/channels/backplane/registry-port.ts`) owns the
  loaded adapters by id: `require` throws for an absent id, `optional` returns
  null, `has`/`size`/`list` inspect, and `register`/`unregister`/`clear`
  mutate the map.
- `startChannelAdapters` starts `gateway.start()` on all adapters concurrently
  (`Promise.allSettled`), unregisters the failures, re-syncs the registry, and
  warns that startup continues with partial availability — but throws
  `No channel adapters started successfully` if none started.
  `stopChannelAdapters` stops in reverse registration order.

```mermaid
flowchart TD
    A["for each manifest entry"] --> B{"enabled?"}
    B -- no --> C{"required?"}
    C -- yes --> D["throw required adapter disabled"]
    C -- no --> E["warn and skip"]
    B -- yes --> F["try eligibility gate, create, wrap, verify id, register and sync"]
    F --> G{"caught error?"}
    G -- "EligibilityDeniedError" --> H{"required?"}
    H -- yes --> I["throw required denied by gate"]
    H -- no --> J["warn and skip"]
    G -- "other error" --> K{"required?"}
    K -- yes --> L["throw required failed to initialize"]
    K -- no --> M["warn optional failure and continue"]
    G -- "no error" --> N["next entry"]
    N --> O{"registry empty after loop?"}
    O -- yes --> P["throw no channel adapters loaded"]
    O -- no --> Q["proceed to gateway startup"]
```

Caption: loadChannelAdaptersFromManifest decision flow — required adapters fail closed, optional adapters degrade with warnings.

## Eligibility gating

`src/channels/backplane/plugin-eligibility.ts` ties channel adapters into the
capability-eligibility system (`src/system/capabilities/eligibility.ts`), which
also gates the STT and TTS connectors through the same `RuntimePluginKind`
(`'channel' | 'stt' | 'tts'`). Eligibility gating applies to manifest-declared
adapters loaded by `loadChannelAdaptersFromManifest`; the `ChannelPluginHost`
path is not eligibility-gated. Every channel adapter manifest must carry
`eligibility: EligibilityRequirements` — omitting them entirely throws
(`channel plugin "<id>" is missing eligibility requirements`), so a manifest
author cannot silently bypass gating. When the gate is absent or the
requirements are empty (`{}`, no required tokens and no minimum tier), the
checks pass through without an operation.

For effective requirements, activation is gated with operation
`{ kind: 'plugin.activate', pluginType: 'channel', pluginId }`, and the
constructed adapter is wrapped by `wrapChannelAdapterWithEligibility` so
runtime actions — `gateway.start`, `outbound.sendText`, `outbound.sendMedia`,
`streaming.sendTyping`, and the compatibility `send` — each re-check the gate
with `{ kind: 'plugin.action', pluginType: 'channel', pluginId, action }`. A
denied action rejects with `EligibilityDeniedError` *before* the underlying
call runs, so a capability revocation mid-run takes effect immediately.

## Gateway composition

`loadGatewayChannelSurfaces` (`src/boundary/gateway/channel-surfaces.ts`) is
where both paths meet at startup:

1. It builds the manifest entries for Discord (one entry per configured account
   in multi-account mode, keyed `discord:<accountId>`) and Telegram, and loads
   them into a fresh `ChannelAdapterRegistry` via
   `loadChannelAdaptersFromManifest`.
2. If any plugin section is enabled, a credential vault is mandatory —
   `Channel plugins require a credential vault` is thrown otherwise.
3. It constructs the `ChannelPluginHost` with the builtin plugin registry (or an
   injected registry as a test seam) and the parsed `channels.json` sections,
   resolving each plugin's host context: the lifecycle logger,
   `shutdownTimeoutMs` set to half the force-exit timeout, the companion-resolved
   intake screening service (only for enabled sections), and the gateway
   `postgresDatabaseUrl`.

Gateway startup then drives the phases in `src/app/gateway/main.ts`:
`wireGatewayChannelMessages` (which calls the host's `wireMessages` with the
gateway's `requestAgentVoiceStream` and `notifyOperator`) runs before
`initGatewayChannelSurfaces` and `startGatewayChannelSurfaces`. Lifecycle order
within the surfaces: plugin adapters initialize between Telegram and Discord;
plugins start last, after Discord and Telegram; and plugins stop first, then
Telegram, then Discord in reverse. Message wiring routes Discord and Telegram
through `notifyChannelMessage` and hands the plugin host `wireMessages` with the
same `requestAgentVoiceStream` and `notifyOperator` entry points.

## Builtin plugins

`createBuiltinChannelPlugins` returns exactly one plugin today: Multica
(`src/channels/multica/plugin.ts`), the gateway-to-Multica work-item channel
(see [multica.md](multica.md) for the adapter end to end). Its `parseConfig` is
the reference example of the fail-closed section contract: an inline `token`
field is rejected in favor of `tokenRef`; unknown keys throw; `workspaceId`
must be a lowercase RFC-4122 UUID; `baseUrl` must be HTTPS unless loopback and
free of credentials, path, query, or fragment; `pollIntervalMs` must sit in
`[250, 60_000]`; and an `enabled: true` section must configure `baseUrl`,
`workspaceId`, `companionId`, `tokenRef`, and `pollIntervalMs`. The declared
credential need is id `token` with description `Multica gateway token`.
`create` fails when an enabled plugin has no companion or no resolved token,
and when the plugin needs its own runtime ownership it derives a Postgres
runtime lease from `context.postgresDatabaseUrl` — falling back fail-closed if
the gateway did not supply one.

## Fail-closed invariants

| Invariant | Enforced by |
| --- | --- |
| Duplicate or empty plugin ids rejected at registration | `createChannelPluginRegistry` |
| Unknown `channels.json` keys rejected at load and at save | `parseChannelPluginSections`, `saveChannelsOwnerFile` |
| Secrets never stored inline; resolved from vault per plugin | `parseConfig` + `instantiatePlugin` |
| Adapter identity must equal manifest/plugin identity | `instantiatePlugin`, `loadChannelAdaptersFromManifest` |
| Required adapters fail closed on disable, denial, or create failure | `loadChannelAdaptersFromManifest` |
| Eligibility requirements may not be omitted | `requireEligibilityRequirements` |
| Plugin host never survives partial construction or partial start | `ChannelPluginHost.load` / `start` rollback |
| No channel surface may attach with zero loaded adapters | `loadChannelAdaptersFromManifest` / `startChannelAdapters` |
| Enabling any plugin without a credential vault aborts startup | `loadGatewayChannelSurfaces` |
