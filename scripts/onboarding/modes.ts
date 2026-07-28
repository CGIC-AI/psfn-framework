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
    label: 'Local dev (split gateway + agent via npm run dev)',
    hint: 'Runs the split runtime on the host from a shared ./data root.',
    defaultRoots: {
      systemDataDir: './data',
      companionDataDir: './data',
      shared: true,
    },
    capturesHostSecret: true,
  },
  kubernetes: {
    mode: 'kubernetes',
    label: 'Kubernetes (validation + Helm pointers, for experienced operators)',
    hint: 'Generates and validates owner files; secrets go in cluster Secrets, not a host .env.',
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
        '  2. Start the split gateway + agent runtime:',
        '',
        '       npm run dev',
        '',
        '  Owner files were written under ./data (shared system/companion root).',
      ];
    case 'kubernetes':
      return [
        'Kubernetes next steps (experienced operators):',
        '  1. Owner files were generated and validated against the settings-contract',
        '     guard. Load them onto the system-data PVC per the Helm chart.',
        `  2. Provide provider/runtime secrets as cluster Secrets (key env: ${provider.apiKeyEnvName}).`,
        '     No host .env was written for this mode.',
        '  3. See deploy/helm/psfn and docs/operations.md ("Live deployment authority")',
        '     for the reference deployment shape and rollout/validation gates.',
      ];
    default:
      return [];
  }
}
