import type { ShellExecSettings } from '../../../system/config/shell-exec-config.js';

/**
 * Gateway execution policy projected from settings.json. `allowedCwd` and
 * `repositoryMountSource` are internal runtime derivations and are never
 * operator-configurable: `allowedCwd` is the per-companion workspace bound and
 * `repositoryMountSource` is the deployment's repository checkout
 * (PSFN_REPOSITORY_DIR) used only when the operator-owned
 * `mountRepositoryReadOnly` setting is true.
 */
export type ShellExecPolicyConfig = Partial<ShellExecSettings> & {
  allowedCwd?: string[];
  repositoryMountSource?: string;
};
