import type { CanonicalModelPurpose } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { resolveCandidates } from '../../../primitives/llm/model-hint-routing.js';
import type { RoutingCandidate } from '../../../primitives/llm/routing.js';

export interface IntakeScreenerModelSelection {
  /** L2 fast classifier: canonical background lane. */
  l2: string;
  /**
   * L3 models. In single-verdict mode this is an ordered failover chain
   * (reasoning first, then background). In dual-verdict mode it contains the
   * two distinct models that must both return a conforming verdict.
   */
  l3: string[];
  /** Vision lane; absent only when vision screening is explicitly disabled. */
  vision?: string;
}

function resolvePurposeCandidates(
  config: SubstrateConfig,
  purpose: CanonicalModelPurpose,
): RoutingCandidate[] {
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
  const selectedCandidate = candidates[0]!;
  if (selectedCandidate.provider !== 'openrouter') {
    throw new Error(
      `Intake screener purpose "${purpose}" resolved to `
      + `${selectedCandidate.provider}/${selectedCandidate.model}, `
      + 'but the isolated tool-less screener transport requires an OpenRouter-routed model. '
      + `Select an OpenRouter models.json slot for ${purpose}.`,
    );
  }
  // A later non-OpenRouter candidate cannot be used by this transport, but it
  // must not erase usable OpenRouter fallbacks declared for the same purpose.
  return candidates.filter((candidate) => candidate.provider === 'openrouter');
}

function distinctModels(candidates: readonly RoutingCandidate[]): string[] {
  return [...new Set(candidates.map((candidate) => candidate.model))];
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
  const background = resolvePurposeCandidates(config, 'background');
  const reasoning = resolvePurposeCandidates(config, 'reasoning');
  const reasoningModels = distinctModels(reasoning);
  const backgroundModels = distinctModels(background);
  let l3: string[];
  if (options.l3DualModel) {
    const primary = reasoningModels[0]!;
    const secondary = backgroundModels.find((model) => model !== primary);
    if (!secondary) {
      throw new Error(
        'Intake L3 dual-model mode requires the reasoning and background purposes '
        + `to resolve to different models; both resolved only to "${primary}". `
        + 'Choose different models.json slots or disable l3Screener.dualModel.',
      );
    }
    l3 = [primary, secondary];
  } else {
    // A schema-valid registry declaration is not proof that a provider will
    // accept the slug or that the model will satisfy the strict L3 contract.
    // Preserve the canonical routing chains so one provider/model failure does
    // not quarantine every mandatory-L3 item. evaluateL3 tries these in order.
    l3 = [...new Set([...reasoningModels, ...backgroundModels])];
    if (l3.length < 2) {
      throw new Error(
        'Intake L3 single-verdict mode requires at least two distinct '
        + 'OpenRouter models across the reasoning and background purpose chains; '
        + `resolved only to "${l3[0] ?? '(none)'}". A single screener model is a `
        + 'fail-closed availability single point of failure.',
      );
    }
  }

  if (!options.visionEnabled) {
    return { l2: background[0]!.model, l3 };
  }
  const vision = resolvePurposeCandidates(config, 'vision')[0]!;
  if (vision.supportsVision !== true) {
    throw new Error(
      `Intake vision purpose resolved to "${vision.model}" without explicit `
      + 'supportsVision=true capability metadata. Configure a vision-capable '
      + 'models.json slot for the vision purpose.',
    );
  }
  return { l2: background[0]!.model, l3, vision: vision.model };
}
