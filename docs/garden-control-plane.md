# Fleet-scoped Garden control plane

Status: implemented in the repository, 2026-07-18 (approved architecture
direction 2026-07-17; delivered by the `psfn-framework-mus2` epic), pending an
operator-managed live cutover. The code and Helm topology define one
fleet-scoped Garden and retire per-companion Garden processes, `gardenPort`,
and the raw fleet-status listener, but this implementation wave did not mutate
the live k3s deployment. The migration section below is the required cutover
and rollback plan, not evidence that the rollout already happened.

## Decision

Run one Garden control plane for the fleet. Its UI contains both the fleet view
and a companion switcher. Selecting a companion opens that companion's ordinary
Garden pages. Selecting one of the companion's shards opens a limited shard
sub-view inside the same Garden.

Do not deploy a Garden process or container per companion or per shard. A fleet
of roughly a dozen companions should still have one Garden deployment, not
roughly a dozen Gardens plus a separately deployed fleet view.

The consolidation shares the pane, not authority or ownership:

- every non-public admin request identifies exactly one companion in its
  canonical URL;
- the gateway authenticates the principal and authorizes the action for that
  companion on every request;
- the Garden verifies the exact companion-bound request capability before it
  selects an agent transport;
- the selected companion's agent remains the adapter for its runtime and
  canonical owner files;
- a shard is always nested under its parent companion and never becomes a fleet
  target, Garden deployment, owner-file root, port, certificate, or PVC.

The UI switcher is navigation only. It is never an authorization seam.

## Existing seams to retain

The design extends the live contracts rather than creating a parallel control
plane.

- `src/boundary/gateway/fleet-sso-router.ts` already parses
  `/companions/<companionId>/garden/...`, resolves live Fleet Auth context for
  that companion and action, and signs an exact request capability.
- `src/operator/garden/garden-admission.ts` already verifies method, path,
  query, body, action, audience, companion, authority versions, and replay
  state. It currently binds one Garden process to one companion.
- `src/operator/garden/operator-surface.ts` already exchanges an admitted
  operator capability for an agent-audience child capability before proxying
  an admin request.
- `src/operator/garden/transport-client.ts` and
  `src/operator/garden/transport-paths.ts` already provide authenticated socket
  and network adapters to agent admin transports.
- `src/operator/garden/local-admin-contract.ts` and
  `src/system/config/settings-contract-guard.ts` already keep owner-file
  selection and validation on the companion side of the admin transport.
- `src/boundary/gateway/fleet-portal-projection.ts` already projects only the
  companions the current Fleet Auth session may see.
- `src/operator/garden/services/shard-fold-review-service.ts` and
  `src/faculties/shards/manager.ts` already expose a parent-owned shard review
  and lifecycle seam.

The new module should be deep: callers provide a request, and the module hides
companion resolution, capability verification, transport selection, child
assertion exchange, and failure normalization behind one interface. Deleting
that module should force this logic back into every route; otherwise the module
is too shallow.

## Invariants

1. There is one fleet Garden process and one fleet view.
2. One admin call has one explicit companion target. There is no fleet-wide
   mutation call and no process-global mutable `currentCompanion`.
3. Companion selection comes from the canonical route and must match the signed
   capability, Fleet Auth context, child capability, selected transport, and
   agent identity.
4. Unknown, malformed, stale, removed, or unauthorized selections fail closed
   before an agent call. They must not reveal whether a companion exists.
5. Agent or owner-file failure never falls back to another companion, a shared
   root, a cached prior selection, or a legacy Garden.
6. Existing owner-file scopes remain authoritative. The consolidation does not
   merge per-companion files, copy them into a Garden database, or turn UI state
   into configuration authority.
7. Concurrent requests for different companions carry their own immutable
   target context. A slow request or WebSocket for companion A cannot influence
   a request for companion B.
8. Shards inherit from one parent companion. A shard identifier without its
   verified parent companion is insufficient to read or mutate anything.
9. The Garden receives no provider, channel, model-provider, shell,
   companion-auth, or Personal Workspace credentials merely because it can
   switch companions.
10. Fleet Auth remains the browser authentication and authorization authority.
    Consolidation must not recreate the retired shared-admin-token topology for
    a fleet-enabled deployment.
11. Garden services that already read or write the database directly keep that
    access (operator decision 2026-07-17: rerouting existing reads through
    agent transports is not worth the rework). In exchange, every database
    access in multi-companion mode is scoped to the request's authenticated
    companion target: the schema, rows, and writes a Garden service touches are
    derived from the immutable request context of the companion who generated
    the request — never from a process-global selection, a cached prior
    companion, or an unscoped query. The companion-scope guard
    (`src/operator/garden/garden-companion-scope.ts`, wired at the admin route
    dispatch chokepoint) refuses any dispatch whose request companion does not
    match the service's companion binding. A request for companion A can neither
    read nor write companion B's data. Observer-eval sidecar persistence remains
    the existing deployment-global, non-authoritative eval store (the explicit
    mus2.16 exception); its Garden routes still require an authenticated,
    companion-bound dispatch, but its rows are not companion-owned data.

## Public route and switcher contract

Keep the existing companion-scoped public root:

```text
/fleet
/companions/<companionId>/garden/
/companions/<companionId>/garden/<page>
/companions/<companionId>/garden/api/admin/<resource>
/companions/<companionId>/garden/api/admin/events
```

`/fleet` is the entry to the same Garden application. It renders the authorized
fleet overview and switcher; it is not a second application or deployment. The
switcher roster comes from the gateway's authenticated fleet portal projection,
which returns only companions for which the session has an active binding and
eligible Garden access. The projection remains a gateway-owned authorization
view even though the Garden UI renders it.

The Companion UI app consumes the same projection through two cookie-authed,
`no-store, private` gateway endpoints (`FleetAuthHttpRoutes`), both backed by
`GatewayFleetPortalProjection.resolveRoster` and its least-authority,
non-enumerating authorizer:

- `GET /v1/fleet-auth/companions` — the roster: `{ companionId, displayName,
  websocketPath, avatarRef? }` per companion the session may reach. `displayName`
  resolves to the manifest label else the `companionId` (no character-card reads
  at request time; see [multi-companion.md](./multi-companion.md)). The active
  companion is expressed only by which `websocketPath` the app opens.
- `GET /v1/fleet-auth/approvals` — the fleet-wide pending-approval view:
  redacted `{ companionId, companionDisplayName, id, title, requestedAt,
  expiresAt?, status }` entries, so an approval for companion X surfaces (with
  attribution) even while the human talks to companion Y. Ownership is joined
  from the approval boundary's owner map; entries with no resolvable owner, or
  an owner outside the session's authorized roster, are excluded (fail closed,
  never mis-attributed, non-enumerating). Redaction reuses the companion-relay
  approval whitelist — raw tool params never appear.

The app never enumerates the raw fleet manifest; both endpoints are filtered to
the session's authorized companions.

The selected companion stays in the URL for page routes, API calls, downloads,
and WebSockets. The browser client derives request URLs from the current
companion route. It does not send an unbound `companionId` header, body field, or
cookie and does not rely on a local-storage selection for authority. Deep links
therefore retain their target, and a stale deep link is re-authorized normally.

On a switch, the client must close the old WebSocket, cancel in-flight requests,
clear page state, and open the new companion-scoped channels. Browser caches,
IndexedDB keys, polling state, event buffers, and dedupe keys that can contain
companion data must include the companion ID. The UI must not render prior
companion data while the new selection is loading or denied.

Static content-hashed assets may remain fleet-shared. HTML bootstrap and all
data-bearing responses remain `no-store` or companion-keyed as appropriate.

## Server-side authorization and routing

Every HTTP request and WebSocket upgrade follows the same sequence:

1. The gateway parses the canonical outer path and validates the selected
   companion ID against the fleet manifest.
2. It compiles the route declaration, including method, canonical inner path,
   query policy, body digest, Fleet Auth action, and selected companion.
3. It resolves the live session/contact/binding/grant/policy context for that
   exact companion and action. The switcher cannot satisfy this step.
4. It signs and consumes a short-lived operator request capability whose target
   and audience are bound to that companion.
5. It forwards the companion-scoped internal route and capability over the one
   gateway-to-Garden mTLS connection.
6. The fleet Garden parses the same companion from the internal route, compiles
   the same inner target, verifies the capability and replay context, and
   requires equality across route target, signed target, audience, and
   authenticated context.
7. Only after verification does the Garden resolve the companion in its
   immutable target registry.
8. For agent-owned admin routes, the Garden exchanges the admitted operator
   capability for an exact agent-audience child capability and sends it through
   that companion's registered admin-transport adapter.
9. The agent verifies the child capability against its own process identity
   before a domain module runs. The resulting `GardenRequestContext` accompanies
   the call and audit record.

The public path may be stripped only after the selected companion has been
compiled into the immutable target and signed authority. Do not add a
caller-controlled authority header as a shortcut.

### Failure behavior

| Condition | Result |
|---|---|
| malformed or unknown companion selection | generic 404; no registry or agent call |
| principal lacks the selected companion/action | generic 404; no registry or agent call |
| route, capability, audience, or context companion mismatch | deny; no transport fallback |
| replayed, stale, or revoked capability/session | deny; no transport fallback |
| selected agent unavailable | authenticated 503 for that target only |
| target registry is incomplete or colliding at startup | Garden refuses to start |
| selected owner file is missing, malformed, or wrong-rooted | operation fails; no global/other-companion fallback |
| stale UI selection | ordinary re-authorization; old data is cleared |
| shard not owned by selected companion | generic 404; no shard detail leaks |

Authorization infrastructure errors remain errors. They are not treated as an
empty allowlist or a reason to retry against another target.

## Fleet Garden module

The external interface should stay small:

```ts
interface FleetGardenControlPlane {
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void>;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  probe(): Promise<FleetGardenReadiness>;
}
```

The implementation owns an immutable `FleetGardenTargetRegistry`, built once
from the validated `companions.json` fleet. A registry entry contains only
trusted routing material:

- canonical companion ID;
- the exact socket or mTLS agent-admin endpoint derived from deployment
  topology;
- health/probe state;
- the material needed to verify that the remote agent represents the same
  companion.

It does not contain caller-supplied paths, mutable selected state, reusable
browser authority, provider credentials, or copied owner data. Unknown entries
are not synthesized.

`GardenAdminTransportProxy` becomes the production adapter at this seam. An
in-memory adapter is justified for concurrency, authorization, and target
isolation tests. Both adapters receive an immutable admitted target; neither
chooses a companion.

The current single-companion `GardenOperatorSurface` can remain the
single-companion adapter while multi-companion mode instantiates the fleet
module. Do not layer a fleet router over N long-lived
`GardenOperatorSurface` instances: that would preserve the deployment and
mutable-config complexity this decision removes.

## Owner-file authority

Admin modules continue to load and mutate owners through the selected
companion's agent-side configuration module.

- Per-companion whole-file owners remain rooted according to
  `PER_COMPANION_OWNER_FILES` in
  `src/system/config/settings-contract.ts` (currently
  `capability-tier.json`, `scheduler.json`, `charge-policy.json`, and
  `skills.json`).
- Per-companion `settings.overlay.json` remains the bounded override over the
  canonical `settings.json` contract.
- Companion-owned Garden audit, reflection, fatigue/charge, prompt, identity,
  memory, and related state remains under that companion's canonical data root
  or Postgres schema.
- Cluster-global owners remain cluster-global. A shared UI does not make a
  per-companion owner global, and selecting a companion does not create a
  companion copy of a global owner.

The target registry maps a companion ID to a transport, not to a request-chosen
filesystem path. The control-plane container does not need every companion PVC
mounted writable. This preserves least privilege and lets the already-bound
agent configuration module enforce owner rooting, validation, atomic writes,
and runtime cache invalidation.

Owner mutations must record the selected companion, principal, action, owner
file, prior revision/digest, resulting revision/digest, and decision in the
existing audit path without recording secrets. A request cannot name an
alternate owner path.

## Fleet view consolidation

The fleet portal and fleet-status presentation are folded into the one Garden
UI:

- keep `GatewayFleetPortalProjection` as the authorized roster source;
- add the authorized connection-health fields needed by the existing fleet
  status presentation without exposing ports, internal origins, sockets, or
  companions the principal cannot access;
- render the overview and companion switcher from the Garden bundle;
- link each row to its canonical companion-scoped Garden route;
- retain gateway ownership of session authentication, live authorization, and
  connection-registry facts.

The separately served HTML/JSON status page and its `FLEET_STATUS_PORT` /
`FLEET_STATUS_HOST` listener are retired. There is no separately deployed
"fleet manager Garden." The gateway may retain a narrow internal
projection module because it owns connection state, but presentation belongs to
the single Garden.

The full-roster raw status payload must not be reused as the browser projection.
The authenticated view remains least-authority and non-enumerating.

## Shards under their parent companion

The companion's Shards page becomes a parent-scoped tree:

```text
Fleet
└── Companion
    └── Shards
        └── Shard detail and limited overrides
```

All shard routes carry both the parent companion from the canonical Garden root
and a shard ID. The parent agent resolves the shard record and proves that its
lineage names that companion before returning status, telemetry, fold review,
or override state. A shard never enters the fleet target registry.

The shard detail page shows a read-only inherited configuration snapshot with
the parent source and revision. The initial mutable allowlist is deliberately
small:

- model selection, restricted to models the parent companion is eligible to
  use;
- shard budget, restricted to the shard's inherited parent allocation and
  never able to widen the parent charge limit.

Capability tier, trust, identity/personality, prompts, skills, channels, owner
paths, workspace roots, and persistence roots are inherited/read-only. Unknown
override keys reject. The server validates every override against the live
parent contract; the UI allowlist is not enforcement.

Shard overrides are ephemeral lineage-bound runtime state, not new JSON owner
files. Reads return inherited, overridden, and effective values separately.
Mutations record principal, parent companion, shard ID, previous/effective
values, and decision in the audit/fold lineage. Completed, failed, cleaned-up,
unknown, or parent-mismatched shards reject mutation.

Existing fold-review approve/deny behavior remains on this parent-scoped page.
Approval routing and derived shard tier follow their dedicated architecture
specifications; this control-plane design must consume those contracts rather
than create parallel rules.

No shard causes creation of:

- a Garden process, pod, Service, Ingress, port, or certificate;
- a fleet-auth companion, binding, or operator grant;
- a companion manifest entry;
- a companion owner-file tree or Garden settings editor;
- a dedicated Garden PVC.

## Deployment topology

### Local supervisor

`scripts/start-gateway-agent.sh` continues to spawn one agent per fleet entry,
then starts one fleet Garden after the complete target registry can be built.
The fleet Garden derives every socket endpoint from the validated companion ID
using `resolveCompanionAdminTransportSocketPath`; it does not accept manifest
path overrides or a delimiter-packed endpoint env variable.

`companions.json` does not assign a Garden port per companion; a `gardenPort`
key fails config validation closed. One fleet-level Garden listener uses the
normal process-wiring port. The launcher plan therefore carries no `gardenPort`,
and a missing/colliding agent-admin endpoint fails the fleet Garden startup.

### Kubernetes / Helm

The fleet topology renders:

- one gateway;
- N companion agent workloads and their authenticated admin endpoints;
- one Garden Deployment and Service;
- no per-companion or per-shard Garden Deployment/Service.

The Garden identity is fleet-scoped. Gateway-to-Garden and Garden-to-agent
connections use mTLS/SPIFFE, with the selected companion additionally bound by
the request capability. NetworkPolicy allows the gateway to reach only the
fleet Garden listener and allows the Garden to reach only registered agent
admin endpoints and the narrow gateway child-assertion/confirmation interface.

The Garden pod mounts its image, required fleet/system configuration,
certificates, logs/tmp as needed, and no provider/channel secrets. It retains
the database credential its existing services already use for direct reads and
writes (invariant 11), with every direct route dispatched through a
companion-bound service table selected from the authenticated request. It does
not require direct writable mounts for every companion-data or Personal
Workspace PVC; selected agents remain the adapters to those domains.

Helm health and post-rollout checks probe the one Garden deployment and then
exercise at least one authorized request per registered companion. One healthy
process probe is not sufficient evidence that the complete target registry is
usable.

## Migration and rollback

This is a topology migration, not a data or owner-format migration. Canonical
owner files and companion state stay in place. An operator performs the
following cutover only after discovering the live k3s authority and preserving
the deployed values and rollback revision:

1. Land the fleet target registry, companion-bound admission, selected
   transport routing, UI URL builder, and tests while the old topology remains
   authoritative.
2. Deploy the fleet Garden dark: no browser route and no mutations. Probe every
   registered companion transport and verify identity equality.
3. Render and inspect the Helm/supervisor plan: exactly one Garden, no direct
   Garden Ingress in Fleet Auth mode, complete target registry, and restrictive
   network policy.
4. Switch the gateway's companion routes atomically from N Garden origins to
   the one fleet Garden origin. The canonical public URLs do not change.
5. Validate parallel reads and bounded mutations against at least two
   companions, one denied companion, one unavailable companion, WebSocket
   switching, and one parent-owned shard.
6. Disable the per-companion Garden processes and remove their Services,
   certificates, per-entry ports, and the raw fleet-status listener. Remove,
   rather than preserve, the retired launcher and manifest fields.
7. Record the deployed revision and verification evidence, then update this
   status only after the rollout topology is confirmed as the live authority.

There is no dual-write period and no copied owner state. During the dark stage,
the fleet Garden is probe-only. After the future gateway cutover, old Gardens
must not receive admin traffic.

### Pinned rollback procedure

Rollback is a whole-deployment revision pin, never a mixed topology:

1. Identify the last known-good revision that predates the fleet-Garden
   cutover: `helm history <release>` in Kubernetes, or the pinned prior
   image/commit for the local supervisor launcher.
2. Roll the entire release back to that revision (`helm rollback <release>
   <revision>`, or restart the supervisor from the pinned prior checkout).
   This restores the prior gateway upstream map and per-companion Garden
   workloads together; do not roll back the Garden while leaving the new
   gateway routing (or vice versa).
3. Because owner files never moved or changed format, and there was no
   dual-write period or copied owner state, rollback reverses no data and
   merges nothing. Canonical owner files are the same files in both
   topologies.
4. A rollback must still preserve the one-browser-origin Fleet Auth boundary;
   it must not expose direct Garden ports or fall back to one shared admin
   token.
5. Re-run the deployment verification (`npm run verify:helm-chart`, rollout
   validation) against the pinned revision before returning traffic.

## Verification

Implementation is not complete until the integrated branch proves:

- two simultaneous requests for different companions cannot cross transports,
  owner roots, response data, audit scope, or WebSocket event streams;
- unknown and unauthorized selections are indistinguishable at the public
  edge and never reach the Garden registry;
- a route/capability/context/transport identity mismatch fails closed;
- every registered companion is independently readiness-probed;
- a selected companion outage does not redirect or fall back to another;
- owner-file reads and writes hit only the selected canonical owner and retain
  settings-contract validation;
- database reads and writes performed for a Garden request touch only the
  selected companion's schema and rows, keyed by the request's authenticated
  companion target and enforced at the admin dispatch chokepoint; a request
  for companion A cannot read or write companion B's data;
- switching clears or companion-keys all browser state;
- the authorized fleet projection omits inaccessible companions and internal
  topology;
- shard lookup enforces parent lineage, inherited fields remain read-only, and
  model/budget overrides cannot widen parent authority;
- rendered local and Helm plans contain exactly one Garden and zero shard
  Gardens;
- migration cutover and pinned rollback preserve the public route and owner
  data.

Run targeted unit/integration/E2E coverage, `npm run lint`, `npm run build`,
`npm run verify:settings-contract`, `npm run verify:repository-hygiene`,
`helm lint deploy/helm/psfn`, and `npm run verify:helm-chart` once the complete
implementation sequence is integrated.

## Non-goals

- Changing companion-data ownership, owner-file formats, or settings scopes.
- Adding a fleet-wide mutation interface or a cross-companion management tier.
- Allowing one companion selection to authorize another.
- Mounting a general shared filesystem or adding manifest path overrides.
- Giving the Garden provider, channel, shell, or companion-agent credentials
  beyond its approved request-scoped database access.
- Giving shards full Garden pages, full settings editors, independent Fleet
  Auth identities, or durable owner files.
- Expanding shard overrides beyond the approved model and budget controls.
- Exposing private transcripts, model reasoning, cross-companion private state,
  or the raw full-roster fleet-status payload.
- Keeping legacy per-companion Garden readers or topology shims after cutover.

## Implementation sequence

The implementation work is filed as `psfn-framework-mus2`, with the sibling
shard-tier and approval-routing contracts named as dependencies rather than
re-designed here.

1. Deepen fleet Garden admission and target routing.
2. Convert the operator surface from one fixed proxy to the immutable fleet
   target registry.
3. Move fleet view and companion switching into the Garden bundle with
   companion-keyed client state.
4. Add parent-scoped shard snapshot and limited override routes using the shard
   tier, budget, and approval contracts.
5. Replace per-companion local supervisor wiring with one fleet Garden.
6. Replace per-companion Helm Garden resources with one fleet deployment,
   identity, Service, and policy.
7. Cut over, certify the integrated topology, retire legacy fleet-status and
   per-companion Garden surfaces, and document rollback.
