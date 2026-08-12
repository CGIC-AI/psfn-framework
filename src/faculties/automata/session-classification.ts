import {
  requireAutomataClass,
  type ProductionAutomataClassId,
} from './registry-contract.js';
import { FREE_TIME_CHANNEL_PREFIX } from '../../core/session/session-id.js';

export type ProtectedSessionOwnership =
  | 'companion'
  | 'free_time'
  | 'icp'
  | 'contact'
  | 'unknown';

interface SessionClassificationBase {
  schemaVersion: 1;
  companionId: string;
  sessionId: string;
  classifiedAtMs: number;
}

export interface AutomataSessionClassification extends SessionClassificationBase {
  ownership: 'automata';
  runId: string;
  automatonClass: ProductionAutomataClassId;
  workerGeneration: number;
  retentionDeadlineMs: number;
}

interface ProtectedSessionClassification extends SessionClassificationBase {
  ownership: ProtectedSessionOwnership;
}

export type SessionClassification =
  | AutomataSessionClassification
  | ProtectedSessionClassification;

export interface SessionClassificationStorePort {
  recordClassification(classification: SessionClassification): Promise<void>;
  loadClassification(companionId: string, sessionId: string): Promise<SessionClassification | null>;
}

export interface ClassifySessionAtCreationInput {
  companionId: string;
  sessionId: string;
  createdAtMs: number;
  owner?:
    | {
        kind: 'automata';
        runId: string;
        automatonClass: string;
        workerGeneration: number;
      }
    | {
        kind: Exclude<ProtectedSessionOwnership, 'unknown'>;
      };
}

/** Supplied by the canonical Automata owner file; this module has no fallback. */
export interface AutomataRawSessionRetentionPolicy {
  rawSessionRetentionMs: number;
}

export interface ForegroundSessionAuthorityInput {
  channelId: string;
  channelType: string;
  hasIcpCorrelation: boolean;
  canonicalContactId?: string;
}

/** Only explicit runtime provenance protects a foreground owner; absence stays unknown. */
export function resolveForegroundSessionOwner(
  input: ForegroundSessionAuthorityInput,
): ClassifySessionAtCreationInput['owner'] {
  if (input.channelId.startsWith(FREE_TIME_CHANNEL_PREFIX)) return { kind: 'free_time' };
  if (input.hasIcpCorrelation) return { kind: 'icp' };
  if (input.canonicalContactId?.trim()) return { kind: 'contact' };
  if (input.channelType === 'companion' || input.channelType === 'companion-ui') {
    return { kind: 'companion' };
  }
  return undefined;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Session classification ${field} must be a non-empty string`);
  return normalized;
}

function safeTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Session classification ${field} must be a non-negative safe integer`);
  }
  return value;
}

function protectedClassification(
  input: ClassifySessionAtCreationInput,
  ownership: ProtectedSessionOwnership,
): ProtectedSessionClassification {
  return {
    schemaVersion: 1,
    companionId: requiredText(input.companionId, 'companionId'),
    sessionId: requiredText(input.sessionId, 'sessionId'),
    ownership,
    classifiedAtMs: safeTimestamp(input.createdAtMs, 'createdAtMs'),
  };
}

/**
 * Produce the immutable ownership record at the session-creation boundary.
 * Missing provenance is deliberately classified as unknown and is permanent.
 * Free-time is permanent even though its scheduler is a registered automaton.
 */
export function classifySessionAtCreation(
  input: ClassifySessionAtCreationInput,
  policy: AutomataRawSessionRetentionPolicy,
): SessionClassification {
  if (!input.owner) return protectedClassification(input, 'unknown');
  if (input.owner.kind !== 'automata') {
    return protectedClassification(input, input.owner.kind);
  }

  const automatonClass = requireAutomataClass(input.owner.automatonClass);
  if (automatonClass === 'scheduler.free_time') {
    return protectedClassification(input, 'free_time');
  }

  const workerGeneration = input.owner.workerGeneration;
  if (!Number.isSafeInteger(workerGeneration) || workerGeneration < 1) {
    throw new Error('Session classification workerGeneration must be a positive safe integer');
  }
  const classifiedAtMs = safeTimestamp(input.createdAtMs, 'createdAtMs');
  if (!Number.isSafeInteger(policy.rawSessionRetentionMs) || policy.rawSessionRetentionMs < 1) {
    throw new Error('Session classification rawSessionRetentionMs must be a positive safe integer');
  }
  const retentionDeadlineMs = classifiedAtMs + policy.rawSessionRetentionMs;
  if (!Number.isSafeInteger(retentionDeadlineMs)) {
    throw new Error('Session classification retention deadline exceeds the safe integer range');
  }

  return {
    schemaVersion: 1,
    companionId: requiredText(input.companionId, 'companionId'),
    sessionId: requiredText(input.sessionId, 'sessionId'),
    ownership: 'automata',
    runId: requiredText(input.owner.runId, 'runId'),
    automatonClass,
    workerGeneration,
    classifiedAtMs,
    retentionDeadlineMs,
  };
}

/** One creation-time operation: classify first, then durably persist or fail. */
export class AutomataSessionClassificationService {
  constructor(
    private readonly policy: AutomataRawSessionRetentionPolicy,
    private readonly store: SessionClassificationStorePort,
  ) {}

  async classifyAtCreation(input: ClassifySessionAtCreationInput): Promise<SessionClassification> {
    const classification = classifySessionAtCreation(input, this.policy);
    await this.store.recordClassification(classification);
    return classification;
  }

  async ensureClassifiedAtCreation(
    input: ClassifySessionAtCreationInput,
  ): Promise<SessionClassification> {
    const existing = await this.store.loadClassification(input.companionId, input.sessionId);
    if (existing) return existing;
    try {
      return await this.classifyAtCreation(input);
    } catch (error) {
      // Concurrent first turns can race between the read and immutable insert.
      // A committed classification is authoritative; all other failures escape.
      const raced = await this.store.loadClassification(input.companionId, input.sessionId);
      if (raced) return raced;
      throw error;
    }
  }
}
