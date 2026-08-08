# pi-ai sole LLM gateway migration guide

Status: code migration implemented on `wave/shjzt-pi-ai-gateway-final`; awaiting
the final pre-PR gate, publication, merge, and separately authorized live rollout

Date: 2026-08-08

Owning epic: `psfn-framework-shjzt`

Decision owner: operator

## Evidence basis and freshness

This is an implementation guide, so statements using "must", "will", and
"required" are operator-approved target requirements rather than claims about
already-delivered behavior.

The current-state architecture was traced with CodeGraph and then checked
against the runtime entrypoints, composition, contracts, tests, Helm templates,
and proxy assets on main at `30510a09b`. The main evidence paths are
`src/app/startup/`, `src/app/gateway/`, `src/app/agent/`, `src/llm/`,
`src/system/config/`, `src/system/settings/`, `charts/`, `k8s/`, and `proxy/`.
Implementation beads must repeat focused source checks after rebasing; this
guide is not authority over code that changes later.

The upstream dependency snapshot was refreshed on 2026-08-08:

- the repository currently pins `@mariozechner/pi-ai@0.73.1` and
  `@mariozechner/pi-agent-core@0.73.1`, whose npm metadata asks consumers to
  move to the `@earendil-works` scope;
- npm's current stable tag for both replacement packages was `0.84.1`, and the
  official repository's `v0.84.1` tag resolved to
  `53fa77ccd8a279eb87e92294ef3687b03ff80112`;
- the selected packages require Node `>=22.19.0`, and their published metadata
  pins TypeBox `1.3.7`;
- the pinned upstream [`Agent` source][pi-agent-0841] and
  [`Models` implementation][pi-models-0841] are the API evidence used by this
  plan, including the runtime `streamFunction` field and instance-owned
  provider dispatch.

Primary references:

- [`@earendil-works/pi-ai` package metadata][pi-ai-npm]
- [`@earendil-works/pi-agent-core` package metadata][pi-agent-npm]
- [`@mariozechner/pi-ai` package metadata][old-pi-ai-npm]
- [`@mariozechner/pi-agent-core` package metadata][old-pi-agent-npm]
- [official pi `v0.84.1` source tag][pi-tag-0841]

[pi-ai-npm]: https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.84.1
[pi-agent-npm]: https://www.npmjs.com/package/@earendil-works/pi-agent-core/v/0.84.1
[old-pi-ai-npm]: https://www.npmjs.com/package/@mariozechner/pi-ai/v/0.73.1
[old-pi-agent-npm]: https://www.npmjs.com/package/@mariozechner/pi-agent-core/v/0.73.1
[pi-tag-0841]: https://github.com/earendil-works/pi/tree/v0.84.1
[pi-agent-0841]: https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/src/agent.ts
[pi-models-0841]: https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/models.ts

## 1. Decision

PSFN will remove its bundled LiteLLM workload and make the maintained
`@earendil-works/pi-ai` provider runtime the only in-process implementation
that dispatches LLM requests.

The operator already owns an external LiteLLM router shared by multiple
systems. That external service remains available to PSFN as an upstream
OpenAI-compatible endpoint. It is not deployed, configured, monitored, or
treated as a privileged subsystem by the PSFN Helm chart.

The resulting production request path is:

```text
companion agent
  -> PSFN gateway RPC boundary
  -> PSFN routing, policy, admission, budgets, and accounting
  -> pi-ai Models/provider runtime
  -> external shared LiteLLM endpoint
  -> selected upstream model provider
```

Direct provider endpoints remain a supported deployment shape for local,
single-user, and test environments. They use the same pi-ai runtime and do not
reintroduce a second PSFN routing implementation.

In this guide, "pi-ai gateway" means the in-process provider dispatch boundary.
It is not a new network service and must not become a second RPC or HTTP hop.

## 2. Why this change is needed

PSFN currently has three overlapping layers between its product policy and the
actual model provider:

1. PSFN selects candidates, enforces policy and budgets, retries calls, records
   usage, and protects foreground capacity.
2. pi-ai converts messages and tools into provider wire formats and interprets
   streamed provider responses.
3. A PSFN-owned LiteLLM pod translates another OpenAI-compatible request before
   forwarding it, usually to OpenRouter.

The third layer is redundant in this deployment. The bundled LiteLLM instance
does not have a database-backed control plane, per-user virtual-key budgets,
independent rate-limit policy, or a separate multi-consumer authority role. Its
active configuration supplies model aliases, parameter dropping, a model-list
endpoint, an internal master key, and an extra network hop. PSFN and the
external router already own the useful policy on either side of that hop.

Removing the internal proxy provides one provider abstraction inside PSFN,
fewer credentials and concepts in owner files, one fewer container and network
policy, and a clearer failure boundary. It also makes the pi-ai upgrade a real
architectural migration instead of retaining its temporary compatibility API
behind another compatibility proxy.

## 3. Current verified architecture

### 3.1 Request ownership

The agent process does not call providers directly. `GatewayClient` sends chat,
completion, vision, and embedding requests over the authenticated gateway RPC
boundary. The gateway-owned `LLMClient` performs candidate selection and invokes
pi-ai.

`LLMClient` already owns functionality that must remain in PSFN:

- purpose and per-companion slot selection;
- sensitive-import routing policy;
- foreground/background admission and preemption;
- retry classification and backoff;
- a sliding-window circuit breaker;
- candidate fallback ordering;
- daily, monthly, and ICP conversation cost enforcement;
- correlation and attribution;
- actual/estimated cost reconciliation;
- usage persistence and operator-facing telemetry.

None of those responsibilities should move to the external router or disappear
inside pi-ai.

### 3.2 Existing dual provider path

The runtime currently chooses one of three paths:

| Condition | Current behavior |
| --- | --- |
| A `requestBaseUrl` exists on the model candidate | Build an OpenAI-compatible pi-ai model for that endpoint. |
| A LiteLLM base URL exists | Normalize the model name and send it to the PSFN-owned LiteLLM proxy. |
| Neither exists | Resolve the provider/model from pi-ai's built-in registry and call it directly. |

The target removes the second branch. An external LiteLLM endpoint uses the
first/general endpoint mechanism through a canonical provider entry. It must
not be recognized by product code through a `litellm` name check.

### 3.3 Bundled LiteLLM deployment surface

The Helm chart currently owns all of the following:

- LiteLLM image pin, command, ConfigMap, Deployment, Service, probes, and
  temporary filesystem;
- internal/external/disabled LiteLLM chart modes;
- `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `LITELLM_MASTER_KEY` wiring;
- a LiteLLM-specific application secret key;
- gateway-to-LiteLLM and LiteLLM-to-internet NetworkPolicy rules;
- explicit model aliases and OpenRouter forwarding rules;
- chart-verifier assertions for the complete surface.

The repository also contains legacy `k8s/` manifests and `proxy/` assets for a
PSFN-managed proxy. Those are part of the contraction, not retained examples.

### 3.4 Capabilities currently encoded in LiteLLM configuration

The internal proxy configuration contains behavior that must be deliberately
migrated rather than deleted:

- public aliases that map to OpenRouter model identifiers;
- an `:exacto` route chosen for tool-call reliability;
- a colon-free Nitro alias that maps to an OpenRouter `:nitro` identifier;
- an explicit reasoning-off setting for the Nitro route;
- wildcard OpenRouter routing;
- unsupported-parameter dropping;
- model-list enrichment used by the Garden discovery surface;
- cost evidence found in LiteLLM-specific response headers.

Each behavior needs either a target owner or an explicit removal decision.

## 4. Target responsibility model

| Concern | Target owner | Notes |
| --- | --- | --- |
| Agent lifecycle and tool loop | `pi-agent-core` plus PSFN scheduled-loop graft | Private graft remains version-coupled and must be audited on every bump. |
| Provider catalog and wire protocol | pi-ai `Models` and `Provider` APIs | No root-level legacy global dispatch and no `/compat`. |
| Provider/model owner configuration | PSFN `providers.json` and `models.json` | Canonical mutable owner files remain authoritative. |
| Purpose/slot/candidate routing | PSFN | pi-ai receives the already-selected model. |
| External shared routing | Operator-owned external LiteLLM | Presented to PSFN as an ordinary OpenAI-compatible endpoint. |
| Direct provider auth | PSFN credential vault integrated with pi-ai | Provider keys stay in the gateway process. |
| Retries, fallback, and circuit breaking | PSFN, with provider retry semantics composed once | Avoid nested retry multiplication. |
| Admission, preemption, and capacity | PSFN | External router limits may reject, but do not replace local welfare-aware admission. |
| Cost budgets and charge policy | PSFN | External cost evidence is an input, never the policy authority. |
| Model discovery | PSFN discovery service backed by provider APIs/pi-ai catalogs | No LiteLLM URL prerequisite. |
| Deployment of external router | Outside this repository | No external hostname, secret value, or deployment-specific path is tracked here. |

## 5. Non-negotiable invariants

1. Agent pods never receive upstream provider credentials.
2. Every agent-originated model request crosses the authenticated gateway RPC
   boundary before network egress.
3. Unknown providers, APIs, model configurations, credentials, and routing
   metadata fail closed.
4. `providers.json` and `models.json` remain the mutable configuration authority;
   environment variables carry only credential references and endpoint wiring.
5. PSFN product policy is evaluated before a provider request begins.
6. Usage recording remains attempt-aware and distinguishes requested identity,
   selected candidate, backend endpoint, and returned model.
7. Actual provider cost is preferred when available. Estimated catalog cost is
   retained as clearly labeled fallback evidence.
8. No temporary pi-ai `/compat` dependency is introduced.
9. No PSFN code branches on `litellm` to decide protocol behavior. Protocol is
   selected from canonical provider/model configuration.
10. The external router cannot silently become a source of mutable PSFN policy.
11. Direct-provider and external-router modes use the same LLMClient and pi-ai
    execution path.
12. A failed migration must be recoverable by owner-file and chart rollback
    without rewriting session or persistence data.

## 6. Provider and model configuration design

### 6.1 External router representation

Use the existing generic OpenAI-compatible provider concept for the external
shared LiteLLM router. Do not retain `litellm_proxy` as a special canonical
provider type merely because the upstream software happens to be LiteLLM.

The public shape should communicate protocol and ownership, for example:

```json
{
  "id": "shared-llm-router",
  "type": "generic_openai",
  "enabled": true,
  "label": "Shared LLM router",
  "apiBaseUrl": "https://router.example.invalid/v1",
  "apiKeyRef": {
    "kind": "env",
    "envName": "SHARED_LLM_ROUTER_API_KEY"
  }
}
```

The example address is reserved documentation data. The live endpoint and
secret remain in ignored/private deployment inputs.

The generic provider contract needs enough metadata to declare its supported
pi-ai API (`openai-completions` or `openai-responses`) and any reviewed
compatibility behavior. If the existing metadata bag is used during expansion,
strict normalization must promote the required fields into a typed contract
before the old LiteLLM type is removed.

### 6.2 Model identities and aliases

`models.json` must carry the model identity actually sent to the selected
endpoint. Alias translation must not live in Helm YAML.

For the current special routes:

- the exacto route records the exact OpenRouter model identifier or typed
  OpenRouter routing preference that reproduces the evaluated provider order;
- the Nitro route records the actual `:nitro` model identifier while its stable
  PSFN slot id remains colon-free if required by UI or storage contracts;
- reasoning-off is an explicit model tuning decision, not an incidental proxy
  default;
- wildcard support is achieved by constructing a validated model from the
  canonical registry rather than requiring it to appear in pi-ai's generated
  catalog.

Slot ids are stable PSFN identifiers. Provider model ids are upstream wire
identifiers. The migration must not conflate them.

### 6.3 Dynamic and newly released models

The target cannot require every external-router model to be present in the
pi-ai version's generated catalog. The provider runtime must be able to create a
validated model from `models.json` metadata when the configured endpoint speaks
a supported API.

Required inputs include:

- endpoint/provider id;
- upstream model id;
- pi-ai API kind;
- context and output limits;
- text/image input support;
- reasoning capability and format;
- prompt-cache compatibility;
- reviewed cost metadata when actual cost is unavailable;
- provider-specific routing metadata where supported.

Missing required capabilities reject at config load or request construction.
There must be no generic "best effort" model with invented defaults in
production.

## 7. pi-ai runtime design

### 7.1 Repository-owned boundary

Introduce one repository-owned provider-runtime boundary before changing the
dependency. It should expose only what PSFN consumes:

- resolve a configured model;
- stream a selected model;
- complete a selected model;
- enumerate configured/built-in providers and models;
- resolve provider auth through the gateway-owned credential source;
- register configured OpenAI-compatible endpoints;
- expose request hooks needed for payload and response evidence capture.

The boundary prevents pi-ai construction, provider registration, and version
details from spreading through the existing 50-plus import sites. Stable pi-ai
message and content types may continue to be imported where they are genuine
domain boundary types; runtime singleton/global functions may not.

### 7.2 Models collection lifecycle

Build the pi-ai `Models` collection during gateway composition after canonical
provider and model owner files have loaded and credential custody is available.
The collection is gateway-owned and injected into `LLMClient`, vision, and any
other provider caller.

Do not create unrelated module-global collections in tests or production. A
single runtime instance makes provider registration, dynamic catalog state,
credentials, and test isolation explicit.

### 7.3 Provider registration

Register:

- the external shared router as a configured OpenAI-compatible provider;
- OpenRouter when directly configured;
- supported direct built-in providers selected in `providers.json`;
- explicitly configured custom endpoints.

Provider ids must match the ids referenced by model entries. Duplicate ids,
unsupported API combinations, and missing credentials fail startup.

### 7.4 Authentication

Adapt the existing `CredentialVaultPort` to pi-ai's credential resolution
contract. Explicit per-request credentials may be used internally when needed,
but callers must not read `process.env` independently after the gateway runtime
has been composed.

Remove the fallback dependency on pi-ai's legacy `getEnvApiKey`. Provider-to-env
mapping belongs either in typed provider auth construction or in canonical
credential references.

### 7.5 Retry composition

pi-ai/provider libraries and PSFN both have retry behavior. The implementation
must document and test the effective attempt count. PSFN's logical-call and
physical-attempt accounting remains authoritative.

Configure provider-level retry behavior so one logical PSFN retry does not
multiply into an unbounded set of hidden upstream retries. OpenRouter or the
external router may still perform endpoint fallback before streaming begins;
that is upstream routing, not a second PSFN candidate attempt.

## 8. pi-agent-core upgrade and private graft audit

Move both packages from deprecated `@mariozechner/*@0.73.1` to exact
`@earendil-works/*@0.84.1` pins, or a later stable version selected at
implementation time after repeating the upstream audit.

The upgrade must include:

- package names, lockfile, ESLint boundary rules, tests, scripts, and docs;
- Node engine floor alignment with the selected packages;
- removal of an obsolete pi-ai `undici` override if the target dependency tree
  no longer contains that edge;
- TypeBox 1.3.7 tool-schema/coercion conformance;
- handling the additional `max` thinking level without silently widening PSFN
  settings unless separately intended;
- handling harness-added AgentMessage variants explicitly;
- the deployment verifier's moved openai-completions artifact path.

The private scheduled-loop graft must be reviewed line by line against the
target `Agent` source. At minimum, upstream renamed the public runtime field
from `streamFn` to `streamFunction`. The current structural cast would compile
while passing `undefined` at runtime if only package names were changed.

Audit and test:

- `runPromptMessages`;
- `runContinuation`;
- `createLoopConfig`;
- `processEvents`;
- `activeRun` lifecycle and settlement;
- `_state` message, streaming, pending-tool, and error fields;
- stream-function ownership;
- reset-during-active-run behavior;
- failure event ordering and awaited listener settlement.

Preserve current PSFN-visible semantics during the dependency migration unless
a separate acceptance criterion deliberately adopts new upstream behavior.

## 9. Traffic-path migration

All of these paths must use the injected pi-ai provider runtime:

- interactive streamed chat;
- non-streamed chat;
- background and maintenance completions;
- summarization, extraction, memory, and import-processing calls;
- vision review;
- agent loop and explicit per-turn model overrides;
- fallback candidates;
- direct custom endpoints;
- configured API embeddings, if retained.

No path may construct its own global pi-ai dispatch registry or use the old root
`completeSimple`/`streamSimple` globals.

The migration is complete only when the same selected candidate produces the
same provider/model identity and control knobs in streaming and completion
paths.

## 10. Model discovery and operator surfaces

Current `ModelDiscovery` construction requires a LiteLLM base URL even though
OpenRouter metadata is the principal catalog. Replace that prerequisite.

The target discovery service should:

1. enumerate configured provider models from the pi-ai runtime;
2. fetch dynamic catalogs only for providers that explicitly support them;
3. continue OpenRouter model and ZDR endpoint enrichment when OpenRouter is
   configured;
4. represent the external shared router's catalog if it exposes a models API,
   without assuming LiteLLM response extensions;
5. tolerate one optional enrichment source failing while rejecting an invalid
   authoritative catalog;
6. cache and invalidate by provider/config identity.

Garden and onboarding changes include:

- remove LiteLLM-specific presence fields;
- display configured generic/shared router endpoints without exposing secrets;
- derive selectable provider types from the canonical contract;
- make connectivity probes protocol-based;
- remove UI copy that instructs operators to deploy a local proxy;
- preserve model selection and discovery refresh workflows.

## 11. Usage, cost, and observability

PSFN already reconciles response usage, captured body/SSE evidence, response
headers, and configured price estimates. Preserve that design while removing
LiteLLM-specific assumptions.

Required changes:

- keep generic response-body and SSE cost extraction;
- validate the external router's actual response shape through fixtures or a
  controlled conformance run;
- retain OpenRouter's final usage/cost evidence when direct OpenRouter is used;
- remove LiteLLM header names only after proving they are not emitted by the
  external shared endpoint, or keep them as protocol-neutral accepted evidence
  without a LiteLLM route dependency;
- rename `configured_litellm_proxy` route telemetry to a protocol/ownership
  concept such as `configured_provider_endpoint`;
- preserve requested provider/model, backend provider/model/API/base URL, slot,
  attempt, cache, and cost-source metadata;
- verify that cost conflicts still downgrade settlement rather than silently
  choosing one source.

Historical database values using the old route-kind string are immutable
history. Readers must continue to display them. New writes use the new value;
do not rewrite historical usage events merely to rename the route.

## 12. Embeddings and vision

The default production embedding provider is local Transformers and is not
dependent on LiteLLM. The optional API embedding provider currently falls back
to `LITELLM_BASE_URL` and `LITELLM_API_KEY`; replace that fallback with explicit
generic endpoint configuration or remove it if no supported owner-file path
requires it.

Embedding acceptance must cover:

- local Transformers unchanged;
- explicitly configured OpenAI-compatible embeddings;
- correct dimensions and response-count validation;
- gateway-only credential custody;
- usage and actual/estimated cost evidence where the endpoint returns it.

Vision review must resolve the same model/provider runtime as ordinary LLM
calls. It must not prefer a LiteLLM URL merely because one is present in an
environment inherited from an older deployment.

## 13. Helm, networking, and repository contraction

Once all runtime consumers use the new provider runtime, remove:

- `liteLlm` chart values and validations;
- the LiteLLM ConfigMap, Deployment, Service, probes, volumes, and helpers;
- LiteLLM image pins;
- LiteLLM application-secret keys and env injection;
- gateway-to-LiteLLM and LiteLLM egress NetworkPolicy rules;
- internal/external/disabled LiteLLM chart modes;
- LiteLLM-specific chart verifier assertions;
- legacy `k8s/` LiteLLM manifests;
- the repository `proxy/` LiteLLM configuration and overrides;
- scripts whose only purpose is managing the bundled proxy.

Do not remove gateway external HTTPS egress: the gateway must reach the
operator's external router or directly configured providers. The agent egress
policy remains closed.

The chart must inject only credentials referenced by supported provider owner
configuration. A later hardening project may move broad secret env injection to
mounted or dynamically resolved credentials, but that is not required to
remove the proxy.

## 14. Migration sequence

### Stage A: expand the runtime boundary

1. Introduce the repository-owned pi provider-runtime interface.
2. Route current global pi-ai calls through it without changing endpoint
   selection.
3. Add focused equivalence tests.

Main remains behaviorally unchanged.

### Stage B: upgrade and replace implementation

1. Upgrade pi-agent-core and pi-ai scopes/versions.
2. Implement the boundary with pi-ai `Models` and configured providers.
3. Audit the private agent graft and tool schemas.
4. Keep the existing owner-file models and endpoint behavior working.

Main now uses the durable pi-ai API but may still contain dormant LiteLLM
configuration branches.

### Stage C: migrate configuration and traffic

1. Add typed generic endpoint/provider metadata needed by the external router.
2. Move aliases and routing preferences into `models.json`.
3. Migrate chat, completion, vision, discovery, cost, and embeddings.
4. Demonstrate parity for direct and external-router modes.

Main no longer needs a bundled proxy at runtime.

### Stage D: contract the old surface

1. Remove `litellm_proxy` and projected LiteLLM fields from runtime contracts.
2. Remove Helm, legacy manifests, proxy assets, scripts, admin fields, and docs.
3. Prune tests and baselines; do not preserve compatibility shims.

### Stage E: integrate and cut over

1. Run the final committed head through the full pre-PR gate once.
2. Merge through normal PR delivery.
3. In a separately authorized live operation, migrate owner files and Helm
   values, inspect hashes, roll out, and observe a controlled shakedown.
4. Close implementation beads only with main SHA evidence; close the live bead
   only with live acceptance evidence.

## 15. Test and conformance matrix

| Area | Required evidence |
| --- | --- |
| Package boundary | Typecheck/build prove all deprecated imports and legacy globals are gone. |
| Agent graft | Prompt, continuation, abort, follow-up queue, failure lifecycle, wait-for-idle, and reset tests. |
| Tool calls | Sequential/parallel execution, streamed arguments, nullable unions, Discord snowflakes, invalid-schema rejection. |
| Streaming | First-output event, text/reasoning accumulation, tool deltas, terminal error, abort, retry, and partial settlement. |
| Completion | Chat/background/summary/extraction/vision parity with streaming model resolution. |
| External router | Auth, model alias, exacto/Nitro behavior, reasoning off, tool calls, cache usage, actual cost, 4xx/429/5xx classification. |
| Direct providers | At least OpenRouter plus one first-party provider or a deterministic faux provider. |
| Routing | Purpose selection, slot pinning, candidate fallback, request endpoint, unknown model/provider fail-closed. |
| Policy | Sensitive-import policy, budget gates, ICP breaker, capacity/preemption, no retry after deliberate preemption. |
| Discovery | OpenRouter metadata/ZDR, configured provider catalogs, cache invalidation, partial enrichment failure. |
| Credentials | Gateway custody, missing/unknown reference rejection, agent environment absence, redacted operator status. |
| Usage | Requested/backend identity, attempts, token/cache fields, actual vs estimated cost, evidence conflicts. |
| Embeddings | Transformers unchanged and configured API endpoint behavior. |
| Helm | No bundled LiteLLM resources or secrets; gateway egress works; agent egress stays denied. |
| Repository | Settings contract, hardcoded settings, knip, hygiene, docs, and no stale LiteLLM runtime references. |

Use deterministic provider fixtures for the broad matrix. A real external-router
shakedown is the final integration proof, not a substitute for automated tests.

## 16. Rollout procedure

Live work must follow `docs/operations.md` and use private repo-local inputs.

Before mutation:

1. discover the authoritative k3s workloads and current release;
2. capture hashes of `providers.json`, `models.json`, and relevant secret names;
3. verify the external router endpoint from the gateway's network position
   without recording its private address;
4. verify required model aliases and routing behavior on the external router;
5. verify a recoverable owner-file and Helm rollback artifact exists.

Cutover:

1. migrate `providers.json` from the special LiteLLM type to the generic shared
   endpoint type;
2. migrate model wire ids and tuning;
3. apply the chart release that contains no bundled LiteLLM workload;
4. wait only for the explicitly authorized rollout boundary;
5. run one controlled completion, streamed chat with a tool call, vision call,
   background completion, and usage/cost verification;
6. confirm the old LiteLLM pod/service are absent and no agent has external
   egress or provider credentials.

Rollback triggers include startup failure, unknown-model rejection for an
accepted slot, tool-call corruption, missing cost evidence where policy requires
it, routing to an unintended provider, or repeated external-router failures.

Rollback restores the prior application/chart version and owner-file snapshot.
It must not restore the old internal proxy by editing ad hoc host or side-directory
configuration.

The owner-file handoff is a deterministic pair, kept in the private live-ops
bundle rather than tracked source:

- forward: the validated `providers.json` uses one enabled
  `generic_openai` entry with the placeholder endpoint and credential reference
  shown in section 6.1, while `models.json` maps each stable PSFN slot to its
  exact upstream wire model and API kind;
- rollback: the pre-cutover byte snapshots of `providers.json` and `models.json`,
  their recorded SHA-256 hashes, and the previous chart/application revision;
- validation: parse both owner files with the release's strict loaders, confirm
  every enabled model references an enabled provider, confirm every credential
  reference names an available gateway-held secret, and render the selected
  chart before either direction is applied.

Real endpoints, secret names, live hashes, and release identifiers belong only
in the ignored private operations input and the Bead 9 execution evidence.

## 17. Risks and mitigations

### Private Agent coupling

Risk: the scheduled-loop graft compiles against a structurally asserted private
shape while using a renamed or semantically changed field.

Mitigation: exact source audit, runtime shape assertion at installation, and
focused lifecycle tests on the target package.

### Dynamic model freshness

Risk: the external router exposes models newer than pi-ai's generated catalog.

Mitigation: validated configured-model construction from owner metadata; pi-ai
catalog lookup is enrichment, not the sole admission mechanism.

### Hidden retry multiplication

Risk: PSFN, pi-ai SDKs, and the external router each retry the same failure.

Mitigation: document effective attempts, cap provider retries, and assert
physical-attempt accounting under 429/5xx tests.

### Cost evidence drift

Risk: removing LiteLLM headers leaves only estimates or double-counts response
evidence.

Mitigation: controlled response/SSE fixtures from the external router, source
reconciliation tests, and fail-closed budget behavior for unknown cost where
policy requires it.

### Alias drift

Risk: moving aliases from Helm changes the actual model or reasoning behavior.

Mitigation: record requested and returned model ids, inspect the captured wire
payload, and retain exact operator-reviewed mappings in `models.json`.

### Configuration half-migration

Risk: new code sees old owner files or old code sees new generic provider data.

Mitigation: versioned/strict owner-file validation, ordered chart and owner-file
rollout, preflight validation, and a complete rollback pair.

## 18. Bead decomposition and dependency graph

The implementation is an expand-migrate-contract graph. Each child is sized for
one focused agent context and must leave its published head internally coherent.

```text
A Provider runtime boundary
  -> B pi 0.84 Models implementation and Agent audit
       -> C Canonical external-router provider configuration
            -> D Chat/completion/vision traffic conformance
            -> E Discovery and operator surfaces
            -> F Credentials/usage/embeddings conformance
                 D + E + F -> G Remove bundled LiteLLM and legacy surfaces
                                  -> H Final repository integration proof
                                       -> I Authorized live cutover and acceptance
```

### A. Introduce the repository-owned pi provider-runtime boundary

Bead: `psfn-framework-shjzt.1`

Deliver a narrow injectable boundary over model lookup, streaming, completion,
provider registration, auth, and request evidence hooks. Route current behavior
through it with equivalence tests. Do not change dependencies or endpoints yet.

### B. Upgrade pi packages and implement the Models runtime

Bead: `psfn-framework-shjzt.2`

Replace deprecated package scopes, implement the boundary with pi-ai `Models`,
register built-in/configured providers, audit the private Agent graft, and repair
type/message/tool compatibility without using `/compat`.

### C. Make external routers ordinary configured providers

Bead: `psfn-framework-shjzt.3`

Extend the typed canonical provider/model contracts so the operator-owned shared
router is represented as a generic OpenAI-compatible endpoint. Move model wire
ids, aliases, routing preferences, and explicit reasoning behavior out of Helm.

### D. Prove all LLM traffic through the single runtime

Bead: `psfn-framework-shjzt.4`

Migrate and test streamed chat, completion, background purposes, explicit model
overrides, fallback, vision, payload capture, and errors through the injected
pi-ai runtime in both external-router and direct modes.

### E. Decouple discovery and operator surfaces from LiteLLM

Bead: `psfn-framework-shjzt.5`

Make discovery provider-driven, retain OpenRouter/ZDR enrichment, migrate Garden
and onboarding views, and remove the requirement for a LiteLLM URL.

### F. Preserve credential, cost, usage, and embedding contracts

Bead: `psfn-framework-shjzt.6`

Integrate credential-vault auth with pi-ai, verify actual/estimated cost and
cache evidence, rename route observability, and make API embeddings use explicit
generic endpoint configuration while leaving Transformers unchanged.

### G. Remove the bundled LiteLLM deployment and legacy surface

Bead: `psfn-framework-shjzt.7`

Delete the chart workload, secret/env/network surface, legacy manifests, proxy
assets, special provider type/fields, scripts, tests, and documentation after
all consumers have migrated.

### H. Run final integration and migration verification

Bead: `psfn-framework-shjzt.8`

Exercise the full conformance matrix on the final committed head, verify no
runtime LiteLLM special cases remain, produce exact migration/rollback inputs,
run the broad pre-PR gate once, and publish the train.

### I. Perform the separately authorized live cutover

Bead: `psfn-framework-shjzt.9`

Inspect live authority and owner-file hashes, apply the reviewed owner-file and
chart migration, run controlled acceptance, confirm old resources are absent,
and record live evidence. This bead remains blocked until the operator grants
live mutation authority.

## 19. Definition of done

The epic is complete only when:

- the maintained pi packages are on main;
- the pi-ai Models/provider runtime is the sole PSFN provider dispatcher;
- every LLM-bearing product path uses it;
- the external shared LiteLLM is configured only as an upstream generic
  endpoint;
- no PSFN Helm or legacy manifest deploys LiteLLM;
- no canonical runtime contract contains a `litellm_proxy` special case;
- model discovery, credentials, cost, caching, tool calls, vision, and embeddings
  meet the conformance matrix;
- final repository gates pass on the merged head;
- live owner files and workloads have been migrated under explicit authority;
- rollback evidence and final main/live SHAs are recorded in Beads.

## 20. Implementation checkpoint

The code train was assembled and rebased onto `origin/main` at
`9009ed876a90f8634120fd02145dd7cd9a485d33`. The final candidate branch contains
the guide plus Beads 1–8 as one nine-commit train. The reconciliation checkpoint
is `2ca7c0cc7953b2dbc8f3317faa7ae500f0d60967`; the documentation and recovery
digest cleanup immediately after that checkpoint will be represented by the
exact gated PR head recorded in Bead 8.

Implemented evidence:

- maintained `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` packages
  replace the deprecated package scope, without `/compat` imports;
- a repository-owned `ProviderRuntime` is injected through gateway composition
  and handles registered and configured pi-ai models;
- traffic-class, provider-runtime, credential, routing, discovery, streaming
  tool-call, embedding, vision, and usage/cost fixtures exercise the migrated
  seams;
- canonical provider configuration models an external router as
  `generic_openai`; production code no longer emits a LiteLLM-specific route or
  branches on a LiteLLM provider identity;
- Helm renders no bundled LiteLLM Deployment, Service, ConfigMap, credential,
  environment variable, or network rule; gateway external HTTPS egress remains
  enabled and agent external provider egress remains denied;
- the bundled proxy assets and retired standalone Kubernetes manifests are
  absent, while historical telemetry decoding and cost-evidence header reading
  remain reader-compatible.

Rebase validation found and fixed one `noUncheckedIndexedAccess` discovery
regression and one stale admin type assertion. Source typecheck reported zero
new errors; conflict-area and migration conformance suites passed. A compact
Kimi review returned PASS, with its two concrete questions independently checked
against the chart egress rule and provider-id uniqueness validation.

Still pending at this checkpoint: the single broad `gate:pre-pr` run on the
exact final commit, PR publication, merge/main evidence, and Bead 9 live work.
No live mutation is authorized by this document.
