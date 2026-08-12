import { createHash } from 'node:crypto';

import { isRecord } from '../../../shared/utils/types.js';
import type { SensitivityLevel } from '../../../system/trust/types.js';

export const AUTOMATA_BUS_REVIEWER_CANDIDATE_KINDS = [
  'duplicate',
  'contradiction',
  'stale-evidence',
  'orphan-provenance',
] as const;

export type AutomataBusReviewerCandidateKind =
  typeof AUTOMATA_BUS_REVIEWER_CANDIDATE_KINDS[number];

export interface AutomataBusReviewerCandidatePolicy {
  similarityThreshold: number;
  maxFindingsPerRun: number;
  maxNominationsPerRun: number;
  maxCandidatesPerCluster: number;
  maxClustersPerRun: number;
}

export interface AutomataBusReviewerNomination {
  kind: AutomataBusReviewerCandidateKind;
  eventIds: readonly string[];
  /** Derived similarity is a nomination hint only; it is never a truth decision. */
  similarityScore?: number;
}

export interface AutomataBusReviewerNominationPort {
  nominate(input: {
    scope: AutomataBusReviewerScope;
    similarityThreshold: number;
    maxFindings: number;
    maxNominations: number;
  }): Promise<unknown>;
}

export interface AutomataBusReviewerScope {
  companionId: string;
  audience: 'operator';
  maxSensitivity: SensitivityLevel;
}

export interface AutomataBusReviewerCandidateCluster {
  clusterId: string;
  kind: AutomataBusReviewerCandidateKind;
  eventIds: string[];
  similarityScore?: number;
}

export interface AutomataBusReviewerCandidateBatch {
  clusters: AutomataBusReviewerCandidateCluster[];
  backlog: {
    findingsScanned: number;
    nominationsSeen: number;
    clustersReturned: number;
    hasMore: boolean;
  };
}

interface ParsedNominationBatch {
  nominations: AutomataBusReviewerNomination[];
  receivedCount: number;
  totalNominations: number;
  findingsScanned: number;
  hasMore: boolean;
}

interface MutableCluster {
  kind: AutomataBusReviewerCandidateKind;
  eventIds: string[];
  similarityScore?: number;
}

const CANDIDATE_KIND_SET = new Set<string>(AUTOMATA_BUS_REVIEWER_CANDIDATE_KINDS);
const PAIR_KINDS = new Set<AutomataBusReviewerCandidateKind>([
  'duplicate',
  'contradiction',
]);
const BATCH_KEYS = new Set([
  'nominations',
  'totalNominations',
  'findingsScanned',
  'hasMore',
]);
const NOMINATION_KEYS = new Set(['kind', 'eventIds', 'similarityScore']);

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Automata Bus reviewer ${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Automata Bus reviewer nomination ${field} must be a non-negative safe integer`);
  }
  return value;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Automata Bus reviewer nomination ${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizePolicy(
  policy: AutomataBusReviewerCandidatePolicy,
): AutomataBusReviewerCandidatePolicy {
  if (
    !Number.isFinite(policy.similarityThreshold)
    || policy.similarityThreshold < 0
    || policy.similarityThreshold > 1
  ) {
    throw new Error('Automata Bus reviewer similarityThreshold must be in [0,1]');
  }
  const maxCandidatesPerCluster = positiveInteger(
    policy.maxCandidatesPerCluster,
    'maxCandidatesPerCluster',
  );
  if (maxCandidatesPerCluster < 2) {
    throw new Error('Automata Bus reviewer maxCandidatesPerCluster must be at least 2');
  }
  return Object.freeze({
    similarityThreshold: policy.similarityThreshold,
    maxFindingsPerRun: positiveInteger(policy.maxFindingsPerRun, 'maxFindingsPerRun'),
    maxNominationsPerRun: positiveInteger(
      policy.maxNominationsPerRun,
      'maxNominationsPerRun',
    ),
    maxCandidatesPerCluster,
    maxClustersPerRun: positiveInteger(policy.maxClustersPerRun, 'maxClustersPerRun'),
  });
}

function parseNomination(
  value: unknown,
  index: number,
  policy: AutomataBusReviewerCandidatePolicy,
): AutomataBusReviewerNomination | null {
  if (!isRecord(value)) {
    throw new Error(`Automata Bus reviewer nomination nominations[${index}] must be an object`);
  }
  assertExactKeys(value, NOMINATION_KEYS, `nominations[${index}]`);
  if (typeof value.kind !== 'string' || !CANDIDATE_KIND_SET.has(value.kind)) {
    throw new Error(`Automata Bus reviewer nomination nominations[${index}].kind is invalid`);
  }
  if (!Array.isArray(value.eventIds)) {
    throw new Error(`Automata Bus reviewer nomination nominations[${index}].eventIds must be an array`);
  }
  const kind = value.kind as AutomataBusReviewerCandidateKind;
  const eventIds = value.eventIds.map((eventId, eventIndex) => (
    nonEmptyString(eventId, `nominations[${index}].eventIds[${eventIndex}]`)
  ));
  const minimumSize = PAIR_KINDS.has(kind) ? 2 : 1;
  if (eventIds.length < minimumSize) {
    throw new Error(`Automata Bus reviewer nomination ${kind} requires ${minimumSize} event ids`);
  }
  if (eventIds.length > policy.maxCandidatesPerCluster) {
    throw new Error('Automata Bus reviewer nomination exceeds maxCandidatesPerCluster');
  }
  if (new Set(eventIds).size !== eventIds.length) {
    throw new Error('Automata Bus reviewer nomination eventIds must be unique');
  }
  const normalizedEventIds = [...eventIds].sort();
  if (PAIR_KINDS.has(kind)) {
    if (
      typeof value.similarityScore !== 'number'
      || !Number.isFinite(value.similarityScore)
      || value.similarityScore < 0
      || value.similarityScore > 1
    ) {
      throw new Error(`Automata Bus reviewer nomination ${kind} requires similarityScore in [0,1]`);
    }
    if (value.similarityScore < policy.similarityThreshold) return null;
    return { kind, eventIds: normalizedEventIds, similarityScore: value.similarityScore };
  }
  if (value.similarityScore !== undefined) {
    throw new Error(`Automata Bus reviewer nomination ${kind} cannot carry similarityScore`);
  }
  return { kind, eventIds: normalizedEventIds };
}

function parseBatch(
  value: unknown,
  policy: AutomataBusReviewerCandidatePolicy,
): ParsedNominationBatch {
  if (!isRecord(value)) throw new Error('Automata Bus reviewer nomination result must be an object');
  assertExactKeys(value, BATCH_KEYS, 'Automata Bus reviewer nomination result');
  if (!Array.isArray(value.nominations)) {
    throw new Error('Automata Bus reviewer nomination result.nominations must be an array');
  }
  if (value.nominations.length > policy.maxNominationsPerRun) {
    throw new Error('Automata Bus reviewer nomination adapter exceeded maxNominationsPerRun');
  }
  const totalNominations = nonNegativeInteger(value.totalNominations, 'totalNominations');
  const findingsScanned = nonNegativeInteger(value.findingsScanned, 'findingsScanned');
  if (totalNominations < value.nominations.length) {
    throw new Error('Automata Bus reviewer nomination totalNominations is smaller than its page');
  }
  if (findingsScanned > policy.maxFindingsPerRun) {
    throw new Error('Automata Bus reviewer nomination adapter exceeded maxFindingsPerRun');
  }
  if (typeof value.hasMore !== 'boolean') {
    throw new Error('Automata Bus reviewer nomination hasMore must be boolean');
  }
  return {
    nominations: value.nominations.flatMap((nomination, index) => {
      const parsed = parseNomination(nomination, index, policy);
      return parsed === null ? [] : [parsed];
    }),
    receivedCount: value.nominations.length,
    totalNominations,
    findingsScanned,
    hasMore: value.hasMore,
  };
}

function clusterPairNominations(
  kind: Extract<AutomataBusReviewerCandidateKind, 'duplicate' | 'contradiction'>,
  nominations: readonly AutomataBusReviewerNomination[],
  maxCandidatesPerCluster: number,
): MutableCluster[] {
  const parent = new Map<string, string>();
  const scores = new Map<string, number>();
  const find = (eventId: string): string => {
    const incumbent = parent.get(eventId);
    if (incumbent === undefined) {
      parent.set(eventId, eventId);
      return eventId;
    }
    if (incumbent === eventId) return incumbent;
    const root = find(incumbent);
    parent.set(eventId, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };

  for (const nomination of nominations) {
    if (nomination.kind !== kind) continue;
    const [first, ...rest] = nomination.eventIds;
    if (first === undefined) continue;
    find(first);
    for (const eventId of rest) union(first, eventId);
    for (const eventId of nomination.eventIds) {
      scores.set(eventId, Math.max(scores.get(eventId) ?? 0, nomination.similarityScore ?? 0));
    }
  }

  const components = new Map<string, string[]>();
  for (const eventId of [...parent.keys()].sort()) {
    const root = find(eventId);
    const component = components.get(root) ?? [];
    component.push(eventId);
    components.set(root, component);
  }
  const clusters: MutableCluster[] = [];
  for (const eventIds of components.values()) {
    if (eventIds.length <= maxCandidatesPerCluster) {
      clusters.push({
        kind,
        eventIds,
        similarityScore: Math.max(...eventIds.map(eventId => scores.get(eventId) ?? 0)),
      });
      continue;
    }
    const advance = maxCandidatesPerCluster - 1;
    for (let offset = 0; offset < eventIds.length - 1; offset += advance) {
      const bounded = eventIds.slice(offset, offset + maxCandidatesPerCluster);
      if (bounded.length < 2) break;
      clusters.push({
        kind,
        eventIds: bounded,
        similarityScore: Math.max(...bounded.map(eventId => scores.get(eventId) ?? 0)),
      });
    }
  }
  return clusters;
}

function singletonClusters(
  kind: Extract<AutomataBusReviewerCandidateKind, 'stale-evidence' | 'orphan-provenance'>,
  nominations: readonly AutomataBusReviewerNomination[],
): MutableCluster[] {
  const eventIds = new Set<string>();
  for (const nomination of nominations) {
    if (nomination.kind !== kind) continue;
    nomination.eventIds.forEach(eventId => eventIds.add(eventId));
  }
  return [...eventIds].sort().map(eventId => ({ kind, eventIds: [eventId] }));
}

function clusterId(
  companionId: string,
  cluster: Pick<MutableCluster, 'kind' | 'eventIds'>,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([companionId, cluster.kind, cluster.eventIds]))
    .digest('hex');
  return `automata-bus-review:v1:${digest}`;
}

export class AutomataBusReviewerCandidateGenerator {
  private readonly nominations: AutomataBusReviewerNominationPort;
  private readonly policy: AutomataBusReviewerCandidatePolicy;

  constructor(options: {
    nominations: AutomataBusReviewerNominationPort;
    policy: AutomataBusReviewerCandidatePolicy;
  }) {
    this.nominations = options.nominations;
    this.policy = normalizePolicy(options.policy);
  }

  async generate(input: AutomataBusReviewerScope): Promise<AutomataBusReviewerCandidateBatch> {
    const companionId = nonEmptyString(input.companionId, 'companionId');
    const page = parseBatch(await this.nominations.nominate({
      scope: { ...input, companionId },
      similarityThreshold: this.policy.similarityThreshold,
      maxFindings: this.policy.maxFindingsPerRun,
      maxNominations: this.policy.maxNominationsPerRun,
    }), this.policy);
    const duplicate = clusterPairNominations(
      'duplicate',
      page.nominations,
      this.policy.maxCandidatesPerCluster,
    );
    const contradiction = clusterPairNominations(
      'contradiction',
      page.nominations,
      this.policy.maxCandidatesPerCluster,
    );
    const rawClusters = [
      ...duplicate,
      ...contradiction,
      ...singletonClusters('stale-evidence', page.nominations),
      ...singletonClusters('orphan-provenance', page.nominations),
    ].sort((left, right) => (
      left.kind.localeCompare(right.kind)
      || left.eventIds.join('\0').localeCompare(right.eventIds.join('\0'))
    ));
    const clusters = rawClusters.slice(0, this.policy.maxClustersPerRun).map(cluster => ({
      clusterId: clusterId(companionId, cluster),
      kind: cluster.kind,
      eventIds: cluster.eventIds,
      ...(cluster.similarityScore !== undefined
        ? { similarityScore: cluster.similarityScore }
        : {}),
    }));
    return {
      clusters,
      backlog: {
        findingsScanned: page.findingsScanned,
        nominationsSeen: page.totalNominations,
        clustersReturned: clusters.length,
        hasMore: page.hasMore
          || page.totalNominations > page.receivedCount
          || rawClusters.length > clusters.length,
      },
    };
  }
}
