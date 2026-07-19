import type { CapabilityToken } from '../../../src/system/capabilities/tokens.js';

export interface CapabilityMatrixProbe {
  token: CapabilityToken;
  tokens: readonly CapabilityToken[];
  executionId: string;
  toolName: string;
  args: Readonly<Record<string, unknown>>;
  safety: string;
}

export const CAPABILITY_MATRIX_PROBES: readonly CapabilityMatrixProbe[];
