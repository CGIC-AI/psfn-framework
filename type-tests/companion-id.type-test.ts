import {
  createCompanionId,
  createShardCompanionId,
  type CompanionId,
  type ShardCompanionId,
} from '../src/shared/routing/companion-id.js';
import { createGatewayRoutingEnvelope } from '../src/shared/routing/envelope.js';

declare function requiresCompanionId(value: CompanionId): void;
declare function requiresShardCompanionId(value: ShardCompanionId): void;

const companionId = createCompanionId('companion-alpha');
const shardCompanionId = createShardCompanionId('companion-alpha::shard-42');

requiresCompanionId(companionId);
requiresShardCompanionId(shardCompanionId);
createGatewayRoutingEnvelope({ companionId });

// @ts-expect-error Raw strings must cross the validating constructor first.
requiresCompanionId('companion-alpha');
// @ts-expect-error Shard identities are not core companion identities.
requiresCompanionId(shardCompanionId);
// @ts-expect-error Core identities are not shard identities.
requiresShardCompanionId(companionId);
// @ts-expect-error Routing envelopes reject unvalidated raw string identities.
createGatewayRoutingEnvelope({ companionId: 'companion-alpha' });
