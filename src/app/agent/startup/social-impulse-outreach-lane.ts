import type {
  SocialImpulseDesireTarget,
  SocialImpulseOutreachMode,
  SocialImpulseOutreachRuntime,
  SocialImpulseOutreachStorePort,
} from '../../../core/emotion/social-impulse-outreach.js';
import { createProductionSocialImpulseOutreachRuntime } from '../social-impulse-outreach-runtime.js';

export interface SocialImpulseOutreachLaneDeps {
  companionId: string;
  store: SocialImpulseOutreachStorePort;
  getMode(): SocialImpulseOutreachMode;
}

export interface SocialImpulseOutreachLane {
  runtime: SocialImpulseOutreachRuntime;
  /** Bound once the social-desire lane is composed; undefined keeps impulses fail-closed. */
  setDesireTarget(value: SocialImpulseDesireTarget | undefined): void;
}

/**
 * EmoSim felt impulses raise per-contact social pressure (vcq8v.4). The desire
 * target is composed later in boot; an impulse that arrives before it (or with
 * socialDesire.enabled false) settles as `lane_disabled` and raises nothing.
 */
export function registerSocialImpulseOutreachLane(
  deps: SocialImpulseOutreachLaneDeps,
): SocialImpulseOutreachLane {
  let desireTarget: SocialImpulseDesireTarget | undefined;
  const runtime = createProductionSocialImpulseOutreachRuntime({
    companionId: deps.companionId,
    store: deps.store,
    getMode: deps.getMode,
    getDesireTarget: () => desireTarget ?? null,
  });
  return {
    runtime,
    setDesireTarget(value) {
      desireTarget = value;
    },
  };
}
