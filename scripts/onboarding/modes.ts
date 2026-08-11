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
    label: 'Docker Compose (guided, ends at the smoke lane)',
    hint: 'Most guidance. Boots the split runtime via docker/docker-compose.smoke.yml.',
    defaultRoots: {
      systemDataDir: './data/system-data',
      companionDataDir: './data/companion-data',
      shared: false,
    },
    capturesHostSecret: true,
  },
  local: {
    mode: 'local',
    label: 'Local development (explicit component entrypoints)',
    hint: 'Generates separate system and companion roots for host-side development.',
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
        '  2. Bring up the split stack and drive one chat turn:',
        '',
        '       npm run smoke:docker',
        '',
        '     Exit 0 = a full provider-backed turn; exit 2 = the stack is healthy but',
        '     the provider egress was not reached (e.g. an unset/incorrect key).',
        '',
        '  Note: the compose smoke stack seeds owner files INSIDE its containers from',
        '  the image\'s baked config/*.seed.json and reads OPENROUTER_API_KEY from your',
        '  .env. The owner files generated here on the host capture your chosen',
        '  provider/model for local dev or a custom (non-smoke) compose run.',
      ];
    case 'local':
      return [
        'Local dev next steps:',
        `  1. Your provider key was written to .env as ${provider.apiKeyEnvName}.`,
        '  2. Start the gateway, agent, and operator in separate terminals:',
        '',
        '       npm run gateway',
        '       npm run agent',
        '       npm run operator',
        '',
        '  Owner files were written under separate ./data roots.',
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
