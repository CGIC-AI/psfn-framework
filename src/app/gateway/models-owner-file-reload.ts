import { join } from 'node:path';
import type { GatewayIntakeScreeningRuntime } from '../../boundary/gateway/intake/fleet-screening.js';
import { OwnerFileReloadWatcher } from '../../operator/garden/services/owner-file-reload-watcher.js';
import { reloadOwnerModelsFromDisk } from '../../operator/garden/services/settings-service.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('GatewayModelsReload');

/**
 * Hot-reload models.json in the gateway process (beads psfn-framework-awhls,
 * psfn-framework-hye2n).
 *
 * The agent already reloads models.json on a direct disk edit; the gateway did
 * not, so it kept routing model calls against the boot-time registry and kept
 * the boot-time intake screener models until a restart. Garden saves and
 * direct edits both land on disk, so one mtime watcher covers both: it applies
 * the owner file to the gateway's live config (model routing reads the
 * registry from it per call) and then re-resolves the intake screeners. A
 * reload that fails to parse, or a screener selection that would not start,
 * throws inside the watcher, is logged, and leaves the running selection.
 */
export function startGatewayModelsOwnerFileReload(input: {
  config: SubstrateConfig;
  intakeScreening: Pick<GatewayIntakeScreeningRuntime, 'refreshScreenerModels'>;
}): OwnerFileReloadWatcher {
  const configStore = createOwnerFileConfigStore({
    dataDir: input.config.dataDir,
    seedDir: process.env.CONFIG_DIR,
    defaultContextWindow: input.config.defaultContextWindow,
  });
  const watcher = new OwnerFileReloadWatcher({
    files: [{
      ownerFile: 'models.json',
      path: join(input.config.dataDir, 'models.json'),
      reload: () => reloadGatewayModels({
        config: input.config,
        configStore,
        intakeScreening: input.intakeScreening,
      }),
    }],
  });
  watcher.start();
  return watcher;
}

export function reloadGatewayModels(input: {
  config: SubstrateConfig;
  configStore: Parameters<typeof reloadOwnerModelsFromDisk>[0]['configStore'];
  intakeScreening: Pick<GatewayIntakeScreeningRuntime, 'refreshScreenerModels'>;
}): void {
  const result = reloadOwnerModelsFromDisk({ config: input.config, configStore: input.configStore });
  if (!result.ok) {
    throw new Error(`models.json disk reload failed: ${result.message}`);
  }
  const screeners = input.intakeScreening.refreshScreenerModels();
  log.info('Gateway applied reloaded models.json', { screenerCompositionsSwitched: screeners.applied });
}
