import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/app/startup/index.ts',
    'gateway-main': 'src/app/gateway/main.ts',
    'agent-main': 'src/app/agent/main.ts',
    'operator-main': 'src/app/operator/main.ts',
    'cert-manager-main': 'src/app/cert-manager/main.ts',
    'migrate-scheduler-owner': 'src/app/maintenance/migrate-scheduler-owner.ts',
    'migrate-system-owner-fleet': 'src/app/maintenance/migrate-system-owner-fleet.ts',
    'system-owner-fleet-snapshot': 'src/app/maintenance/system-owner-fleet-snapshot.ts',
    'owner-upgrade-readiness-probe': 'src/app/maintenance/owner-upgrade-readiness-probe.ts',
    'preflight-startup-owner-files': 'scripts/preflight-startup-owner-files.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
