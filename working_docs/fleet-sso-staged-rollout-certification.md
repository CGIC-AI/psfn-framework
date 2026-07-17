# Fleet SSO Staged Rollout Certification

This is the repo-local operator artifact for certifying and staging the optional
fleet-authenticated browser origin. It does not authorize a deployment by
itself, contain deployment-specific addresses, or replace the canonical owner
files. Private values belong in `scripts/ops/private-ops.env`; runtime authority
remains in the repo-owned system and companion data roots.

## Deterministic certification

Run the final behavioral fixture from the exact candidate commit:

```bash
npm run verify:fleet-auth-certification
```

The fixture runs four fail-fast phases. The first proves gateway-only
OAuth/session/assertion authority and disjoint projections for two principals
across two companions. The second proves the Discord member-deny hard veto,
authoritative Hub device identity, Companion UI human/device separation, and
legacy-token mode separation. The third proves first-owner and recovery
ceremonies plus self/co-subject JIT and exclusive non-subject privacy
break-glass. The fourth uses disposable PostgreSQL to prove lifecycle races,
monotonic account/passkey floors, restore quarantine, replay consumption, and
privacy-projection invalidation.

The complete candidate gate is:

```bash
npm run verify:fleet-auth-certification
npm run lint
npm run build
npm run verify:settings-contract
npm run verify:repository-hygiene
npm run verify:backup-restore
npm run verify:helm-chart
git diff --check
```

No phase requires live Discord, production credentials, or a production
hostname. Docker is required for the disposable PostgreSQL fixtures. The Helm
gate requires the exact tool versions already enforced by the repository.

## Acceptance evidence map

| Boundary | Deterministic evidence |
| --- | --- |
| OAuth, CSRF, state/code replay, session fixation, SSRF and secret redaction | `fleet-auth-broker.test.ts`, `fleet-auth-routes.test.ts` |
| Two companions and two principals, IDOR, logout/revocation, Companion UI origin | `fleet-sso-unified-origin.integration.test.ts` |
| Discord administrator evidence and member-specific deny hard veto | `discord-evidence-runtime.test.ts` |
| Device/place authority independent from human authority | `hub-device-assertion.test.ts`, `hub-device-ingress.test.ts`, Companion UI suites |
| Ed25519 audience, body/query/action binding, rotation and replay | request-capability and child-assertion suites |
| First owner, current-plus-new provider lifecycle and trusted-host recovery | ceremony suites and authority-lifecycle PostgreSQL fixture |
| Self/co-subject JIT and exclusive UV non-subject disclosure | memory JIT and privacy break-glass suites |
| Backup resurrection, account reapproval and passkey A/B floor regression | fleet-auth schema and restore PostgreSQL fixtures |
| Enabled legacy rejection and feature-off parity | legacy-surface, Garden fleet-SSO and recovery-route suites |
| Sole gateway ingress, pinned images, Companion UI and rollback topology | `npm run verify:helm-chart` |

## Staged rollout

Use one immutable candidate commit and exact image digest throughout the
stages. First capture the current Helm revision, effective repo-owned values,
certificate Secret names, and a same-snapshot fleet owner backup. Do not copy
Secret values into the artifact or shell history.

Render the candidate with the private repo-local values before touching the
cluster:

```bash
helm lint deploy/helm/psfn -f "$PSFN_VALUES_FILE"
helm template "$PSFN_HELM_RELEASE" deploy/helm/psfn \
  -f "$PSFN_VALUES_FILE" > /tmp/psfn-fleet-render.yaml
npm run verify:helm-chart
```

The render must have exactly one browser Ingress, owned by the gateway at the
canonical HTTPS root. Garden and Companion UI remain `ClusterIP`, accept only
gateway ingress, and have no host port or direct browser Ingress. Enabled
gateway and Garden workloads must not receive `ADMIN_TOKEN`,
`ADMIN_ALLOW_INSECURE`, or a public `FLEET_STATUS_PORT`.

Apply first to an isolated namespace or canary fleet with the same topology as
production. Use Helm's wait/atomic behavior and then the repo-owned rollout
validator:

```bash
helm upgrade --install "$PSFN_HELM_RELEASE" deploy/helm/psfn \
  -n "$PSFN_NAMESPACE" -f "$PSFN_VALUES_FILE" --atomic --wait
scripts/ops/validate-kube-rollout.sh --local --namespace "$PSFN_NAMESPACE"
```

The operator smoke verifies the canonical TLS host, signed-out `/fleet` entry,
one OAuth login, the two principal-specific portal projections, one authorized
Garden route per principal, indistinguishable 404 responses for an unauthorized
and unknown companion, Companion UI login/device separation, self-memory JIT,
one exact non-subject break-glass confirmation, logout, and denial after session
or role revocation. Repeat the logout and portal smoke while one companion is
unavailable. Inspect only structured, content-free audit records; credentials,
memory bodies and provider tokens must not occur in logs, URLs, browser storage,
diagnostics, backups, or prompts.

Promotion to the next stage uses the same digest and values. A changed digest,
owner file, certificate identity, companion manifest, or authorization policy
starts certification again.

## Rollback

Rollback must preserve the sole-gateway edge. Before applying a historical Helm
revision, render it and reject it if it exposes Garden or Companion UI directly,
restores a host port, or lacks the unified gateway router. A safe rollback is:

```bash
helm rollback "$PSFN_HELM_RELEASE" "$PSFN_SAFE_REVISION" -n "$PSFN_NAMESPACE" \
  --cleanup-on-fail --wait
scripts/ops/validate-kube-rollout.sh --local --namespace "$PSFN_NAMESPACE"
```

If fleet auth must be disabled, render the current chart with the flag off and
confirm the feature-off topology before applying it. Feature-off Garden remains
internal/loopback and uses its existing legacy credential behavior; rollback
must never recreate a historical public privileged Garden edge.

Do not roll back or restore the trusted-host account or passkey authority floors
with `fleet_auth`. Do not promote restored account rows automatically. After a
restore, fresh OAuth remains denied until exact trusted-host account reapproval;
account reapproval never promotes a passkey. A missing or mismatched current
passkey floor requires a separate expected-provider, live-origin, UV WebAuthn
enrollment. Use the repo commands' built-in usage contracts:

```bash
npm run fleet-auth:account-reapproval -- --help
npm run fleet-auth:passkey-ceremony -- --help
npm run fleet-auth:provider-recovery -- --help
```

After rollback, repeat the sole-ingress inspection, canonical-origin smoke,
authorized and denied companion checks, logout, revocation, and restore-floor
checks before reopening access.
