# Purrsephone System Account Cutover

This host currently runs `purrsephone.service` as a per-user `vega` unit.

That is not a viable long-term deployment shape for a dedicated runtime account on this machine because:

- the live checkout sits under `/mnt/samesung`, which is `0700` and not traversable by other accounts
- the current Node toolchain lives under `/home/vega/.nvm`, and `/home/vega` is `0750`
- the live runtime still writes to the legacy shared `./data` root owned by `vega`

## Provisioner

Use [`scripts/system/install-purrsephone-service.sh`](/mnt/samesung/ai/psfn-live-ssm/scripts/system/install-purrsephone-service.sh) to create a service-owned deployment that no longer depends on `vega`'s home or checkout:

- creates or reuses a `purrsephone` system user/group
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
systemctl --user stop purrsephone.service
```

2. Run the provisioner as root from the source checkout you want to deploy:

```bash
sudo ./scripts/system/install-purrsephone-service.sh \
  --source-repo-root /path/to/checkout \
  --migrate-data
```

3. If you need a non-disruptive validation first, stage everything under a temp root:

```bash
./scripts/system/install-purrsephone-service.sh \
  --staging-root /tmp/purrsephone-stage
```

4. Confirm the rendered unit is valid and the bundled runtime is reachable:

```bash
systemd-analyze verify /etc/systemd/system/purrsephone.service
sudo -u purrsephone /var/lib/purrsephone/app/tools/node/bin/node /var/lib/purrsephone/app/node_modules/.bin/tsx --version
```

5. Enable the system service when the maintenance window is open:

```bash
sudo ./scripts/system/install-purrsephone-service.sh \
  --source-repo-root /path/to/checkout \
  --migrate-data \
  --enable
```

## Notes

- The service unit forces `PSFN_RUNTIME_LAYOUT_MODE=production` and `PSFN_RUNTIME_ROOT=/var/lib/purrsephone/runtime`.
- The launcher now detects repo-root `purrsephone/modules/repl-registry.json` and production workspace locations, so it no longer assumes a `./companion` layout.
- If you need to keep the runtime in `split` mode instead of `yolo`, pass `--mode split` to the provisioner.
