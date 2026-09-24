import type { CanonicalModelPurpose } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { resolveCandidates } from '../../../primitives/llm/model-hint-routing.js';
import type { RoutingCandidate } from '../../../primitives/llm/routing.js';

export interface IntakeScreenerModelSelection {
  /** L2 fast classifier: canonical background lane. */
  l2: RoutingCandidate;
  /**
   * L3 models. In single-verdict mode this is an ordered failover chain
   * (reasoning first, then background). In dual-verdict mode it contains the
   * two distinct models that must both return a conforming verdict.
   */
  l3: RoutingCandidate[];
  /** Vision lane; absent only when vision screening is explicitly disabled. */
  vision?: RoutingCandidate;
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
  return candidates;
}

function candidateKey(candidate: RoutingCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

function distinctModels(candidates: readonly RoutingCandidate[]): RoutingCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  let l3: RoutingCandidate[];
  if (options.l3DualModel) {
    const primary = reasoningModels[0]!;
    const secondary = backgroundModels.find((model) => candidateKey(model) !== candidateKey(primary));
    if (!secondary) {
      throw new Error(
        'Intake L3 dual-model mode requires the reasoning and background purposes '
        + `to resolve to different models; both resolved only to "${candidateKey(primary)}". `
        + 'Choose different models.json slots or disable l3Screener.dualModel.',
      );
    }
    l3 = [primary, secondary];
  } else {
    // A schema-valid registry declaration is not proof that a provider will
    // accept the slug or that the model will satisfy the strict L3 contract.
    // Preserve the canonical routing chains so one provider/model failure does
    // not quarantine every mandatory-L3 item. evaluateL3 tries these in order.
    l3 = distinctModels([...reasoningModels, ...backgroundModels]);
    if (l3.length < 2) {
      throw new Error(
        'Intake L3 single-verdict mode requires at least two distinct '
        + 'models across the reasoning and background purpose chains; '
        + `resolved only to "${l3[0] ? candidateKey(l3[0]) : '(none)'}". A single screener model is a `
        + 'fail-closed availability single point of failure.',
      );
    }
  }

  if (!options.visionEnabled) {
    return { l2: background[0]!, l3 };
  }
  const vision = resolvePurposeCandidates(config, 'vision')[0]!;
  if (vision.supportsVision !== true) {
    throw new Error(
      `Intake vision purpose resolved to "${candidateKey(vision)}" without explicit `
      + 'supportsVision=true capability metadata. Configure a vision-capable '
      + 'models.json slot for the vision purpose.',
    );
  }
  return { l2: background[0]!, l3, vision };
}

/** Identity of a selection: the routed models plus the card metadata they carry. */
function selectionFingerprint(selection: IntakeScreenerModelSelection): string {
  return JSON.stringify({ l2: selection.l2, l3: selection.l3, vision: selection.vision ?? null });
}

/**
 * The intake screeners' model selection, re-resolvable when models.json changes
 * on disk (beads psfn-framework-hye2n, psfn-framework-awhls). Resolution is the
 * same fail-closed startup operation; a refresh that would not start (missing
 * purpose, non-vision card, unready backend) throws and keeps the running
 * selection, so a bad edit never leaves intake without a screener.
 */
export interface LiveIntakeScreenerModels {
  current(): IntakeScreenerModelSelection;
  /**
   * Re-resolve from the (reloaded) config. `verify` proves a changed selection
   * ready before it serves traffic; if resolution or `verify` throws, the
   * running selection stays in place.
   */
  refresh(verify: (selection: IntakeScreenerModelSelection) => void): 'unchanged' | 'applied';
}

export function createLiveIntakeScreenerModels(
  config: SubstrateConfig,
  options: {
    l3DualModel: boolean;
    visionEnabled: boolean;
  },
): LiveIntakeScreenerModels {
  const resolve = (): IntakeScreenerModelSelection => resolveIntakeScreenerModels(config, options);
  let selection = resolve();
  return {
    current: () => selection,
    refresh: (verify) => {
      const next = resolve();
      if (selectionFingerprint(next) === selectionFingerprint(selection)) return 'unchanged';
      verify(next);
      selection = next;
      return 'applied';
    },
  };
}
