import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { MemoryRetrievalPolicy } from '../../system/config/memory-retrieval-policy.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { RetrievalAccessScope } from './types.js';
import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';
import type { MemoryDeletionPolicy } from '../../system/config/memory-deletion-policy.js';
import type { EpisodicTimelineStore } from './retrieval/episodic.js';
import type { MemorySessionQuarantineFilter } from './retrieval/session-quarantine.js';
import type { HybridEpisodeSearchPort } from './retrieval/episode-search.js';
import type {
  EpisodeDrilldownSessionReader,
  EpisodeDrilldownStore,
} from './retrieval/episode-drilldown.js';
import type { MemoryWriter } from './writer.js';
import { createSharedBackgroundProvider } from './retrieval/shared-background.js';
import {
  createMemoryTool,
  createScratchpadTool,
} from './tools.js';

export interface MemoryRuntimeTarget {
  registerTool: ToolRegistrar;
}

export function registerMemoryTools(
  target: MemoryRuntimeTarget,
  options: {
    writer: MemoryWriter;
    memoryStore: MemoryStorePort;
    memoryDeletionProposalStore: MemoryDeletionProposalStorePort;
    memoryDeletionApprovalPort: MemoryDeletionApprovalPort;
    memoryDeletionPolicy: MemoryDeletionPolicy | (() => MemoryDeletionPolicy | undefined);
    episodicStore?: (EpisodicTimelineStore & EpisodeDrilldownStore) | null;
    episodeSearch?: HybridEpisodeSearchPort | null;
    sessionReader?: EpisodeDrilldownSessionReader | null;
    sessionQuarantineFilter?: MemorySessionQuarantineFilter | null;
    episodicAccessScope?: RetrievalAccessScope | (() => RetrievalAccessScope | undefined);
    contactStore?: ContactStorePort | null;
    /**
     * Live retrieval policy authority (zet.2) so the `action=timeline` tool
     * path applies operator-set timeline knobs. A resolver is preferred so
     * late-bound runtime config edits are honored per call.
     */
    memoryRetrievalPolicy?: MemoryRetrievalPolicy | (() => MemoryRetrievalPolicy | undefined);
  },
): void {
  const sharedBackgroundProvider = options.contactStore
    ? createSharedBackgroundProvider({
      memoryStore: options.memoryStore,
      contactStore: options.contactStore,
    })
    : null;
  target.registerTool(createMemoryTool(options.writer, options.memoryStore, {
    episodicStore: options.episodicStore ?? null,
    episodeSearch: options.episodeSearch ?? null,
    sessionReader: options.sessionReader ?? null,
    sessionQuarantineFilter: options.sessionQuarantineFilter ?? null,
    ...(options.episodicAccessScope !== undefined
      ? { episodicAccessScope: options.episodicAccessScope }
      : {}),
    sharedBackgroundProvider,
    ...(options.memoryRetrievalPolicy !== undefined
      ? { memoryRetrievalPolicy: options.memoryRetrievalPolicy }
      : {}),
    memoryDeletionProposalStore: options.memoryDeletionProposalStore,
    memoryDeletionApprovalPort: options.memoryDeletionApprovalPort,
    memoryDeletionPolicy: options.memoryDeletionPolicy,
  }), 'core');
  target.registerTool(createScratchpadTool(options.memoryStore), 'core');
}
