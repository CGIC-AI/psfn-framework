import type { CanonicalModelPurpose } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { resolveCandidates } from '../../../primitives/llm/model-hint-routing.js';
import type { RoutingCandidate } from '../../../primitives/llm/routing.js';

export interface IntakeScreenerModelSelection {
  /** L2 fast classifier: canonical background lane. */
  l2: string;
  /** L3 primary reasoning lane, optionally followed by background in dual mode. */
  l3: string[];
  /** Vision lane; absent only when vision screening is explicitly disabled. */
  vision?: string;
}

function resolvePurposeCandidate(
  config: SubstrateConfig,
  purpose: CanonicalModelPurpose,
): RoutingCandidate {
  // Let the canonical resolver apply its own single- versus multi-companion
  // selection semantics. In particular, a fleet gateway must not reinterpret
  // one hydrated companion overlay as a global slot hint.
  const candidates = resolveCandidates(config, purpose, undefined);
  if (candidates.length === 0) {
    throw new Error(
      `Intake screener purpose "${purpose}" has no eligible model in models.json. `
      + `Configure a primary model for the ${purpose} purpose or set `
      + `modelPurposeSelection.${purpose} to an enabled models.json slot.`,
    );
  }
  const candidate = candidates[0]!;
  if (candidate.provider !== 'openrouter') {
    throw new Error(
      `Intake screener purpose "${purpose}" resolved to ${candidate.provider}/${candidate.model}, `
      + 'but the isolated tool-less screener transport requires an OpenRouter-routed model. '
      + `Select an OpenRouter models.json slot for ${purpose}.`,
    );
  }
  return candidate;
}

/**
 * Resolve the intake screeners through the same canonical purpose routing and
 * per-companion slot selection used by ordinary model calls. This is a
 * startup-time operation: missing purposes, stale slot selections, provider
 * mismatches, and missing vision capability all fail closed before intake is
 * accepted.
 */
export function resolveIntakeScreenerModels(
  config: SubstrateConfig,
  options: {
    l3DualModel: boolean;
    visionEnabled: boolean;
  },
): IntakeScreenerModelSelection {
  const background = resolvePurposeCandidate(config, 'background');
  const reasoning = resolvePurposeCandidate(config, 'reasoning');
  const l3 = options.l3DualModel
    ? [reasoning.model, background.model]
    : [reasoning.model];
  if (options.l3DualModel && l3[0] === l3[1]) {
    throw new Error(
      'Intake L3 dual-model mode requires the reasoning and background purposes '
      + `to resolve to different models; both resolved to "${l3[0]}". `
      + 'Choose different models.json slots or disable l3Screener.dualModel.',
    );
  }

  if (!options.visionEnabled) {
    return { l2: background.model, l3 };
  }
  const vision = resolvePurposeCandidate(config, 'vision');
  if (vision.supportsVision !== true) {
    throw new Error(
      `Intake vision purpose resolved to "${vision.model}" without explicit `
      + 'supportsVision=true capability metadata. Configure a vision-capable '
      + 'models.json slot for the vision purpose.',
    );
  }
  return { l2: background.model, l3, vision: vision.model };
}
