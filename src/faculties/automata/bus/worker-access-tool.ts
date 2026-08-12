import type { SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../../core/agent/tool-surface/descriptions.js';
import { textResult, textResultWithError } from '../../../core/tools/results.js';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import { isRecord } from '../../../shared/utils/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
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

async function dispatchOperation(
  port: AutomataBusWorkerPort,
  scope: AutomataBusWorkerScope,
  operation: AutomataBusWorkerOperation,
): Promise<unknown> {
  switch (operation.action) {
    case 'brief':
      return await port.brief({ scope, ...(operation.query ? { query: operation.query } : {}) });
    case 'search':
      return await port.search({
        scope,
        query: operation.query,
        ...(operation.limit === undefined ? {} : { limit: operation.limit }),
      });
    case 'append':
      return await port.append({
        scope,
        claim: operation.claim,
        provenance: operation.provenance,
        evidence: operation.evidence,
        artifactRefs: operation.artifactRefs,
        verificationStatus: operation.verificationStatus,
        ...(operation.source === undefined ? {} : { source: operation.source }),
        ...(operation.confidence === undefined ? {} : { confidence: operation.confidence }),
        ...(operation.lessonAttribution === undefined
          ? {}
          : { lessonAttribution: operation.lessonAttribution }),
      });
    case 'correct':
      return await port.correct({
        scope,
        targetEventId: operation.targetEventId,
        relation: operation.relation,
        reason: operation.reason,
        ...(operation.replacementClaim === undefined
          ? {}
          : { replacementClaim: operation.replacementClaim }),
      });
    case 'handoff':
      return await port.handoff({
        scope,
        summary: operation.summary,
        outputRefs: operation.outputRefs,
        validationPerformed: operation.validationPerformed,
        ...(operation.blocker === undefined ? {} : { blocker: operation.blocker }),
        ...(operation.nextAction === undefined ? {} : { nextAction: operation.nextAction }),
      });
    case 'runs':
      return await port.runs({
        scope,
        ...(operation.status === undefined ? {} : { status: operation.status }),
        ...(operation.classId === undefined ? {} : { classId: operation.classId }),
        ...(operation.taskId === undefined ? {} : { taskId: operation.taskId }),
        ...(operation.limit === undefined ? {} : { limit: operation.limit }),
      });
    case 'inspect':
      return await port.inspect({
        scope,
        ...(operation.eventId === undefined ? {} : { eventId: operation.eventId }),
        ...(operation.runId === undefined ? {} : { runId: operation.runId }),
      });
  }
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
