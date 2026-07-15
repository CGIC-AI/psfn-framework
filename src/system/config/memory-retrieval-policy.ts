import { isRecord } from '../../shared/utils/types.js';

export const MEMORY_POLICY_TYPES = [
  'episodic',
  'semantic',
  'emotional',
  'procedural',
  'boundary',
  'reflection',
  'relational',
] as const;

export type MemoryPolicyType = (typeof MEMORY_POLICY_TYPES)[number];

export type MemorySalienceFloorPolicy =
  | { mode: 'constant'; value: number }
  | { mode: 'valence_scaled'; base: number; absoluteValenceScale: number }
  | {
      mode: 'valence_threshold';
      base: number;
      absoluteValenceThreshold: number;
      thresholdValue: number;
    };

export interface MemoryTypeRetrievalPolicy {
  halfLifeDays: number;
  salienceFloor: MemorySalienceFloorPolicy;
  retrievalPrior: number;
}

export interface EpisodicRetrievalPolicy {
  /** Landmark-chain scan: episodes fetched from the store per query. */
  scanLimit: number;
  /** Landmark-chain: maximum distinct chains returned. */
  maxChains: number;
  /** Landmark-chain: maximum breadth-first arc-follow depth. */
  maxDepth: number;
  /** Landmark-chain: maximum episodes accreted into a single chain. */
  maxEpisodesPerChain: number;
  /** Timeline: maximum root entries returned. */
  timelineLimit: number;
  /** Timeline: episodes fetched from the store per query. */
  timelineScanLimit: number;
  /** Timeline: maximum arc-follow depth from each root. */
  timelineMaxDepth: number;
  /** Timeline: maximum linked episodes accreted per root. */
  timelineMaxEpisodesPerRoot: number;
  /** Per-episode arc fan-out scanned while walking a chain. */
  arcScanLimit: number;
  /** Minimum score for an episode to seed a chain root. */
  minRootMatchScore: number;
  /** Minimum score for a linked episode to stay in a chain. */
  minRelatedMatchScore: number;
}

export interface MemoryRetrievalPolicy {
  typePolicies: Record<MemoryPolicyType, MemoryTypeRetrievalPolicy>;
  proceduralTaskRetrievalPrior: number;
  selectionCaps: {
    reflection: number;
    procedural: number;
  };
  nonTemporalRecencyFloor: number;
  lexicalAugment: {
    pageSize: number;
    maxScan: number;
    selectedLimit: number;
    /** Minimum shared-token overlap for a recent memory to augment. */
    minOverlap: number;
    /** Base similarity assigned to a lexical-augment match. */
    baseSimilarity: number;
  };
  /**
   * Minimum count of top-similarity memories the score guarantee rescues
   * when the scored set would otherwise fall below it.
   */
  scoreGuaranteeMinK: number;
  /** Similarity multiplier applied to score-guaranteed rescues. */
  scoreGuaranteeFloor: number;
  episodic: EpisodicRetrievalPolicy;
  emotionalIntensityPersistenceMaxMultiplier: number;
}

function freezeMemoryRetrievalPolicy(
  policy: MemoryRetrievalPolicy,
): MemoryRetrievalPolicy {
  for (const type of MEMORY_POLICY_TYPES) {
    Object.freeze(policy.typePolicies[type].salienceFloor);
    Object.freeze(policy.typePolicies[type]);
  }
  Object.freeze(policy.typePolicies);
  Object.freeze(policy.selectionCaps);
  Object.freeze(policy.lexicalAugment);
  Object.freeze(policy.episodic);
  return Object.freeze(policy);
}

const DEFAULT_POLICY: MemoryRetrievalPolicy = freezeMemoryRetrievalPolicy({
  typePolicies: {
    episodic: {
      halfLifeDays: 30,
      salienceFloor: { mode: 'constant', value: 0.05 },
      retrievalPrior: 1,
    },
    semantic: {
      halfLifeDays: 120,
      salienceFloor: { mode: 'constant', value: 0.05 },
      retrievalPrior: 1,
    },
    emotional: {
      halfLifeDays: 365,
      salienceFloor: {
        mode: 'valence_scaled',
        base: 0.25,
        absoluteValenceScale: 0.35,
      },
      retrievalPrior: 1.3,
    },
    procedural: {
      halfLifeDays: 14,
      salienceFloor: { mode: 'constant', value: 0.05 },
      retrievalPrior: 0.6,
    },
    boundary: {
      halfLifeDays: 365,
      salienceFloor: { mode: 'constant', value: 0.5 },
      retrievalPrior: 1.6,
    },
    reflection: {
      halfLifeDays: 90,
      salienceFloor: { mode: 'constant', value: 0.05 },
      retrievalPrior: 0.9,
    },
    relational: {
      halfLifeDays: 180,
      salienceFloor: {
        mode: 'valence_threshold',
        base: 0.05,
        absoluteValenceThreshold: 0.5,
        thresholdValue: 0.5,
      },
      retrievalPrior: 1.15,
    },
  },
  proceduralTaskRetrievalPrior: 1.2,
  selectionCaps: {
    reflection: 2,
    procedural: 2,
  },
  nonTemporalRecencyFloor: 0.35,
  lexicalAugment: {
    pageSize: 256,
    maxScan: 2_048,
    selectedLimit: 12,
    minOverlap: 2,
    baseSimilarity: 0.62,
  },
  scoreGuaranteeMinK: 3,
  scoreGuaranteeFloor: 0.01,
  episodic: {
    scanLimit: 1_000,
    maxChains: 3,
    maxDepth: 2,
    maxEpisodesPerChain: 5,
    timelineLimit: 8,
    timelineScanLimit: 200,
    timelineMaxDepth: 1,
    timelineMaxEpisodesPerRoot: 3,
    arcScanLimit: 8,
    minRootMatchScore: 0.18,
    minRelatedMatchScore: 0.08,
  },
  emotionalIntensityPersistenceMaxMultiplier: 6,
});

const DETERMINISTIC_PROCEDURAL_TASK_KINDS = new Set([
  'analysis',
  'deferred_tool_handoff',
  'focus-work',
  'focus_work',
  'heartbeat',
  'maintenance',
  'planning',
  'research',
  'work',
]);

export function createDefaultMemoryRetrievalPolicy(): MemoryRetrievalPolicy {
  return structuredClone(DEFAULT_POLICY);
}

export function resolveMemoryRetrievalPolicy(
  policy: MemoryRetrievalPolicy | undefined,
): MemoryRetrievalPolicy {
  return policy ?? DEFAULT_POLICY;
}

export function cloneMemoryRetrievalPolicy(
  policy: MemoryRetrievalPolicy,
): MemoryRetrievalPolicy {
  return structuredClone(policy);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  fieldPath: string,
): void {
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter(key => !(key in value));
  const unknown = Object.keys(value).filter(key => !expected.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
      ...(unknown.length > 0 ? [`unknown ${unknown.join(', ')}`] : []),
    ].join('; ');
    throw new Error(`Invalid settings at ${fieldPath}: ${details}`);
  }
}

function requireRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected object`);
  }
  return value;
}

function requireFiniteNumber(
  value: unknown,
  fieldPath: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `Invalid settings at ${fieldPath}: expected finite number between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function requireInteger(
  value: unknown,
  fieldPath: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = requireFiniteNumber(value, fieldPath, minimum, maximum);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid settings at ${fieldPath}: expected integer`);
  }
  return parsed;
}

function normalizeSalienceFloorPolicy(
  value: unknown,
  fieldPath: string,
): MemorySalienceFloorPolicy {
  const record = requireRecord(value, fieldPath);
  if (record.mode === 'constant') {
    assertExactKeys(record, ['mode', 'value'], fieldPath);
    return {
      mode: 'constant',
      value: requireFiniteNumber(record.value, `${fieldPath}.value`, 0, 1),
    };
  }
  if (record.mode === 'valence_scaled') {
    assertExactKeys(record, ['mode', 'base', 'absoluteValenceScale'], fieldPath);
    const base = requireFiniteNumber(record.base, `${fieldPath}.base`, 0, 1);
    const absoluteValenceScale = requireFiniteNumber(
      record.absoluteValenceScale,
      `${fieldPath}.absoluteValenceScale`,
      0,
      1,
    );
    if (base + absoluteValenceScale > 1) {
      throw new Error(
        `Invalid settings at ${fieldPath}: base + absoluteValenceScale must be at most 1`,
      );
    }
    return { mode: 'valence_scaled', base, absoluteValenceScale };
  }
  if (record.mode === 'valence_threshold') {
    assertExactKeys(
      record,
      ['mode', 'base', 'absoluteValenceThreshold', 'thresholdValue'],
      fieldPath,
    );
    const base = requireFiniteNumber(record.base, `${fieldPath}.base`, 0, 1);
    const thresholdValue = requireFiniteNumber(
      record.thresholdValue,
      `${fieldPath}.thresholdValue`,
      0,
      1,
    );
    if (thresholdValue < base) {
      throw new Error(
        `Invalid settings at ${fieldPath}: thresholdValue must be greater than or equal to base`,
      );
    }
    return {
      mode: 'valence_threshold',
      base,
      absoluteValenceThreshold: requireFiniteNumber(
        record.absoluteValenceThreshold,
        `${fieldPath}.absoluteValenceThreshold`,
        0,
        1,
      ),
      thresholdValue,
    };
  }
  throw new Error(
    `Invalid settings at ${fieldPath}.mode: expected constant, valence_scaled, or valence_threshold`,
  );
}

function normalizeTypePolicy(
  value: unknown,
  fieldPath: string,
): MemoryTypeRetrievalPolicy {
  const record = requireRecord(value, fieldPath);
  assertExactKeys(record, ['halfLifeDays', 'salienceFloor', 'retrievalPrior'], fieldPath);
  return {
    halfLifeDays: requireFiniteNumber(
      record.halfLifeDays,
      `${fieldPath}.halfLifeDays`,
      1,
      36_500,
    ),
    salienceFloor: normalizeSalienceFloorPolicy(
      record.salienceFloor,
      `${fieldPath}.salienceFloor`,
    ),
    retrievalPrior: requireFiniteNumber(
      record.retrievalPrior,
      `${fieldPath}.retrievalPrior`,
      0.01,
      10,
    ),
  };
}

export function normalizeMemoryRetrievalPolicy(
  value: unknown,
  fieldPath = 'memoryRetrievalPolicy',
): MemoryRetrievalPolicy {
  const record = requireRecord(value, fieldPath);
  assertExactKeys(record, [
    'typePolicies',
    'proceduralTaskRetrievalPrior',
    'selectionCaps',
    'nonTemporalRecencyFloor',
    'lexicalAugment',
    'scoreGuaranteeMinK',
    'scoreGuaranteeFloor',
    'episodic',
    'emotionalIntensityPersistenceMaxMultiplier',
  ], fieldPath);

  const typePoliciesRecord = requireRecord(record.typePolicies, `${fieldPath}.typePolicies`);
  assertExactKeys(typePoliciesRecord, MEMORY_POLICY_TYPES, `${fieldPath}.typePolicies`);
  const typePolicies = Object.fromEntries(MEMORY_POLICY_TYPES.map(type => [
    type,
    normalizeTypePolicy(typePoliciesRecord[type], `${fieldPath}.typePolicies.${type}`),
  ])) as Record<MemoryPolicyType, MemoryTypeRetrievalPolicy>;

  const selectionCaps = requireRecord(record.selectionCaps, `${fieldPath}.selectionCaps`);
  assertExactKeys(selectionCaps, ['reflection', 'procedural'], `${fieldPath}.selectionCaps`);

  const lexicalAugment = requireRecord(record.lexicalAugment, `${fieldPath}.lexicalAugment`);
  assertExactKeys(
    lexicalAugment,
    ['pageSize', 'maxScan', 'selectedLimit', 'minOverlap', 'baseSimilarity'],
    `${fieldPath}.lexicalAugment`,
  );
  const pageSize = requireInteger(
    lexicalAugment.pageSize,
    `${fieldPath}.lexicalAugment.pageSize`,
    1,
    500,
  );
  const maxScan = requireInteger(
    lexicalAugment.maxScan,
    `${fieldPath}.lexicalAugment.maxScan`,
    pageSize,
    100_000,
  );
  const selectedLimit = requireInteger(
    lexicalAugment.selectedLimit,
    `${fieldPath}.lexicalAugment.selectedLimit`,
    1,
    maxScan,
  );
  const minOverlap = requireInteger(
    lexicalAugment.minOverlap,
    `${fieldPath}.lexicalAugment.minOverlap`,
    1,
    100,
  );
  const baseSimilarity = requireFiniteNumber(
    lexicalAugment.baseSimilarity,
    `${fieldPath}.lexicalAugment.baseSimilarity`,
    0,
    1,
  );

  const episodic = normalizeEpisodicRetrievalPolicy(
    record.episodic,
    `${fieldPath}.episodic`,
  );

  return {
    typePolicies,
    proceduralTaskRetrievalPrior: requireFiniteNumber(
      record.proceduralTaskRetrievalPrior,
      `${fieldPath}.proceduralTaskRetrievalPrior`,
      0.01,
      10,
    ),
    selectionCaps: {
      reflection: requireInteger(
        selectionCaps.reflection,
        `${fieldPath}.selectionCaps.reflection`,
        1,
        100,
      ),
      procedural: requireInteger(
        selectionCaps.procedural,
        `${fieldPath}.selectionCaps.procedural`,
        1,
        100,
      ),
    },
    nonTemporalRecencyFloor: requireFiniteNumber(
      record.nonTemporalRecencyFloor,
      `${fieldPath}.nonTemporalRecencyFloor`,
      0,
      1,
    ),
    lexicalAugment: { pageSize, maxScan, selectedLimit, minOverlap, baseSimilarity },
    scoreGuaranteeMinK: requireInteger(
      record.scoreGuaranteeMinK,
      `${fieldPath}.scoreGuaranteeMinK`,
      0,
      100,
    ),
    scoreGuaranteeFloor: requireFiniteNumber(
      record.scoreGuaranteeFloor,
      `${fieldPath}.scoreGuaranteeFloor`,
      0,
      1,
    ),
    episodic,
    emotionalIntensityPersistenceMaxMultiplier: requireFiniteNumber(
      record.emotionalIntensityPersistenceMaxMultiplier,
      `${fieldPath}.emotionalIntensityPersistenceMaxMultiplier`,
      1,
      100,
    ),
  };
}

function normalizeEpisodicRetrievalPolicy(
  value: unknown,
  fieldPath: string,
): EpisodicRetrievalPolicy {
  const record = requireRecord(value, fieldPath);
  assertExactKeys(
    record,
    [
      'scanLimit',
      'maxChains',
      'maxDepth',
      'maxEpisodesPerChain',
      'timelineLimit',
      'timelineScanLimit',
      'timelineMaxDepth',
      'timelineMaxEpisodesPerRoot',
      'arcScanLimit',
      'minRootMatchScore',
      'minRelatedMatchScore',
    ],
    fieldPath,
  );
  return {
    scanLimit: requireInteger(record.scanLimit, `${fieldPath}.scanLimit`, 1, 100_000),
    maxChains: requireInteger(record.maxChains, `${fieldPath}.maxChains`, 1, 1_000),
    maxDepth: requireInteger(record.maxDepth, `${fieldPath}.maxDepth`, 0, 100),
    maxEpisodesPerChain: requireInteger(
      record.maxEpisodesPerChain,
      `${fieldPath}.maxEpisodesPerChain`,
      1,
      1_000,
    ),
    timelineLimit: requireInteger(record.timelineLimit, `${fieldPath}.timelineLimit`, 1, 1_000),
    timelineScanLimit: requireInteger(
      record.timelineScanLimit,
      `${fieldPath}.timelineScanLimit`,
      1,
      100_000,
    ),
    timelineMaxDepth: requireInteger(
      record.timelineMaxDepth,
      `${fieldPath}.timelineMaxDepth`,
      0,
      100,
    ),
    timelineMaxEpisodesPerRoot: requireInteger(
      record.timelineMaxEpisodesPerRoot,
      `${fieldPath}.timelineMaxEpisodesPerRoot`,
      1,
      1_000,
    ),
    arcScanLimit: requireInteger(record.arcScanLimit, `${fieldPath}.arcScanLimit`, 1, 1_000),
    minRootMatchScore: requireFiniteNumber(
      record.minRootMatchScore,
      `${fieldPath}.minRootMatchScore`,
      0,
      1,
    ),
    minRelatedMatchScore: requireFiniteNumber(
      record.minRelatedMatchScore,
      `${fieldPath}.minRelatedMatchScore`,
      0,
      1,
    ),
  };
}

export function resolveMemorySalienceFloor(
  policy: MemoryRetrievalPolicy,
  type: MemoryPolicyType,
  emotionalValence: number,
): number {
  const floor = policy.typePolicies[type].salienceFloor;
  const absoluteValence = Math.min(1, Math.abs(Number.isFinite(emotionalValence) ? emotionalValence : 0));
  if (floor.mode === 'constant') return floor.value;
  if (floor.mode === 'valence_scaled') {
    return floor.base + (floor.absoluteValenceScale * absoluteValence);
  }
  return absoluteValence >= floor.absoluteValenceThreshold
    ? floor.thresholdValue
    : floor.base;
}

export function isProceduralTaskContext(taskKind: string | undefined): boolean {
  return DETERMINISTIC_PROCEDURAL_TASK_KINDS.has(taskKind?.trim().toLowerCase() ?? '');
}

export function resolveMemoryRetrievalPrior(
  policy: MemoryRetrievalPolicy,
  type: MemoryPolicyType,
  taskKind: string | undefined,
): number {
  if (type === 'procedural' && isProceduralTaskContext(taskKind)) {
    return policy.proceduralTaskRetrievalPrior;
  }
  return policy.typePolicies[type].retrievalPrior;
}

export function resolveMemorySelectionCap(
  policy: MemoryRetrievalPolicy,
  type: MemoryPolicyType,
): number | undefined {
  if (type === 'reflection') return policy.selectionCaps.reflection;
  if (type === 'procedural') return policy.selectionCaps.procedural;
  return undefined;
}
