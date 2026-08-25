// ── Install-mode metadata (psfn-framework-wckv.1.1) ──
// Per-mode default persistence roots and post-generation guidance. The roots
// are defaults only; the operator may override them at the prompt.

import type { InstallMode, PersistenceRootPlan } from './types.js';

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
    label: 'External orchestrator (owner-file generation only)',
    hint: 'Generates and validates owner files without writing host deployment configuration.',
    defaultRoots: {
      systemDataDir: './data/system-data',
      companionDataDir: './data/companion-data',
      shared: false,
    },
    capturesHostSecret: false,
  },
};

/** Post-generation guidance shown after a successful commit. */
export function modeGuidance(mode: InstallMode, provider: { apiKeyEnvName: string }): string[] {
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
        'External orchestrator next steps:',
        '  1. Owner files were generated and validated against the settings-contract',
        '     guard. Import them through your private deployment configuration.',
        `  2. Provide provider/runtime secrets through your orchestrator (key env: ${provider.apiKeyEnvName}).`,
        '     No host .env was written for this mode.',
        '  3. See docs/operations.md for the public runtime integration contract.',
      ];
    default:
      return [];
  }
}
