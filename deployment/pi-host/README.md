# Pi host-side backup

Canonical copies of the host-level off-node backup units running on the
single-node k3s Pi deployment (bead psfn-framework-q9ra.6; originally gwq9). The live
files are `/usr/local/bin/psfn-backup.sh` plus the systemd units in
`/etc/systemd/system/` — deploy by copying and `systemctl daemon-reload`.
Treat this directory as the source of truth; edit here first, then ship.

Host-specific paths (NAS mount, backup root, PVC directories, source checkout)
live in `/etc/psfn-backup.env` on the node — deliberately not repo-tracked;
the script fails closed if the file or any required key is missing.

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
