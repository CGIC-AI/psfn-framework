import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/app/startup/index.ts',
    'gateway-main': 'src/app/gateway/main.ts',
    'agent-main': 'src/app/agent/main.ts',
    'operator-main': 'src/app/operator/main.ts',
    'cert-manager-main': 'src/app/cert-manager/main.ts',
    'migrate-scheduler-owner': 'src/app/maintenance/migrate-scheduler-owner.ts',
    'migrate-required-settings-blocks':
      'src/app/maintenance/migrate-required-settings-blocks.ts',
    'migrate-intake-policy-owner':
      'src/app/maintenance/migrate-intake-policy-owner.ts',
    'create-passkey-ceremony': 'src/app/maintenance/create-passkey-ceremony.ts',
    'create-account-reapproval-ceremony':
      'src/app/maintenance/create-account-reapproval-ceremony.ts',
    'create-provider-recovery': 'src/app/maintenance/create-provider-recovery.ts',
    'migrate-system-owner-fleet': 'src/app/maintenance/migrate-system-owner-fleet.ts',
    'system-owner-fleet-snapshot': 'src/app/maintenance/system-owner-fleet-snapshot.ts',
    'owner-upgrade-readiness-probe': 'src/app/maintenance/owner-upgrade-readiness-probe.ts',
    'session-integrity-repair': 'src/app/maintenance/session-integrity-repair.ts',
    'preflight-startup-owner-files': 'scripts/preflight-startup-owner-files.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
