// ── Shared-world wiki projection context for maintenance CLIs (s10f9) ──
//
// The vinz.4 (places→wiki publish) and vinz.27 (bulk import) CLIs run
// host-side with dotenv + loadConfig, so they construct the configured
// embedding provider directly — the same provider composition builds for the
// runtime (`createEmbeddingProviderFromConfig`), just not proxied through the
// gateway. The projection runner then decides: multi-companion + missing
// Postgres/embedder fails closed BEFORE any filesystem write; flag-off it
// degrades to an honest `skipped` report.

import { createEmbeddingProviderFromConfig } from '../../faculties/memory/embedding.js';
import type { SharedWikiProjectionContext } from '../../faculties/wiki/shared-pgvector-projection.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const log = createComponentLogger('SharedWikiProjectionCli');

export function resolveSharedWikiProjectionContext(
  config: SubstrateConfig,
): SharedWikiProjectionContext {
  const multiCompanion = config.multiCompanion === true;
  const databaseUrl = config.postgresDatabaseUrl?.trim() || undefined;
  if (!databaseUrl) {
    // The runner's decision fails closed under multi-companion and reports an
    // honest skip flag-off; no embedder is needed when nothing can project.
    return { multiCompanion };
  }
  try {
    return {
      databaseUrl,
      embedding: createEmbeddingProviderFromConfig(config, process.env),
      multiCompanion,
    };
  } catch (error) {
    // Leave `embedding` unset: the runner fails closed under multi-companion
    // and reports `skipped: embedding_unavailable` flag-off — never silent.
    log.warn('Embedding provider unavailable for shared wiki projection', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { databaseUrl, multiCompanion };
  }
}
