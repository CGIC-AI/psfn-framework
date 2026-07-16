import type { ResolvedCompanionFleetEntry } from '../../system/config/companions-config.js';
import {
  loadChargePolicyConfig,
  type ChargePolicyConfig,
} from '../../system/config/charge-policy-config.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { IcpConversationChargePolicyResolver } from '../../primitives/llm/icp-conversation-cost-breaker.js';

export type FleetChargePolicyOwner = Pick<
  ResolvedCompanionFleetEntry,
  'companionId' | 'companionDataDir'
>;

/** Load and bind every fleet charge owner to its canonical companion identity. */
export function createGatewayFleetChargePolicyResolver(input: {
  companions: readonly FleetChargePolicyOwner[];
  seedDir?: string;
}): IcpConversationChargePolicyResolver {
  const chargePolicyByCompanionId = new Map<string, ChargePolicyConfig>();
  for (const companion of input.companions) {
    if (chargePolicyByCompanionId.has(companion.companionId)) {
      throw new Error(`Fleet charge policy owner is duplicated for ${companion.companionId}`);
    }
    chargePolicyByCompanionId.set(
      companion.companionId,
      loadChargePolicyConfig(
        companion.companionDataDir,
        input.seedDir ? { seedDir: input.seedDir } : {},
      ),
    );
  }

  return (rawCompanionId: string) => {
    const companionId = createCompanionId(rawCompanionId, 'fleet charge policy companionId');
    const policy = chargePolicyByCompanionId.get(companionId);
    if (!policy) {
      throw new Error('Fleet charge policy requires a known multi-companion sender');
    }
    return policy;
  };
}
