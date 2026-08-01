# Pi host-side backup

Repository-owned templates for an optional host-level, off-node backup lane on
a single-node k3s host. This lane supplements the runtime's encrypted backup
system; it is not Kubernetes runtime authority. The live application and owner
files remain the workloads and PVCs in namespace `psfn` as described in
[`docs/operations.md`](../../docs/operations.md#live-deployment-authority-read-this-first).

Install the script and systemd units through an operator-reviewed host
procedure, then run `systemctl daemon-reload`. Treat this directory as the
template source of truth and keep the installed copies synchronized with it.

Host-specific paths (NAS mount, backup root, PVC directories, source checkout)
belong in the operator-selected host env file — deliberately not repo-tracked.
The script's `PSFN_BACKUP_ENV_FILE` override selects that file; without the
override it uses `/etc/psfn-backup.env`. It fails closed if the file or a
required key is missing.

The script dumps the in-cluster Postgres (validated with `pg_restore --list`),
rsyncs the companion-data and system-data PVC trees, records helm values and
image/git provenance, then applies GFS retention: newest 4 six-hourlies,
newest-per-day for 7 days, newest-per-ISO-week for 4 weeks, newest-per-month
for 12 months (~27 generations ≈ 16GB at ~600MB/snapshot; 12-month
cogsec-event recovery depth). The newest backup is always kept — the prune
refuses to run if that invariant would not hold. `PSFN_PRUNE_DRY_RUN=1`
prints the keep/prune plan without creating or deleting anything.

PVC paths and the NFS target are node-specific and belong in the env file;
other deployments reuse the script with their own env (second-cluster off-node
backups: bead psfn-framework-80rx).
