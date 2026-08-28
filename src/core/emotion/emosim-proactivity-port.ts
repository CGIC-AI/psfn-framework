import { isRfc4122Uuid } from '../../shared/utils/types.js';

export const EMOSIM_PROACTIVITY_IMPULSE_VERSION =
  'emosim-proactivity.impulse.v1' as const;
export const EMOSIM_PROACTIVITY_SUPPRESSION_VERSION =
  'emosim-proactivity.suppression.v1' as const;

const ATTACHMENT_EMOTIONS: ReadonlySet<string> = new Set([
  'Love',
  'Romance',
  'Adoration',
  'Admiration',
  'Sympathy',
]);

export interface EmoSimProactivityThresholdProfile {
  profileId: string;
  socialNeedThreshold: number;
  attachmentIntensityThreshold: number;
  sustainMs: number;
  cooldownMs: number;
}

export interface EmoSimProactivityInputLineage {
  schemaVersion: 1;
  /** Content-free identity of the sanitized turn projection. */
  inputId: string;
  projectionVersion: string;
  privacyClass: string;
  rawContentRedacted: true;
}

export interface EmoSimProactivityObservation {
  companionId: string;
  observedAtMs: number;
  source: {
    model: string;
    version: string;
    availability: 'available' | 'unavailable';
    confidence: number;
  };
  lineage: EmoSimProactivityInputLineage;
  snapshot: {
    dominant: string;
    emotions: Readonly<Record<string, number>>;
    drives?: Readonly<Partial<Record<string, number>>> | null;
  } | null;
}

/**
 * A narrow production fact: the configured source crossed its approved
 * proactivity threshold. It is not a claim about felt affect and is not send
 * authority; disposition and delivery policy remain downstream.
 */
export interface EmoSimProactivityImpulse {
  schemaVersion: 1;
  impulseVersion: typeof EMOSIM_PROACTIVITY_IMPULSE_VERSION;
  kind: 'would_message';
  companionId: string;
  source: {
    model: string;
    version: string;
  };
  lineage: EmoSimProactivityInputLineage;
  firstCrossingMs: number;
  firedAtMs: number;
  thresholdProfile: EmoSimProactivityThresholdProfile;
  dedupeKey: string;
  /** Existing disposition-funnel correlation identity; equal to dedupeKey. */
  correlationId: string;
  confidence: number;
  availability: 'available';
  authority: 'qualified_source_fire';
}

export type EmoSimProactivitySuppressionReason =
  | 'port_disabled'
  | 'source_unavailable'
  | 'inputs_unavailable'
  | 'threshold_not_met'
  | 'sustain_pending'
  | 'cooldown_active';

export interface EmoSimProactivitySuppression {
  schemaVersion: 1;
  suppressionVersion: typeof EMOSIM_PROACTIVITY_SUPPRESSION_VERSION;
  kind: 'suppressed';
  companionId: string;
  observedAtMs: number;
  availability: 'disabled' | 'unavailable' | 'available';
  reason: EmoSimProactivitySuppressionReason;
  lineage: EmoSimProactivityInputLineage;
  firstCrossingMs: number | null;
  nextEligibleAtMs?: number;
}

export type EmoSimProactivityResult =
  | { kind: 'emitted'; impulse: EmoSimProactivityImpulse }
  | EmoSimProactivitySuppression;

export interface EmoSimProactivityState {
  firstCrossingMs: number | null;
  lastFiredAtMs: number | null;
}

/**
 * Companion-local state seam. The production port depends only on this narrow
 * interface; persistence may migrate historical crossing state behind it.
 */
export interface EmoSimProactivityStateStorePort {
  load(): Promise<EmoSimProactivityState>;
  save(state: EmoSimProactivityState): Promise<void>;
}

export interface EmoSimProactivityPort {
  observe(observation: EmoSimProactivityObservation): Promise<EmoSimProactivityResult>;
}

export interface EmoSimProactivityPortOptions {
  enabled: boolean;
  companionId: string;
  thresholdProfile: EmoSimProactivityThresholdProfile;
  stateStore: EmoSimProactivityStateStorePort;
  /** Required handoff into the disposition funnel; this callback may not send. */
  emitImpulse(impulse: EmoSimProactivityImpulse): Promise<void>;
}

export function createEmoSimProactivityPort(
  options: EmoSimProactivityPortOptions,
): EmoSimProactivityPort {
  const companionId = requireCompanionId(options.companionId);
  const profile = normalizeThresholdProfile(options.thresholdProfile);
  let state: EmoSimProactivityState | null = null;
  let pending: Promise<void> = Promise.resolve();

  const loadState = async (): Promise<EmoSimProactivityState> => {
    if (state) return state;
    state = normalizeState(await options.stateStore.load());
    return state;
  };

  const observe = async (
    observation: EmoSimProactivityObservation,
  ): Promise<EmoSimProactivityResult> => {
    requireObservation(observation, companionId);
    if (!options.enabled) {
      return suppression(observation, 'port_disabled', 'disabled', null);
    }
    const current = await loadState();
    if (observation.source.availability !== 'available') {
      await resetCrossing(current);
      return suppression(observation, 'source_unavailable', 'unavailable', null);
    }
    const condition = evaluateWouldMessage(observation, profile);
    if (condition === null) {
      await resetCrossing(current);
      return suppression(observation, 'inputs_unavailable', 'available', null);
    }
    if (!condition) {
      await resetCrossing(current);
      return suppression(observation, 'threshold_not_met', 'available', null);
    }
    if (current.firstCrossingMs === null) {
      current.firstCrossingMs = observation.observedAtMs;
      await options.stateStore.save(current);
    }
    const firstCrossingMs = current.firstCrossingMs;
    if (observation.observedAtMs - firstCrossingMs < profile.sustainMs) {
      return suppression(observation, 'sustain_pending', 'available', firstCrossingMs);
    }
    if (current.lastFiredAtMs !== null
      && firstCrossingMs <= current.lastFiredAtMs
      && observation.observedAtMs - current.lastFiredAtMs < profile.cooldownMs) {
      return {
        ...suppression(observation, 'cooldown_active', 'available', firstCrossingMs),
        nextEligibleAtMs: current.lastFiredAtMs + profile.cooldownMs,
      };
    }

    const impulse: EmoSimProactivityImpulse = {
      schemaVersion: 1,
      impulseVersion: EMOSIM_PROACTIVITY_IMPULSE_VERSION,
      kind: 'would_message',
      companionId,
      source: {
        model: observation.source.model,
        version: observation.source.version,
      },
      lineage: structuredClone(observation.lineage),
      firstCrossingMs,
      firedAtMs: observation.observedAtMs,
      thresholdProfile: structuredClone(profile),
      dedupeKey: `felt-impulse:would_message:${firstCrossingMs}`,
      correlationId: `felt-impulse:would_message:${firstCrossingMs}`,
      confidence: observation.source.confidence,
      availability: 'available',
      authority: 'qualified_source_fire',
    };
    // Persist the fire only after the required consumer acknowledges it. If
    // the response is lost, the same first-crossing dedupe key is retried and
    // the durable disposition funnel decides the single winner.
    await options.emitImpulse(impulse);
    current.lastFiredAtMs = observation.observedAtMs;
    await options.stateStore.save(current);
    return { kind: 'emitted', impulse };
  };

  const resetCrossing = async (current: EmoSimProactivityState): Promise<void> => {
    if (current.firstCrossingMs === null) return;
    current.firstCrossingMs = null;
    await options.stateStore.save(current);
  };

  return {
    observe: async observation => {
      let resolveResult!: (result: EmoSimProactivityResult) => void;
      let rejectResult!: (error: unknown) => void;
      const result = new Promise<EmoSimProactivityResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      pending = pending.then(async () => {
        try {
          resolveResult(await observe(observation));
        } catch (error) {
          rejectResult(error);
        }
      });
      return await result;
    },
  };
}

function evaluateWouldMessage(
  observation: EmoSimProactivityObservation,
  profile: EmoSimProactivityThresholdProfile,
): boolean | null {
  const snapshot = observation.snapshot;
  if (!snapshot) return null;
  const socialNeed = finiteUnit(snapshot.drives?.socialNeed);
  const dominantIntensity = finiteUnit(snapshot.emotions[snapshot.dominant]);
  if (socialNeed === null && dominantIntensity === null) return null;
  return (socialNeed !== null && socialNeed >= profile.socialNeedThreshold)
    || (dominantIntensity !== null
      && ATTACHMENT_EMOTIONS.has(snapshot.dominant)
      && dominantIntensity >= profile.attachmentIntensityThreshold);
}

function suppression(
  observation: EmoSimProactivityObservation,
  reason: EmoSimProactivitySuppressionReason,
  availability: EmoSimProactivitySuppression['availability'],
  firstCrossingMs: number | null,
): EmoSimProactivitySuppression {
  return {
    schemaVersion: 1,
    suppressionVersion: EMOSIM_PROACTIVITY_SUPPRESSION_VERSION,
    kind: 'suppressed',
    companionId: observation.companionId,
    observedAtMs: observation.observedAtMs,
    availability,
    reason,
    lineage: structuredClone(observation.lineage),
    firstCrossingMs,
  };
}

function requireObservation(
  observation: EmoSimProactivityObservation,
  companionId: string,
): void {
  if (observation.companionId !== companionId) {
    throw new Error('EmoSim proactivity observation companionId does not match the port owner');
  }
  requireTimestamp(observation.observedAtMs, 'observedAtMs');
  if (!observation.source.model.trim() || !observation.source.version.trim()) {
    throw new Error('EmoSim proactivity source model and version are required');
  }
  if (!Number.isFinite(observation.source.confidence)
    || observation.source.confidence < 0
    || observation.source.confidence > 1) {
    throw new Error('EmoSim proactivity source confidence must be within 0..1');
  }
  if (!observation.lineage.inputId.trim() || !observation.lineage.projectionVersion.trim()) {
    throw new Error('EmoSim proactivity sanitized input lineage is required');
  }
  const rawContentRedacted = (observation.lineage as { rawContentRedacted?: unknown })
    .rawContentRedacted;
  if (rawContentRedacted !== true) {
    throw new Error('EmoSim proactivity input lineage must attest raw-content redaction');
  }
}

function normalizeState(input: EmoSimProactivityState): EmoSimProactivityState {
  return {
    firstCrossingMs: nullableTimestamp(input.firstCrossingMs, 'firstCrossingMs'),
    lastFiredAtMs: nullableTimestamp(input.lastFiredAtMs, 'lastFiredAtMs'),
  };
}

function normalizeThresholdProfile(
  input: EmoSimProactivityThresholdProfile,
): EmoSimProactivityThresholdProfile {
  const profileId = input.profileId.trim();
  if (!profileId) throw new Error('EmoSim proactivity threshold profileId is required');
  for (const [field, value] of [
    ['socialNeedThreshold', input.socialNeedThreshold],
    ['attachmentIntensityThreshold', input.attachmentIntensityThreshold],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`EmoSim proactivity ${field} must be within 0..1`);
    }
  }
  requireTimestamp(input.sustainMs, 'sustainMs');
  requireTimestamp(input.cooldownMs, 'cooldownMs');
  return { ...input, profileId };
}

function requireCompanionId(value: string): string {
  const companionId = value.trim();
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('EmoSim proactivity port requires a lowercase RFC-4122 companionId');
  }
  return companionId;
}

function finiteUnit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`EmoSim proactivity ${field} must be a non-negative safe integer`);
  }
  return value;
}

function nullableTimestamp(value: number | null, field: string): number | null {
  return value === null ? null : requireTimestamp(value, field);
}
