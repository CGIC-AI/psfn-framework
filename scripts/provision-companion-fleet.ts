import { resolveConfiguredCompanionFleet } from './companion-fleet-runtime.js';
import { provisionFleetWorkspaces } from '../src/persistence/workspaces/provisioning.js';
import { migrateLegacyWorkspaceForFleet } from '../src/persistence/workspaces/legacy-workspace-migration.js';

function main(): void {
  const fleet = resolveConfiguredCompanionFleet(process.env);
  if (!fleet) return;
  migrateLegacyWorkspaceForFleet({
    fleet,
    legacyWorkspacePath: process.env.WORKSPACE_PATH,
    env: process.env,
  });
  provisionFleetWorkspaces(fleet);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[provision-companion-fleet] ${message}\n`);
  process.exit(1);
}
