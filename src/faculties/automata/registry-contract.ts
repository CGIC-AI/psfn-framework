import { isRecord } from '../../shared/utils/types.js';

export const AUTOMATA_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export type AutomataRunStatus = typeof AUTOMATA_RUN_STATUSES[number];

export const AUTOMATA_RUN_OUTCOMES = [
  'completed',
  'blocked',
  'cancelled',
  'budget_limited',
] as const;

export type AutomataRunOutcome = typeof AUTOMATA_RUN_OUTCOMES[number];
export type AutomataBusEligibility = 'eligible' | 'excluded';
export type AutomataRetentionClass = 'ephemeral' | 'standard' | 'extended';

export interface AutomataClassDescriptor {
  id: string;
  workerKind: 'subagent' | 'shard' | 'background' | 'scheduler' | 'post_turn';
  trigger: string;
  promptPolicy: 'inherited_identity_bus_task' | 'inherited_identity_task' | 'system_owned' | 'none';
  chargeClass: 'subagent' | 'shard' | 'background' | 'maintenance';
  concurrencyClass: 'bounded_worker' | 'background_session' | 'serialized' | 'scheduler';
  failureClass: 'terminal' | 'retry' | 'lease_retry' | 'isolated';
  retentionClass: AutomataRetentionClass;
}

export interface EffectiveAutomataClassDescriptor extends AutomataClassDescriptor {
  busEligibility: AutomataBusEligibility;
  retentionMs: number;
}

const INHERITANCE_MODES = Object.freeze({
  bus: 'inherited_identity_bus_task',
  task: 'inherited_identity_task',
  system: 'system_owned',
  none: 'none',
} as const);

const EXECUTION_MODES = Object.freeze({
  bounded: 'bounded_worker',
  background: 'background_session',
  serialized: 'serialized',
  scheduler: 'scheduler',
} as const);

/**
 * The canonical vocabulary of production ephemeral workers. Runtime spawn
 * registries reference these IDs; adding a new spawn path without adding its
 * class therefore fails the registration coverage test and the runtime guard.
 */
export const PRODUCTION_AUTOMATA_CLASSES = [
  {
    id: 'subagent.bounded',
    workerKind: 'subagent',
    trigger: 'tool-or-post-turn-request',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'subagent',
    concurrencyClass: EXECUTION_MODES.bounded,
    failureClass: 'terminal',
    retentionClass: 'standard',
  },
  {
    id: 'shard.long_horizon',
    workerKind: 'shard',
    trigger: 'internal-shard-execution-port',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'shard',
    concurrencyClass: EXECUTION_MODES.bounded,
    failureClass: 'terminal',
    retentionClass: 'extended',
  },
  {
    id: 'memory.retrieval',
    workerKind: 'background',
    trigger: 'foreground-context-retrieval',
    promptPolicy: INHERITANCE_MODES.task,
    chargeClass: 'background',
    concurrencyClass: EXECUTION_MODES.background,
    failureClass: 'isolated',
    retentionClass: 'ephemeral',
  },
  {
    id: 'memory.extraction',
    workerKind: 'background',
    trigger: 'background-work:memory_extraction',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'background',
    concurrencyClass: EXECUTION_MODES.background,
    failureClass: 'lease_retry',
    retentionClass: 'standard',
  },
  {
    id: 'memory.sleeptime',
    workerKind: 'post_turn',
    trigger: 'post-turn:memory.sleeptime.run',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'maintenance',
    concurrencyClass: EXECUTION_MODES.serialized,
    failureClass: 'retry',
    retentionClass: 'extended',
  },
  {
    id: 'memory.social_graph_builder',
    workerKind: 'scheduler',
    trigger: 'background-maintenance:social-graph-builder',
    promptPolicy: INHERITANCE_MODES.system,
    chargeClass: 'maintenance',
    concurrencyClass: EXECUTION_MODES.scheduler,
    failureClass: 'isolated',
    retentionClass: 'standard',
  },
  {
    id: 'intention.concern_candidate_review',
    workerKind: 'background',
    trigger: 'turn-gated-concern-candidate-review',
    promptPolicy: INHERITANCE_MODES.task,
    chargeClass: 'background',
    concurrencyClass: EXECUTION_MODES.serialized,
    failureClass: 'retry',
    retentionClass: 'standard',
  },
  {
    id: 'background.intention_post_turn_hooks',
    workerKind: 'background',
    trigger: 'background-work:intention_post_turn_hooks',
    promptPolicy: INHERITANCE_MODES.system,
    chargeClass: 'background',
    concurrencyClass: EXECUTION_MODES.background,
    failureClass: 'lease_retry',
    retentionClass: 'standard',
  },
  {
    id: 'background.emotion_appraisal',
    workerKind: 'background',
    trigger: 'background-work:emotion_appraisal',
    promptPolicy: INHERITANCE_MODES.task,
    chargeClass: 'background',
    concurrencyClass: EXECUTION_MODES.background,
    failureClass: 'lease_retry',
    retentionClass: 'standard',
  },
  {
    id: 'background.auto_compaction',
    workerKind: 'background',
    trigger: 'background-work:auto_compaction',
    promptPolicy: INHERITANCE_MODES.task,
    chargeClass: 'background',
    concurrencyClass: EXECUTION_MODES.serialized,
    failureClass: 'lease_retry',
    retentionClass: 'standard',
  },
  {
    id: 'post_turn.subagent_spawn',
    workerKind: 'post_turn',
    trigger: 'post-turn:subagent.spawn',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'subagent',
    concurrencyClass: EXECUTION_MODES.bounded,
    failureClass: 'retry',
    retentionClass: 'standard',
  },
  {
    id: 'scheduler.reflection',
    workerKind: 'scheduler',
    trigger: 'scheduler:reflection-template',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'maintenance',
    concurrencyClass: EXECUTION_MODES.scheduler,
    failureClass: 'isolated',
    retentionClass: 'extended',
  },
  {
    id: 'scheduler.free_time',
    workerKind: 'scheduler',
    trigger: 'scheduler:free-time',
    promptPolicy: INHERITANCE_MODES.bus,
    chargeClass: 'maintenance',
    concurrencyClass: EXECUTION_MODES.scheduler,
    failureClass: 'isolated',
    retentionClass: 'standard',
  },
] as const satisfies readonly AutomataClassDescriptor[];

export type ProductionAutomataClassId = typeof PRODUCTION_AUTOMATA_CLASSES[number]['id'];

export interface AutomataBusQueryOwnerPolicy {
  maxQueryChars: number;
  candidateLimit: number;
  maxSearchResults: number;
  maxBriefingItems: number;
  maxBriefingChars: number;
  maxBriefingClaimChars: number;
  resultCacheEnabled: boolean;
  resultCacheTtlMs: number;
  semanticWeight: number;
  lexicalWeight: number;
  exactFallbackEnabled: boolean;
  modelIdentityPolicy: 'configured-provider-strict';
}

export interface AutomataOwnerPolicy {
  schemaVersion: 1;
  bus: {
    eligibleClasses: ProductionAutomataClassId[];
    excludedClasses: ProductionAutomataClassId[];
    query: AutomataBusQueryOwnerPolicy;
  };
  retentionMs: Record<AutomataRetentionClass, number>;
  recentRunLimit: number;
  operatorMutationLimit: number;
}

export interface AutomataArtifactRef {
  kind: string;
  ref: string;
  custody: 'pending' | 'durable' | 'discarded';
}

export interface AutomataRunRecord {
  companionId: string;
  runId: string;
  automatonClass: ProductionAutomataClassId;
  workerId: string;
  workerGeneration: number;
  taskId: string;
  taskLabel: string;
  taskSummary: string;
  parentRunId?: string;
  sourceRunId?: string;
  sessionIds: string[];
  artifacts: AutomataArtifactRef[];
  status: AutomataRunStatus;
  statusReason: string;
  outcome?: AutomataRunOutcome;
  failureReason?: string;
  promotionState: 'not_requested' | 'pending' | 'promoted' | 'rejected';
  foldState: 'not_required' | 'pending' | 'folded' | 'rejected';
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  retentionDeadlineMs: number;
}

const CLASS_IDS = new Set<string>(PRODUCTION_AUTOMATA_CLASSES.map(entry => entry.id));
const RETENTION_CLASSES: readonly AutomataRetentionClass[] = ['ephemeral', 'standard', 'extended'];

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown keys: ${unknown.join(', ')}`);
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function requireUnitWeight(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${path} must be a finite number between 0 and 1`);
  }
  return value;
}

function parseBusQueryPolicy(value: unknown, path: string): AutomataBusQueryOwnerPolicy {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  assertExactKeys(value, [
    'maxQueryChars',
    'candidateLimit',
    'maxSearchResults',
    'maxBriefingItems',
    'maxBriefingChars',
    'maxBriefingClaimChars',
    'resultCacheEnabled',
    'resultCacheTtlMs',
    'semanticWeight',
    'lexicalWeight',
    'exactFallbackEnabled',
    'modelIdentityPolicy',
  ], path);
  const candidateLimit = requirePositiveInteger(value.candidateLimit, `${path}.candidateLimit`);
  const maxSearchResults = requirePositiveInteger(value.maxSearchResults, `${path}.maxSearchResults`);
  const maxBriefingItems = requirePositiveInteger(value.maxBriefingItems, `${path}.maxBriefingItems`);
  const maxBriefingChars = requirePositiveInteger(value.maxBriefingChars, `${path}.maxBriefingChars`);
  const maxBriefingClaimChars = requirePositiveInteger(
    value.maxBriefingClaimChars,
    `${path}.maxBriefingClaimChars`,
  );
  const semanticWeight = requireUnitWeight(value.semanticWeight, `${path}.semanticWeight`);
  const lexicalWeight = requireUnitWeight(value.lexicalWeight, `${path}.lexicalWeight`);
  if (maxSearchResults > candidateLimit) {
    throw new Error(`${path}.maxSearchResults must not exceed candidateLimit`);
  }
  if (maxBriefingItems > maxSearchResults) {
    throw new Error(`${path}.maxBriefingItems must not exceed maxSearchResults`);
  }
  if (maxBriefingClaimChars > maxBriefingChars) {
    throw new Error(`${path}.maxBriefingClaimChars must not exceed maxBriefingChars`);
  }
  if (semanticWeight + lexicalWeight !== 1) {
    throw new Error(`${path} weights must sum to 1`);
  }
  if (value.modelIdentityPolicy !== 'configured-provider-strict') {
    throw new Error(`${path}.modelIdentityPolicy must be "configured-provider-strict"`);
  }
  return {
    maxQueryChars: requirePositiveInteger(value.maxQueryChars, `${path}.maxQueryChars`),
    candidateLimit,
    maxSearchResults,
    maxBriefingItems,
    maxBriefingChars,
    maxBriefingClaimChars,
    resultCacheEnabled: requireBoolean(value.resultCacheEnabled, `${path}.resultCacheEnabled`),
    resultCacheTtlMs: requirePositiveInteger(value.resultCacheTtlMs, `${path}.resultCacheTtlMs`),
    semanticWeight,
    lexicalWeight,
    exactFallbackEnabled: requireBoolean(value.exactFallbackEnabled, `${path}.exactFallbackEnabled`),
    modelIdentityPolicy: value.modelIdentityPolicy,
  };
}

function parseClassList(value: unknown, path: string): ProductionAutomataClassId[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const classes = value.map((entry, index) => {
    if (typeof entry !== 'string' || !CLASS_IDS.has(entry)) {
      throw new Error(`${path}[${index}] names unknown automata class "${String(entry)}"`);
    }
    return entry as ProductionAutomataClassId;
  });
  if (new Set(classes).size !== classes.length) throw new Error(`${path} must not contain duplicates`);
  return classes;
}

export function parseAutomataOwnerPolicy(value: unknown, source = 'automata-policy.json'): AutomataOwnerPolicy {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.bus) || !isRecord(value.retentionMs)) {
    throw new Error(`${source} must contain schemaVersion=1, bus, and retentionMs objects`);
  }
  const retentionValues = value.retentionMs;
  assertExactKeys(
    value,
    ['schemaVersion', 'bus', 'retentionMs', 'recentRunLimit', 'operatorMutationLimit'],
    source,
  );
  assertExactKeys(value.bus, ['eligibleClasses', 'excludedClasses', 'query'], `${source}.bus`);
  assertExactKeys(retentionValues, RETENTION_CLASSES, `${source}.retentionMs`);
  const eligibleClasses = parseClassList(value.bus.eligibleClasses, `${source}.bus.eligibleClasses`);
  const excludedClasses = parseClassList(value.bus.excludedClasses, `${source}.bus.excludedClasses`);
  const overlap = eligibleClasses.filter(classId => excludedClasses.includes(classId));
  if (overlap.length > 0) throw new Error(`${source} assigns classes to both bus lists: ${overlap.join(', ')}`);
  const accounted = new Set([...eligibleClasses, ...excludedClasses]);
  const missing = PRODUCTION_AUTOMATA_CLASSES.map(entry => entry.id).filter(classId => !accounted.has(classId));
  if (missing.length > 0) throw new Error(`${source} does not assign bus policy for: ${missing.join(', ')}`);
  const query = parseBusQueryPolicy(value.bus.query, `${source}.bus.query`);
  const retentionMs = Object.fromEntries(RETENTION_CLASSES.map(retentionClass => [
    retentionClass,
    requirePositiveInteger(retentionValues[retentionClass], `${source}.retentionMs.${retentionClass}`),
  ])) as Record<AutomataRetentionClass, number>;
  return {
    schemaVersion: 1,
    bus: { eligibleClasses, excludedClasses, query },
    retentionMs,
    recentRunLimit: requirePositiveInteger(value.recentRunLimit, `${source}.recentRunLimit`),
    operatorMutationLimit: requirePositiveInteger(value.operatorMutationLimit, `${source}.operatorMutationLimit`),
  };
}

export function buildEffectiveAutomataClassManifest(
  policy: AutomataOwnerPolicy,
): EffectiveAutomataClassDescriptor[] {
  const eligible = new Set(policy.bus.eligibleClasses);
  return PRODUCTION_AUTOMATA_CLASSES.map(entry => ({
    ...entry,
    busEligibility: eligible.has(entry.id) ? 'eligible' : 'excluded',
    retentionMs: policy.retentionMs[entry.retentionClass],
  }));
}

export function requireAutomataClass(classId: string): ProductionAutomataClassId {
  if (!CLASS_IDS.has(classId)) throw new Error(`Unknown automata class "${classId}".`);
  return classId as ProductionAutomataClassId;
}

export function requireAutomataRunStatus(status: string): AutomataRunStatus {
  if (!(AUTOMATA_RUN_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Unknown automata run status "${status}".`);
  }
  return status as AutomataRunStatus;
}

export function cloneAutomataRun(record: AutomataRunRecord): AutomataRunRecord {
  return {
    ...record,
    sessionIds: [...record.sessionIds],
    artifacts: record.artifacts.map(artifact => ({ ...artifact })),
  };
}
