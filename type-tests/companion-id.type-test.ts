import {
  createCompanionId,
  createShardCompanionId,
  type CompanionId,
  type OptionalCompanionRoutingBinding,
  type ShardCompanionId,
} from '../src/shared/routing/companion-id.js';
import { createGatewayRoutingEnvelope } from '../src/shared/routing/envelope.js';
import type { RequestAgentVoiceStreamOptions } from '../src/boundary/gateway/voice-stream-request.js';
import { applyWyomingRoutingPolicy } from '../src/boundary/gateway/wyoming-routing.js';

declare function requiresCompanionId(value: CompanionId): void;
declare function requiresShardCompanionId(value: ShardCompanionId): void;
declare function requiresBoundCompanionId(
  value: NonNullable<OptionalCompanionRoutingBinding['companionId']>,
): void;
declare function requiresVoiceCompanionId(value: RequestAgentVoiceStreamOptions['companionId']): void;
declare function requiresWyomingCompanionId(
  value: Parameters<typeof applyWyomingRoutingPolicy>[3],
): void;

const companionId = createCompanionId('companion-alpha');
const shardCompanionId = createShardCompanionId('companion-alpha::shard-42');

requiresCompanionId(companionId);
requiresShardCompanionId(shardCompanionId);
createGatewayRoutingEnvelope({ companionId });
requiresBoundCompanionId(companionId);
requiresVoiceCompanionId(companionId);
requiresWyomingCompanionId(companionId);

// @ts-expect-error Raw strings must cross the validating constructor first.
requiresCompanionId('companion-alpha');
// @ts-expect-error Shard identities are not core companion identities.
requiresCompanionId(shardCompanionId);
// @ts-expect-error Core identities are not shard identities.
requiresShardCompanionId(companionId);
// @ts-expect-error Routing envelopes reject unvalidated raw string identities.
createGatewayRoutingEnvelope({ companionId: 'companion-alpha' });
// @ts-expect-error Gateway client/server bindings require a validated identity.
requiresBoundCompanionId('companion-alpha');
// @ts-expect-error Reverse voice propagation requires a validated routing identity.
requiresVoiceCompanionId('companion-alpha');
// @ts-expect-error Wyoming propagation requires a validated routing identity.
requiresWyomingCompanionId('companion-alpha');
