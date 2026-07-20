import type { ShellExecSettings } from '../../../system/config/shell-exec-config.js';

/**
 * Gateway execution policy projected from settings.json. `allowedCwd` is an
 * internal per-companion derivation and is never operator-configurable.
 */
export type ShellExecPolicyConfig = Partial<ShellExecSettings> & {
  allowedCwd?: string[];
};
