// Embedding provider for the embedding repair CLIs (memory:repair:embeddings,
// migrate:embeddings). These run as one companion's own runtime role, and on a
// fleet follower that role can only read the model-usage ledger
// (psfn-framework-uhc6b).

import type { EmbeddingRuntimeProvider } from '../../faculties/memory/embedding.js';
import { isModelUsageLedgerAuthority } from '../../persistence/postgres/model-usage-store.js';
import type { ModelUsageRecorder } from '../../shared/telemetry/model-usage.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createProviderRuntimeServices } from '../../system/config/provider-runtime-factory.js';

/** A dry run never embeds, so it books nothing; a recorded event is a defect. */
const reportOnlyUsageRecorder: ModelUsageRecorder = {
  recordUsageEvent: async () => {
    throw new Error('An embedding repair dry run must not call the embedding provider');
  },
};

/**
 * `report` (a dry run) needs only the provider's kind and dimensions, so it
 * opens no ledger. `embed` books every call to the ledger and refuses before
 * any provider call when this role cannot write it.
 */
export function createMaintenanceEmbeddingProvider(
  config: SubstrateConfig,
  mode: 'report' | 'embed',
): EmbeddingRuntimeProvider {
  if (mode === 'report') {
    return createProviderRuntimeServices({ config, modelUsageRecorder: reportOnlyUsageRecorder })
      .embeddingProvider;
  }
  if (!isModelUsageLedgerAuthority(config)) {
    throw new Error(
      `Companion ${config.companionId ?? '<unknown>'} runs as a fleet follower role and cannot book `
      + 'embedding usage: followers only read the model-usage ledger. Dry runs work here; embedding '
      + 'a follower corpus is not supported yet (psfn-framework-uhc6b)',
    );
  }
  return createProviderRuntimeServices({ config }).embeddingProvider;
}
