import type { SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type {
  AutomataBusEvidence,
  AutomataBusLessonAttribution,
  AutomataBusProvenance,
  AutomataBusVerificationStatus,
} from './contract.js';
import {
  type AutomataBusToolAction,
  type AutomataBusWorkerAccess,
  type AutomataBusWorkerOperation,
  type AutomataBusWorkerPort,
  type AutomataBusWorkerScope,
} from './worker-access-contracts.js';
import {
  isAutomataBusWorkerEligible,
  normalizeAuthorizedAutomataBusWorkerScope,
} from './worker-access-formation.js';
import {
  AUTOMATA_BUS_TOOL_PARAMETERS,
  normalizeAutomataBusWorkerOperation,
} from './worker-access-operation.js';

function assertJsonResult(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} contains a non-JSON value`);
  }
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonResult(item, `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (!isRecord(value)) throw new Error(`${path} must be JSON data`);
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must contain plain JSON objects`);
  }
  for (const [key, item] of Object.entries(value)) {
    assertJsonResult(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function boundedResult(value: unknown, maximum: number): string {
  assertJsonResult(value, 'Automata Bus result', new WeakSet());
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    throw new Error('Automata Bus result is not JSON-serializable');
  }
  if (typeof serialized !== 'string') throw new Error('Automata Bus result is empty');
  if (serialized.length > maximum) {
    throw new Error(`Automata Bus result exceeds maxToolResultChars (${maximum})`);
  }
  return serialized;
}

function boundedError(error: unknown, maximum: number): string {
  const prefix = 'automata_bus failed safely: ';
  const detail = toErrorMessage(error);
  return `${prefix}${detail}`.slice(0, maximum);
}

type OperationDispatcher = (
  port: AutomataBusWorkerPort,
  scope: AutomataBusWorkerScope,
  operation: AutomataBusWorkerOperation,
) => Promise<unknown>;

const OPERATION_DISPATCHERS: Readonly<Record<AutomataBusToolAction, OperationDispatcher>> = {
  brief: (port, scope, operation) => port.brief({
    scope,
    ...(typeof operation.query === 'string' ? { query: operation.query } : {}),
  }),
  search: (port, scope, operation) => port.search({
    scope,
    query: operation.query as string,
    ...(typeof operation.limit === 'number' ? { limit: operation.limit } : {}),
  }),
  append: (port, scope, operation) => port.append({
    scope,
    claim: operation.claim as string,
    provenance: operation.provenance as AutomataBusProvenance,
    evidence: operation.evidence as AutomataBusEvidence[],
    artifactRefs: operation.artifactRefs as string[],
    verificationStatus: operation.verificationStatus as AutomataBusVerificationStatus,
    ...(typeof operation.source === 'string' ? { source: operation.source } : {}),
    ...(typeof operation.confidence === 'number' ? { confidence: operation.confidence } : {}),
    ...(operation.lessonAttribution
      ? { lessonAttribution: operation.lessonAttribution as AutomataBusLessonAttribution }
      : {}),
  }),
  correct: (port, scope, operation) => port.correct({
    scope,
    targetEventId: operation.targetEventId as string,
    relation: operation.relation as string,
    reason: operation.reason as string,
    ...(typeof operation.replacementClaim === 'string'
      ? { replacementClaim: operation.replacementClaim }
      : {}),
  }),
  handoff: (port, scope, operation) => port.handoff({
    scope,
    summary: operation.summary as string,
    outputRefs: operation.outputRefs as string[],
    validationPerformed: operation.validationPerformed as string[],
    ...(typeof operation.blocker === 'string' ? { blocker: operation.blocker } : {}),
    ...(typeof operation.nextAction === 'string' ? { nextAction: operation.nextAction } : {}),
  }),
  runs: (port, scope, operation) => port.runs({
    scope,
    ...(typeof operation.status === 'string' ? { status: operation.status } : {}),
    ...(typeof operation.classId === 'string' ? { classId: operation.classId } : {}),
    ...(typeof operation.taskId === 'string' ? { taskId: operation.taskId } : {}),
    ...(typeof operation.limit === 'number' ? { limit: operation.limit } : {}),
  }),
  inspect: (port, scope, operation) => port.inspect({
    scope,
    ...(typeof operation.eventId === 'string' ? { eventId: operation.eventId } : {}),
    ...(typeof operation.runId === 'string' ? { runId: operation.runId } : {}),
  }),
};

async function dispatchOperation(
  port: AutomataBusWorkerPort,
  scope: AutomataBusWorkerScope,
  operation: AutomataBusWorkerOperation,
): Promise<unknown> {
  return OPERATION_DISPATCHERS[operation.action](port, scope, operation);
}

export function createAutomataBusTool(input: {
  access: AutomataBusWorkerAccess;
  scope: AutomataBusWorkerScope;
}): SubstrateAgentTool {
  if (!isAutomataBusWorkerEligible(input.access, input.scope.automatonClass)) {
    throw new Error(`Automata Bus tool is not eligible for ${input.scope.automatonClass}`);
  }
  const scope = normalizeAuthorizedAutomataBusWorkerScope(input.access, input.scope);
  const { access } = input;
  const tool: SubstrateAgentTool = {
    name: 'automata_bus',
    label: 'automata_bus',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.automata_bus,
    parameters: AUTOMATA_BUS_TOOL_PARAMETERS,
    execute: async (_toolCallId, params: unknown) => {
      try {
        const operation = normalizeAutomataBusWorkerOperation(params, access.bounds);
        const result = await dispatchOperation(access.port, scope, operation);
        return textResult(boundedResult({ action: operation.action, result }, access.bounds.maxToolResultChars));
      } catch (error) {
        return textResultWithError(boundedError(error, access.bounds.maxToolResultChars), true);
      }
    },
  };
  return tagToolWithReversibility(tool, 'irreversible');
}
