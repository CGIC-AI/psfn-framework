# Private Live Operations Note Template

Copy this file to `working_docs/private-live-ops.md`. The populated note is
gitignored and must remain inside the deployment checkout; do not create a
second authoritative copy elsewhere.

Record only what the operator needs to recover or validate the deployment:

- SSH destination and Kubernetes namespace
- repository, runtime-data, database-data, and optional satellite paths
- backing device identity and expected `findmnt` source
- service registration locations and early-boot mount dependencies
- rollback artifact names and cleanup approval state
- reserved ports and health endpoints

Keep secrets in the repo-owned ignored environment/secret files documented by
the deployment, not in this note. Copy `scripts/ops/private-ops.env.example` to
`scripts/ops/private-ops.env` for the non-secret values consumed by ops scripts.
