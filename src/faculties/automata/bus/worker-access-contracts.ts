import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { ProductionAutomataClassId } from '../registry-contract.js';
import type { AutomataBusQueryAudience } from './query-ports.js';
import type {
  AutomataBusEvidence,
  AutomataBusLessonAttribution,
  AutomataBusProvenance,
  AutomataBusRelationKind,
  AutomataBusVerificationStatus,
} from './contract.js';

export const AUTOMATA_BUS_TOOL_ACTIONS = [
  'brief',
  'search',
  'append',
  'correct',
  'handoff',
  'runs',
  'inspect',
] as const;

export type AutomataBusToolAction = typeof AUTOMATA_BUS_TOOL_ACTIONS[number];

export interface AutomataBusWorkerScope {
  /** Authenticated companion owner. Never accepted from model arguments. */
  companionId: string;
  /** Durable runtime run identity. Never accepted from model arguments. */
  runId: string;
  /** Runtime task identity. Never accepted from model arguments. */
  taskId: string;
  automatonClass: ProductionAutomataClassId;
  /** The worker disclosure audience is fixed by runtime composition. */
  audience: Extract<AutomataBusQueryAudience, 'eligible-automata'>;
  maxSensitivity: SensitivityLevel;
}

/** Owner-policy bounds supplied by the runtime adapter; no model-owned override exists. */
export interface AutomataBusWorkerBounds {
  maxQueryChars: number;
  maxTextChars: number;
  maxArrayItems: number;
  maxSearchResults: number;
  maxRunResults: number;
  maxBriefingChars: number;
  maxBriefingItems: number;
  maxToolResultChars: number;
}

export interface AutomataBusWorkerBriefing {
  text: string;
  itemCount: number;
}

export type AutomataBusWorkerOperation =
  | { action: 'brief'; query?: string }
  | { action: 'search'; query: string; limit?: number }
  | {
    action: 'append';
    claim: string;
    provenance: AutomataBusProvenance;
    evidence: AutomataBusEvidence[];
    artifactRefs: string[];
    verificationStatus: AutomataBusVerificationStatus;
    source?: string;
    confidence?: number;
    lessonAttribution?: AutomataBusLessonAttribution;
  }
  | {
    action: 'correct';
    targetEventId: string;
    relation: AutomataBusRelationKind;
    reason: string;
    replacementClaim?: string;
  }
  | {
    action: 'handoff';
    summary: string;
    outputRefs: string[];
    validationPerformed: string[];
    blocker?: string;
    nextAction?: string;
  }
  | { action: 'runs'; status?: string; classId?: string; taskId?: string; limit?: number }
  | { action: 'inspect'; eventId?: string; runId?: string };

/**
 * Narrow adapter over the canonical Bus store/query service and run registry.
 * The adapter receives trusted scope separately from validated model arguments.
 */
export interface AutomataBusWorkerPort {
  isClassEligible(classId: ProductionAutomataClassId): boolean;
  brief(input: {
    scope: AutomataBusWorkerScope;
    query?: string;
  }): Promise<unknown>;
  search(input: {
    scope: AutomataBusWorkerScope;
    query: string;
    limit?: number;
  }): Promise<unknown>;
  append(input: {
    scope: AutomataBusWorkerScope;
    claim: string;
    provenance: AutomataBusProvenance;
    evidence: readonly AutomataBusEvidence[];
    artifactRefs: readonly string[];
    verificationStatus: AutomataBusVerificationStatus;
    source?: string;
    confidence?: number;
    lessonAttribution?: AutomataBusLessonAttribution;
  }): Promise<unknown>;
  correct(input: {
    scope: AutomataBusWorkerScope;
    targetEventId: string;
    relation: AutomataBusRelationKind;
    reason: string;
    replacementClaim?: string;
  }): Promise<unknown>;
  handoff(input: {
    scope: AutomataBusWorkerScope;
    summary: string;
    outputRefs: readonly string[];
    validationPerformed: readonly string[];
    blocker?: string;
    nextAction?: string;
  }): Promise<unknown>;
  runs(input: {
    scope: AutomataBusWorkerScope;
    status?: string;
    classId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<unknown>;
  inspect(input: {
    scope: AutomataBusWorkerScope;
    eventId?: string;
    runId?: string;
  }): Promise<unknown>;
}

export interface AutomataBusWorkerAccess {
  port: AutomataBusWorkerPort;
  bounds: AutomataBusWorkerBounds;
  /** Authenticated companion/audience identity bound by runtime composition. */
  identity: Pick<AutomataBusWorkerScope, 'companionId' | 'audience' | 'maxSensitivity'>;
}

export interface AutomataBusWorkerFormation {
  scope: AutomataBusWorkerScope;
  promptBlock: string;
  briefing: AutomataBusWorkerBriefing;
}
