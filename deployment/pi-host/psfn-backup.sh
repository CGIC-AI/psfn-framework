#!/bin/bash
# PSFN live-cluster backup to NAS (kube era; replaces the pre-cutover script
# that kept dumping the FROZEN host Postgres — bead psfn-framework-gwq9).
# 6-hourly: in-cluster pg_dump + companion-data/system-data PVC trees + helm
# values to NFS. Fail closed on missing mount; never write to local disk.
#
# Host-specific paths live in /etc/psfn-backup.env (NOT repo-tracked; contains
# private mount paths). Required keys: NAS_MOUNT, BAK_ROOT, COMPANION_PVC,
# SYSTEM_PVC. Optional: PSFN_SOURCE_DIR (git provenance), NS (default psfn).
#
# Retention (bead psfn-framework-q9ra.6, operator-approved 2026-07-16):
# GFS generational roll — newest 4 six-hourlies, newest-per-day for 7 days,
# newest-per-ISO-week for 4 weeks, newest-per-month for 12 months (~27 dirs,
# ~16GB at ~600MB/snapshot; 12-month cogsec-event recovery depth).
# Hard invariant: the newest backup is ALWAYS kept. Dry-run the prune with
# PSFN_PRUNE_DRY_RUN=1 (skips backup creation, prints the prune plan only).
set -euo pipefail

# Override only for retention dry-run testing against scratch fixtures; the
# systemd unit always uses the default root-owned path.
ENV_FILE=${PSFN_BACKUP_ENV_FILE:-/etc/psfn-backup.env}
[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE; refusing to guess backup paths" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
for var in NAS_MOUNT BAK_ROOT COMPANION_PVC SYSTEM_PVC; do
  [ -n "${!var:-}" ] || { echo "$ENV_FILE missing required key: $var" >&2; exit 1; }
done
NS=${NS:-psfn}
KUBECTL="k3s kubectl -n $NS"

KEEP_ROTATING=4
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=12
DRY_RUN=${PSFN_PRUNE_DRY_RUN:-0}

mountpoint -q "$NAS_MOUNT" || { echo "NAS not mounted; refusing to back up to local disk" >&2; exit 1; }
[ -d "$COMPANION_PVC" ] || { echo "companion-data PVC path missing: $COMPANION_PVC" >&2; exit 1; }
[ -d "$SYSTEM_PVC" ] || { echo "system-data PVC path missing: $SYSTEM_PVC" >&2; exit 1; }

if [ "$DRY_RUN" != "1" ]; then
  TS=$(date +%Y%m%dT%H%M%S)
  DEST="$BAK_ROOT/auto-kube-$TS"
  mkdir -p "$DEST"
  chmod 700 "$DEST"

  # 1. Live in-cluster Postgres: dump inside the pod, copy out via tar (binary-safe).
  $KUBECTL exec psfn-postgres-0 -- sh -c 'pg_dump -U psfn -Fc psfn > /tmp/psfn-live.dump'
  $KUBECTL exec psfn-postgres-0 -- tar -cf - -C /tmp psfn-live.dump > "$DEST/postgres-live.tar"
  tar -xf "$DEST/postgres-live.tar" -C "$DEST" --no-same-owner && mv "$DEST/psfn-live.dump" "$DEST/postgres-psfn-live.dump" && rm "$DEST/postgres-live.tar"
  $KUBECTL exec psfn-postgres-0 -- rm -f /tmp/psfn-live.dump
  # Sanity: a valid custom-format dump must list contents.
  $KUBECTL exec psfn-postgres-0 -- true  # keep kubectl failures loud before the check
  pg_restore --list "$DEST/postgres-psfn-live.dump" >/dev/null 2>&1 \
    || { echo "pg_restore --list failed on fresh dump; backup is not valid" >&2; exit 1; }

  # 2. Companion + system state (JSONL stores, owner files, sessions, vault).
  rsync -rlt --exclude tmp "$COMPANION_PVC/" "$DEST/companion-data/"
  rsync -rlt "$SYSTEM_PVC/" "$DEST/system-data/"

  # 3. Deploy provenance + live values (contains secrets — keep tight perms).
  KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm get values psfn -n "$NS" -o yaml > "$DEST/helm-values.yaml" 2>/dev/null || true
  chmod 600 "$DEST/helm-values.yaml" 2>/dev/null || true
  $KUBECTL get deploy -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[*].image}{"\n"}{end}' > "$DEST/deployed-images.txt"
  if [ -n "${PSFN_SOURCE_DIR:-}" ]; then
    git -C "$PSFN_SOURCE_DIR" rev-parse HEAD > "$DEST/git-rev.txt" 2>/dev/null || echo unknown > "$DEST/git-rev.txt"
  else
    echo unknown > "$DEST/git-rev.txt"
  fi
fi

# 4. GFS retention. Newest-first walk; first-seen per day/week/month IS the
# newest of that bucket. Every deletion candidate must match the strict name
# pattern and parse as a timestamp; anything else is left alone.
mapfile -t ALL < <(
  for d in "$BAK_ROOT"/auto-kube-* "$BAK_ROOT"/auto-2*; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [[ "$name" =~ ^auto(-kube)?-[0-9]{8}T[0-9]{6}$ ]] || continue
    stamp=${name#auto-kube-}; stamp=${stamp#auto-}
    echo "$stamp $name"
  done | LC_ALL=C sort -r | awk '{print $2}'
)

if [ "${#ALL[@]}" -eq 0 ]; then
  echo "retention: no parseable backup dirs found; nothing to prune"
else
  # Additive tiers, matching src/persistence/backups/retention.ts: higher tiers
  # (monthly > weekly > daily) claim shared snapshots first, and a dir already
  # protected by a higher tier is skipped WITHOUT consuming the lower tier's
  # slot. Rotating runs last and protects the N most-recent dirs not already
  # protected, so promotions extend total coverage instead of overlapping it.
  declare -A KEEP SEEN_DAY SEEN_WEEK SEEN_MONTH
  rot=0 day=0 week=0 month=0
  for name in "${ALL[@]}"; do
    stamp=${name#auto-kube-}; stamp=${stamp#auto-}
    ymd=${stamp:0:8}
    ym=${stamp:0:6}
    wk=$(date -d "${stamp:0:8}" +%G-%V 2>/dev/null) || continue
    if [ -z "${SEEN_MONTH[$ym]:-}" ]; then
      SEEN_MONTH[$ym]=1
      if [ "$month" -lt "$KEEP_MONTHLY" ] && [ -z "${KEEP[$name]:-}" ]; then KEEP[$name]="monthly"; month=$((month+1)); fi
    fi
    if [ -z "${SEEN_WEEK[$wk]:-}" ]; then
      SEEN_WEEK[$wk]=1
      if [ "$week" -lt "$KEEP_WEEKLY" ] && [ -z "${KEEP[$name]:-}" ]; then KEEP[$name]="weekly"; week=$((week+1)); fi
    fi
    if [ -z "${SEEN_DAY[$ymd]:-}" ]; then
      SEEN_DAY[$ymd]=1
      if [ "$day" -lt "$KEEP_DAILY" ] && [ -z "${KEEP[$name]:-}" ]; then KEEP[$name]="daily"; day=$((day+1)); fi
    fi
  done
  for name in "${ALL[@]}"; do
    [ "$rot" -ge "$KEEP_ROTATING" ] && break
    if [ -z "${KEEP[$name]:-}" ]; then KEEP[$name]="rotating"; rot=$((rot+1)); fi
  done

  # Hard invariants: keep set non-empty and the newest dir is in it.
  newest="${ALL[0]}"
  if [ "${#KEEP[@]}" -eq 0 ] || [ -z "${KEEP[$newest]:-}" ]; then
    echo "retention INVARIANT VIOLATION: newest backup '$newest' not protected; refusing to prune" >&2
    exit 1
  fi

  for name in "${ALL[@]}"; do
    dir="$BAK_ROOT/$name"
    if [ -n "${KEEP[$name]:-}" ]; then
      [ "$DRY_RUN" = "1" ] && echo "KEEP  $name (${KEEP[$name]})"
      continue
    fi
    if [ "$DRY_RUN" = "1" ]; then
      echo "PRUNE $name ($(du -sh "$dir" 2>/dev/null | cut -f1))"
      continue
    fi
    # Guarded delete: mount + strict-name checks already passed; delete the
    # tree contents then the dir itself. No recursive-force on a glob, ever.
    mountpoint -q "$NAS_MOUNT" || { echo "NAS unmounted mid-prune; aborting" >&2; exit 1; }
    find "$dir" -mindepth 1 -delete
    rmdir "$dir"
    echo "retention: pruned $name"
  done
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "dry-run complete: no backup created, nothing deleted"
else
  echo "backup complete: $DEST"
fi
