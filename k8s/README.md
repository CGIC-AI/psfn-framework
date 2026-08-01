# Legacy Kustomize Manifests

The manifests under `k8s/` describe an older, unsupported deployment shape.
They colocate gateway and agent processes, expose retired admin-token surfaces,
and place mutable settings in environment-backed ConfigMaps. They do not
implement the current companion-cluster, split-root, owner-file, mTLS, or
Postgres tenancy contracts.

Do not use `kubectl apply -k k8s/...` for a new deployment or to repair the live
cluster. The supported Kubernetes deployment is the Helm chart at
[`deploy/helm/psfn`](../deploy/helm/psfn/README.md). Use:

- [`docs/setup.md`](../docs/setup.md) for first-time configuration;
- [`docs/operations.md`](../docs/operations.md) to discover live authority and
  operate the current k3s deployment; and
- [`docs/helm-upgrades.md`](../docs/helm-upgrades.md) for every Helm install or
  upgrade.

These files remain only as migration archaeology. Remove the directory once no
external deployment still depends on it; do not extend it with current runtime
features.
