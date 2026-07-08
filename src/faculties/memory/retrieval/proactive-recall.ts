import type { TrustLevel } from '../../../system/trust/types.js';
import type { ChannelMeta } from '../../../system/trust/policy.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import { resolveBroadcastVisibilityScope } from '../../../system/trust/broadcast-safety.js';
import { cloneMemory } from '../../../core/turns/snapshot.js';
import type { TurnMemorySnapshot } from '../../../core/turns/snapshot.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import {
  computeProactiveRecallWeight,
  selectWeightedMemory,
} from './proactive.js';
import {
  evaluateRetrievalAccessDecision,
  type RetrievalRoomVisibilityContext,
} from './access.js';
import { renderProactiveRecall } from './formatting.js';
import {
  filterQuarantinedMemories,
  type MemorySessionQuarantineFilter,
} from './session-quarantine.js';
import { collectProactiveRecallCandidates } from './social-context.js';

export async function retrieveProactiveRecall(input: {
  memoryStore: MemoryStorePort;
  sessionQuarantineFilter: MemorySessionQuarantineFilter | null;
  proactiveRecallProbability: number;
  proactiveRecallMinTurnsBetween: number;
  proactiveTurnCounter: number;
  lastProactiveRecallTurn: number;
  setProactiveTurnCounter(value: number): void;
  setLastProactiveRecallTurn(value: number): void;
  resolveRoomVisibilityContext(
    channelId: string,
    channelMeta: ChannelMeta | undefined,
    canonicalContactId: string | undefined,
  ): Promise<RetrievalRoomVisibilityContext>;
  createAccessUpdateError(memoryId: string, trustLevel: TrustLevel, cause: unknown): Error;
  logIntegrityFailure(error: Error, cause: unknown): void;
  channelId: string;
  trustLevel?: TrustLevel;
  channelMeta?: ChannelMeta;
  canonicalContactId?: string;
  turnSnapshot?: TurnMemorySnapshot;
}): Promise<string> {
  if (input.proactiveRecallProbability <= 0) return '';

  const currentTurn = input.proactiveTurnCounter + 1;
  input.setProactiveTurnCounter(currentTurn);
  if (currentTurn - input.lastProactiveRecallTurn <= input.proactiveRecallMinTurnsBetween) {
    return '';
  }

  if (Math.random() > input.proactiveRecallProbability) {
    return '';
  }

  const effectiveTrust = input.trustLevel ?? 'regular';
  const channelDisclosure = classifyChannelDisclosure(input.channelId, input.channelMeta);
  const { channelPrivacy, broadcast } = channelDisclosure;
  const visibilityScope = resolveBroadcastVisibilityScope(input.channelId, input.channelMeta) ?? 'non_broadcast';
  const operatorApproval = visibilityScope === 'approved_private_context';
  const roomVisibility = await input.resolveRoomVisibilityContext(
    input.channelId,
    input.channelMeta,
    input.canonicalContactId,
  );
  const candidates = filterQuarantinedMemories(
    input.sessionQuarantineFilter,
    input.turnSnapshot?.proactiveCandidates.map(cloneMemory)
    ?? await collectProactiveRecallCandidates(input.memoryStore, input.channelId, input.canonicalContactId),
  ).memories;
  if (candidates.length === 0) return '';

  const weighted = candidates
    .filter((memory) => evaluateRetrievalAccessDecision(memory, {
      trustLevel: effectiveTrust,
      channelPrivacy,
      broadcast,
      channelMeta: input.channelMeta,
      canonicalContactId: input.canonicalContactId,
      operatorApproval,
      roomVisibility,
    }).allowed)
    .map(memory => ({
      memory,
      weight: computeProactiveRecallWeight(memory),
    }))
    .filter(item => item.weight > 0)
    .sort((left, right) => right.weight - left.weight);

  if (weighted.length === 0) return '';

  const selected = selectWeightedMemory(weighted);
  if (!selected) return '';

  input.setLastProactiveRecallTurn(currentTurn);
  try {
    await input.memoryStore.updateMemory(selected.id, {
      lastAccessed: Date.now(),
      accessCount: selected.accessCount + 1,
    });
  } catch (error) {
    const wrapped = input.createAccessUpdateError(selected.id, effectiveTrust, error);
    input.logIntegrityFailure(wrapped, error);
    throw wrapped;
  }

  return renderProactiveRecall(selected);
}
