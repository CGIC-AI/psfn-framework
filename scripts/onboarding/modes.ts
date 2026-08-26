// ── Install-mode metadata (psfn-framework-wckv.1.1) ──
// Per-mode default persistence roots and post-generation guidance. The roots
// are defaults only; the operator may override them at the prompt.

import type { InstallMode, KubernetesTargetPlan, PersistenceRootPlan } from './types.js';

export interface InstallModeInfo {
  mode: InstallMode;
  label: string;
  hint: string;
  /** Default two-root layout for the mode. */
  defaultRoots: PersistenceRootPlan;
  /** Whether the flow captures the provider key into a host .env. */
  capturesHostSecret: boolean;
}

export const INSTALL_MODES: Record<InstallMode, InstallModeInfo> = {
  compose: {
    mode: 'compose',
    label: 'Docker Compose (persistent supported install)',
    hint: 'Runs Postgres, gateway, agent, and Garden with persistent data and safe lifecycle commands.',
    defaultRoots: {
      systemDataDir: './data/system-data',
      companionDataDir: './data/companion-data',
      shared: false,
    },
    capturesHostSecret: true,
  },
  local: {
    mode: 'local',
    label: 'Repository-native (supervised persistent install)',
    hint: 'Runs the full split runtime from this checkout against your PostgreSQL server.',
    defaultRoots: {
      systemDataDir: './data/system-data',
      companionDataDir: './data/companion-data',
      shared: false,
    },
    capturesHostSecret: true,
  },
  kubernetes: {
    mode: 'kubernetes',
    label: 'Kubernetes / Helm (persistent supported install)',
    hint: 'Runs Postgres, gateway, agent, and Garden with retained PVCs and safe lifecycle commands.',
    defaultRoots: {
      systemDataDir: './data/system-data',
      companionDataDir: './data/companion-data',
      shared: false,
    },
    capturesHostSecret: false,
  },
};

/** Post-generation guidance shown after a successful commit. */
export function modeGuidance(
  mode: InstallMode,
  provider: { apiKeyEnvName: string },
  kubernetesTarget?: KubernetesTargetPlan,
): string[] {
  switch (mode) {
    case 'compose':
      return [
        'Docker Compose next steps:',
        `  1. Your provider key was written to .env as ${provider.apiKeyEnvName}.`,
        '  2. Start the persistent split stack:',
        '',
        '       npm run compose:up',
        '',
        '  3. Open the Garden login page shown by compose:up, then use the ADMIN_TOKEN',
        '     stored in .env. Check the complete runtime at any time with:',
        '',
        '       npm run compose:doctor',
        '',
        '  Updates rebuild the image while retaining owner files, workspace, memories,',
        '  and Postgres data. npm run compose:down also preserves all data.',
      ];
    case 'local':
      return [
        'Repository-native next steps:',
        `  1. Your provider key was written to .env as ${provider.apiKeyEnvName}.`,
        '  2. Start the complete supervised runtime:',
        '',
        '       npm run local:up',
        '',
        '  The command provisions isolated PostgreSQL roles, starts gateway, agent, and',
        '  Garden, then validates health and login. Use local:status, local:doctor,',
        '  local:verify, local:update, local:restart, local:logs, and local:down for operation.',
      ];
    case 'kubernetes':
      return [
        'Kubernetes / Helm next steps:',
        `  1. Export ${provider.apiKeyEnvName} in the shell that runs the Helm lifecycle.`,
        '     No provider key was written to the host .env.',
        `  2. The ${kubernetesTarget?.kind === 'local-k3d' ? 'local k3d' : 'existing-context'} target wiring was written to .env.`,
        '  3. Start the complete persistent release; local k3d is created automatically:',
        '',
        '       npm run helm:up',
        '',
        '  Garden is published natively for new local k3d installs. Use helm:status,',
        '  helm:doctor, helm:verify, helm:update, helm:restart, helm:logs, helm:connect,',
        '  helm:token, and helm:down for operation.',
      ];
    default:
      return [];
  }
}
