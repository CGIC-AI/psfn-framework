import type { ChannelDisclosureContext } from '../../../system/trust/policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { MemoryScopeQuery } from '../types.js';
import {
  cloneEpisodicRetrievalChain,
  retrieveEpisodicChains,
  type EpisodicRetrievalChain,
  type EpisodicRetrievalStore,
} from './episodic.js';
import {
  filterQuarantinedEpisodicChains,
  type MemorySessionQuarantineFilter,
} from './session-quarantine.js';

export async function resolveEpisodicChains(input: {
  episodicStore: EpisodicRetrievalStore | null;
  sessionQuarantineFilter: MemorySessionQuarantineFilter | null;
  request: {
    contextText: string;
    channelId: string;
    trustLevel: TrustLevel;
    channelDisclosure: ChannelDisclosureContext;
    canonicalContactId?: string;
    scopeQuery?: MemoryScopeQuery;
  };
  wrapError(error: unknown): Error;
}): Promise<EpisodicRetrievalChain[]> {
  if (!input.episodicStore) {
    return [];
  }

  try {
    return filterQuarantinedEpisodicChains(
      input.sessionQuarantineFilter,
      (await retrieveEpisodicChains(input.episodicStore, input.request))
        .map(cloneEpisodicRetrievalChain),
    );
  } catch (error) {
    throw input.wrapError(error);
  }
}
