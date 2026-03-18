# PSFN System Account Cutover

This host currently runs `psfn.service` as a per-user `operator` unit.

That is not a viable long-term deployment shape for a dedicated runtime account on this machine because:

- the live checkout sits under `/mnt/samesung`, which is `0700` and not traversable by other accounts
- the current Node toolchain lives under `/home/operator/.nvm`, and `/home/operator` is `0750`
- the live runtime still writes to the legacy shared `./data` root owned by `operator`

## Provisioner

Use [`scripts/system/install-psfn-service.sh`](/workspace/psfn-live-ssm/scripts/system/install-psfn-service.sh) to create a service-owned deployment that no longer depends on `operator`'s home or checkout:

- creates or reuses a `psfn` system user/group
- clones the source repo into a service-owned app root
- overlays the working tree so untracked runtime prerequisites like `node_modules/` come along
- bundles the chosen `node` binary into `app/tools/node/bin/node`
- filters `.env` into a systemd env file without legacy path overrides
- prepares a production runtime root
- renders and validates a systemd unit
- optionally applies the persistence split-root cutover

## Safe Cutover Sequence

1. Stop the old user service:

```bash
systemctl --user stop psfn.service
```

2. Run the provisioner as root from the source checkout you want to deploy:

```bash
sudo ./scripts/system/install-psfn-service.sh \
  --source-repo-root /path/to/checkout \
  --migrate-data
```

3. If you need a non-disruptive validation first, stage everything under a temp root:

```bash
./scripts/system/install-psfn-service.sh \
  --staging-root /tmp/psfn-stage
```

4. Confirm the rendered unit is valid and the bundled runtime is reachable:

```bash
systemd-analyze verify /etc/systemd/system/psfn.service
sudo -u psfn /var/lib/psfn/app/tools/node/bin/node /var/lib/psfn/app/node_modules/.bin/tsx --version
```

5. Enable the system service when the maintenance window is open:

```bash
sudo ./scripts/system/install-psfn-service.sh \
  --source-repo-root /path/to/checkout \
  --migrate-data \
  --enable
```

## Notes

- The service unit forces `PSFN_RUNTIME_LAYOUT_MODE=production` and `PSFN_RUNTIME_ROOT=/var/lib/psfn/runtime`.
- The launcher now detects repo-root `psfn/modules/repl-registry.json` and production workspace locations, so it no longer assumes a `./companion` layout.
- If you need to keep the runtime in `split` mode instead of `yolo`, pass `--mode split` to the provisioner.
