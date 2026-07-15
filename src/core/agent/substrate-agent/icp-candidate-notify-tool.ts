import { Type } from '@sinclair/typebox';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import { withCapabilityRequirement } from '../../../system/capabilities/requirements.js';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { textResultWithError } from '../../tools/results.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../tool-surface/descriptions.js';

const candidateNotifyParameters = Type.Object({
  action: Type.Literal('send'),
  target_kind: Type.Literal('companion'),
  contact_id: Type.String({
    minLength: 1,
    description: 'Exact canonical contact ID from the permitted candidate.',
  }),
  initiation_permit: Type.String({
    minLength: 1,
    description: 'Broker-issued one-use UUID bound to the permitted candidate.',
  }),
}, { additionalProperties: false });

function parseCandidateNotifyParams(value: unknown): {
  action: 'send';
  target_kind: 'companion';
  contact_id: string;
  initiation_permit: string;
} {
  if (!isRecord(value)) {
    throw new Error('candidate notify params must be an object');
  }
  assertNoUnknownKeys(
    value,
    ['action', 'target_kind', 'contact_id', 'initiation_permit'],
    'candidate notify params',
  );
  if (value.action !== 'send' || value.target_kind !== 'companion') {
    throw new Error('candidate notify requires action=send and target_kind=companion');
  }
  if (typeof value.contact_id !== 'string'
    || value.contact_id.length === 0
    || value.contact_id.trim() !== value.contact_id) {
    throw new Error('candidate notify contact_id must be an exact non-empty canonical ID');
  }
  if (!isRfc4122Uuid(value.initiation_permit)) {
    throw new Error('candidate notify initiation_permit must be a lowercase RFC-4122 UUID');
  }
  return {
    action: 'send',
    target_kind: 'companion',
    contact_id: value.contact_id,
    initiation_permit: value.initiation_permit,
  };
}

/**
 * Candidate projection of the canonical unified notify tool. It keeps the
 * same semantic tool name and implementation, but narrows the model-facing
 * schema and runtime parser to the one action authorized for an ICP candidate
 * turn. The delegate is reached only after the live owner context is checked.
 */
export function createIcpCandidateScopedNotifyTool(input: {
  notifyTool: AgentTool<any>;
  authorizeExecution: () => boolean;
}): AgentTool<any> {
  if (input.notifyTool.name !== 'notify') {
    throw new Error('ICP candidate notify projection requires the canonical notify tool');
  }
  return withCapabilityRequirement({
    ...input.notifyTool,
    name: 'notify',
    label: 'notify',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.notify,
    parameters: candidateNotifyParameters,
    execute: async (toolCallId, rawParams, signal) => {
      let params: ReturnType<typeof parseCandidateNotifyParams>;
      try {
        params = parseCandidateNotifyParams(rawParams);
      } catch (error) {
        return textResultWithError(
          `notify: candidate companion outreach blocked (${error instanceof Error ? error.message : String(error)}).`,
          true,
        );
      }
      if (!input.authorizeExecution()) {
        return textResultWithError(
          'notify: candidate companion outreach blocked (the exact live candidate turn is no longer authorized).',
          true,
        );
      }
      return input.notifyTool.execute(toolCallId, params, signal);
    },
  }, 'external.companion');
}
