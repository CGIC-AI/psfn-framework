import {
  createSocialImpulseOutreachRuntime,
  type SocialImpulseDesireTarget,
  type SocialImpulseOutreachMode,
  type SocialImpulseOutreachRuntime,
  type SocialImpulseOutreachStorePort,
} from '../../core/emotion/social-impulse-outreach.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('SocialImpulseOutreach');

export interface ProductionSocialImpulseOutreachOptions {
  companionId: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
  getDesireTarget(): SocialImpulseDesireTarget | null;
  now?: () => number;
}

/**
 * Production binding of a qualified EmoSim impulse to per-contact social
 * pressure (psfn-framework-vcq8v.4). The impulse never chooses a destination:
 * it raises live per-contact desire and requests an immediate per-contact
 * evaluation, whose outreach turns run in each contact's own channel.
 */
export function createProductionSocialImpulseOutreachRuntime(
  options: ProductionSocialImpulseOutreachOptions,
): SocialImpulseOutreachRuntime {
  const runtime = createSocialImpulseOutreachRuntime({
    companionId: options.companionId,
    store: options.store,
    getMode: options.getMode,
    getDesireTarget: options.getDesireTarget,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    async onImpulse(impulse) {
      const result = await runtime.onImpulse(impulse);
      log.info('EmoSim impulse settled against per-contact social pressure', {
        impulseId: result.record.impulseId,
        outcome: result.outcome,
        replayed: result.replayed,
        boostedContactCount: result.record.boostedContactCount,
      });
      return result;
    },
  };
}
